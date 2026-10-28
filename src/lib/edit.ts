import { numberLine } from "./util.ts";

/** A replacement that cannot be applied; the message tells the model how to fix its call. */
export class EditError extends Error {}

export interface EditOutcome {
	/** The new file content, with the original byte-order mark and line endings. */
	content: string;
	replacements: number;
	/** 1-based lines of the first replacement in the new content, for a snippet. */
	firstLine: number;
	lastLine: number;
}

const BOM = "﻿";

function toLF(text: string): string {
	return text.replaceAll("\r\n", "\n");
}

function count(text: string, search: string): number {
	let found = 0;
	for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) found++;
	return found;
}

function countOccurrences(text: string, search: string): { count: number; first: number } {
	let count = 0;
	let first = -1;
	for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) {
		if (first === -1) first = index;
		count++;
	}
	return { count, first };
}

function lineOf(text: string, index: number): number {
	let line = 1;
	for (let at = text.indexOf("\n"); at !== -1 && at < index; at = text.indexOf("\n", at + 1)) line++;
	return line;
}

/**
 * Where `search` would match if whitespace were ignored at the ends of lines, or everywhere: a hint for a model whose
 * `old_string` differs from the file only in indentation or spacing. Returns a 1-based line, or undefined.
 */
function nearMatchLine(text: string, search: string): number | undefined {
	const fileLines = text.split("\n");
	const searchLines = search.split("\n");
	while (searchLines.length > 1 && searchLines.at(-1)!.trim() === "") searchLines.pop();
	for (const normalize of [(line: string) => line.trimEnd(), (line: string) => line.replace(/\s+/g, "")]) {
		const wanted = searchLines.map(normalize);
		if (wanted.every((line) => line === "")) return undefined;
		for (let start = 0; start + wanted.length <= fileLines.length; start++) {
			let matches = true;
			for (let offset = 0; offset < wanted.length && matches; offset++) {
				const line = fileLines[start + offset]!;
				// The first and last lines of a match may be partial, like an exact substring match.
				const candidate = normalize(line);
				const target = wanted[offset]!;
				if (wanted.length === 1) matches = candidate.includes(target);
				else if (offset === 0) matches = candidate.endsWith(target);
				else if (offset === wanted.length - 1) matches = candidate.startsWith(target);
				else matches = candidate === target;
			}
			if (matches) return start + 1;
		}
	}
	return undefined;
}

/**
 * Replace `oldString` with `newString` in `original`, changing nothing else. A file with CRLF line endings throughout is
 * matched as if it had LF endings and keeps CRLF; in other files, a search written with LF that only matches with CRLF
 * is tried as well. The byte-order mark is kept. Without `replaceAll`, `oldString` must occur exactly once.
 */
export function applyEdit(original: string, oldString: string, newString: string, replaceAll: boolean): EditOutcome {
	const bom = original.startsWith(BOM) ? BOM : "";
	const body = original.slice(bom.length);
	const crlf = count(body, "\r\n");
	const ending = crlf > 0 && crlf === count(body, "\n") ? "\r\n" : "\n";
	let text = ending === "\r\n" ? toLF(body) : body;
	let search = ending === "\r\n" ? toLF(oldString) : oldString;
	let replacement = ending === "\r\n" ? toLF(newString) : newString;
	if (search === "") throw new EditError("old_string is empty; to create or overwrite a whole file, use write.");
	if (search === replacement) throw new EditError("old_string and new_string are identical; nothing to change.");
	if (ending === "\n" && crlf > 0 && !text.includes(search) && search.includes("\n") && !search.includes("\r")) {
		// Mixed line endings: the lines being replaced may end in CRLF.
		const withCRLF = search.replaceAll("\n", "\r\n");
		if (text.includes(withCRLF)) {
			search = withCRLF;
			replacement = replacement.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
		}
	}
	const { count: occurrences, first } = countOccurrences(text, search);
	if (occurrences === 0) {
		const near = nearMatchLine(text, search);
		throw new EditError(
			near === undefined
				? "old_string was not found in the file. Read the file again and copy the text exactly, including whitespace."
				: `old_string was not found exactly, but text differing only in whitespace starts at line ${near}. Read that part of the file again and copy it exactly, including indentation.`,
		);
	}
	if (occurrences > 1 && !replaceAll) {
		throw new EditError(
			`old_string occurs ${occurrences} times (first at line ${lineOf(text, first)}). Include more surrounding context to make it unique, or set replace_all to replace every occurrence.`,
		);
	}
	text = replaceAll
		? text.split(search).join(replacement)
		: text.slice(0, first) + replacement + text.slice(first + search.length);
	const firstLine = lineOf(text, first);
	const lastLine = firstLine + Math.max(0, replacement.split("\n").length - 1);
	const content = bom + (ending === "\r\n" ? text.replaceAll("\n", "\r\n") : text);
	return { content, replacements: replaceAll ? occurrences : 1, firstLine, lastLine };
}

/** Numbered lines `[firstLine - context, lastLine + context]` of `content`, as `cat -n` prints them. */
export function snippet(content: string, firstLine: number, lastLine: number, context = 4, maxLineLength = 500): string {
	const lines = toLF(content.startsWith(BOM) ? content.slice(1) : content).split("\n");
	// A final newline ends the last line rather than starting another.
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	const from = Math.max(1, firstLine - context);
	const to = Math.min(lines.length, lastLine + context);
	const out: string[] = [];
	for (let line = from; line <= to; line++) {
		const text = lines[line - 1]!;
		out.push(numberLine(line, text.length > maxLineLength ? `${text.slice(0, maxLineLength)}…` : text));
	}
	return out.join("\n");
}
