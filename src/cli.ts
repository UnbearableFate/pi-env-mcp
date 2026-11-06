#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { HostKeyChangedError } from "@earendil-works/pi-env";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { validateMcpServerConfig } from "@earendil-works/pi-mcp";
import {
	configFile,
	defaultConfigDir,
	describeTarget,
	type HostConfig,
	loadConfig,
	mcpServers,
	saveConfig,
	sshOptions,
	validateHostName,
} from "./config.ts";
import { errorMessage, formatDuration, shellQuote } from "./lib/util.ts";
import { RemoteMcpServer, RemoteMcpServers } from "./mcp.ts";
import { createServer, describeMcpServer } from "./server.ts";
import { contextFor, HostManager, stderrLogger } from "./session.ts";
import { forgetHostKey, scanHost, trustHostKey } from "./trust.ts";
import { VERSION } from "./version.ts";

/**
 * How long `serve` waits for its MCP servers to start before it answers the agent, so their tools and instructions are
 * there from the start; later ones are announced with tools/list_changed. Below Codex's default startup timeout (10 s).
 */
const DEFAULT_MCP_WAIT_SECONDS = 8;

const USAGE = `pi-env-mcp: an MCP server for persistent access to remote machines over SSH, through the pi-env daemon.

Usage:
  pi-env-mcp [serve] [--host NAME]... [--mcp-wait SECONDS]
                                        Run the MCP server on stdin/stdout (what agents start).
                                        --host offers only these hosts; the first is the default. A name
                                        that is not configured is used as an SSH host or ~/.ssh/config alias.
                                        The MCP servers configured on its hosts start with it; it waits up
                                        to --mcp-wait seconds (default ${DEFAULT_MCP_WAIT_SECONDS}) for them before answering.
  pi-env-mcp add NAME [options]         Add a host, or update one.
      --host SSH_HOST        SSH host name or ~/.ssh/config alias (default: NAME)
      --user USER  --port PORT  --identity FILE  --ssh-config FILE
      --cwd DIR              Initial working directory on the host (default: the remote home)
      --env KEY=VALUE        Environment variable for every command (repeatable)
      --no-login-shell       Do not start the daemon through the login shell
      --source-bashrc        Let bash source ~/.bashrc before each command (slower)
      --share-connection     Connect through your own ssh ControlMaster connection, opened with
                             ssh -fN SSH_HOST (for hosts that ask for a passphrase or one-time password)
      --default              Make this the default host
  pi-env-mcp trust NAME [--yes] [--replace]
                                        Scan the host's SSH key, compare it with ~/.ssh/known_hosts, and trust it.
  pi-env-mcp check NAME                 Connect (deploying the daemon if needed) and report what the host says.
  pi-env-mcp list                       List configured hosts.
  pi-env-mcp remove NAME                Remove a host and forget its key.

MCP servers on the hosts (their tools are offered by serve, named <server>__<tool>):
  pi-env-mcp mcp add SERVER [options] -- COMMAND [ARGS...]
                                        Add or replace a stdio MCP server that runs on a host.
      --host NAME            Host it runs on (default: the default host)
      --env KEY=VALUE        Environment variable for the server (repeatable; \${NAME} is taken from here)
      --cwd DIR              Working directory on the host (default: the host's cwd, else the remote home)
      --description TEXT     What the server offers, shown to the agent
  pi-env-mcp mcp remove SERVER          Remove an MCP server.
  pi-env-mcp mcp list [--json]          Start every enabled MCP server and print its state, tools and errors;
                                        exit with 1 when an entry is invalid or an enabled server is not connected.

Options for every command:
  --config-dir DIR    Configuration directory (default: $PI_ENV_MCP_HOME or ~/.config/pi-env-mcp)
  --verbose           Log connection details to stderr
`;

function fail(message: string): never {
	process.stderr.write(`pi-env-mcp: ${message}\n`);
	process.exit(1);
}

async function confirm(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const prompt = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
	} finally {
		prompt.close();
	}
}

async function serve(configDir: string, hosts: string[], verbose: boolean, mcpWaitSeconds: number): Promise<void> {
	const log = stderrLogger(verbose);
	const config = await loadConfig(configDir);
	const manager = new HostManager({ configDir, config, hosts, log });
	const entries = mcpServers(config);
	for (const error of entries.errors) log.warn(`mcpServers: ${error}`);
	const mcp = new RemoteMcpServers({ manager, entries, log });
	let stopping = false;
	const stop = async (reason: string) => {
		if (stopping) return;
		stopping = true;
		log.debug(`stopping: ${reason}`);
		// Terminals die with the connections; detached background jobs keep running.
		const forced = setTimeout(() => process.exit(0), 5000);
		forced.unref();
		// MCP servers first, while their connections are up: stdin closed, then killed if they do not exit.
		await mcp.closeAll();
		await manager.closeAll();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGHUP", () => void stop("SIGHUP"));
	process.stdin.on("end", () => void stop("stdin closed"));
	process.on("unhandledRejection", (error) => log.warn(`unhandled rejection: ${errorMessage(error)}`));
	if (mcp.servers.length > 0) {
		await mcp.ready(mcpWaitSeconds * 1000);
		for (const remote of mcp.servers) {
			if (remote.state !== "connected") log.warn(`MCP server ${remote.name} on ${remote.host}: ${describeMcpServer(remote)}${remote.error === undefined ? "" : `: ${remote.error}`}`);
		}
	}
	if (stopping) return;
	const { server } = createServer({ manager, mcp });
	await server.connect(new StdioServerTransport());
	log.debug(`serving ${manager.names().join(", ") || "no hosts"} (config ${configFile(configDir)})`);
}

async function add(configDir: string, name: string, values: Record<string, unknown>): Promise<void> {
	validateHostName(name);
	const config = await loadConfig(configDir);
	const host: HostConfig = { ...config.hosts[name] };
	if (typeof values.host === "string") host.host = values.host;
	if (typeof values.user === "string") host.user = values.user;
	if (typeof values.port === "string") {
		const port = Number(values.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port ${values.port}`);
		host.port = port;
	}
	if (typeof values.identity === "string") host.identityFile = values.identity;
	if (typeof values["ssh-config"] === "string") host.sshConfig = values["ssh-config"];
	if (typeof values.cwd === "string") host.cwd = values.cwd;
	if (values["no-login-shell"] === true) host.loginShell = false;
	if (values["source-bashrc"] === true) host.sourceBashrc = true;
	if (values["share-connection"] === true) host.shareConnection = true;
	if (Array.isArray(values.env)) {
		host.env = { ...host.env };
		for (const pair of values.env as string[]) {
			const equals = pair.indexOf("=");
			if (equals <= 0) fail(`--env needs KEY=VALUE, got ${pair}`);
			host.env[pair.slice(0, equals)] = pair.slice(equals + 1);
		}
	}
	const existed = config.hosts[name] !== undefined;
	config.hosts[name] = host;
	if (values.default === true || Object.keys(config.hosts).length === 1) config.defaultHost = name;
	await saveConfig(configDir, config);
	process.stdout.write(`${existed ? "Updated" : "Added"} ${name} (ssh ${describeTarget(name, host)}) in ${configFile(configDir)}.\n`);
	process.stdout.write(`Next: pi-env-mcp trust ${name}   (then: pi-env-mcp check ${name})\n`);
}

async function trust(configDir: string, name: string, yes: boolean, replace: boolean): Promise<void> {
	const config = await loadConfig(configDir);
	const host = config.hosts[name] ?? {};
	validateHostName(name);
	const target = sshOptions(configDir, name, host);
	process.stdout.write(`Scanning the SSH host key of ${name} (ssh ${describeTarget(name, host)})...\n`);
	const scan = await scanHost(target);
	for (const fingerprint of scan.fingerprints) process.stdout.write(`  ${fingerprint}\n`);
	let accepted = yes;
	if (scan.verdict === "match") {
		process.stdout.write(`This is the key your own ~/.ssh/known_hosts records for ${scan.lookupName}.\n`);
		accepted = true;
	} else if (scan.verdict === "mismatch") {
		process.stdout.write(
			`WARNING: your ~/.ssh/known_hosts records a DIFFERENT key for ${scan.lookupName}. The host may have been reinstalled, or someone may be intercepting the connection.\n`,
		);
		if (!yes) fail("not trusted. Verify the key with the host's administrator; rerun with --yes to trust it anyway.");
	} else if (!yes) {
		process.stdout.write(
			`Your ~/.ssh/known_hosts has no key of this type for ${scan.lookupName}. Compare the fingerprint with one obtained another way (e.g. ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on the host).\n`,
		);
		accepted = await confirm("Trust this key?");
		if (!accepted && !process.stdin.isTTY) fail("not trusted (no terminal to confirm on); rerun with --yes to trust it.");
	}
	if (!accepted) fail("not trusted.");
	try {
		await trustHostKey(target, scan.lines, replace);
	} catch (error) {
		if (error instanceof HostKeyChangedError) {
			fail(`${error.message}. If the change is expected, rerun with --replace to forget the old key.`);
		}
		throw error;
	}
	process.stdout.write(`Trusted. pi-env-mcp can now connect to ${name}${config.hosts[name] ? "" : " (not in the configuration: pass --host " + name + " to serve, or run pi-env-mcp add)"}.\n`);
}

async function check(configDir: string, name: string, verbose: boolean): Promise<void> {
	const config = await loadConfig(configDir);
	const manager = new HostManager({ configDir, config, hosts: [name], log: stderrLogger(verbose) });
	const started = Date.now();
	try {
		const session = await manager.session(name);
		const connected = Date.now() - started;
		const info = session.info;
		const timings: number[] = [];
		for (let index = 0; index < 5; index++) {
			const before = performance.now();
			await session.capture(["true"]);
			timings.push(performance.now() - before);
		}
		const shellStart = performance.now();
		const shell = await session.env.exec("echo ok", {}, contextFor());
		const shellMs = performance.now() - shellStart;
		const lines = [
			`${name}: connected in ${formatDuration(connected)} (ssh ${describeTarget(name, session.config)})`,
			`  system:      ${info.os} ${info.arch}, hostname ${session.hostname}`,
			`  home:        ${info.home}; working directory ${session.cwd}`,
			`  daemon:      pi-env ${info.version} (protocol ${info.protocol}, pid ${info.pid}, features: ${(info.features ?? []).join(", ") || "none"})`,
			`  ripgrep:     ${(await session.hasRipgrep()) ? "installed" : "not installed (grep falls back to grep -E)"}`,
			`  latency:     ${Math.min(...timings).toFixed(1)} ms per command without a shell, ${shellMs.toFixed(1)} ms with bash${shell.ok ? "" : " (failed)"}`,
		];
		process.stdout.write(`${lines.join("\n")}\n`);
	} finally {
		await manager.closeAll();
	}
}

async function list(configDir: string): Promise<void> {
	const config = await loadConfig(configDir);
	const names = Object.keys(config.hosts);
	if (names.length === 0) {
		process.stdout.write(`No hosts configured (${configFile(configDir)}). Add one with: pi-env-mcp add NAME --host SSH_HOST\n`);
		return;
	}
	for (const name of names) {
		const host = config.hosts[name]!;
		const flags = [
			name === config.defaultHost ? "default" : undefined,
			host.cwd === undefined ? undefined : `cwd ${host.cwd}`,
			host.loginShell === false ? "no login shell" : undefined,
			host.shareConnection === true ? "shared connection" : undefined,
		].filter((flag) => flag !== undefined);
		process.stdout.write(`${name}\tssh ${describeTarget(name, host)}${flags.length ? `\t(${flags.join(", ")})` : ""}\n`);
	}
}

async function remove(configDir: string, name: string): Promise<void> {
	const config = await loadConfig(configDir);
	if (config.hosts[name] === undefined) fail(`no host named ${name}`);
	const target = sshOptions(configDir, name, config.hosts[name]);
	delete config.hosts[name];
	if (config.defaultHost === name) delete config.defaultHost;
	await saveConfig(configDir, config);
	await forgetHostKey(target);
	process.stdout.write(`Removed ${name} and forgot its host key.\n`);
}

/** `KEY=VALUE` pairs of a repeatable option. */
function pairs(option: string, values: readonly string[] | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const pair of values ?? []) {
		const equals = pair.indexOf("=");
		if (equals <= 0) fail(`--${option} needs KEY=VALUE, got ${pair}`);
		result[pair.slice(0, equals)] = pair.slice(equals + 1);
	}
	return result;
}

const MCP_ADD_USAGE = "usage: pi-env-mcp mcp add SERVER [--host NAME] [--env KEY=VALUE]... [--cwd DIR] [--description TEXT] -- COMMAND [ARGS...]";

/** `pi-env-mcp mcp add`: like `pi mcp add` for stdio servers, plus the host the server runs on. Does not connect. */
async function mcpAdd(configDir: string, name: string | undefined, command: string[], values: Record<string, unknown>): Promise<void> {
	if (name === undefined || command.length === 0) fail(MCP_ADD_USAGE);
	const config = await loadConfig(configDir);
	const hostNames = Object.keys(config.hosts);
	const hosts = values.host as string[] | undefined;
	const host = hosts?.at(-1) ?? config.defaultHost ?? (hostNames.length === 1 ? hostNames[0] : undefined);
	if (host === undefined) fail(`pass --host NAME: there is no default host to run "${name}" on`);
	validateHostName(host);
	const env = pairs("env", values.env as string[] | undefined);
	const [executable, ...args] = command as [string, ...string[]];
	const entry: Record<string, unknown> = {
		command: executable,
		...(args.length > 0 ? { args } : {}),
		...(Object.keys(env).length > 0 ? { env } : {}),
		...(typeof values.cwd === "string" ? { cwd: values.cwd } : {}),
		...(typeof values.description === "string" ? { description: values.description } : {}),
		runOn: { host },
	};
	const validated = validateMcpServerConfig(name, entry);
	if (validated.kind === "invalid") fail(validated.error);
	const replaced = config.mcpServers?.[name] !== undefined;
	config.mcpServers = { ...config.mcpServers, [name]: entry };
	const problem = mcpServers(config).errors.find((error) => error.startsWith(`server "${name}"`));
	if (problem !== undefined) fail(problem);
	await saveConfig(configDir, config);
	process.stdout.write(`${replaced ? "Replaced" : "Added"} MCP server "${name}" (runs on ${host}) in ${configFile(configDir)}.\n`);
	if (config.hosts[host] === undefined) {
		process.stdout.write(`${host} is not a configured host: serve offers it only with --host ${host} (trust it first with: pi-env-mcp trust ${host}).\n`);
	}
	process.stdout.write("Check it with: pi-env-mcp mcp list\n");
}

async function mcpRemove(configDir: string, name: string | undefined): Promise<void> {
	if (name === undefined) fail("usage: pi-env-mcp mcp remove SERVER");
	const config = await loadConfig(configDir);
	if (config.mcpServers?.[name] === undefined) fail(`No MCP server named "${name}" in ${configFile(configDir)}.`);
	const { [name]: _removed, ...others } = config.mcpServers;
	config.mcpServers = others;
	await saveConfig(configDir, config);
	process.stdout.write(`Removed MCP server "${name}" from ${configFile(configDir)}.\n`);
}

/** One server in `mcp list`, as `pi mcp list` reports it, with the host it runs on. */
interface McpReport {
	name: string;
	host: string;
	enabled: boolean;
	transport: string;
	state: string;
	tools: string[];
	error?: string;
}

/** `pi-env-mcp mcp list`: start every enabled server, report, stop it again; exit 1 on any failure, as pi does. */
async function mcpList(configDir: string, json: boolean, verbose: boolean): Promise<number> {
	const config = await loadConfig(configDir);
	const entries = mcpServers(config);
	const hosts = [...new Set([...Object.keys(config.hosts), ...entries.servers.map((entry) => entry.host)])];
	const log = stderrLogger(verbose);
	const manager = new HostManager({ configDir, config, ...(hosts.length > 0 ? { hosts } : {}), log });
	let reports: McpReport[];
	try {
		reports = await Promise.all(
			entries.servers.map(async (entry): Promise<McpReport> => {
				const { command, args = [], cwd } = entry.config;
				const report: McpReport = {
					name: entry.name,
					host: entry.host,
					enabled: entry.enabled,
					transport: `stdio: ${[command, ...args].map((word) => (/^[\w@%+=:,./~-]+$/.test(word) ? word : shellQuote(word))).join(" ")}${cwd === undefined ? "" : ` (in ${cwd})`}`,
					state: "disabled",
					tools: [],
				};
				if (!entry.enabled) return report;
				const server = new RemoteMcpServer({ entry, manager, log });
				try {
					await server.getClient();
				} catch {
					// The server records its state and error.
				}
				report.state = server.state;
				report.tools = server.tools.map((tool) => tool.name);
				if (server.state !== "connected" && server.error !== undefined) report.error = server.error;
				await server.close();
				return report;
			}),
		);
	} finally {
		await manager.closeAll();
	}
	const failed = entries.errors.length > 0 || reports.some((report) => report.enabled && report.state !== "connected");
	if (json) {
		process.stdout.write(`${JSON.stringify({ servers: reports, errors: entries.errors }, null, 2)}\n`);
		return failed ? 1 : 0;
	}
	if (reports.length === 0 && entries.errors.length === 0) {
		process.stdout.write(`No MCP servers configured. Add one with: pi-env-mcp mcp add SERVER --host NAME -- COMMAND [ARGS...]\n`);
	}
	for (const report of reports) {
		const state =
			report.state === "connected" ? `connected, ${report.tools.length} tool${report.tools.length === 1 ? "" : "s"}` : report.state;
		process.stdout.write(`${report.name}: ${state} (on ${report.host})\n`);
		process.stdout.write(`  ${report.transport}\n`);
		if (report.tools.length > 0) {
			process.stdout.write(`  tools (offered as ${report.name.replace(/[^A-Za-z0-9_]/g, "_")}__<tool>): ${report.tools.join(", ")}\n`);
		}
		if (report.error !== undefined) process.stdout.write(`  ${report.error.split("\n").join("\n  ")}\n`);
	}
	for (const error of entries.errors) process.stdout.write(`config error: ${error}\n`);
	return failed ? 1 : 0;
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		options: {
			"config-dir": { type: "string" },
			verbose: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean" },
			host: { type: "string", multiple: true },
			user: { type: "string" },
			port: { type: "string" },
			identity: { type: "string" },
			"ssh-config": { type: "string" },
			cwd: { type: "string" },
			env: { type: "string", multiple: true },
			"no-login-shell": { type: "boolean" },
			"source-bashrc": { type: "boolean" },
			"share-connection": { type: "boolean" },
			default: { type: "boolean" },
			yes: { type: "boolean", short: "y" },
			replace: { type: "boolean" },
			description: { type: "string" },
			json: { type: "boolean" },
			"mcp-wait": { type: "string" },
		},
	});
	if (values.help) {
		process.stdout.write(USAGE);
		return;
	}
	if (values.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	const configDir = values["config-dir"] ?? defaultConfigDir();
	const verbose = values.verbose === true || process.env.PI_ENV_MCP_DEBUG === "1";
	const [command = "serve", name, ...rest] = positionals;
	if (command === "mcp") {
		const [server, ...more] = rest;
		switch (name) {
			case "add":
				await mcpAdd(configDir, server, more, values);
				return;
			case "remove":
				if (more.length > 0) fail(`unexpected arguments: ${more.join(" ")}`);
				await mcpRemove(configDir, server);
				return;
			case "list":
				if (rest.length > 0) fail(`unexpected arguments: ${rest.join(" ")}`);
				process.exitCode = await mcpList(configDir, values.json === true, verbose);
				return;
			case undefined:
			case "help":
				process.stdout.write(USAGE);
				return;
			default:
				fail(`unknown command mcp ${name}; see pi-env-mcp --help`);
		}
	}
	if (rest.length > 0) fail(`unexpected arguments: ${rest.join(" ")}`);
	const needName = () => name ?? fail(`${command} needs a host name; see pi-env-mcp --help`);
	switch (command) {
		case "serve": {
			const wait = values["mcp-wait"] === undefined ? DEFAULT_MCP_WAIT_SECONDS : Number(values["mcp-wait"]);
			if (!(wait >= 0)) fail(`--mcp-wait needs a number of seconds, got ${values["mcp-wait"]}`);
			await serve(configDir, values.host ?? [], verbose, wait);
			return;
		}
		case "add": {
			const { host, ...others } = values;
			await add(configDir, needName(), { ...others, ...(host === undefined ? {} : { host: host.at(-1) }) });
			return;
		}
		case "trust":
			await trust(configDir, needName(), values.yes === true, values.replace === true);
			return;
		case "check":
			await check(configDir, needName(), verbose);
			return;
		case "list":
			await list(configDir);
			return;
		case "remove":
			await remove(configDir, needName());
			return;
		case "help":
			process.stdout.write(USAGE);
			return;
		default:
			fail(`unknown command ${command}; see pi-env-mcp --help`);
	}
}

main().catch((error: unknown) => fail(errorMessage(error)));
