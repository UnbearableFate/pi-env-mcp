import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logServerOnFailure, prepareConfig, TEST_HOST, TestClient } from "./helpers.ts";

describe.skipIf(TEST_HOST === undefined)(`terminals on ${TEST_HOST}`, () => {
	const host = TEST_HOST!;
	let configDir: string;
	let client: TestClient;
	let id: string;

	logServerOnFailure(() => client);

	beforeAll(async () => {
		configDir = prepareConfig(host);
		client = await new TestClient(configDir).connect();
	});

	afterAll(async () => {
		await client?.close();
		rmSync(configDir, { recursive: true, force: true });
	});

	it("opens a login shell and reports it at its prompt", async () => {
		const opened = await client.ok("terminal_open", { cwd: "/tmp" });
		id = /terminal (t\d+) on/.exec(opened)?.[1] ?? "";
		expect(id).toMatch(/^t\d+$/);
		expect(opened).toMatch(/shell at prompt/);
	});

	it("keeps shell state between calls, and returns promptly when a command finishes", async () => {
		await client.ok("terminal_send", { terminal_id: id, input: "export PI_ENV_MCP_T=kept; cd /tmp\n" });
		const started = Date.now();
		const echoed = await client.ok("terminal_send", { terminal_id: id, input: 'echo "value=$PI_ENV_MCP_T in $(pwd)"\n' });
		expect(Date.now() - started).toBeLessThan(1500);
		expect(echoed).toContain("value=kept in /tmp");
		expect(echoed).toMatch(/shell at prompt/);
	});

	it("drives an interactive program, matching prompts that end in a space", async () => {
		const started = Date.now();
		const python = await client.ok("terminal_send", { terminal_id: id, input: "python3 -q\n", wait_for: ">>> $" });
		expect(python).toMatch(/running python3 .*wait_for matched/);
		const answer = await client.ok("terminal_send", { terminal_id: id, input: "print(6 * 7)\n", wait_for: ">>> " });
		expect(answer).toMatch(/wait_for matched/);
		expect(answer).toContain("42");
		expect(Date.now() - started).toBeLessThan(8000);
		// Slow output: the prompt the input was typed at must not satisfy wait_for.
		const slow = await client.ok("terminal_send", {
			terminal_id: id,
			input: "import time; time.sleep(1.5); print('slow', 6 * 7)\n",
			wait_for: ">>> ",
		});
		expect(slow).toContain("slow 42");
		const exited = await client.ok("terminal_send", { terminal_id: id, keys: ["C-d"] });
		expect(exited).toMatch(/shell at prompt/);
	});

	it("interrupts a running command with C-c", async () => {
		const running = await client.ok("terminal_send", { terminal_id: id, input: "sleep 100\n", timeout: 1 });
		expect(running).toMatch(/running sleep/);
		const interrupted = await client.ok("terminal_send", { terminal_id: id, keys: ["C-c"] });
		expect(interrupted).toMatch(/shell at prompt/);
	});

	it("waits for slow output with terminal_read", async () => {
		await client.ok("terminal_send", { terminal_id: id, input: "sleep 1; echo slow-done\n", timeout: 0.3 });
		const read = await client.ok("terminal_read", { terminal_id: id, wait_for: "slow-done", timeout: 10 });
		expect(read).toContain("slow-done");
	});

	it("shows the screen of a full-screen program", async () => {
		await client.ok("terminal_send", { terminal_id: id, input: "seq 1 500 | less\n", wait_for: "^20$" });
		const screen = await client.ok("terminal_read", { terminal_id: id, screen: true });
		expect(screen).toMatch(/full screen 120x40/);
		expect(screen.split("\n")).toContain("1");
		const quit = await client.ok("terminal_send", { terminal_id: id, input: "q" });
		expect(quit).toMatch(/shell at prompt/);
	});

	it("lists open terminals and closes them", async () => {
		expect(await client.ok("hosts", {})).toContain(`terminals: ${id} (shell;`);
		expect(await client.ok("terminal_close", { terminal_id: id })).toContain(`Closed terminal ${id}`);
		const closed = await client.call("terminal_read", { terminal_id: id });
		expect(closed.isError).toBe(true);
		expect(closed.text).toMatch(/No terminal/);
	});

	it("types a first command once the shell is ready", async () => {
		const opened = await client.ok("terminal_open", { command: "python3 -q" });
		// The command ran in the shell, and the call waited for it: python is in front, showing its prompt.
		expect(opened).toMatch(/running python3/);
		expect(opened).toMatch(/\$ python3 -q\n>>>$/);
		const other = /terminal (t\d+) on/.exec(opened)?.[1];
		await client.ok("terminal_close", { terminal_id: other });
	});
});
