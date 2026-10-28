import { describe, expect, it } from "vitest";
import { CHANGES_DIRECTORY } from "../../src/shell.ts";

describe("CHANGES_DIRECTORY", () => {
	it("spots commands that may leave the shell in another directory", () => {
		for (const command of [
			"cd /tmp",
			"cd",
			"  cd src && make",
			"make && cd build",
			"ls; cd ..",
			"(cd sub && pwd)",
			"x=$(cd y && pwd)",
			"if [ -d x ]; then cd x; fi",
			"for d in a b; do cd $d; done",
			"pushd lib",
			"popd",
			"source venv/bin/activate",
			". ./env.sh",
			"echo start\ncd /srv",
		]) {
			expect(CHANGES_DIRECTORY.test(command), command).toBe(true);
		}
	});

	it("leaves ordinary commands alone, including ones that mention the current directory", () => {
		for (const command of [
			"find . -size +1G",
			"du -sh .",
			"rg foo .",
			"ls -la",
			"./run.sh",
			"echo cd",
			"cd-tool --help",
			"git status",
			"python3 train.py --data ./data",
		]) {
			expect(CHANGES_DIRECTORY.test(command), command).toBe(false);
		}
	});
});
