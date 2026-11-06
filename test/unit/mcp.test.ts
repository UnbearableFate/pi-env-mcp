import { describe, expect, it } from "vitest";
import { type McpServerEntry, mcpServers, parseConfig } from "../../src/config.ts";
import { launchOf } from "../../src/mcp.ts";

function entry(config: Record<string, unknown>): McpServerEntry {
	return { name: "s", host: "h", config: { command: "srv", ...config }, enabled: true };
}

describe("mcpServers configuration", () => {
	it("checks entries one by one, as pi does, and places them on a host", () => {
		const config = parseConfig({
			defaultHost: "gpu",
			hosts: { gpu: {}, cpu: {} },
			mcpServers: {
				jobs: { command: "jobs-mcp", args: ["serve"], runOn: { host: "cpu" } },
				plain: { command: "plain-mcp" },
				off: { command: "off-mcp", enabled: false },
				web: { url: "https://example.org/mcp" },
				broken: { args: ["x"] },
				"bad-run": { command: "x", runOn: "cpu" },
				"jobs_": { command: "y" },
				jobs_mcp: { command: "a" },
				"jobs-mcp": { command: "b" },
			},
		});
		const { servers, errors } = mcpServers(config);
		expect(servers.map((server) => [server.name, server.host, server.enabled])).toEqual([
			["jobs", "cpu", true],
			["plain", "gpu", true],
			["off", "gpu", false],
			["jobs_", "gpu", true],
			["jobs_mcp", "gpu", true],
		]);
		expect(errors).toEqual([
			expect.stringMatching(/server "web": .*HTTP servers/),
			expect.stringMatching(/server "broken" needs either "command"/),
			expect.stringMatching(/server "bad-run": runOn must be/),
			expect.stringMatching(/server "jobs-mcp": its tools would be named like those of "jobs_mcp"/),
		]);
	});

	it("needs runOn when there is no default host", () => {
		const { errors } = mcpServers(parseConfig({ hosts: { a: {}, b: {} }, mcpServers: { s: { command: "x" } } }));
		expect(errors).toEqual([expect.stringMatching(/runOn is missing/)]);
	});

	it("refuses an mcpServers that is not an object", () => {
		expect(() => parseConfig({ mcpServers: [] })).toThrow(/mcpServers must be an object/);
	});
});

describe("launching a server on its host", () => {
	const host = { home: "/home/me", baseCwd: "/work/project", posix: true, env: { A: "host", B: "host" } };

	it("expands ~/ in the command, arguments and cwd, and resolves cwd against the host's", () => {
		const launch = launchOf(entry({ command: "~/bin/srv", args: ["~/data", "--x=~/no", "~"], cwd: "sub" }), host);
		expect(launch.argv).toEqual(["/home/me/bin/srv", "/home/me/data", "--x=~/no", "/home/me"]);
		expect(launch.cwd).toBe("/work/project/sub");
		expect(launchOf(entry({ cwd: "~/x" }), host).cwd).toBe("/home/me/x");
		expect(launchOf(entry({ cwd: "/abs" }), host).cwd).toBe("/abs");
		expect(launchOf(entry({}), host).cwd).toBe("/work/project");
	});

	it("adds the server's env over the host's, with ${NAME} from this process's environment", () => {
		const launch = launchOf(entry({ env: { B: "server", TOKEN: "Bearer ${SECRET}" } }), host, { SECRET: "s3" });
		expect(launch.env).toEqual({ A: "host", B: "server", TOKEN: "Bearer s3" });
		expect(() => launchOf(entry({ env: { T: "${MISSING}" } }), host, {})).toThrow(/MISSING \(in env.T\) is not set/);
	});
});
