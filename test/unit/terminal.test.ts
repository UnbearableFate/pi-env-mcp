import { describe, expect, it } from "vitest";
import { keySequence } from "../../src/lib/keys.ts";
import { TerminalScreen } from "../../src/lib/screen.ts";

describe("keySequence", () => {
	it("maps named and control keys", () => {
		expect(keySequence("Enter")).toBe("\r");
		expect(keySequence("C-c")).toBe("\x03");
		expect(keySequence("ctrl+D")).toBe("\x04");
		expect(keySequence("^Z")).toBe("\x1a");
		expect(keySequence("M-b")).toBe("\x1bb");
		expect(keySequence("PageDown")).toBe("\x1b[6~");
		expect(keySequence("S-Tab")).toBe("\x1b[Z");
	});

	it("follows application cursor key mode", () => {
		expect(keySequence("Up")).toBe("\x1b[A");
		expect(keySequence("Up", true)).toBe("\x1bOA");
	});

	it("lists the accepted names for an unknown key", () => {
		expect(() => keySequence("Hyper-x")).toThrow(/Unknown key "Hyper-x"\. Use Enter, Tab/);
	});
});

describe("TerminalScreen", () => {
	it("returns new output since the last read, starting at the prompt line", async () => {
		const screen = new TerminalScreen(40, 5);
		screen.write("$ ");
		await screen.flush();
		expect(screen.takeNew().text).toBe("$");
		screen.write("ls\r\nfile1  file2\r\n$ ");
		await screen.flush();
		expect(screen.takeNew().text).toBe("$ ls\nfile1  file2\n$");
		screen.dispose();
	});

	it("keeps a prompt's trailing space for matching, and drops it for display", async () => {
		const screen = new TerminalScreen(40, 5);
		screen.write("Python 3\r\n>>> ");
		await screen.flush();
		expect(/>>> $/m.test(screen.peekNew(false))).toBe(true);
		expect(screen.peekNew()).toBe("Python 3\n>>>");
		expect(screen.cursor()).toEqual({ row: 2, col: 5 });
		screen.dispose();
	});

	it("reads what was printed after a marked cursor position, not the prompt before it", async () => {
		const screen = new TerminalScreen(40, 5);
		screen.write(">>> ");
		await screen.flush();
		const mark = screen.markCursor()!;
		expect(screen.textFrom(mark, false)).toBe("");
		expect(/>>> /.test(screen.textFrom(mark, false)!)).toBe(false);
		screen.write("print(42)\r\n42\r\n>>> ");
		await screen.flush();
		expect(screen.textFrom(mark, false)).toBe("print(42)\n42\n>>> ");
		expect(screen.textFrom(mark)).toBe("print(42)\n42\n>>>");
		screen.dispose();
	});

	it("applies cursor movement and line rewrites like a terminal", async () => {
		const screen = new TerminalScreen(40, 5);
		screen.write("progress 10%\rprogress 99%\r\n\x1b[31mred\x1b[0m\r\n");
		await screen.flush();
		expect(screen.takeNew().text).toBe("progress 99%\nred");
		screen.dispose();
	});

	it("joins wrapped rows into one line without losing spaces at the wrap", async () => {
		const screen = new TerminalScreen(10, 5);
		screen.write("hello     world\r\n");
		await screen.flush();
		expect(screen.takeNew().text).toBe("hello     world");
		screen.dispose();
	});

	it("shows the screen of a full-screen program and resumes the shell output after it", async () => {
		const screen = new TerminalScreen(20, 4);
		screen.write("$ vim\r\n");
		await screen.flush();
		screen.takeNew();
		screen.write("\x1b[?1049h\x1b[H\x1b[2Jline one\r\n~\r\n~");
		await screen.flush();
		expect(screen.alternate).toBe(true);
		const shown = screen.takeNew();
		expect(shown.screen).toBe(true);
		expect(shown.text).toBe("line one\n~\n~");
		screen.write("\x1b[?1049l$ ");
		await screen.flush();
		expect(screen.alternate).toBe(false);
		// The read before vim started ended on the line below "$ vim", where the shell now prints its prompt.
		expect(screen.takeNew().text).toBe("$");
		screen.dispose();
	});

	it("reports output that scrolled out of the scrollback before it was read", async () => {
		const screen = new TerminalScreen(20, 3, 10);
		screen.write("start\r\n");
		await screen.flush();
		screen.takeNew();
		for (let index = 0; index < 50; index++) screen.write(`line ${index}\r\n`);
		await screen.flush();
		const taken = screen.takeNew();
		expect(taken.lost).toBe(true);
		expect(taken.text.split("\n").at(-1)).toBe("line 49");
		screen.dispose();
	});
});
