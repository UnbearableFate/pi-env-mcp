import type { IBuffer, IMarker, Terminal } from "@xterm/headless";
import xterm from "@xterm/headless";

/** A place in the normal buffer: a marker for its line, which follows scrolling, and a column. */
export interface ScreenPosition {
	readonly marker: IMarker;
	readonly col: number;
}

/**
 * A terminal emulator without a display: it interprets a program's raw output (cursor movement, line editing, colors,
 * the alternate screen) so the text a person would see can be read back as plain lines.
 */
export class TerminalScreen {
	readonly #term: Terminal;
	/** Where the next `takeNew` starts: the line the cursor was on at the previous one. */
	#mark: IMarker | undefined;

	constructor(cols: number, rows: number, scrollback = 5000) {
		this.#term = new xterm.Terminal({ cols, rows, scrollback, allowProposedApi: true });
	}

	write(data: Uint8Array | string): void {
		this.#term.write(data);
	}

	/** Resolves once everything written so far has been interpreted. */
	flush(): Promise<void> {
		return new Promise((resolve) => this.#term.write("", resolve));
	}

	/** Full-screen programs (vim, less, htop) draw on the alternate screen, which has no scrollback. */
	get alternate(): boolean {
		return this.#term.buffer.active.type === "alternate";
	}

	get applicationCursorKeys(): boolean {
		return this.#term.modes.applicationCursorKeysMode;
	}

	get cols(): number {
		return this.#term.cols;
	}

	get rows(): number {
		return this.#term.rows;
	}

	/**
	 * Lines `[start, end)` of `buffer` as text, the first from cell `startColumn`: wrapped rows joined into one line,
	 * trailing blank lines dropped. With `trim`, also spaces the program wrote at the end of a line (a prompt's `>>> `),
	 * which matter only for matching.
	 */
	#text(buffer: IBuffer, start: number, end: number, joinWrapped: boolean, trim = true, startColumn = 0): string {
		const lines: string[] = [];
		for (let y = Math.max(0, start); y < end; y++) {
			const line = buffer.getLine(y);
			if (line === undefined) continue;
			// A row that continues on the next one keeps its trailing spaces: they are inside the logical line.
			const continued = joinWrapped && buffer.getLine(y + 1)?.isWrapped === true;
			const cells = line.translateToString(!continued, y === start ? startColumn : 0);
			const text = continued || !trim ? cells : cells.trimEnd();
			if (joinWrapped && line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
			else lines.push(text);
		}
		while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
		return lines.join("\n");
	}

	/** Where unread output starts in the normal buffer, and whether some of it already left the scrollback. */
	#unreadStart(): { start: number; lost: boolean } {
		if (this.#mark === undefined) return { start: 0, lost: false };
		if (this.#mark.isDisposed || this.#mark.line < 0) return { start: 0, lost: true };
		return { start: this.#mark.line, lost: false };
	}

	/**
	 * Output since the last `takeNew`, without consuming it; on the alternate screen, the screen. With `trim` false, lines
	 * keep the spaces the program wrote at their end, as a pattern like `>>> $` expects.
	 */
	peekNew(trim = true): string {
		if (this.alternate) return this.screen(trim);
		const buffer = this.#term.buffer.normal;
		return this.#text(buffer, this.#unreadStart().start, buffer.length, true, trim);
	}

	/**
	 * Output since the last call, from the line the cursor was on then (so a prompt and the command typed at it appear
	 * together), as plain text. On the alternate screen it returns the screen and keeps the mark, so the shell's output
	 * continues where it left off once the program exits. `lost` reports output that scrolled out of the scrollback
	 * before it was read.
	 */
	takeNew(): { text: string; lost: boolean; screen: boolean } {
		if (this.alternate) return { text: this.screen(), lost: false, screen: true };
		const buffer = this.#term.buffer.normal;
		const { start, lost } = this.#unreadStart();
		const text = this.#text(buffer, start, buffer.length, true);
		this.#mark?.dispose();
		this.#mark = this.#term.registerMarker(0);
		return { text, lost, screen: false };
	}

	/** The cursor's place in the normal buffer, which follows scrolling; undefined on the alternate screen. */
	markCursor(): ScreenPosition | undefined {
		if (this.alternate) return undefined;
		const marker = this.#term.registerMarker(0);
		return marker === undefined ? undefined : { marker, col: this.#term.buffer.normal.cursorX };
	}

	/**
	 * What was printed from `position` on: the rest of its line, then the lines below. Undefined once the position
	 * scrolled out of the scrollback.
	 */
	textFrom(position: ScreenPosition, trim = true): string | undefined {
		if (position.marker.isDisposed || position.marker.line < 0) return undefined;
		const buffer = this.#term.buffer.normal;
		return this.#text(buffer, position.marker.line, buffer.length, true, trim, position.col);
	}

	/** The visible screen, row by row. */
	screen(trim = true): string {
		const buffer = this.#term.buffer.active;
		return this.#text(buffer, buffer.viewportY, buffer.viewportY + this.#term.rows, false, trim);
	}

	/** 1-based cursor position on the visible screen. */
	cursor(): { row: number; col: number } {
		const buffer = this.#term.buffer.active;
		return { row: buffer.cursorY + 1, col: buffer.cursorX + 1 };
	}

	resize(cols: number, rows: number): void {
		this.#term.resize(cols, rows);
	}

	dispose(): void {
		this.#mark?.dispose();
		this.#term.dispose();
	}
}
