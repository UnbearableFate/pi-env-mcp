import type { OutputBuffer, OutputSkip } from "@earendil-works/chord/output";

/** Escape sequences: CSI (colors, cursor movement), OSC (titles, links), and the short ESC forms. */
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-Z\\-_=>])/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/**
 * What a terminal shows for one line that redraws itself with carriage returns (progress bars from pip, wget, tqdm):
 * the last non-empty segment.
 */
function lastSegment(line: string): string {
	if (!line.includes("\r")) return line;
	const parts = line.split("\r");
	for (let index = parts.length - 1; index >= 0; index--) if (parts[index] !== "") return parts[index]!;
	return "";
}

/** Text as a terminal would leave it: escape sequences removed, carriage-return redraws collapsed. */
export function renderText(text: string): string {
	return stripAnsi(text).split("\n").map(lastSegment).join("\n");
}

/**
 * Feeds streamed output into an `OutputBuffer` as a terminal would show it. Complete lines are rendered as they arrive;
 * the incomplete last line is kept back, reduced to its latest redraw, so a progress bar that rewrites one line
 * thousands of times costs one line.
 */
export class RenderedOutput {
	readonly #buffer: OutputBuffer;
	readonly #maxPending: number;
	#pending = "";

	constructor(buffer: OutputBuffer, maxPending: number) {
		this.#buffer = buffer;
		this.#maxPending = maxPending;
	}

	push(text: string, skipped?: OutputSkip): void {
		if (skipped !== undefined) {
			// Everything before the skip, including a held-back partial line, is out of the window anyway.
			this.#pending = "";
			this.#buffer.push("", skipped);
		}
		let data = this.#pending + text;
		const newline = data.lastIndexOf("\n");
		if (newline >= 0) {
			this.#buffer.push(renderText(data.slice(0, newline + 1)));
			data = data.slice(newline + 1);
		}
		if (data.includes("\r")) {
			// Keep the latest redraw, and a trailing carriage return that the next text overwrites.
			data = lastSegment(data) + (data.endsWith("\r") ? "\r" : "");
		}
		if (data.length > this.#maxPending) {
			this.#buffer.push(renderText(data));
			data = "";
		}
		this.#pending = data;
	}

	end(): void {
		if (this.#pending !== "") this.#buffer.push(renderText(this.#pending));
		this.#pending = "";
		this.#buffer.end();
	}
}

/** The end of the last complete UTF-8 character in `bytes`. */
export function completeUtf8(bytes: Uint8Array): number {
	for (let back = 1; back <= Math.min(4, bytes.length); back++) {
		const byte = bytes[bytes.length - back]!;
		if ((byte & 0xc0) === 0x80) continue;
		if (byte < 0xc0) return bytes.length;
		const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
		return needed > back ? bytes.length - back : bytes.length;
	}
	return bytes.length;
}

/** The end of the first `maxLines` lines of `bytes`. */
export function headLinesEnd(bytes: Uint8Array, maxLines: number): number {
	let count = 0;
	for (let index = bytes.indexOf(0x0a); index !== -1; index = bytes.indexOf(0x0a, index + 1)) {
		if (++count === maxLines) return index + 1;
	}
	return bytes.length;
}

/** The start of the last `maxLines` lines of `bytes`; a final newline ends the last line rather than starting one. */
export function tailLinesStart(bytes: Uint8Array, maxLines: number): number {
	const last = bytes[bytes.length - 1] === 0x0a ? bytes.length - 2 : bytes.length - 1;
	if (last < 0) return 0;
	let count = 0;
	for (let index = bytes.lastIndexOf(0x0a, last); index !== -1; index = index === 0 ? -1 : bytes.lastIndexOf(0x0a, index - 1)) {
		if (++count === maxLines) return index + 1;
	}
	return 0;
}
