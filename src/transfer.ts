import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Context } from "@earendil-works/chord";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { contextFor, type HostSession } from "./session.ts";

/** Bytes per write request; frames are at most 16 MiB. */
const UPLOAD_CHUNK = 1024 * 1024;
/** Write requests in flight at once. */
const UPLOAD_DEPTH = 8;
/** Bytes per read call; the reader splits it into pipelined 256 KiB requests. */
const DOWNLOAD_CHUNK = 4 * 1024 * 1024;
/** Files copied at once within a directory. */
const FILE_CONCURRENCY = 4;
const MAX_FILES = 50_000;

/** Bytes copied so far, of `total` (0 when unknown). */
export interface TransferProgress {
	(done: number, total: number, message: string): void;
}

export interface TransferResult {
	/** What was copied, as an absolute path on its own machine (a link given as the source is named, not followed). */
	source: string;
	/** Where the copy ended up. */
	destination: string;
	files: number;
	directories: number;
	bytes: number;
	/** Entries left out: symbolic links, special files, and names that are not safe on this machine. */
	skipped: string[];
	durationMs: number;
}

/** A local path: `~` is this machine's home, relative paths are relative to the server's working directory. */
export function localPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(path);
}

/** A temporary name next to `path`, hidden, for writing before the rename or copy into place. */
function partName(path: string, separator: string): string {
	const slash = path.lastIndexOf(separator);
	return `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.pi-env-mcp-${randomBytes(4).toString("hex")}.part`;
}

/** Whether a remote file name can be used as one path component here: no traversal, no separators or drive letters. */
function safeLocalName(name: string): boolean {
	if (name === "" || name === "." || name === "..") return false;
	return process.platform === "win32" ? !/[\\/:*?"<>|\x00-\x1f]/.test(name) : !name.includes("/") && !name.includes("\0");
}

/** The local path of a remote entry `remoteRelative` (`/`-separated) below `root`, or undefined if it would escape it. */
export function localChild(root: string, remoteRelative: string): string | undefined {
	const parts = remoteRelative.split("/");
	if (!parts.every(safeLocalName)) return undefined;
	const local = join(root, ...parts);
	const inside = relative(root, local);
	return inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? undefined : local;
}

/** Run `work` over `items`, `limit` at a time, stopping at the first failure. */
async function forEachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	let failed = false;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (!failed && next < items.length) {
			const item = items[next++]!;
			try {
				await work(item);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	});
	await Promise.all(workers);
}

/** What a remote path names, following symbolic links as `cp` does: a directory, a file (or a dangling link), or nothing. */
async function remoteKind(session: HostSession, path: string, context: Context): Promise<"directory" | "file" | "missing"> {
	const info = await session.env.fileInfo(path, context);
	if (!info.ok) {
		if (info.error.code === "not_found") return "missing";
		throw info.error;
	}
	if (info.value.kind !== "symlink") return info.value.kind === "directory" ? "directory" : "file";
	const real = await session.env.canonicalPath(path, context);
	if (!real.ok) return "file";
	const target = await session.env.fileInfo(real.value, context);
	return target.ok && target.value.kind === "directory" ? "directory" : "file";
}

/**
 * Stream one local file to the host. The bytes go to a temporary file next to the target first, so a cancelled or
 * failed upload leaves the target as it was. A new target is then renamed into place; an existing one is overwritten
 * in place, as `scp` does, so its permissions, owner, hard links and symbolic links stay.
 */
async function uploadFile(
	session: HostSession,
	source: string,
	target: string,
	onBytes: (n: number) => void,
	signal?: AbortSignal,
): Promise<"created" | "replaced"> {
	const connection = session.connection;
	const kind = await remoteKind(session, target, contextFor(signal));
	if (kind === "directory") throw new Error(`${target} is a directory on ${session.name}`);
	const part = partName(target, session.paths.sep);
	let handle: { id: number; session: number } | undefined;
	const inFlight: Promise<unknown>[] = [];
	try {
		const stream = createReadStream(source, { highWaterMark: UPLOAD_CHUNK });
		let first = true;
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			if (signal?.aborted) throw signal.reason;
			if (first) {
				first = false;
				const reply = await connection.request("write", { path: part, append: false, keep: true }, { payload: chunk });
				handle = { id: reply.json.handle as number, session: reply.session };
			} else {
				const written = connection.request("writeChunk", { handle: handle!.id }, { payload: chunk, session: handle!.session });
				written.catch(() => {});
				inFlight.push(written);
				if (inFlight.length >= UPLOAD_DEPTH) await inFlight.shift();
			}
			onBytes(chunk.length);
		}
		if (first) await connection.request("write", { path: part, append: false }, { payload: new Uint8Array(0) });
		for (const written of inFlight.splice(0)) await written;
		if (handle !== undefined) await connection.request("close", { handle: handle.id }, { session: handle.session });
		handle = undefined;
		// From here on the upload is complete; finishing it is quick and not cancelled.
		if (kind === "missing" || !session.posix) {
			getOrThrow(await session.env.renameFile(part, target, contextFor()));
			return kind === "missing" ? "created" : "replaced";
		}
		const copied = await session.capture(["/bin/sh", "-c", 'cat -- "$1" > "$2" && rm -f -- "$1"', "pi-env-mcp-replace", part, target]);
		if (copied.exitCode !== 0) throw new Error(`Could not overwrite ${target}: ${copied.stderr.trim()}`);
		return "replaced";
	} catch (error) {
		await Promise.allSettled(inFlight);
		if (handle !== undefined) await connection.request("close", { handle: handle.id }, { session: handle.session }).catch(() => {});
		await session.env.remove(part, { force: true }, contextFor());
		throw error;
	}
}

/** Copy a local file or directory to the host, like `scp -r`. */
export async function upload(
	session: HostSession,
	localSource: string,
	remoteTarget: string,
	options: { signal?: AbortSignal; onProgress?: TransferProgress } = {},
): Promise<TransferResult> {
	const started = Date.now();
	const signal = options.signal;
	const context = contextFor(signal);
	const paths = session.paths;
	const source = localPath(localSource);
	const sourceStat = await stat(source).catch(() => {
		throw new Error(`Local path not found: ${source}`);
	});
	const target = await session.resolve(remoteTarget, signal);
	// Into the target when it is a directory (or a link to one), or is written as one (`dir/`); otherwise as the target.
	const intoTarget = (await remoteKind(session, target, context)) === "directory" || /[\\/]$/.test(remoteTarget);
	const destination = intoTarget ? paths.join(target, basename(source)) : target;

	const files: { local: string; remote: string; size: number; executable: boolean }[] = [];
	const directories: string[] = [];
	const skipped: string[] = [];
	if (sourceStat.isFile()) {
		files.push({ local: source, remote: destination, size: sourceStat.size, executable: (sourceStat.mode & 0o111) !== 0 });
	} else if (sourceStat.isDirectory()) {
		directories.push(destination);
		const walk = async (dir: string) => {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				const remote = paths.join(destination, ...relative(source, path).split(sep));
				if (entry.isDirectory()) {
					directories.push(remote);
					await walk(path);
				} else if (entry.isFile()) {
					const info = await lstat(path);
					files.push({ local: path, remote, size: info.size, executable: (info.mode & 0o111) !== 0 });
					if (files.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} files; archive the directory first (tar) and upload one file`);
				} else {
					skipped.push(relative(source, path));
				}
			}
		};
		await walk(source);
	} else {
		throw new Error(`${source} is neither a file nor a directory`);
	}

	const total = files.reduce((sum, file) => sum + file.size, 0);
	let done = 0;
	const report = (n: number) => {
		done += n;
		options.onProgress?.(done, total, `uploading to ${session.name}`);
	};
	for (const directory of directories) getOrThrow(await session.env.createDir(directory, { recursive: true }, context));
	// New files get the local executable bit; files that existed keep their own permissions, as with scp.
	const executables: string[] = [];
	await forEachLimited(files, FILE_CONCURRENCY, async (file) => {
		const outcome = await uploadFile(session, file.local, file.remote, report, signal);
		if (outcome === "created" && file.executable) executables.push(file.remote);
	});
	for (let index = 0; session.posix && index < executables.length; index += 200) {
		await session.capture(["chmod", "+x", "--", ...executables.slice(index, index + 200)]);
	}
	return { source, destination, files: files.length, directories: directories.length, bytes: total, skipped, durationMs: Date.now() - started };
}

/**
 * Stream one remote file to this machine, through a temporary file next to the target. A new target is renamed into
 * place; an existing file, or a link, is overwritten in place, keeping its permissions and links.
 */
async function downloadFile(session: HostSession, source: string, target: string, onBytes: (n: number) => void, signal?: AbortSignal) {
	const context = contextFor(signal);
	const link = await lstat(target).catch(() => undefined);
	const existing = link?.isSymbolicLink() ? await stat(target).catch(() => undefined) : link;
	if (existing?.isDirectory()) throw new Error(`${target} is a directory`);
	const reader = getOrThrow(await session.env.openBinaryReader(source, undefined, context));
	const part = partName(target, sep);
	try {
		await mkdir(dirname(target), { recursive: true });
		const size = getOrThrow(await reader.info(context)).size;
		const file = await open(part, "w");
		try {
			for (let offset = 0; offset < size; ) {
				const bytes = getOrThrow(await reader.read(offset, Math.min(DOWNLOAD_CHUNK, size - offset), context));
				if (bytes.length === 0) break;
				await file.write(bytes, 0, bytes.length, offset);
				offset += bytes.length;
				onBytes(bytes.length);
			}
		} finally {
			await file.close();
		}
		if (link === undefined) {
			await rename(part, target);
		} else {
			await pipeline(createReadStream(part), createWriteStream(target));
			await rm(part, { force: true });
		}
	} catch (error) {
		await rm(part, { force: true }).catch(() => {});
		throw error;
	} finally {
		await reader.close(context);
	}
}

/** Copy a remote file or directory to this machine, like `scp -r`. */
export async function download(
	session: HostSession,
	remoteSource: string,
	localTarget: string,
	options: { signal?: AbortSignal; onProgress?: TransferProgress } = {},
): Promise<TransferResult> {
	const started = Date.now();
	const signal = options.signal;
	const context = contextFor(signal);
	const paths = session.paths;
	const resolved = await session.resolve(remoteSource, signal);
	let source = resolved;
	let info = getOrThrow(await session.env.fileInfo(source, context));
	if (info.kind === "symlink") {
		// Follow a link given explicitly, as `scp` does.
		source = getOrThrow(await session.env.canonicalPath(source, context));
		info = getOrThrow(await session.env.fileInfo(source, context));
	}
	const target = localPath(localTarget);
	const targetStat = await stat(target).catch(() => undefined);
	const intoTarget = targetStat?.isDirectory() === true || /[\\/]$/.test(localTarget);
	let destination = target;
	if (intoTarget) {
		const name = paths.basename(source);
		if (!safeLocalName(name)) throw new Error(`The remote name ${JSON.stringify(name)} is not a safe local file name; give local_path as the full file path`);
		destination = join(target, name);
	}

	const files: { remote: string; local: string }[] = [];
	const directories: string[] = [];
	const skipped: string[] = [];
	if (info.kind === "file") {
		files.push({ remote: source, local: destination });
	} else if (info.kind === "directory") {
		directories.push(destination);
		const listing = getOrThrow(
			await session.env.listFiles(source, { hidden: true, gitignore: false, maxEntries: MAX_FILES, timeoutMs: 120_000 }, context),
		);
		if (listing.truncated) throw new Error(`More than ${MAX_FILES} entries under ${source}; archive it first (tar) and download one file`);
		for (const entry of listing.entries) {
			const local = localChild(destination, entry.path);
			if (local === undefined || (entry.kind !== "directory" && entry.kind !== "file")) {
				skipped.push(entry.path);
				continue;
			}
			if (entry.kind === "directory") directories.push(local);
			else files.push({ remote: paths.join(source, ...entry.path.split("/")), local });
		}
	} else {
		throw new Error(`${source} is neither a file nor a directory`);
	}

	let done = 0;
	for (const directory of directories) await mkdir(directory, { recursive: true });
	await forEachLimited(files, FILE_CONCURRENCY, async (file) => {
		await downloadFile(
			session,
			file.remote,
			file.local,
			(n) => {
				done += n;
				// The total is unknown: a listing has no sizes.
				options.onProgress?.(done, 0, `downloading from ${session.name}`);
			},
			signal,
		);
	});
	return {
		source: resolved,
		destination,
		files: files.length,
		directories: directories.length,
		bytes: done,
		skipped,
		durationMs: Date.now() - started,
	};
}
