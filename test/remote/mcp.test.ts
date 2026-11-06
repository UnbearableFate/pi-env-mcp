import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, logServerOnFailure, prepareConfig, sleep, TEST_HOST, TestClient } from "./helpers.ts";

const run = promisify(execFile);
const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "mcp_server.py"), "utf8");

/**
 * Run the CLI on the test's configuration; resolves with its exit code and output either way. The configuration
 * directory comes first (after `--` it would be the server's argument) and also by environment, so a mistake here can
 * never reach the user's own configuration.
 */
async function pi(configDir: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await run(process.execPath, [cli, "--config-dir", configDir, ...args], {
			timeout: 120_000,
			env: { ...process.env, PI_ENV_MCP_HOME: configDir },
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failed = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
	}
}

describe.skipIf(TEST_HOST === undefined)(`MCP servers on ${TEST_HOST}`, () => {
	const host = TEST_HOST!;
	let configDir: string;
	let client: TestClient;

	logServerOnFailure(() => client);

	beforeAll(async () => {
		configDir = prepareConfig(host);
		process.env.PI_ENV_MCP_TEST_VAR = "from the agent's side";
		const added = await pi(
			configDir,
			"mcp",
			"add",
			"fixture",
			"--host",
			host,
			"--cwd",
			"/tmp",
			"--env",
			"FIXTURE_VAR=${PI_ENV_MCP_TEST_VAR}",
			"--description",
			"Test fixture",
			"--",
			"python3",
			"-u",
			"-c",
			FIXTURE,
			"two words",
			"--quote='x' \"y\" $HOME",
		);
		expect(added.stdout).toContain(`Added MCP server "fixture" (runs on ${host})`);
		// A short request timeout, as `mcp add` (like pi's) leaves timeouts to the file: long calls must live on progress.
		const file = join(configDir, "config.json");
		const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: { fixture: { timeout?: number } } };
		config.mcpServers.fixture.timeout = 3;
		writeFileSync(file, JSON.stringify(config, null, 2));
		client = await new TestClient(configDir).connect();
	});

	afterAll(async () => {
		await client?.close();
		rmSync(configDir, { recursive: true, force: true });
	});

	it("lists the remote server's tools next to its own, with their schemas as the server gave them", async () => {
		const { tools } = await client.client.listTools();
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("bash");
		expect(names).toEqual(expect.arrayContaining(["fixture__echo", "fixture__info", "fixture__slow", "fixture__quit"]));
		const echo = tools.find((tool) => tool.name === "fixture__echo")!;
		expect(echo.description).toBe("Echo text back.");
		expect(echo.inputSchema).toEqual({
			type: "object",
			properties: { text: { type: "string", description: "What to echo." } },
			required: ["text"],
		});
		expect(tools.find((tool) => tool.name === "fixture__info")?.annotations).toEqual({ readOnlyHint: true });
		const instructions = client.client.getInstructions() ?? "";
		expect(instructions).toContain(`fixture on ${host} (tools fixture__*): Test fixture`);
	});

	it("calls tools with the configured cwd, env and verbatim arguments", async () => {
		expect(await client.ok("fixture__echo", { text: "hello" })).toBe("hello");
		const result = await client.client.callTool({ name: "fixture__info", arguments: {} });
		expect(result.structuredContent).toMatchObject({
			cwd: "/tmp",
			var: "from the agent's side",
			argv: ["two words", "--quote='x' \"y\" $HOME"],
		});
	});

	it("passes error results through", async () => {
		const failed = await client.call("fixture__fail");
		expect(failed).toMatchObject({ isError: true, text: "it failed" });
	});

	it("forwards progress, and cancellation to the remote server", async () => {
		const progress: string[] = [];
		const result = await client.client.callTool({ name: "fixture__slow", arguments: { steps: 4 } }, undefined, {
			onprogress: (update) => progress.push(`${update.progress}/${update.total} ${update.message}`),
		});
		expect(result.content).toEqual([{ type: "text", text: "done after 4 steps" }]);
		expect(progress).toEqual(["1/4 step 1", "2/4 step 2", "3/4 step 3", "4/4 step 4"]);

		const controller = new AbortController();
		const slow = client.client.callTool({ name: "fixture__slow", arguments: { steps: 100 } }, undefined, {
			signal: controller.signal,
		});
		await sleep(400);
		controller.abort();
		await expect(slow).rejects.toThrow();
		expect(await client.ok("fixture__echo", { text: "still there" })).toBe("still there");
	});

	it("asks the server for progress even when the agent does not, so a long call outlives the request timeout", async () => {
		const result = await client.client.callTool({ name: "fixture__slow", arguments: { steps: 50 } }, undefined, {
			timeout: 30_000,
		});
		expect(result).toMatchObject({ content: [{ type: "text", text: "done after 50 steps" }] });
		expect(result.isError).toBeFalsy();
	});

	it("announces changed tools", async () => {
		let changed = 0;
		client.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
			changed++;
		});
		await client.ok("fixture__grow");
		for (let waited = 0; changed === 0 && waited < 5000; waited += 100) await sleep(100);
		expect(changed).toBeGreaterThan(0);
		const { tools } = await client.client.listTools();
		expect(tools.map((tool) => tool.name)).toContain("fixture__extra1");
	});

	it("starts a server that exited again on the next call, and shows it in hosts", async () => {
		const before = (await client.client.callTool({ name: "fixture__info", arguments: {} })).structuredContent as { pid: number };
		expect(await client.ok("fixture__quit")).toBe("bye");
		await sleep(1000);
		expect(await client.ok("hosts")).toMatch(/MCP server fixture: disconnected \(starts again on the next call\)/);
		const after = (await client.client.callTool({ name: "fixture__info", arguments: {} })).structuredContent as { pid: number };
		expect(after.pid).not.toBe(before.pid);
		expect(await client.ok("hosts")).toMatch(/MCP server fixture: connected, \d+ tools; its tools are fixture__\*/);
	});

	it("starts the servers again on the new connection after hosts reconnects", async () => {
		const before = (await client.client.callTool({ name: "fixture__info", arguments: {} })).structuredContent as { pid: number };
		const report = await client.ok("hosts", { reconnect: true });
		expect(report).toMatch(/MCP server fixture: connected, \d+ tools/);
		const after = (await client.client.callTool({ name: "fixture__info", arguments: {} })).structuredContent as { pid: number };
		expect(after.pid).not.toBe(before.pid);
	});

	it("mcp list reports servers and fails when one does not start, as pi mcp list does", async () => {
		const good = await pi(configDir, "mcp", "list");
		expect(good.code).toBe(0);
		expect(good.stdout).toContain(`fixture: connected, 6 tools (on ${host})`);
		expect(good.stdout).toContain("tools (offered as fixture__<tool>): echo, info, slow, fail, quit, grow");

		await pi(configDir, "mcp", "add", "broken", "--host", host, "--", "/nonexistent/mcp-server");
		const bad = await pi(configDir, "mcp", "list", "--json");
		expect(bad.code).toBe(1);
		const report = JSON.parse(bad.stdout) as { servers: { name: string; state: string; error?: string }[] };
		expect(report.servers.find((server) => server.name === "broken")).toMatchObject({ state: "failed" });
		expect(report.servers.find((server) => server.name === "fixture")).toMatchObject({ state: "connected" });

		const removed = await pi(configDir, "mcp", "remove", "broken");
		expect(removed.code).toBe(0);
		expect((await pi(configDir, "mcp", "remove", "broken")).code).toBe(1);
	});
});
