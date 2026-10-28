import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { sanitizeOutput } from "@earendil-works/chord/output";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { Limits } from "./config.ts";
import { completeUtf8, headLinesEnd, renderText, tailLinesStart } from "./lib/text.ts";
import { contextFor, type HostSession } from "./session.ts";

/**
 * Background jobs: commands detached from the daemon into their own process group (a new session where `setsid -f`
 * exists), so they keep running when the connection drops or this server stops. Their state lives on the remote host,
 * under `~/.local/state/pi-env-mcp/jobs/<hostname>/<id>/`: the command, a runner script, `pid` ("pid start-epoch"),
 * `output.log` (stdout and stderr), `exit` ("code end-epoch") once it ends, and `killed` naming a signal sent to it.
 * The host name in the path keeps machines that share a home directory apart.
 */

const JOBS_DIR = ".local/state/pi-env-mcp/jobs";
const JOB_ID = /^job-[0-9a-f]{6,16}$/;

/**
 * Runs the job: records its pid, runs the command with output to the log, records the exit status. `trap 'true'` lets
 * the runner outlive TERM and INT long enough to record how the command ended; the command itself gets default
 * handling. HUP is ignored, as `nohup` does.
 */
const RUNNER = `d=$1
trap '' HUP
trap 'true' INT TERM
echo "$$ $(date +%s)" > "$d/pid"
if command -v bash >/dev/null 2>&1; then s=bash; else s=sh; fi
"$s" "$d/command" > "$d/output.log" 2>&1 < /dev/null
c=$?
echo "$c $(date +%s)" > "$d/exit.tmp" && mv -f "$d/exit.tmp" "$d/exit"
`;

/**
 * Starts the runner outside the daemon's process group and waits briefly for its pid. `setsid -f` gives a new
 * session; otherwise bash's job control gives a new process group. A plain `sh` background start would do neither:
 * the job would ignore SIGINT and could not be signalled as a group, so such hosts get no jobs.
 */
const LAUNCHER = `d=$1
if command -v setsid >/dev/null 2>&1 && setsid --help 2>&1 | grep -q -- --fork; then
  setsid -f /bin/sh "$d/run.sh" "$d" </dev/null >/dev/null 2>&1
elif command -v bash >/dev/null 2>&1; then
  bash -c 'set -m; /bin/sh "$1/run.sh" "$1" </dev/null >/dev/null 2>&1 &' launcher "$d"
else
  echo "background jobs need setsid with --fork (util-linux) or bash on this host" >&2
  exit 3
fi
i=0
while [ ! -s "$d/pid" ] && [ "$i" -lt 100 ]; do sleep 0.05 2>/dev/null || sleep 1; i=$((i+1)); done
cat "$d/pid" 2>/dev/null
`;

/** One tab-separated line per job directory: dir, pid, start, exit code, end, alive, log size, killed-with, meta. */
const STATUS = `for d in "$@"; do
  [ -d "$d" ] || continue
  pid=; started=; code=; ended=; alive=0
  [ -s "$d/pid" ] && read pid started < "$d/pid"
  [ -s "$d/exit" ] && read code ended < "$d/exit"
  if [ -n "$pid" ] && [ -z "$code" ] && kill -0 "$pid" 2>/dev/null; then
    args=$(ps -o args= -p "$pid" 2>/dev/null) || args="$d"
    case "$args" in *"$d"*) alive=1 ;; esac
  fi
  size=$(wc -c < "$d/output.log" 2>/dev/null | tr -d ' ')
  killed=$(cat "$d/killed" 2>/dev/null)
  meta=$(tr -d '\\n' < "$d/meta.json" 2>/dev/null)
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$d" "$pid" "$started" "$code" "$ended" "$alive" "\${size:-0}" "$killed" "$meta"
done
`;

const LIST = `r=$1
set -- "$r"/job-*
[ -e "$1" ] || exit 0
${STATUS}`;

export type JobState = "starting" | "running" | "exited" | "killed" | "lost";

/** A job without a pid this long after it was created never started. */
const START_GRACE_MS = 60_000;

export interface Job {
	id: string;
	dir: string;
	logPath: string;
	command: string;
	cwd: string;
	state: JobState;
	pid?: number;
	/** Epoch seconds, remote clock. */
	startedAt?: number;
	endedAt?: number;
	exitCode?: number;
	/** The signal job_kill sent, if any. */
	killedWith?: string;
	logSize: number;
}

export interface JobOutput {
	text: string;
	/** Byte range of the log the text covers. */
	from: number;
	to: number;
	size: number;
	/** Earlier output that is not shown. */
	omittedBefore: number;
}

function number(text: string | undefined): number | undefined {
	if (text === undefined || text === "") return undefined;
	const value = Number(text);
	return Number.isFinite(value) ? value : undefined;
}

export function parseStatus(line: string): Job | undefined {
	const [dir, pid, started, code, ended, alive, size, killed, meta] = line.split("\t");
	if (dir === undefined || dir === "") return undefined;
	let info: { command?: string; cwd?: string; createdAt?: string } = {};
	try {
		info = JSON.parse(meta ?? "{}") as typeof info;
	} catch {
		// A job whose metadata is unreadable is still listed.
	}
	const exitCode = number(code);
	const killedWith = killed === undefined || killed === "" ? undefined : killed;
	let state: JobState;
	const created = info.createdAt === undefined ? Number.NaN : Date.parse(info.createdAt);
	if (exitCode !== undefined) state = "exited";
	else if (alive === "1") state = "running";
	else if ((pid === undefined || pid === "") && !(Date.now() - created > START_GRACE_MS)) state = "starting";
	else state = killedWith !== undefined ? "killed" : "lost";
	const job: Job = {
		id: posix.basename(dir),
		dir,
		logPath: `${dir}/output.log`,
		command: info.command ?? "",
		cwd: info.cwd ?? "",
		state,
		logSize: number(size) ?? 0,
	};
	const fields = { pid: number(pid), startedAt: number(started), endedAt: number(ended), exitCode };
	for (const [key, value] of Object.entries(fields)) if (value !== undefined) (job as unknown as Record<string, number>)[key] = value;
	if (killedWith !== undefined) job.killedWith = killedWith;
	return job;
}

export const JOB_SIGNALS = ["TERM", "INT", "KILL", "HUP", "QUIT", "USR1", "USR2"] as const;
export type JobSignal = (typeof JOB_SIGNALS)[number];

export class JobStore {
	readonly #session: HostSession;

	constructor(session: HostSession) {
		this.#session = session;
	}

	/** Where this machine's jobs live. */
	root(): string {
		const hostname = this.#session.hostname.replace(/[^A-Za-z0-9._-]/g, "_") || this.#session.name;
		return posix.join(this.#session.info.home, JOBS_DIR, hostname);
	}

	#requirePosix(): void {
		if (!this.#session.posix) throw new Error("Background jobs need a POSIX shell on the remote host");
	}

	async start(command: string, cwd: string, signal?: AbortSignal): Promise<Job> {
		this.#requirePosix();
		const env = this.#session.env;
		const context = contextFor(signal);
		const root = this.root();
		getOrThrow(await env.createDir(root, { recursive: true }, context));
		let id = "";
		let dir = "";
		for (let attempt = 0; ; attempt++) {
			id = `job-${randomBytes(4).toString("hex")}`;
			dir = posix.join(root, id);
			const created = await env.createDir(dir, { recursive: false }, context);
			if (created.ok) break;
			if (attempt >= 4) throw created.error;
		}
		getOrThrow(await env.writeFile(`${dir}/command`, `${command}\n`, context));
		getOrThrow(await env.writeFile(`${dir}/run.sh`, RUNNER, context));
		getOrThrow(
			await env.writeFile(
				`${dir}/meta.json`,
				`${JSON.stringify({ id, command, cwd, host: this.#session.name, createdAt: new Date().toISOString() })}\n`,
				context,
			),
		);
		let launched: Awaited<ReturnType<HostSession["capture"]>>;
		try {
			// Not cancelled midway: a launch that already started must report its job.
			launched = await this.#session.capture(["/bin/sh", "-c", LAUNCHER, "pi-env-mcp-launcher", dir], { cwd });
		} catch (error) {
			await env.remove(dir, { recursive: true, force: true }, contextFor());
			throw error;
		}
		if (launched.exitCode !== 0) {
			await env.remove(dir, { recursive: true, force: true }, contextFor());
			throw new Error(`The job did not start: ${(launched.stderr || launched.stdout).trim() || `exit code ${launched.exitCode}`}`);
		}
		// Without a pid yet the runner is merely slow to start (a loaded host, a slow home directory): it is "starting".
		return this.get(id);
	}

	async #status(script: string, args: string[]): Promise<Job[]> {
		const result = await this.#session.capture(["/bin/sh", "-c", script, "pi-env-mcp-status", ...args]);
		return result.stdout
			.split("\n")
			.map(parseStatus)
			.filter((job): job is Job => job !== undefined);
	}

	async list(): Promise<Job[]> {
		this.#requirePosix();
		const jobs = await this.#status(LIST, [this.root()]);
		return jobs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
	}

	async get(id: string): Promise<Job> {
		this.#requirePosix();
		if (!JOB_ID.test(id)) throw new Error(`Invalid job id "${id}"; job ids look like job-1a2b3c4d`);
		const [job] = await this.#status(STATUS, [posix.join(this.root(), id)]);
		if (job === undefined) throw new Error(`No job "${id}" on ${this.#session.name}; job_status without job_id lists them`);
		return job;
	}

	/**
	 * Output of the job: from byte `offset` on (at most `limits.maxBytes`, ending at a line break when it can), or
	 * without an offset the last `limits` worth of it.
	 */
	async output(job: Job, limits: Limits, offset?: number, signal?: AbortSignal): Promise<JobOutput> {
		const env = this.#session.env;
		const context = contextFor(signal);
		const opened = await env.openBinaryReader(job.logPath, undefined, context);
		if (!opened.ok) {
			if (opened.error.code === "not_found") return { text: "", from: 0, to: 0, size: 0, omittedBefore: 0 };
			throw opened.error;
		}
		const reader = opened.value;
		const show = (bytes: Uint8Array) => sanitizeOutput(renderText(new TextDecoder().decode(bytes)));
		try {
			const size = getOrThrow(await reader.info(context)).size;
			if (offset !== undefined) {
				// Forward from `offset`: whole lines within the limits, so the next read starts at a line.
				const from = Math.min(Math.max(0, Math.floor(offset)), size);
				let bytes = getOrThrow(await reader.read(from, Math.min(size - from, limits.maxBytes), context));
				bytes = bytes.subarray(0, headLinesEnd(bytes, limits.maxLines));
				if (from + bytes.length < size) {
					const newline = bytes.lastIndexOf(0x0a);
					// A line longer than the limit is cut at a character boundary and continues next time.
					bytes = bytes.subarray(0, newline >= 0 ? newline + 1 : completeUtf8(bytes));
				}
				return { text: show(bytes), from, to: from + bytes.length, size, omittedBefore: from };
			}
			// The end: the last whole lines within the limits.
			const start = Math.max(0, size - limits.maxBytes);
			let bytes = getOrThrow(await reader.read(start, size - start, context));
			let skip = 0;
			if (start > 0) {
				const newline = bytes.indexOf(0x0a);
				if (newline >= 0 && newline + 1 < bytes.length) skip = newline + 1;
				else while (skip < bytes.length && (bytes[skip]! & 0xc0) === 0x80) skip++;
			}
			bytes = bytes.subarray(skip);
			const lines = tailLinesStart(bytes, limits.maxLines);
			const from = start + skip + lines;
			return { text: show(bytes.subarray(lines)), from, to: size, size, omittedBefore: from };
		} finally {
			await reader.close(context);
		}
	}

	/** Signal the job's whole process group, recording the signal so its state reads as killed. */
	async kill(job: Job, signal: JobSignal): Promise<void> {
		if (job.pid === undefined) throw new Error(`Job ${job.id} has no process yet`);
		const script = `echo "$3" > "$1/killed"; kill -s "$3" -- "-$2" 2>/dev/null || kill -s "$3" "$2"`;
		const result = await this.#session.capture(["/bin/sh", "-c", script, "pi-env-mcp-kill", job.dir, String(job.pid), signal]);
		if (result.exitCode !== 0) throw new Error(`Sending SIG${signal} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
	}

	async remove(job: Job): Promise<void> {
		getOrThrow(await this.#session.env.remove(job.dir, { recursive: true, force: true }, contextFor()));
	}
}
