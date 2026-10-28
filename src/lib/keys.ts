/** Named keys for terminal input, as a terminal emulator would send them. */

const ESC = "\x1b";

const NAMED: Record<string, string> = {
	enter: "\r",
	return: "\r",
	tab: "\t",
	backtab: `${ESC}[Z`,
	escape: ESC,
	esc: ESC,
	backspace: "\x7f",
	space: " ",
	delete: `${ESC}[3~`,
	del: `${ESC}[3~`,
	insert: `${ESC}[2~`,
	home: `${ESC}[H`,
	end: `${ESC}[F`,
	pageup: `${ESC}[5~`,
	pgup: `${ESC}[5~`,
	pagedown: `${ESC}[6~`,
	pgdn: `${ESC}[6~`,
	f1: `${ESC}OP`,
	f2: `${ESC}OQ`,
	f3: `${ESC}OR`,
	f4: `${ESC}OS`,
	f5: `${ESC}[15~`,
	f6: `${ESC}[17~`,
	f7: `${ESC}[18~`,
	f8: `${ESC}[19~`,
	f9: `${ESC}[20~`,
	f10: `${ESC}[21~`,
	f11: `${ESC}[23~`,
	f12: `${ESC}[24~`,
};

/** Cursor keys: `ESC [ x` normally, `ESC O x` once a program enables application cursor keys (vim, less, htop). */
const CURSOR: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };

/** Control characters for `C-x`: letters, and the punctuation terminals map. */
function control(char: string): string | undefined {
	const lower = char.toLowerCase();
	if (lower >= "a" && lower <= "z") return String.fromCharCode(lower.charCodeAt(0) - 96);
	const special: Record<string, string> = { "@": "\x00", " ": "\x00", "[": ESC, "\\": "\x1c", "]": "\x1d", "^": "\x1e", _: "\x1f", "?": "\x7f" };
	return special[char];
}

/**
 * The bytes for one key name: `Enter`, `Tab`, `Escape`, `Up`, `PageDown`, `F5`, `C-c` (also `Ctrl-C`, `ctrl+c`, `^C`),
 * `M-b` (also `Alt-b`), `S-Tab`. Unknown names throw, listing what is accepted.
 */
export function keySequence(name: string, applicationCursorKeys = false): string {
	const key = name.trim();
	const lower = key.toLowerCase();
	const cursor = CURSOR[lower];
	if (cursor !== undefined) return `${ESC}${applicationCursorKeys ? "O" : "["}${cursor}`;
	const named = NAMED[lower];
	if (named !== undefined) return named;
	if (lower === "s-tab" || lower === "shift-tab" || lower === "shift+tab") return `${ESC}[Z`;
	const ctrl = /^(?:c-|ctrl-|ctrl\+|control-|\^)(.)$/i.exec(key);
	if (ctrl) {
		const sequence = control(ctrl[1]!);
		if (sequence !== undefined) return sequence;
	}
	const meta = /^(?:m-|alt-|alt\+|meta-)(.+)$/i.exec(key);
	if (meta) {
		const rest = meta[1]!;
		return ESC + (rest.length === 1 ? rest : keySequence(rest, applicationCursorKeys));
	}
	throw new Error(
		`Unknown key "${name}". Use Enter, Tab, Escape, Backspace, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown, Delete, Insert, F1-F12, C-<char> (e.g. C-c, C-d, C-z), M-<char>, or S-Tab; send ordinary text with "input".`,
	);
}
