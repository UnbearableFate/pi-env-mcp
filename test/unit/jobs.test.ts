import { describe, expect, it } from "vitest";
import { parseStatus } from "../../src/jobs.ts";

/** A status line as the remote status script prints it. */
function line(fields: { pid?: string; started?: string; code?: string; ended?: string; alive?: string; killed?: string; createdAt: Date }): string {
	const meta = JSON.stringify({ id: "job-0a0b0c0d", command: "make", cwd: "/w", createdAt: fields.createdAt.toISOString() });
	const { pid = "", started = "", code = "", ended = "", alive = "0", killed = "" } = fields;
	return ["/s/jobs/h/job-0a0b0c0d", pid, started, code, ended, alive, "12", killed, meta].join("\t");
}

describe("parseStatus", () => {
	it("reads the state of a job from its status line", () => {
		const now = new Date();
		expect(parseStatus(line({ pid: "42", started: "100", alive: "1", createdAt: now }))).toMatchObject({
			id: "job-0a0b0c0d",
			state: "running",
			pid: 42,
			startedAt: 100,
			command: "make",
			cwd: "/w",
			logSize: 12,
		});
		expect(parseStatus(line({ pid: "42", code: "3", ended: "200", createdAt: now }))).toMatchObject({ state: "exited", exitCode: 3, endedAt: 200 });
		expect(parseStatus(line({ pid: "42", killed: "KILL", createdAt: now }))?.state).toBe("killed");
		expect(parseStatus(line({ pid: "42", createdAt: now }))?.state).toBe("lost");
	});

	it("counts a job without a pid as starting for a minute, then as never started", () => {
		expect(parseStatus(line({ createdAt: new Date() }))?.state).toBe("starting");
		expect(parseStatus(line({ createdAt: new Date(Date.now() - 5 * 60_000) }))?.state).toBe("lost");
	});
});
