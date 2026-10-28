import { getOrThrow } from "@earendil-works/pi-durable/env";
import picomatch from "picomatch";
import { contextFor, type HostSession } from "./session.ts";

/** Entries `glob` lets the daemon list before it gives up on a tree. */
const LIST_MAX_ENTRIES = 200_000;
const LIST_TIMEOUT_MS = 30_000;

export interface GlobOptions {
	path?: string;
	includeIgnored?: boolean;
	limit: number;
	signal?: AbortSignal;
}

/**
 * Paths matching a glob pattern, from the daemon's listing (no shell, honoring .gitignore in work trees). Only the
 * pattern's static prefix is listed: `src/**\/*.ts` walks `src`, not the whole tree.
 */
export async function glob(session: HostSession, pattern: string, options: GlobOptions): Promise<string> {
	const context = contextFor(options.signal);
	const paths = session.paths;
	// An absolute pattern brings its own base; listing entries always use `/`.
	const base = paths.isAbsolute(pattern) ? paths.parse(paths.resolve(pattern)).root : await session.resolve(options.path ?? ".", options.signal);
	const scan = picomatch.scan(pattern);
	if (!scan.isGlob) {
		const path = paths.resolve(base, pattern);
		const info = await session.env.fileInfo(path, context);
		return info.ok ? `${path}${info.value.kind === "directory" ? "/" : ""}` : `No match: ${path} does not exist.`;
	}
	const root = paths.resolve(base, scan.base || ".");
	const listed = await session.env.listFiles(
		root,
		{
			hidden: true,
			gitignore: options.includeIgnored !== true,
			maxEntries: LIST_MAX_ENTRIES,
			timeoutMs: LIST_TIMEOUT_MS,
		},
		context,
	);
	if (!listed.ok) {
		if (listed.error.code === "not_found") return `No match: ${root} does not exist.`;
		if (listed.error.code === "not_directory") return `No match: ${root} is not a directory.`;
		throw listed.error;
	}
	const matches = picomatch(scan.glob, { dot: true });
	const found = listed.value.entries.filter((entry) => matches(entry.path));
	const lines = found
		.slice(0, options.limit)
		.map((entry) => `${paths.join(root, ...entry.path.split("/"))}${entry.kind === "directory" ? "/" : ""}`);
	const notes: string[] = [];
	if (found.length > options.limit) notes.push(`[${found.length - options.limit} more matches not shown; narrow the pattern or raise limit]`);
	if (listed.value.truncated) {
		notes.push(`[the listing of ${root} stopped early (too many entries or too slow); matches may be missing: use a narrower path]`);
	}
	if (found.length === 0) return [`No files match ${pattern} under ${root}.`, ...notes].join("\n");
	const header = `${found.length} match${found.length === 1 ? "" : "es"} under ${root}${options.includeIgnored ? "" : " (git-ignored paths skipped)"}:`;
	return [header, ...lines, ...notes].join("\n");
}

export type GrepMode = "files_with_matches" | "content" | "count";

export interface GrepOptions {
	pattern: string;
	path?: string;
	glob?: string;
	type?: string;
	mode: GrepMode;
	caseInsensitive?: boolean;
	context?: number;
	multiline?: boolean;
	headLimit: number;
	signal?: AbortSignal;
}

function ripgrepArgs(options: GrepOptions, target: string): string[] {
	const args = ["rg", "--color=never", "--no-heading", "--with-filename", "--hidden", "--glob", "!.git", "--max-columns", "500", "--max-columns-preview"];
	if (options.caseInsensitive) args.push("-i");
	if (options.multiline) args.push("-U", "--multiline-dotall");
	if (options.glob) args.push("--glob", options.glob);
	if (options.type) args.push("--type", options.type);
	if (options.mode === "files_with_matches") args.push("-l");
	else if (options.mode === "count") args.push("-c");
	else {
		args.push("-n");
		if (options.context) args.push("-C", String(options.context));
	}
	args.push("-e", options.pattern, "--", target);
	return args;
}

function grepArgs(options: GrepOptions, target: string): string[] {
	if (options.type) throw new Error("type needs ripgrep, which is not installed on this host; use glob instead");
	if (options.multiline) throw new Error("multiline needs ripgrep, which is not installed on this host");
	const args = ["grep", "-r", "-I", "-E", "-H", "--color=never", "--exclude-dir=.git"];
	if (options.caseInsensitive) args.push("-i");
	if (options.glob) args.push(`--include=${options.glob}`);
	if (options.mode === "files_with_matches") args.push("-l");
	else if (options.mode === "count") args.push("-c");
	else {
		args.push("-n");
		if (options.context) args.push(`-C${options.context}`);
	}
	args.push("-e", options.pattern, "--", target);
	return args;
}

/** Search file contents on the host with ripgrep, or grep -E without it. */
export async function grep(session: HostSession, options: GrepOptions): Promise<string> {
	const target = await session.resolve(options.path ?? ".", options.signal);
	const ripgrep = await session.hasRipgrep();
	const argv = ripgrep ? ripgrepArgs(options, target) : grepArgs(options, target);
	const limits = session.outputLimits;
	const stop = new AbortController();
	const onCallerAbort = () => stop.abort();
	options.signal?.addEventListener("abort", onCallerAbort, { once: true });
	let stdout = "";
	let stderr = "";
	let lines = 0;
	let truncated = false;
	try {
		const result = await session.env.exec(
			argv,
			{
				// The target is absolute; the working directory may have been deleted, which the daemon would refuse.
				cwd: session.info.home,
				timeout: 120,
				onOutput: (text, _context, info) => {
					if (info.stream === "stderr") {
						if (stderr.length < 4000) stderr += text;
						return;
					}
					if (truncated) return;
					stdout += text;
					for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines++;
					if (lines > options.headLimit || Buffer.byteLength(stdout, "utf8") > limits.maxBytes) {
						// Enough: stop the search instead of transferring results nobody reads.
						truncated = true;
						stop.abort();
					}
				},
			},
			contextFor(stop.signal),
		);
		if (options.signal?.aborted) throw options.signal.reason;
		let found = stdout.split("\n").filter((line) => line !== "");
		if (!ripgrep && options.mode === "count") found = found.filter((line) => !line.endsWith(":0"));
		if (truncated) found = found.slice(0, options.headLimit);
		let output = found.join("\n");
		while (Buffer.byteLength(output, "utf8") > limits.maxBytes) {
			found.pop();
			output = found.join("\n");
			truncated = true;
		}
		const exitCode = result.ok ? result.value.exitCode : undefined;
		if (!result.ok && !truncated) throw result.error;
		const tool = ripgrep ? "ripgrep" : "grep";
		const problems = stderr.trim() === "" ? "" : `\n[${tool} reported: ${stderr.trim().split("\n").slice(0, 5).join(" | ")}]`;
		if (found.length === 0) {
			if (exitCode !== undefined && exitCode > 1) throw new Error(`${tool} failed (exit code ${exitCode}): ${stderr.trim()}`);
			return `No matches for ${JSON.stringify(options.pattern)} in ${target}.${problems}`;
		}
		const note = truncated ? `\n[results cut at ${found.length} lines; narrow the search, or raise head_limit]` : "";
		return `${output}${note}${problems}`;
	} finally {
		options.signal?.removeEventListener("abort", onCallerAbort);
	}
}
