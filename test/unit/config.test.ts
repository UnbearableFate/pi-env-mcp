import { describe, expect, it } from "vitest";
import { describeTarget, hostKeyAlias, parseConfig, sshOptions, validateHostName } from "../../src/config.ts";
import { HostManager } from "../../src/session.ts";

const quiet = { debug() {}, info() {}, warn() {} };

describe("configuration", () => {
	it("accepts a valid configuration and rejects malformed fields", () => {
		const config = parseConfig({ defaultHost: "gpu", hosts: { gpu: { host: "gpu.example.org", port: 2222, env: { A: "1" } } } });
		expect(config.hosts.gpu?.port).toBe(2222);
		expect(() => parseConfig({ hosts: { gpu: { port: "22" } } })).toThrow(/port/);
		expect(() => parseConfig({ hosts: { gpu: { env: { A: 1 } } } })).toThrow(/env/);
		expect(() => parseConfig({ hosts: { "-bad": {} } })).toThrow(/Invalid host name/);
		expect(() => parseConfig({ output: { maxBytes: 0 } })).toThrow(/positive integer/);
	});

	it("validates host names", () => {
		expect(() => validateHostName("devbox")).not.toThrow();
		expect(() => validateHostName("a/b")).toThrow();
		expect(() => validateHostName("")).toThrow();
	});

	it("builds pi-env SSH options with this tool's known-hosts file and alias", () => {
		const options = sshOptions("/cfg", "gpu", { host: "gpu.example.org", user: "me", port: 2222 });
		expect(options).toMatchObject({
			host: "gpu.example.org",
			user: "me",
			port: 2222,
			knownHostsFile: "/cfg/known_hosts",
			hostKeyAlias: hostKeyAlias("gpu"),
			loginShell: true,
		});
		expect(describeTarget("gpu", { host: "gpu.example.org", user: "me", port: 2222 })).toBe("me@gpu.example.org:2222");
	});
});

describe("HostManager host selection", () => {
	it("defaults to the only host, or the configured default", () => {
		const single = new HostManager({ configDir: "/cfg", config: { hosts: { a: {} } }, log: quiet });
		expect(single.resolveName(undefined)).toBe("a");
		const several = new HostManager({ configDir: "/cfg", config: { hosts: { a: {}, b: {} } }, log: quiet });
		expect(() => several.resolveName(undefined)).toThrow(/Several hosts.*a, b/);
		const withDefault = new HostManager({ configDir: "/cfg", config: { defaultHost: "b", hosts: { a: {}, b: {} } }, log: quiet });
		expect(withDefault.resolveName(undefined)).toBe("b");
		expect(() => withDefault.resolveName("c")).toThrow(/Unknown host "c"\. Available: a, b/);
	});

	it("offers only the hosts named on the command line, unknown names as SSH aliases", () => {
		const manager = new HostManager({ configDir: "/cfg", config: { hosts: { a: { cwd: "/x" }, b: {} } }, hosts: ["b", "adhoc"], log: quiet });
		expect(manager.names()).toEqual(["b", "adhoc"]);
		expect(manager.resolveName(undefined)).toBe("b");
		expect(manager.hostConfig("adhoc")).toEqual({});
		expect(() => manager.resolveName("a")).toThrow(/Unknown host/);
	});

	it("tells the agent how to configure a host when there is none", () => {
		const empty = new HostManager({ configDir: "/cfg", config: { hosts: {} }, log: quiet });
		expect(() => empty.resolveName(undefined)).toThrow(/pi-env-mcp add <name>/);
	});
});
