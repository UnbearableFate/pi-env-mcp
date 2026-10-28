import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logServerOnFailure, prepareConfig, ssh, TEST_HOST, TestClient } from "./helpers.ts";

describe.skipIf(TEST_HOST === undefined)(`shell and file tools on ${TEST_HOST}`, () => {
	const host = TEST_HOST!;
	// The remote host's own /tmp: not on storage it might share with this machine.
	const dir = `/tmp/pi-env-mcp-test-${randomBytes(4).toString("hex")}`;
	let configDir: string;
	let client: TestClient;

	logServerOnFailure(() => client);

	beforeAll(async () => {
		configDir = prepareConfig(host);
		client = await new TestClient(configDir).connect();
		await client.ok("bash", { command: `mkdir -p ${dir} && cd ${dir}` });
	});

	afterAll(async () => {
		await client?.call("bash", { command: `rm -rf ${dir}` });
		await client?.close();
		rmSync(configDir, { recursive: true, force: true });
	});

	it("lists its tools and the configured host", async () => {
		const { tools } = await client.client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(
			[
				"bash",
				"download",
				"edit",
				"glob",
				"grep",
				"hosts",
				"job_kill",
				"job_status",
				"read",
				"terminal_close",
				"terminal_open",
				"terminal_read",
				"terminal_send",
				"upload",
				"write",
			].sort(),
		);
		const hosts = await client.ok("hosts", {});
		expect(hosts).toContain(`${host} (default)`);
		expect(hosts).toMatch(/connected for/);
		expect(hosts).toContain(`working directory: ${dir}`);
	});

	it("runs commands on the remote machine, not this one", async () => {
		const remote = (await client.ok("bash", { command: "hostname" })).trim();
		expect(remote).toBe(ssh(host, "hostname").trim());
		expect(remote).not.toBe(hostname());
	});

	it("keeps the working directory between calls, but not a one-off cwd", async () => {
		expect((await client.ok("bash", { command: "pwd" })).trim()).toBe(dir);
		const moved = await client.ok("bash", { command: "mkdir -p sub/deeper && cd sub" });
		expect(moved).toContain(`working directory is now ${dir}/sub`);
		expect((await client.ok("bash", { command: "pwd" })).trim()).toBe(`${dir}/sub`);
		expect((await client.ok("bash", { command: "pwd", cwd: "deeper" })).trim()).toBe(`${dir}/sub/deeper`);
		expect((await client.ok("bash", { command: "pwd" })).trim()).toBe(`${dir}/sub`);
		await client.ok("bash", { command: `cd ${dir}` });
	});

	it("reports exit codes, merges stderr, and does not leak shell state", async () => {
		const failed = await client.call("bash", { command: "echo out; echo err >&2; exit 3" });
		expect(failed.isError).toBe(false);
		expect(failed.text).toMatch(/out\nerr\n\[exit code 3\]/);
		await client.ok("bash", { command: "export PI_ENV_MCP_VAR=1" });
		expect((await client.ok("bash", { command: 'echo "[${PI_ENV_MCP_VAR:-unset}]"' })).trim()).toBe("[unset]");
	});

	it("fails fast on stdin instead of hanging", async () => {
		const result = await client.call("bash", { command: "read line; echo \"got:$line\"", timeout: 20 });
		expect(result.text).toContain("got:");
	});

	it("kills a command at its timeout", async () => {
		const started = Date.now();
		const result = await client.call("bash", { command: "echo BEFORE-MARK; sleep 30; echo AFTER-MARK", timeout: 1 });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("BEFORE-MARK");
		expect(result.text).not.toContain("AFTER-MARK");
		expect(result.text).toMatch(/timed out after 1 s/);
	});

	it("keeps the end of long output and saves all of it on the host", async () => {
		const result = await client.ok("bash", { command: "seq 1 200000" });
		expect(result).toMatch(/output truncated: the first \d+ lines/);
		expect(result.trimEnd().endsWith("200000")).toBe(true);
		const spill = /on \S+ at (\S+\.log)\]/.exec(result)?.[1];
		expect(spill).toBeDefined();
		const head = await client.ok("read", { file_path: spill!, limit: 3 });
		expect(head).toMatch(/^\s+1\t1\n\s+2\t2\n\s+3\t3/);
	});

	it("collapses progress bars and strips colors", async () => {
		const result = await client.ok("bash", { command: "printf 'dl 10%%\\rdl 60%%\\rdl 100%%\\n\\033[32mgreen\\033[0m\\n'" });
		expect(result).toBe("dl 100%\ngreen");
	});

	it("runs calls in parallel over one connection", async () => {
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, index) => client.ok("bash", { command: `sleep 0.5; echo ${index}`, cwd: dir })),
		);
		expect(results.map((text) => text.trim())).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
	});

	it("writes, reads with line numbers and ranges, and edits files", async () => {
		const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
		expect(await client.ok("write", { file_path: "notes/a.txt", content })).toMatch(/Created .*notes\/a\.txt.*30 lines/);
		const all = await client.ok("read", { file_path: `${dir}/notes/a.txt` });
		expect(all.split("\n")[0]).toBe("     1\tline 1");
		expect(all.split("\n")).toHaveLength(30);
		const part = await client.ok("read", { file_path: "notes/a.txt", offset: 10, limit: 2 });
		expect(part).toContain("    10\tline 10\n    11\tline 11");
		expect(part).toContain("Continue with offset=12");
		const past = await client.call("read", { file_path: "notes/a.txt", offset: 99 });
		expect(past.isError).toBe(true);
		expect(past.text).toMatch(/past the end .* 30 lines/);

		const edited = await client.ok("edit", { file_path: "notes/a.txt", old_string: "line 7\n", new_string: "line seven\nline 7.5\n" });
		expect(edited).toContain("     7\tline seven\n     8\tline 7.5");
		const ambiguous = await client.call("edit", { file_path: "notes/a.txt", old_string: "line 1", new_string: "x" });
		expect(ambiguous.isError).toBe(true);
		expect(ambiguous.text).toMatch(/occurs \d+ times/);
		const missing = await client.call("edit", { file_path: "notes/a.txt", old_string: "no such text", new_string: "x" });
		expect(missing.isError).toBe(true);
		expect(await client.ok("bash", { command: "sed -n '6,9p' notes/a.txt" })).toBe("line 6\nline seven\nline 7.5\nline 8");
	});

	it("reports missing files and directories clearly", async () => {
		const missing = await client.call("read", { file_path: "does/not/exist.txt" });
		expect(missing.isError).toBe(true);
		expect(missing.text).toBe(`No such file or directory: ${dir}/does/not/exist.txt`);
		const directory = await client.call("read", { file_path: "notes" });
		expect(directory.isError).toBe(true);
		expect(directory.text).toMatch(/Is a directory/);
	});

	it("refuses binary files and returns images as images", async () => {
		await client.ok("bash", { command: "head -c 4096 /dev/urandom > blob.bin; printf '\\0' >> blob.bin" });
		const binary = await client.call("read", { file_path: "blob.bin" });
		expect(binary.isError).toBe(true);
		expect(binary.text).toMatch(/binary file/);
		// A 1x1 PNG.
		await client.ok("bash", {
			command:
				"printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > pixel.png",
		});
		const image = await client.call("read", { file_path: "pixel.png" });
		expect(image.isError).toBe(false);
		expect(image.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("finds files by glob, honoring .gitignore in repositories", async () => {
		await client.ok("bash", {
			command:
				"mkdir -p repo/src/pkg repo/build && (cd repo && git init -q . && echo build/ > .gitignore && touch src/a.py src/pkg/b.py build/c.py README.md)",
		});
		const found = await client.ok("glob", { pattern: "**/*.py", path: "repo" });
		expect(found).toContain(`${dir}/repo/src/a.py`);
		expect(found).toContain(`${dir}/repo/src/pkg/b.py`);
		expect(found).not.toContain("build/c.py");
		const ignored = await client.ok("glob", { pattern: "**/*.py", path: "repo", include_ignored: true });
		expect(ignored).toContain(`${dir}/repo/build/c.py`);
		const scoped = await client.ok("glob", { pattern: "repo/src/*.py" });
		expect(scoped.split("\n").slice(1)).toEqual([`${dir}/repo/src/a.py`]);
		expect(await client.ok("glob", { pattern: "**/*.nothing" })).toMatch(/^No files match/);
	});

	it("searches file contents", async () => {
		await client.ok("write", { file_path: "repo/src/a.py", content: "def alpha():\n    return 'Needle'\n" });
		await client.ok("write", { file_path: "repo/src/pkg/b.py", content: "NEEDLE = 1\nneedle = 2\n" });
		const files = await client.ok("grep", { pattern: "needle", path: "repo", case_insensitive: true });
		expect(files.split("\n").sort()).toEqual([`${dir}/repo/src/a.py`, `${dir}/repo/src/pkg/b.py`]);
		const content = await client.ok("grep", { pattern: "^needle", path: "repo", output_mode: "content" });
		expect(content).toBe(`${dir}/repo/src/pkg/b.py:2:needle = 2`);
		const counts = await client.ok("grep", { pattern: "needle", path: "repo", output_mode: "count", case_insensitive: true });
		expect(counts).toContain(`${dir}/repo/src/pkg/b.py:2`);
		expect(await client.ok("grep", { pattern: "absent-text", path: "repo" })).toMatch(/^No matches/);
		const limited = await client.ok("grep", { pattern: ".", path: "notes", output_mode: "content", head_limit: 5 });
		expect(limited).toMatch(/results cut at 5 lines/);
	});

	it("keeps working after the working directory is deleted", async () => {
		await client.ok("bash", { command: "mkdir -p doomed && cd doomed" });
		await client.ok("bash", { command: "rm -rf doomed", cwd: dir });
		const found = await client.ok("grep", { pattern: "needle", path: `${dir}/repo`, case_insensitive: true, type: "py" });
		expect(found).toContain(`${dir}/repo/src/a.py`);
		expect(await client.ok("job_status", {})).toMatch(/background jobs? on|No background jobs/);
		const reset = await client.ok("bash", { command: "pwd" });
		expect(reset).toMatch(/no longer exists; ran in/);
		await client.ok("bash", { command: `cd ${dir}` });
	});

	it("survives the daemon dying: the next call reconnects", async () => {
		// Kill the daemon that runs this very command.
		const killed = await client.call("bash", { command: "kill -9 $PPID; sleep 5" });
		expect(killed.isError).toBe(true);
		expect(killed.text).toMatch(/connection to .* was lost/);
		const after = await client.ok("bash", { command: "pwd" });
		expect(after.trim()).toBe(dir);
	});
});
