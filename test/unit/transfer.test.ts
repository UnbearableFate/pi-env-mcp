import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localChild } from "../../src/transfer.ts";

describe("localChild", () => {
	it("maps remote relative paths below the destination", () => {
		expect(localChild("/dl", "a/b.txt")).toBe(join("/dl", "a", "b.txt"));
		expect(localChild("/dl", "..foo")).toBe(join("/dl", "..foo"));
	});

	it("refuses names that would leave the destination", () => {
		expect(localChild("/dl", "../x")).toBeUndefined();
		expect(localChild("/dl", "a/../../x")).toBeUndefined();
		expect(localChild("/dl", "a//b")).toBeUndefined();
		expect(localChild("/dl", ".")).toBeUndefined();
	});
});
