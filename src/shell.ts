import { OutputBuffer } from "@earendil-works/chord/output";
import { RenderedOutput } from "./lib/text.ts";
import { shellQuote } from "./lib/util.ts";
import { contextFor, type HostSession } from "./session.ts";

/**
 * `cd`, `pushd`, `popd`, `source` or `.` where a command starts: at the start of a line, after `;`, `&`, `|`, `(`, `{`,
 * `!`, a backquote or `$(`, or after a keyword such as `then` or `do`. Only such commands get the trailer that reports
 * the final working directory, so ordinary ones (including `find .` or `du -sh .`) cost a single round trip. A false
 * positive only costs a little time.
 */
export const CHANGES_DIRECTORY =
	/(?:^|[;&|({`!]|\$\(|\b(?:then|do|else|elif|time|builtin|command)\b)\s*(?:cd|pushd|popd|source|\.)(?=\s|$|[;&|)])/m;

/** Daemon output pacing, as Durable's harness uses it: coalesce for 100 ms, at about 100 KiB/s. */
const WINDOW_INTERVAL_MS = 100;
const WINDOW_BYTES_PER_SECOND = 100 * 1024;

export interface ShellResult {
	/** The command's exit status; undefined when it did not finish (`failure`). */
	exitCode: number | undefined;
	/** Why the command did not finish: `timeout`, `aborted`, `lost` (connection), or another pi-env code. */
	failure?: { code: string; message: string };
	/** The retained end of stdout and stderr, in arrival order, as a terminal would show it. */
	output: string;
	droppedLines: number;
	droppedBytes: number;
	/** The complete output on the remote host, when it exceeded the limits. */
	spillPath?: string;
	/** The working directory after the command, when it changed. */
	newCwd?: string;
	/** The directory the command ran in. */
	ranIn: string;
	/** Set when the persistent working directory had disappeared and was reset. */
	cwdReset?: string;
	durationMs: number;
}

export interface ShellOptions {
	/** Directory to start in; default the session's working directory. */
	cwd?: string;
	timeoutSeconds: number;
	signal?: AbortSignal;
	/** Receives each chunk of output as it arrives, for progress reports. */
	onOutput?: (text: string) => void;
}

function isLost(message: string): boolean {
	return /connection (lost|timed out|closed)|exited with code .* before it was ready|did not answer within/i.test(message);
}

/** The daemon's refusal to start a command in a directory that does not exist. */
function isMissingDirectory(message: string): boolean {
	return message.startsWith("Working directory does not exist");
}

/** Run one shell command on the host, keeping the end of its output within the session's limits. */
export async function runShell(session: HostSession, command: string, options: ShellOptions): Promise<ShellResult> {
	const started = Date.now();
	const limits = session.outputLimits;
	const ranIn = options.cwd === undefined ? session.cwd : await session.resolve(options.cwd, options.signal);
	// Tracking the directory is a convenience: if its bookkeeping fails, the command still runs.
	const tracking =
		session.posix && CHANGES_DIRECTORY.test(command) ? await session.nextCwdFile().catch(() => undefined) : undefined;
	// The trailer keeps the command's exit status; `exit`, `exec` or `set -e` in the command skip it, which only means
	// the working directory is not updated. `set -C` refuses to write through anything planted at the file's name.
	const script =
		tracking === undefined
			? command
			: `${command}\n__pi_env_mcp_status=$?\n{ set -C; pwd > ${shellQuote(tracking.file)}; } 2>/dev/null\nexit $__pi_env_mcp_status`;

	const execute = async (cwd: string) => {
		const buffer = new OutputBuffer({ ...limits, retain: "tail" });
		const rendered = new RenderedOutput(buffer, limits.maxBytes);
		const result = await session.env.exec(
			script,
			{
				cwd,
				// With PWD naming the start directory, bash keeps logical paths: symbolic links stay as they were typed.
				env: { PWD: cwd },
				timeout: options.timeoutSeconds,
				onOutput: (text, _context, info) => {
					rendered.push(text, info.skipped);
					options.onOutput?.(text);
				},
				spill: { afterBytes: limits.maxBytes, afterLines: limits.maxLines },
				window: {
					maxBytes: limits.maxBytes,
					maxLines: limits.maxLines,
					minIntervalMs: WINDOW_INTERVAL_MS,
					bytesPerSecond: WINDOW_BYTES_PER_SECOND,
				},
			},
			contextFor(options.signal),
		);
		rendered.end();
		return { result, snapshot: buffer.snapshot() };
	};

	let cwd = ranIn;
	let cwdReset: string | undefined;
	let { result, snapshot } = await execute(cwd);
	if (
		!result.ok &&
		result.error.code === "spawn_error" &&
		isMissingDirectory(result.error.message) &&
		options.cwd === undefined &&
		cwd !== session.baseCwd
	) {
		// The persistent working directory was removed meanwhile: fall back to the base directory once.
		cwdReset = cwd;
		cwd = session.baseCwd;
		session.cwd = cwd;
		({ result, snapshot } = await execute(cwd));
	}

	// Only a command that ran to its end can have reported a directory; after a failure, asking the host again would
	// only wait on a connection that is probably gone.
	let newCwd: string | undefined;
	if (tracking !== undefined && result.ok) {
		const context = contextFor(options.signal);
		const reported = await session.env.readTextFile(tracking.file, context);
		if (reported.ok) {
			// Only a directory change made by the command persists; a one-off `cwd` argument does not.
			const directory = reported.value.trim();
			if (directory !== "" && directory !== cwd) {
				session.cwd = directory;
				newCwd = directory;
			}
			void session.env.remove(tracking.file, { force: true }, contextFor());
		} else if (reported.error.code === "not_found") {
			// The command ended early (`exit`, `exec`), or the directory is gone, e.g. a reboot cleared /tmp.
			const directory = await session.env.fileInfo(tracking.dir, context);
			if (!directory.ok && directory.error.code === "not_found") session.forgetTempDir(tracking.dir);
		}
	}

	const base = {
		output: snapshot.text,
		droppedLines: snapshot.droppedLines,
		droppedBytes: snapshot.droppedBytes,
		ranIn: cwd,
		durationMs: Date.now() - started,
		...(newCwd === undefined ? {} : { newCwd }),
		...(cwdReset === undefined ? {} : { cwdReset }),
	};
	if (result.ok) {
		return {
			...base,
			exitCode: result.value.exitCode,
			...(result.value.spillPath === undefined ? {} : { spillPath: result.value.spillPath }),
		};
	}
	const error = result.error;
	const code = error.code === "unknown" && isLost(error.message) ? "lost" : error.code;
	return {
		...base,
		exitCode: undefined,
		failure: { code, message: error.message },
		...(error.spillPath === undefined ? {} : { spillPath: error.spillPath }),
	};
}
