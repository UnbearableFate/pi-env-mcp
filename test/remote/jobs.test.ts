import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logServerOnFailure, prepareConfig, sleep, TEST_HOST, TestClient } from "./helpers.ts";

const JOB_ID = /Started background job (job-[0-9a-f]+)/;

async function waitForState(client: TestClient, jobId: string, pattern: RegExp, timeoutMs = 20_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = await client.ok("job_status", { job_id: jobId });
		if (pattern.test(status.split("\n")[0]!)) return status;
		if (Date.now() > deadline) throw new Error(`job ${jobId} never matched ${pattern}:\n${status}`);
		await sleep(300);
	}
}

describe.skipIf(TEST_HOST === undefined)(`background jobs on ${TEST_HOST}`, () => {
	const host = TEST_HOST!;
	let configDir: string;
	let client: TestClient;
	const started: string[] = [];

	const start = async (command: string): Promise<string> => {
		const text = await client.ok("bash", { command, run_in_background: true });
		const id = JOB_ID.exec(text)?.[1];
		if (id === undefined) throw new Error(`no job id in: ${text}`);
		started.push(id);
		return id;
	};

	logServerOnFailure(() => client);

	beforeAll(async () => {
		configDir = prepareConfig(host);
		client = await new TestClient(configDir).connect();
		await client.ok("bash", { command: "cd /tmp" });
	});

	afterAll(async () => {
		for (const id of started) await client?.call("job_kill", { job_id: id, signal: "KILL", remove: true });
		await client?.close();
		rmSync(configDir, { recursive: true, force: true });
	});

	it("runs a job to completion and shows its output and exit code", async () => {
		const id = await start("for i in 1 2 3; do echo tick $i; sleep 0.3; done; echo done >&2; exit 4");
		const running = await client.ok("job_status", { job_id: id });
		expect(running).toMatch(/running for|exited/);
		const finished = await waitForState(client, id, /exited with code 4/);
		expect(finished).toContain("tick 1\ntick 2\ntick 3\ndone");
		expect(finished).toContain("cwd: /tmp");
		const list = await client.ok("job_status", {});
		expect(list).toContain(`${id}  exited with code 4`);
	});

	it("reads output incrementally from an offset", async () => {
		const id = await start("echo first; sleep 1.5; echo second");
		let early = "";
		for (const deadline = Date.now() + 10_000; !early.includes("first\n") && Date.now() < deadline; await sleep(100)) {
			early = await client.ok("job_status", { job_id: id, offset: 0 });
		}
		expect(early).toContain("first");
		const next = Number(/next_offset: (\d+)/.exec(early)?.[1]);
		expect(next).toBe(6);
		await waitForState(client, id, /exited with code 0/);
		const later = await client.ok("job_status", { job_id: id, offset: next });
		const output = later.slice(later.indexOf("[output bytes"));
		expect(output).toMatch(/^\[output bytes 6-13 of 13\]\nsecond\n\[next_offset: 13\]$/);
	});

	it("delivers SIGINT to the job, like Ctrl-C", async () => {
		const id = await start("trap 'echo got INT; exit 7' INT; echo ready; while true; do sleep 0.1; done");
		await waitForState(client, id, /running/);
		await sleep(500);
		const killed = await client.ok("job_kill", { job_id: id, signal: "INT" });
		expect(killed).toMatch(/Sent SIGINT/);
		const status = await waitForState(client, id, /exited with code 7/);
		expect(status).toContain("got INT");
	});

	it("stops a job's whole process group with TERM and removes its record", async () => {
		const id = await start("sleep 300 & sleep 300; wait");
		await waitForState(client, id, /running/);
		const killed = await client.ok("job_kill", { job_id: id, remove: true });
		expect(killed).toMatch(/Sent SIGTERM/);
		expect(killed).toMatch(/Removed its record/);
		const gone = await client.call("job_status", { job_id: id });
		expect(gone.isError).toBe(true);
		expect(gone.text).toMatch(/No job/);
		// No `sleep 300` of that job is left.
		const orphans = await client.ok("bash", { command: `ps -eo args | grep -c '[s]leep 300' || true` });
		expect(orphans.trim()).toBe("0");
	});

	it("keeps running when the connection and the server go away", async () => {
		const id = await start("sleep 3; echo survived");
		await waitForState(client, id, /running/);
		// Restart the server: its connection and daemon end, which kills foreground commands but not jobs.
		await client.close();
		client = await new TestClient(configDir).connect();
		expect(await client.ok("job_status", { job_id: id })).toMatch(/running/);
		const status = await waitForState(client, id, /exited with code 0/);
		expect(status).toContain("survived");
	});

	it("waits for a job to end when asked to", async () => {
		const id = await start("sleep 1.5; echo waited");
		const started = Date.now();
		const status = await client.ok("job_status", { job_id: id, wait: 30 });
		expect(status.split("\n")[0]).toMatch(/exited with code 0/);
		expect(status).toContain("waited");
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("leaves no record of a job that could not start", async () => {
		const before = await client.ok("job_status", {});
		const failed = await client.call("bash", { command: "true", run_in_background: true, cwd: "/no/such/dir" });
		expect(failed.isError).toBe(true);
		expect(failed.text).toMatch(/Working directory does not exist/);
		expect(await client.ok("job_status", {})).toBe(before);
	});

	it("rejects job ids that are not job ids", async () => {
		const result = await client.call("job_status", { job_id: "../../etc" });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/Invalid job id/);
	});
});
