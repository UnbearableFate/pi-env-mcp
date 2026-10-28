import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach } from "vitest";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The SSH host the remote tests run against, e.g. PI_ENV_MCP_TEST_HOST=devbox. */
export const TEST_HOST = process.env.PI_ENV_MCP_TEST_HOST;

/** The server under test: the sources, or a build given by PI_ENV_MCP_TEST_CLI (e.g. dist/cli.js). */
const cli = process.env.PI_ENV_MCP_TEST_CLI ?? join(import.meta.dirname, "..", "..", "src", "cli.ts");

/** A configuration directory with the test host added and its key trusted. */
export function prepareConfig(host: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-env-mcp-test-"));
	execFileSync(process.execPath, [cli, "add", host, "--config-dir", dir], { stdio: "pipe" });
	execFileSync(process.execPath, [cli, "trust", host, "--yes", "--config-dir", dir], { stdio: "pipe" });
	return dir;
}

export interface CallResult {
	text: string;
	isError: boolean;
	content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

export class TestClient {
	readonly client: Client;
	readonly #transport: StdioClientTransport;
	stderr = "";

	constructor(configDir: string, extraArgs: string[] = []) {
		this.#transport = new StdioClientTransport({
			command: process.execPath,
			args: [cli, "serve", "--config-dir", configDir, "--verbose", ...extraArgs],
			env: { ...process.env } as Record<string, string>,
			stderr: "pipe",
		});
		this.#transport.stderr?.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString("utf8");
		});
		this.client = new Client({ name: "pi-env-mcp-tests", version: "0" });
	}

	async connect(): Promise<this> {
		await this.client.connect(this.#transport);
		return this;
	}

	async call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
		const result = (await this.client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as {
			content: CallResult["content"];
			isError?: boolean;
		};
		const text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
		return { text, isError: result.isError === true, content: result.content };
	}

	/** Call a tool that must succeed; returns its text. */
	async ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
		const result = await this.call(name, args);
		if (result.isError) throw new Error(`${name} failed: ${result.text}`);
		return result.text;
	}

	async close(): Promise<void> {
		await this.client.close();
	}
}

/** Print the server's log after a failed test, so an intermittent failure explains itself. */
export function logServerOnFailure(current: () => TestClient | undefined): void {
	afterEach((context) => {
		const client = current();
		if (context.task.result?.state === "fail" && client !== undefined) {
			process.stderr.write(`\n--- server log for "${context.task.name}" ---\n${client.stderr.slice(-20_000)}\n---\n`);
		}
	});
}

/** Run a command on the test host with plain ssh, independent of the server under test. */
export function ssh(host: string, command: string): string {
	return execFileSync("ssh", ["-o", "BatchMode=yes", host, command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
