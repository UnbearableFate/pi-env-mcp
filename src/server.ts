import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { describeTarget } from "./config.ts";
import { editFile, readFile, writeFile } from "./files.ts";
import { JOB_SIGNALS, type Job, JobStore } from "./jobs.ts";
import { EditError } from "./lib/edit.ts";
import { errorMessage, formatBytes, formatDuration, sleep } from "./lib/util.ts";
import { glob, grep } from "./search.ts";
import type { HostManager, HostSession } from "./session.ts";
import { runShell, type ShellResult } from "./shell.ts";
import { TerminalRegistry } from "./terminals.ts";
import { download, upload } from "./transfer.ts";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const VERSION = "0.1.0";

function text(body: string, isError = false): CallToolResult {
	return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

/** A failure as the model should read it: what went wrong, and what to do about it when that is known. */
export function describeError(error: unknown): string {
	if (error instanceof Error && error.name === "FileError" && "code" in error) {
		const path = "path" in error && typeof error.path === "string" ? error.path : undefined;
		const at = path === undefined ? "" : `: ${path}`;
		switch (error.code) {
			case "not_found":
				return `No such file or directory${at}`;
			case "permission_denied":
				return `Permission denied${at}`;
			case "is_directory":
				return `Is a directory${at} (use glob, or bash ls)`;
			case "not_directory":
				return `Not a directory${at}`;
			case "aborted":
				return "Cancelled";
		}
	}
	const message = errorMessage(error);
	if (/pi-env connection (lost|timed out)|exited with code .* before it was ready/i.test(message)) {
		return `${message}. The connection to the host was lost; the next call reconnects.`;
	}
	return message;
}

/** Run a handler, turning thrown errors into error results the model can act on. */
function guarded<A>(handler: (args: A, extra: Extra) => Promise<CallToolResult>) {
	return async (args: A, extra: Extra): Promise<CallToolResult> => {
		try {
			return await handler(args, extra);
		} catch (error) {
			if (extra.signal.aborted) return text("Cancelled.", true);
			return text(error instanceof EditError ? error.message : describeError(error), true);
		}
	};
}

/** Progress notifications, when the client asked for them, at most one per second. */
function progressReporter(extra: Extra): ((progress: number, total: number, message: string) => void) | undefined {
	const token = extra._meta?.progressToken;
	if (token === undefined) return undefined;
	let last = 0;
	let lastProgress = -1;
	return (progress, total, message) => {
		const now = Date.now();
		if (now - last < 1000 || progress <= lastProgress) return;
		last = now;
		lastProgress = progress;
		void extra
			.sendNotification({
				method: "notifications/progress",
				params: { progressToken: token, progress, ...(total > 0 ? { total } : {}), message },
			})
			.catch(() => {});
	};
}

function lastLine(text: string): string | undefined {
	const lines = text.split(/[\r\n]+/).filter((line) => line.trim() !== "");
	const line = lines.at(-1)?.trim();
	return line === undefined ? undefined : line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function formatShell(session: HostSession, result: ShellResult, timeoutSeconds: number): CallToolResult {
	const parts: string[] = [];
	if (result.cwdReset !== undefined) {
		parts.push(`[the working directory ${result.cwdReset} no longer exists; ran in ${result.ranIn} instead]`);
	}
	if (result.droppedLines > 0 || result.droppedBytes > 0) {
		const where = result.spillPath === undefined ? "" : `; the complete output is on ${session.name} at ${result.spillPath}`;
		parts.push(`[output truncated: the first ${result.droppedLines} lines (${formatBytes(result.droppedBytes)}) are not shown${where}]`);
	}
	parts.push(result.output === "" ? "(no output)" : result.output.replace(/\n$/, ""));
	let isError = false;
	if (result.failure !== undefined) {
		isError = true;
		const { code, message } = result.failure;
		if (code === "timeout") {
			parts.push(`[timed out after ${timeoutSeconds} s: the command and everything it started were killed. Pass a larger timeout, or use run_in_background for long work]`);
		} else if (code === "aborted") {
			parts.push("[cancelled: the command was killed]");
		} else if (code === "lost") {
			parts.push(`[the connection to ${session.name} was lost while the command ran; its outcome is unknown. The daemon stops its commands when the connection drops, but not when it is killed itself, so the command may still be running: check before running it again. The next call reconnects]`);
		} else if (code === "shell_unavailable" || code === "spawn_error") {
			parts.push(`[the command could not start: ${message}]`);
		} else {
			parts.push(`[the command failed: ${message}]`);
		}
	} else if (result.exitCode !== 0) {
		parts.push(`[exit code ${result.exitCode}]`);
	}
	if (result.newCwd !== undefined) parts.push(`[working directory is now ${result.newCwd}]`);
	if (result.durationMs >= 10_000 && result.failure === undefined) parts.push(`[took ${formatDuration(result.durationMs)}]`);
	return text(parts.join("\n"), isError);
}

/** A duration measured with the remote clock, which jobs record in whole seconds. */
function seconds(value: number): string {
	const whole = Math.max(0, Math.round(value));
	return whole < 60 ? `${whole} s` : formatDuration(whole * 1000);
}

function jobState(job: Job): string {
	const now = Date.now() / 1000;
	const ran = (end: number) => (job.startedAt === undefined ? "" : ` after ${seconds(end - job.startedAt)}`);
	switch (job.state) {
		case "running":
			return `running for ${job.startedAt === undefined ? "?" : seconds(now - job.startedAt)}`;
		case "exited":
			return `exited with code ${job.exitCode}${ran(job.endedAt ?? now)}${job.killedWith === undefined ? "" : ` (SIG${job.killedWith} was sent)`}`;
		case "killed":
			return `killed by SIG${job.killedWith}`;
		case "starting":
			return "starting";
		case "lost":
			return job.pid === undefined
				? "never started (its runner recorded no process)"
				: "gone without an exit status (killed with SIGKILL from outside, or the machine restarted)";
	}
}

function oneLine(command: string, max = 100): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

export interface ServerOptions {
	manager: HostManager;
}

/** The MCP server and its tools. */
export function createServer(options: ServerOptions): { server: McpServer; terminals: TerminalRegistry } {
	const { manager } = options;
	const terminals = new TerminalRegistry();
	const names = manager.names();
	const defaultHost = manager.defaultHost;
	const hostList = names.length === 0 ? "none configured yet" : names.map((name) => (name === defaultHost ? `${name} (default)` : name)).join(", ");

	const instructions = [
		"Tools for working on remote machines over SSH. Each host keeps one persistent connection to a pi-env daemon running there, which every call reuses: calls are fast, and state such as the working directory, terminals and background jobs persists between them.",
		`Hosts: ${hostList}.${names.length > 1 || defaultHost === undefined ? ' Pass "host" to choose one.' : ""}`,
		"All paths are paths on the remote host; relative paths resolve against the host's working directory, which a `cd` in bash changes for later calls.",
		"Use bash for commands; bash with run_in_background, then job_status and job_kill, for long-running work (jobs keep running if the connection drops); terminal_open, terminal_send, terminal_read and terminal_close for interactive programs and shell state; read, write, edit, glob and grep for files; upload and download to copy between this machine and a host.",
	].join("\n");

	const server = new McpServer({ name: "pi-env-mcp", title: "Remote hosts over SSH (pi-env)", version: VERSION }, { instructions });

	const host = z.string().optional().describe(`Remote host to use: ${hostList}.`);

	server.registerTool(
		"hosts",
		{
			title: "List remote hosts",
			description:
				"List the remote hosts this server can reach: SSH target, connection state, system (OS, hostname, home), current working directory and open terminals. connect: true connects now (deploying the pi-env daemon if needed) to check that a host works; reconnect: true restarts a host's connection, which closes its terminals but leaves background jobs running.",
			inputSchema: {
				host: host.describe("Only this host (default: all)."),
				connect: z.boolean().optional().describe("Connect now if not connected yet."),
				reconnect: z.boolean().optional().describe("Drop the connection and start a new one."),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		guarded(async (args: { host?: string | undefined; connect?: boolean | undefined; reconnect?: boolean | undefined }) => {
			const selected = args.host ? [manager.resolveName(args.host)] : names;
			if (selected.length === 0) {
				return text("No remote hosts are configured. Ask the user to run: pi-env-mcp add <name> --host <ssh-host>, then pi-env-mcp trust <name>.");
			}
			const errors: string[] = [];
			if (args.reconnect) {
				for (const name of selected) await manager.reconnect(name).catch((error: unknown) => errors.push(`${name}: ${describeError(error)}`));
			} else if (args.connect) {
				await Promise.all(selected.map((name) => manager.session(name).catch((error: unknown) => errors.push(`${name}: ${describeError(error)}`))));
			}
			const lines: string[] = [];
			for (const name of selected) {
				const target = describeTarget(name, manager.hostConfig(name));
				const label = name === defaultHost ? `${name} (default)` : name;
				const session = manager.connected(name);
				if (session === undefined) {
					lines.push(`${label}: ssh ${target}; not connected (connects on first use)`);
					const error = manager.lastError(name);
					if (error !== undefined) lines.push(`  last error: ${error.replaceAll("\n", "\n    ")}`);
					continue;
				}
				const info = session.info;
				lines.push(`${label}: ssh ${target}; connected for ${formatDuration(Date.now() - session.connectedAt)}`);
				lines.push(`  system: ${info.os} ${info.arch}, hostname ${session.hostname}, home ${info.home}, pi-env daemon ${info.version}`);
				lines.push(`  working directory: ${session.cwd}${session.cwd === session.baseCwd ? "" : ` (initially ${session.baseCwd})`}`);
				const open = terminals.list(name);
				if (open.length > 0) lines.push(`  terminals: ${open.map((terminal) => terminal.describe()).join(", ")}`);
			}
			if (errors.length > 0) lines.push("", ...errors);
			return text(lines.join("\n"), errors.length > 0);
		}),
	);

	server.registerTool(
		"bash",
		{
			title: "Run a remote shell command",
			description:
				"Run a command with bash on a remote host, through the host's persistent pi-env connection. Returns stdout and stderr combined, as a terminal would show them (progress bars collapsed, colors removed). Long output keeps only its end, and the complete output is saved to a file on the host. The working directory persists per host: a `cd` applies to later calls, which start where the previous one ended. Variables and other shell state do not persist; use terminal_open for that. stdin is empty, so a command that waits for input fails instead of hanging. For work longer than the timeout (servers, training, builds), set run_in_background to start a detached job that survives disconnects, then follow it with job_status.",
			inputSchema: {
				command: z.string().describe("The command, as typed in bash. May span several lines."),
				host,
				cwd: z.string().optional().describe("Directory to run in for this call only (absolute, or relative to the working directory)."),
				timeout: z.number().positive().optional().describe("Seconds before the command is killed (default 120, at most 3600)."),
				run_in_background: z
					.boolean()
					.optional()
					.describe("Start the command as a detached background job and return its id at once, without waiting."),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		},
		guarded(
			async (
				args: { command: string; host?: string | undefined; cwd?: string | undefined; timeout?: number | undefined; run_in_background?: boolean | undefined },
				extra,
			) => {
				const session = await manager.session(args.host);
				if (args.run_in_background) {
					const cwd = args.cwd === undefined ? session.cwd : await session.resolve(args.cwd, extra.signal);
					const job = await new JobStore(session).start(args.command, cwd, extra.signal);
					return text(
						[
							`Started background job ${job.id} on ${session.name} (pid ${job.pid ?? "?"}) in ${cwd}.`,
							`Its output goes to ${job.logPath}.`,
							`Follow it with job_status {"job_id": "${job.id}"} (add "wait": <seconds> to wait for it to end); stop it with job_kill. It keeps running if the connection drops or this server stops.`,
						].join("\n"),
					);
				}
				const requested = args.timeout ?? session.timeouts.default;
				const timeoutSeconds = Math.min(requested, session.timeouts.max);
				const report = progressReporter(extra);
				let latest: string | undefined;
				const started = Date.now();
				const ticker =
					report === undefined
						? undefined
						: setInterval(() => {
								const seconds = Math.floor((Date.now() - started) / 1000);
								report(seconds, 0, latest === undefined ? `running on ${session.name}` : `${session.name}: ${latest}`);
							}, 1000);
				try {
					const result = await runShell(session, args.command, {
						...(args.cwd === undefined ? {} : { cwd: args.cwd }),
						timeoutSeconds,
						signal: extra.signal,
						...(report === undefined ? {} : { onOutput: (chunk: string) => (latest = lastLine(chunk) ?? latest) }),
					});
					const formatted = formatShell(session, result, timeoutSeconds);
					if (requested > timeoutSeconds) {
						const first = formatted.content[0];
						if (first?.type === "text") first.text += `\n[timeout capped at ${timeoutSeconds} s]`;
					}
					return formatted;
				} finally {
					if (ticker !== undefined) clearInterval(ticker);
				}
			},
		),
	);

	server.registerTool(
		"read",
		{
			title: "Read a remote file",
			description:
				"Read a text file or an image on a remote host. Text comes back with line numbers (cat -n format), up to 2000 lines from the start by default; use offset and limit for other parts of long files. Lines longer than 2000 characters are cut. PNG, JPEG, GIF and WebP files come back as images. Relative paths resolve against the host's working directory.",
			inputSchema: {
				file_path: z.string().describe("Path of the file on the remote host."),
				offset: z.number().int().positive().optional().describe("First line to read (1-based)."),
				limit: z.number().int().positive().optional().describe("Number of lines to read."),
				host,
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		guarded(async (args: { file_path: string; offset?: number | undefined; limit?: number | undefined; host?: string | undefined }, extra) => {
			const session = await manager.session(args.host);
			const result = await readFile(session, args.file_path, {
				...(args.offset === undefined ? {} : { offset: args.offset }),
				...(args.limit === undefined ? {} : { limit: args.limit }),
				signal: extra.signal,
			});
			if (result.kind === "image") {
				return { content: [{ type: "image", data: result.data, mimeType: result.mimeType }, { type: "text", text: result.text }] };
			}
			return text(result.text);
		}),
	);

	server.registerTool(
		"write",
		{
			title: "Write a remote file",
			description:
				"Create a file on a remote host, or replace its whole content, with UTF-8 text. Missing parent directories are created. To change part of an existing file, use edit.",
			inputSchema: {
				file_path: z.string().describe("Path of the file on the remote host."),
				content: z.string().describe("The complete new content."),
				host,
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		guarded(async (args: { file_path: string; content: string; host?: string | undefined }, extra) => {
			const session = await manager.session(args.host);
			return text(await writeFile(session, args.file_path, args.content, extra.signal));
		}),
	);

	server.registerTool(
		"edit",
		{
			title: "Edit a remote file",
			description:
				"Replace text in a file on a remote host. old_string must match the file exactly, including indentation, and occur exactly once unless replace_all is set; include enough surrounding lines to make it unique. LF and CRLF line endings are handled. Returns the changed lines with line numbers. Read the file first so that old_string is copied exactly. An empty old_string creates a file that does not exist yet.",
			inputSchema: {
				file_path: z.string().describe("Path of the file on the remote host."),
				old_string: z.string().describe("The exact text to replace."),
				new_string: z.string().describe("The text to put in its place."),
				replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring exactly one."),
				host,
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		},
		guarded(
			async (
				args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean | undefined; host?: string | undefined },
				extra,
			) => {
				const session = await manager.session(args.host);
				return text(await editFile(session, args.file_path, args.old_string, args.new_string, args.replace_all === true, extra.signal));
			},
		),
	);

	server.registerTool(
		"glob",
		{
			title: "Find remote files",
			description:
				"Find files on a remote host by glob pattern, such as **/*.py or src/**/test_*.ts, from the pi-env daemon's directory listing (no shell, fast). Inside git repositories, paths ignored by .gitignore are skipped unless include_ignored is set; .git directories are never listed. Directories in the results end with /. Returns absolute paths.",
			inputSchema: {
				pattern: z.string().describe("Glob pattern, relative to path, or absolute."),
				path: z.string().optional().describe("Directory to search (default: the working directory)."),
				include_ignored: z.boolean().optional().describe("Also list paths that .gitignore excludes."),
				limit: z.number().int().positive().optional().describe("Most results to return (default 500)."),
				host,
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		guarded(
			async (
				args: { pattern: string; path?: string | undefined; include_ignored?: boolean | undefined; limit?: number | undefined; host?: string | undefined },
				extra,
			) => {
				const session = await manager.session(args.host);
				return text(
					await glob(session, args.pattern, {
						...(args.path === undefined ? {} : { path: args.path }),
						includeIgnored: args.include_ignored === true,
						limit: args.limit ?? 500,
						signal: extra.signal,
					}),
				);
			},
		),
	);

	server.registerTool(
		"grep",
		{
			title: "Search remote file contents",
			description:
				"Search file contents on a remote host with ripgrep (or grep -E where ripgrep is not installed). The pattern is a regular expression: Rust syntax with ripgrep, POSIX extended with grep. Hidden files are searched; with ripgrep, .gitignore is honored. output_mode: files_with_matches (default) lists matching files, content shows matching lines as path:line:text, count shows matches per file.",
			inputSchema: {
				pattern: z.string().describe("Regular expression to search for."),
				path: z.string().optional().describe("File or directory to search (default: the working directory)."),
				glob: z.string().optional().describe("Only search files whose path matches this glob, e.g. *.py."),
				type: z.string().optional().describe("Only search files of this ripgrep type, e.g. py, js, rust."),
				output_mode: z.enum(["files_with_matches", "content", "count"]).optional().describe("What to return (default files_with_matches)."),
				case_insensitive: z.boolean().optional().describe("Ignore case."),
				context: z.number().int().min(0).max(50).optional().describe("Lines of context around each match (content mode)."),
				multiline: z.boolean().optional().describe("Let the pattern span lines (ripgrep only)."),
				head_limit: z.number().int().positive().optional().describe("Most lines of results to return (default 200)."),
				host,
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		guarded(
			async (
				args: {
					pattern: string;
					path?: string | undefined;
					glob?: string | undefined;
					type?: string | undefined;
					output_mode?: "files_with_matches" | "content" | "count" | undefined;
					case_insensitive?: boolean | undefined;
					context?: number | undefined;
					multiline?: boolean | undefined;
					head_limit?: number | undefined;
					host?: string | undefined;
				},
				extra,
			) => {
				const session = await manager.session(args.host);
				return text(
					await grep(session, {
						pattern: args.pattern,
						...(args.path === undefined ? {} : { path: args.path }),
						...(args.glob === undefined ? {} : { glob: args.glob }),
						...(args.type === undefined ? {} : { type: args.type }),
						mode: args.output_mode ?? "files_with_matches",
						caseInsensitive: args.case_insensitive === true,
						...(args.context === undefined ? {} : { context: args.context }),
						multiline: args.multiline === true,
						headLimit: args.head_limit ?? 200,
						signal: extra.signal,
					}),
				);
			},
		),
	);

	server.registerTool(
		"job_status",
		{
			title: "Check background jobs",
			description:
				"Check background jobs started with bash run_in_background. Without job_id, lists the host's jobs and their state. With job_id, shows its state and output: by default the end of the output; pass offset (a byte position, such as next_offset from the previous call) to read output from there on, e.g. only what is new. wait blocks until the job ends or that many seconds pass, instead of polling with sleep.",
			inputSchema: {
				job_id: z.string().optional().describe("The job, e.g. job-1a2b3c4d (default: list all jobs)."),
				offset: z.number().int().min(0).optional().describe("Byte position in the job's output to read from."),
				wait: z.number().min(0).max(3600).optional().describe("Seconds to wait for the job to end before answering (default 0)."),
				host,
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		guarded(async (args: { job_id?: string | undefined; offset?: number | undefined; wait?: number | undefined; host?: string | undefined }, extra) => {
			const session = await manager.session(args.host);
			const store = new JobStore(session);
			if (args.job_id === undefined || args.job_id === "") {
				const jobs = await store.list();
				if (jobs.length === 0) return text(`No background jobs on ${session.name}.`);
				const lines = jobs.map((job) => `${job.id}  ${jobState(job)}  ${formatBytes(job.logSize)} output  $ ${oneLine(job.command)}`);
				return text([`${jobs.length} background job${jobs.length === 1 ? "" : "s"} on ${session.name} (newest first):`, ...lines].join("\n"));
			}
			let job = await store.get(args.job_id);
			if (args.wait !== undefined && args.wait > 0) {
				const report = progressReporter(extra);
				const started = Date.now();
				const deadline = started + args.wait * 1000;
				while ((job.state === "running" || job.state === "starting") && Date.now() < deadline) {
					await sleep(Math.min(500, deadline - Date.now()), extra.signal);
					job = await store.get(args.job_id);
					report?.(Math.floor((Date.now() - started) / 1000), args.wait, `${job.id} on ${session.name}: ${job.state}`);
				}
			}
			const output = await store.output(job, session.outputLimits, args.offset, extra.signal);
			const lines = [
				`job ${job.id} on ${session.name}: ${jobState(job)}`,
				`command: ${oneLine(job.command, 300)}`,
				`cwd: ${job.cwd}; pid ${job.pid ?? "?"}; log ${job.logPath} (${formatBytes(output.size)})`,
			];
			if (args.offset === undefined && output.omittedBefore > 0) {
				lines.push(`[showing the end of the output; the first ${formatBytes(output.omittedBefore)} are not shown]`);
			} else if (args.offset !== undefined) {
				lines.push(`[output bytes ${output.from}-${output.to} of ${output.size}]`);
			}
			lines.push(output.text === "" ? "(no output)" : output.text.replace(/\n$/, ""));
			const more = output.to < output.size ? "; more output is available from there" : "";
			lines.push(`[next_offset: ${output.to}${more}]`);
			return text(lines.join("\n"));
		}),
	);

	server.registerTool(
		"job_kill",
		{
			title: "Stop a background job",
			description:
				"Send a signal to a background job's whole process group: TERM (default) asks it to stop, INT is like Ctrl-C, KILL forces it. With remove, also delete the job's record and output log once it has stopped (a finished job can be removed directly).",
			inputSchema: {
				job_id: z.string().describe("The job, e.g. job-1a2b3c4d."),
				signal: z.enum(JOB_SIGNALS).optional().describe("Signal to send (default TERM)."),
				remove: z.boolean().optional().describe("Delete the job's record and log after it stopped."),
				host,
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		},
		guarded(
			async (
				args: { job_id: string; signal?: (typeof JOB_SIGNALS)[number] | undefined; remove?: boolean | undefined; host?: string | undefined },
				extra,
			) => {
				const session = await manager.session(args.host);
				const store = new JobStore(session);
				let job = await store.get(args.job_id);
				const signal = args.signal ?? "TERM";
				const lines: string[] = [];
				if (job.pid !== undefined && (job.state === "running" || job.state === "starting")) {
					await store.kill(job, signal);
					for (let waited = 0; waited < 3000 && (job.state === "running" || job.state === "starting"); waited += 200) {
						await sleep(200, extra.signal);
						job = await store.get(args.job_id);
					}
					lines.push(`Sent SIG${signal} to job ${job.id} on ${session.name}; it is now ${jobState(job)}.`);
				} else {
					lines.push(`Job ${job.id} on ${session.name} is not running: ${jobState(job)}.`);
				}
				if (args.remove) {
					if (job.state === "running") {
						lines.push("It is still running, so it was not removed; try signal KILL.");
						return text(lines.join("\n"), true);
					}
					await store.remove(job);
					lines.push(`Removed its record and log (${job.dir}).`);
				}
				return text(lines.join("\n"));
			},
		),
	);

	const timeoutSchema = (fallback: number) =>
		z.number().positive().max(600).optional().describe(`Most seconds to wait for output to settle (default ${fallback}).`);

	server.registerTool(
		"terminal_open",
		{
			title: "Open a remote terminal",
			description:
				"Open a persistent interactive terminal on a remote host: the user's login shell in a pseudo-terminal, kept between calls. Use it for interactive programs (python, ipython, gdb, psql, prompts, full-screen tools) and for shell state that must persist (exported variables, activated virtualenvs or conda environments, a server running in the foreground). Optionally types a first command. Returns the terminal id and its first output. The terminal lives until terminal_close, until this server stops, or until the connection drops.",
			inputSchema: {
				host,
				cwd: z.string().optional().describe("Directory to start in (default: the working directory)."),
				command: z.string().optional().describe("A command to type into the new shell, e.g. python3."),
				cols: z.number().int().min(20).max(500).optional().describe("Width in columns (default 120)."),
				rows: z.number().int().min(5).max(200).optional().describe("Height in rows (default 40)."),
				timeout: timeoutSchema(10),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		},
		guarded(
			async (
				args: {
					host?: string | undefined;
					cwd?: string | undefined;
					command?: string | undefined;
					cols?: number | undefined;
					rows?: number | undefined;
					timeout?: number | undefined;
				},
				extra,
			) => {
				const session = await manager.session(args.host);
				const cwd = args.cwd === undefined ? session.cwd : await session.resolve(args.cwd, extra.signal);
				const terminal = await terminals.open(session, {
					cwd,
					...(args.command === undefined ? {} : { command: args.command }),
					cols: args.cols ?? 120,
					rows: args.rows ?? 40,
					signal: extra.signal,
				});
				let reason;
				try {
					reason = await terminal.settle({
						timeoutMs: (args.timeout ?? 10) * 1000,
						afterInput: args.command !== undefined,
						signal: extra.signal,
					});
				} catch (error) {
					// The caller never learns the id of a terminal whose opening it cancelled.
					terminal.close();
					throw error;
				}
				return text(await terminal.render(session.outputLimits, "new", reason));
			},
		),
	);

	server.registerTool(
		"terminal_send",
		{
			title: "Type into a remote terminal",
			description:
				'Type into a terminal and return what it printed since the last read. input is typed as literal text; end it with "\\n" to press Enter. keys presses named keys after the input, e.g. ["C-c"] to interrupt the running program, or ["Up", "Enter"] to rerun the previous command. Waits until the shell is back at its prompt, output stays quiet for 1.5 s, wait_for matches the new output, or the timeout passes.',
			inputSchema: {
				terminal_id: z.string().describe("The terminal, e.g. t1."),
				input: z.string().optional().describe('Text to type; "\\n" presses Enter.'),
				keys: z
					.array(z.string())
					.optional()
					.describe("Named keys to press after the input: Enter, Tab, Escape, Backspace, Up, Down, Left, Right, Home, End, PageUp, PageDown, Delete, F1-F12, C-c, C-d, C-z, C-l, M-x, ..."),
				wait_for: z.string().optional().describe("Wait until the new output matches this regular expression, e.g. a prompt like '>>> $'."),
				timeout: timeoutSchema(15),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		},
		guarded(
			async (
				args: { terminal_id: string; input?: string | undefined; keys?: string[] | undefined; wait_for?: string | undefined; timeout?: number | undefined },
				extra,
			) => {
				const terminal = terminals.get(args.terminal_id);
				if ((args.input === undefined || args.input === "") && (args.keys === undefined || args.keys.length === 0)) {
					throw new Error("Nothing to send: give input or keys. To only read, use terminal_read.");
				}
				const waitFor = args.wait_for === undefined ? undefined : new RegExp(args.wait_for, "m");
				await terminal.send(args.input, args.keys);
				const reason = await terminal.settle({
					timeoutMs: (args.timeout ?? 15) * 1000,
					...(waitFor === undefined ? {} : { waitFor }),
					afterInput: true,
					signal: extra.signal,
				});
				return text(await terminal.render(terminal.host.outputLimits, "new", reason));
			},
		),
	);

	server.registerTool(
		"terminal_read",
		{
			title: "Read a remote terminal",
			description:
				"Return a terminal's output since the last read. With timeout or wait_for, first wait for more output (until the shell is back at its prompt, output stays quiet, or wait_for matches). With screen, return the whole visible screen instead, as for full-screen programs like vim, less or htop.",
			inputSchema: {
				terminal_id: z.string().describe("The terminal, e.g. t1."),
				wait_for: z.string().optional().describe("Wait until the new output matches this regular expression."),
				timeout: z.number().positive().max(600).optional().describe("Most seconds to wait (default: do not wait, or 15 with wait_for)."),
				screen: z.boolean().optional().describe("Return the visible screen instead of the new output."),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		guarded(
			async (
				args: { terminal_id: string; wait_for?: string | undefined; timeout?: number | undefined; screen?: boolean | undefined },
				extra,
			) => {
				const terminal = terminals.get(args.terminal_id);
				const waitFor = args.wait_for === undefined ? undefined : new RegExp(args.wait_for, "m");
				let reason;
				if (waitFor !== undefined || args.timeout !== undefined) {
					reason = await terminal.settle({
						timeoutMs: (args.timeout ?? 15) * 1000,
						...(waitFor === undefined ? {} : { waitFor }),
						signal: extra.signal,
					});
				}
				return text(await terminal.render(terminal.host.outputLimits, args.screen ? "screen" : "new", reason));
			},
		),
	);

	server.registerTool(
		"terminal_close",
		{
			title: "Close a remote terminal",
			description: "Close a terminal, killing its shell and everything running in it.",
			inputSchema: { terminal_id: z.string().describe("The terminal, e.g. t1.") },
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		},
		guarded(async (args: { terminal_id: string }) => {
			const terminal = terminals.get(args.terminal_id);
			terminal.close();
			return text(`Closed terminal ${terminal.id} on ${terminal.host.name}.`);
		}),
	);

	const localNote = `Relative local paths are relative to ${process.cwd()}.`;

	server.registerTool(
		"upload",
		{
			title: "Copy files to a remote host",
			description: `Copy a file or directory from this machine (where the agent runs) to a remote host, like scp -r: into remote_path when it is an existing directory or ends with /, otherwise as remote_path. Directories are copied recursively; symbolic links inside them are skipped. A new file appears only once it is complete and keeps the local executable bit; an existing file (or link) is overwritten in place, keeping its permissions, as scp does. ${localNote}`,
			inputSchema: {
				local_path: z.string().describe("File or directory on this machine."),
				remote_path: z.string().describe("Destination on the remote host."),
				host,
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		},
		guarded(async (args: { local_path: string; remote_path: string; host?: string | undefined }, extra) => {
			const session = await manager.session(args.host);
			const report = progressReporter(extra);
			const result = await upload(session, args.local_path, args.remote_path, {
				signal: extra.signal,
				...(report === undefined ? {} : { onProgress: report }),
			});
			const skipped =
				result.skipped.length === 0 ? "" : `\nSkipped ${result.skipped.length} symbolic links or special files: ${result.skipped.slice(0, 10).join(", ")}`;
			return text(
				`Uploaded ${result.files} file${result.files === 1 ? "" : "s"} (${formatBytes(result.bytes)}) to ${session.name}:${result.destination} in ${formatDuration(result.durationMs)}.${skipped}`,
			);
		}),
	);

	server.registerTool(
		"download",
		{
			title: "Copy files from a remote host",
			description: `Copy a file or directory from a remote host to this machine (where the agent runs), like scp -r: into local_path when it is an existing directory or ends with /, otherwise as local_path. Directories are copied recursively, including git-ignored files; symbolic links inside them are skipped. ${localNote}`,
			inputSchema: {
				remote_path: z.string().describe("File or directory on the remote host."),
				local_path: z.string().describe("Destination on this machine."),
				host,
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		},
		guarded(async (args: { remote_path: string; local_path: string; host?: string | undefined }, extra) => {
			const session = await manager.session(args.host);
			const report = progressReporter(extra);
			const result = await download(session, args.remote_path, args.local_path, {
				signal: extra.signal,
				...(report === undefined ? {} : { onProgress: report }),
			});
			const skipped =
				result.skipped.length === 0
					? ""
					: `\nSkipped ${result.skipped.length} symbolic links, special files or names not usable here: ${result.skipped.slice(0, 10).join(", ")}`;
			return text(
				`Downloaded ${result.files} file${result.files === 1 ? "" : "s"} (${formatBytes(result.bytes)}) from ${session.name} to ${result.destination} in ${formatDuration(result.durationMs)}.${skipped}`,
			);
		}),
	);

	return { server, terminals };
}
