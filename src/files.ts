import { getOrThrow } from "@earendil-works/pi-durable/env";
import { applyEdit, EditError, snippet } from "./lib/edit.ts";
import { formatBytes, numberLine } from "./lib/util.ts";
import { contextFor, type HostSession } from "./session.ts";

/** Longest line `read` shows in full. */
const MAX_LINE_CHARS = 2000;
/** Largest image `read` returns; larger ones exceed what models accept. */
const MAX_IMAGE_BYTES = 3_750_000;
/** Largest file `edit` rewrites. */
const MAX_EDIT_BYTES = 16 * 1024 * 1024;
/**
 * Writes run to completion even when the call is cancelled: pi-env truncates the file first and checks for an abort
 * before each further 512 KiB, so a cancelled write of a larger file would leave only its beginning.
 */
const UNINTERRUPTED = contextFor();

export type ReadResult = { kind: "text"; text: string } | { kind: "image"; data: string; mimeType: string; text: string };

/** Image formats models accept, by their first bytes. */
function imageType(head: Uint8Array): string | undefined {
	const starts = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (starts(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
		return "image/webp";
	}
	return undefined;
}

/**
 * Read lines `[offset, offset + limit)` of a text file (1-based), numbered like `cat -n`, or an image. Only the selected
 * lines travel: the daemon finds their byte range in one pass over the file.
 */
export async function readFile(
	session: HostSession,
	filePath: string,
	options: { offset?: number; limit?: number; signal?: AbortSignal },
): Promise<ReadResult> {
	const context = contextFor(options.signal);
	const path = await session.resolve(filePath, options.signal);
	const reader = getOrThrow(await session.env.openBinaryReader(path, undefined, context));
	try {
		const size = getOrThrow(await reader.info(context)).size;
		if (size === 0) return { kind: "text", text: `(${path} is empty)` };
		const head = getOrThrow(await reader.read(0, Math.min(size, 16), context));
		const mimeType = imageType(head);
		if (mimeType !== undefined) {
			if (size > MAX_IMAGE_BYTES) {
				throw new Error(
					`${path} is a ${formatBytes(size)} image, larger than the ${formatBytes(MAX_IMAGE_BYTES)} a model accepts. Make a smaller copy on the host (e.g. with ImageMagick or Python) and read that, or download it.`,
				);
			}
			const bytes = getOrThrow(await reader.read(0, size, context));
			return { kind: "image", data: Buffer.from(bytes).toString("base64"), mimeType, text: `${path} (${mimeType}, ${formatBytes(size)})` };
		}

		const limits = session.readLimits;
		const startLine = options.offset === undefined ? 0 : Math.max(1, Math.floor(options.offset)) - 1;
		const maxLines = options.limit === undefined ? limits.maxLines : Math.max(1, Math.floor(options.limit));
		const scan = getOrThrow(await reader.scanLines({ startLine, endLine: startLine + maxLines }, context));
		const endsWithNewline = getOrThrow(await reader.read(size - 1, 1, context))[0] === 0x0a;
		const totalLines = scan.newlines + (endsWithNewline ? 0 : 1);
		if (startLine >= totalLines) {
			throw new Error(`offset ${startLine + 1} is past the end of ${path}, which has ${totalLines} line${totalLines === 1 ? "" : "s"}`);
		}
		// Lines are cut at MAX_LINE_CHARS, so a little more than the byte limit is all that can be shown.
		const wanted = scan.end - scan.start;
		const cap = Math.min(wanted, limits.maxBytes * 2 + MAX_LINE_CHARS * 4);
		const bytes = getOrThrow(await reader.read(scan.start, cap, context));
		if (bytes.subarray(0, 8192).includes(0) || (scan.start === 0 && head.subarray(0, 8).includes(0))) {
			throw new Error(`${path} is a binary file (${formatBytes(size)}). Use bash (file, xxd, strings) to inspect it, or download it.`);
		}
		let text = new TextDecoder("utf-8", { ignoreBOM: scan.start !== 0 }).decode(bytes);
		const lines = text.split("\n");
		// A final newline ends the last line rather than starting one.
		if (lines.length > 1 && lines.at(-1) === "") lines.pop();
		// When the read was capped, its last line is incomplete; drop it unless it is the only one.
		const complete = bytes.length === wanted;
		if (!complete && lines.length > 1) lines.pop();

		const out: string[] = [];
		let outBytes = 0;
		let shown = 0;
		for (const [index, raw] of lines.entries()) {
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			const cut = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated: ${line.length}+ characters]` : line;
			const numbered = numberLine(startLine + index + 1, cut);
			const lineBytes = Buffer.byteLength(numbered, "utf8") + 1;
			if (shown > 0 && outBytes + lineBytes > limits.maxBytes) break;
			out.push(numbered);
			outBytes += lineBytes;
			shown++;
		}
		const lastShown = startLine + shown;
		text = out.join("\n");
		if (lastShown < totalLines) {
			const limited = shown < lines.length || !complete;
			const reason = limited ? `output limit of ${formatBytes(limits.maxBytes)} reached` : `${shown} lines shown`;
			text += `\n\n[${path}: lines ${startLine + 1}-${lastShown} of ${totalLines} (${reason}). Continue with offset=${lastShown + 1}.]`;
		}
		return { kind: "text", text };
	} finally {
		await reader.close(context);
	}
}

/** Create or replace a file with `content`, creating missing parent directories. */
export async function writeFile(session: HostSession, filePath: string, content: string, signal?: AbortSignal): Promise<string> {
	const context = contextFor(signal);
	const path = await session.resolve(filePath, signal);
	return session.fileLocks.run(path, async () => {
		const before = await session.env.fileInfo(path, context);
		if (before.ok && before.value.kind === "directory") throw new Error(`${path} is a directory`);
		getOrThrow(await session.env.writeFile(path, content, UNINTERRUPTED));
		const bytes = Buffer.byteLength(content, "utf8");
		const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
		return `${before.ok ? "Overwrote" : "Created"} ${path} on ${session.name} (${lines} line${lines === 1 ? "" : "s"}, ${formatBytes(bytes)}).`;
	});
}

/** Replace text in a file; see `applyEdit`. An empty `oldString` creates a missing or empty file. */
export async function editFile(
	session: HostSession,
	filePath: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
	signal?: AbortSignal,
): Promise<string> {
	const context = contextFor(signal);
	const path = await session.resolve(filePath, signal);
	return session.fileLocks.run(path, async () => {
		const info = await session.env.fileInfo(path, context);
		if (!info.ok) {
			if (info.error.code === "not_found" && oldString === "") {
				getOrThrow(await session.env.writeFile(path, newString, UNINTERRUPTED));
				return `Created ${path} on ${session.name} with the new content.`;
			}
			throw info.error;
		}
		if (info.value.kind === "directory") throw new EditError(`${path} is a directory`);
		if (info.value.size > MAX_EDIT_BYTES) {
			throw new EditError(`${path} is ${formatBytes(info.value.size)}, too large to edit here; use bash (sed, python) instead.`);
		}
		const raw = getOrThrow(await session.env.readBinaryFile(path, context));
		let text: string;
		try {
			// Keep a byte-order mark in the text, so the edit writes it back.
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
		} catch {
			throw new EditError(`${path} is not valid UTF-8; editing it could corrupt it. Use bash (sed, iconv) instead.`);
		}
		if (oldString === "" && text.replace(/^﻿/, "") === "") {
			getOrThrow(await session.env.writeFile(path, newString, UNINTERRUPTED));
			return `Wrote the new content into the empty file ${path} on ${session.name}.`;
		}
		const outcome = applyEdit(text, oldString, newString, replaceAll);
		getOrThrow(await session.env.writeFile(path, outcome.content, UNINTERRUPTED));
		const count = outcome.replacements === 1 ? "1 replacement" : `${outcome.replacements} replacements`;
		return `Edited ${path} on ${session.name} (${count}). The changed region now reads:\n${snippet(outcome.content, outcome.firstLine, outcome.lastLine)}`;
	});
}
