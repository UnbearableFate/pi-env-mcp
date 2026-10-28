import { OutputBuffer } from "@earendil-works/chord/output";
import { describe, expect, it } from "vitest";
import { completeUtf8, headLinesEnd, RenderedOutput, renderText, stripAnsi, tailLinesStart } from "../../src/lib/text.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("renderText", () => {
	it("removes colors and collapses carriage-return redraws", () => {
		expect(stripAnsi("\x1b[1;32mok\x1b[0m \x1b]0;title\x07done")).toBe("ok done");
		expect(renderText(" 10%\r 50%\r100%\nnext\n")).toBe("100%\nnext\n");
		// A redraw that ends with a carriage return keeps the last non-empty state.
		expect(renderText("50%\r100%\r")).toBe("100%");
	});
});

describe("RenderedOutput", () => {
	const render = (chunks: string[]) => {
		const buffer = new OutputBuffer({ maxBytes: 10_000, maxLines: 100, retain: "tail" });
		const rendered = new RenderedOutput(buffer, 1000);
		for (const chunk of chunks) rendered.push(chunk);
		rendered.end();
		return buffer.snapshot().text;
	};

	it("collapses a progress bar redrawn across chunks", () => {
		expect(render(["Downloading  1%\r", "Downloading 40%\r", "Downloading 100%\n", "done\n"])).toBe("Downloading 100%\ndone\n");
	});

	it("keeps text split across chunks intact", () => {
		expect(render(["hel", "lo\nwor", "ld"])).toBe("hello\nworld");
	});

	it("drops held-back text before skipped output", () => {
		const buffer = new OutputBuffer({ maxBytes: 100, maxLines: 5, retain: "tail" });
		const rendered = new RenderedOutput(buffer, 1000);
		rendered.push("partial");
		rendered.push("tail\n", { bytes: 5000, newlines: 500, endsWithNewline: true });
		rendered.end();
		const snapshot = buffer.snapshot();
		expect(snapshot.text).toBe("tail\n");
		expect(snapshot.droppedLines).toBeGreaterThanOrEqual(500);
	});
});

describe("byte helpers", () => {
	it("finds the end of the first lines and the start of the last ones", () => {
		const data = bytes("a\nb\nc\nd\n");
		expect(headLinesEnd(data, 2)).toBe(4);
		expect(headLinesEnd(data, 10)).toBe(data.length);
		expect(tailLinesStart(data, 2)).toBe(4);
		expect(tailLinesStart(bytes("a\nb\nc"), 1)).toBe(4);
		expect(tailLinesStart(bytes("\n"), 1)).toBe(0);
		expect(tailLinesStart(new Uint8Array(0), 3)).toBe(0);
	});

	it("never splits a UTF-8 character", () => {
		const euro = bytes("a€"); // 61 e2 82 ac
		expect(completeUtf8(euro)).toBe(4);
		expect(completeUtf8(euro.subarray(0, 3))).toBe(1);
		expect(completeUtf8(euro.subarray(0, 2))).toBe(1);
		expect(completeUtf8(bytes("abc"))).toBe(3);
	});
});
