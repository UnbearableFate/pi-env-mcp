import { describe, expect, it } from "vitest";
import { applyEdit, EditError, snippet } from "../../src/lib/edit.ts";

describe("applyEdit", () => {
	it("replaces a unique occurrence and reports its lines", () => {
		const outcome = applyEdit("a\nb\nc\n", "b", "B1\nB2", false);
		expect(outcome.content).toBe("a\nB1\nB2\nc\n");
		expect(outcome).toMatchObject({ replacements: 1, firstLine: 2, lastLine: 3 });
	});

	it("refuses an ambiguous match unless replace_all is set", () => {
		expect(() => applyEdit("x\nx\n", "x", "y", false)).toThrow(/occurs 2 times \(first at line 1\)/);
		const outcome = applyEdit("x\nx\n", "x", "y", true);
		expect(outcome.content).toBe("y\ny\n");
		expect(outcome.replacements).toBe(2);
	});

	it("explains a missing match, pointing at a whitespace-only difference", () => {
		expect(() => applyEdit("def f():\n    return 1\n", "def g():", "x", false)).toThrow(/not found in the file/);
		expect(() => applyEdit("def f():\n    return 1\n", "def f():\n  return 1", "x", false)).toThrow(
			/differing only in whitespace starts at line 1/,
		);
	});

	it("rejects empty and no-op edits", () => {
		expect(() => applyEdit("abc", "", "x", false)).toThrow(EditError);
		expect(() => applyEdit("abc", "b", "b", false)).toThrow(/identical/);
	});

	it("keeps CRLF endings of a CRLF file and matches LF searches in it", () => {
		const outcome = applyEdit("one\r\ntwo\r\nthree\r\n", "one\ntwo", "1\n2", false);
		expect(outcome.content).toBe("1\r\n2\r\nthree\r\n");
	});

	it("changes nothing outside the match in a file with mixed endings", () => {
		const outcome = applyEdit("line1\nline2\r\nline3\n", "line1", "L1", false);
		expect(outcome.content).toBe("L1\nline2\r\nline3\n");
		// A multi-line LF search over CRLF lines of a mixed file.
		const crlfRegion = applyEdit("a\nb\r\nc\r\nd\n", "b\nc", "B\nC", false);
		expect(crlfRegion.content).toBe("a\nB\r\nC\r\nd\n");
	});

	it("keeps a byte-order mark", () => {
		expect(applyEdit("﻿hello\n", "hello", "bye", false).content).toBe("﻿bye\n");
	});

	it("treats replacement patterns literally", () => {
		expect(applyEdit("cost: X\n", "X", "$& and $1", false).content).toBe("cost: $& and $1\n");
	});
});

describe("snippet", () => {
	it("numbers the changed lines with context and no phantom final line", () => {
		const content = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
		expect(snippet(content, 9, 10, 2)).toBe(["     7\t7", "     8\t8", "     9\t9", "    10\t10"].join("\n"));
	});
});
