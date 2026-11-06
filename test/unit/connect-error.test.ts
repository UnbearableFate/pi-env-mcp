import { RemoteError, SshError } from "@earendil-works/pi-env";
import { describe, expect, it } from "vitest";
import { connectError } from "../../src/session.ts";

// What ssh prints when the master refuses another session and the connection of its own then cannot log in.
const FULL_MASTER = [
	"mux_client_request_session: session request failed: Session open refused by peer",
	"user@login.example.org: Permission denied (publickey,keyboard-interactive).",
].join("\n");

describe("connectError", () => {
	const shared = { host: "cluster", shareConnection: true };

	it("says a full master is full, not closed, when detecting the system fails", () => {
		const error = new SshError(`ssh cluster failed with exit code 255: ${FULL_MASTER}`, 255, FULL_MASTER);
		const message = connectError("hpc", shared, error).message;
		expect(message).toContain("is open but has no free session");
		expect(message).toContain("MaxSessions");
		expect(message).not.toMatch(/closed or expired|ssh -fN/);
	});

	it("says the same when starting the daemon fails", () => {
		const error = new RemoteError({
			code: "unknown",
			message: `pi-env exited with code 255 before it was ready\nremote stderr:\n${FULL_MASTER}`,
			lost: true,
		});
		expect(connectError("hpc", shared, error).message).toContain("is open but has no free session");
	});

	it("still points to an expired master, and to keys without one", () => {
		const denied = "user@login.example.org: Permission denied (publickey).";
		const failure = () => new SshError(`ssh cluster failed with exit code 255: ${denied}`, 255, denied);
		expect(connectError("hpc", shared, failure()).message).toContain("probably closed or expired");
		expect(connectError("hpc", { host: "cluster" }, failure()).message).toContain("Authentication failed");
	});
});
