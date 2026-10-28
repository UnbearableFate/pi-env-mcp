#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { HostKeyChangedError } from "@earendil-works/pi-env";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	configFile,
	defaultConfigDir,
	describeTarget,
	type HostConfig,
	loadConfig,
	saveConfig,
	sshOptions,
	validateHostName,
} from "./config.ts";
import { errorMessage, formatDuration } from "./lib/util.ts";
import { createServer } from "./server.ts";
import { contextFor, HostManager, stderrLogger } from "./session.ts";
import { forgetHostKey, scanHost, trustHostKey } from "./trust.ts";

const USAGE = `pi-env-mcp: an MCP server for persistent access to remote machines over SSH, through the pi-env daemon.

Usage:
  pi-env-mcp [serve] [--host NAME]...   Run the MCP server on stdin/stdout (what agents start).
                                        --host offers only these hosts; the first is the default. A name
                                        that is not configured is used as an SSH host or ~/.ssh/config alias.
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

async function serve(configDir: string, hosts: string[], verbose: boolean): Promise<void> {
	const log = stderrLogger(verbose);
	const config = await loadConfig(configDir);
	const manager = new HostManager({ configDir, config, hosts, log });
	const { server } = createServer({ manager });
	let stopping = false;
	const stop = async (reason: string) => {
		if (stopping) return;
		stopping = true;
		log.debug(`stopping: ${reason}`);
		// Terminals die with the connections; detached background jobs keep running.
		const forced = setTimeout(() => process.exit(0), 5000);
		forced.unref();
		await manager.closeAll();
		await server.close().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGHUP", () => void stop("SIGHUP"));
	process.stdin.on("end", () => void stop("stdin closed"));
	process.on("unhandledRejection", (error) => log.warn(`unhandled rejection: ${errorMessage(error)}`));
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
		},
	});
	if (values.help) {
		process.stdout.write(USAGE);
		return;
	}
	if (values.version) {
		process.stdout.write("0.1.0\n");
		return;
	}
	const configDir = values["config-dir"] ?? defaultConfigDir();
	const verbose = values.verbose === true || process.env.PI_ENV_MCP_DEBUG === "1";
	const [command = "serve", name, ...rest] = positionals;
	if (rest.length > 0) fail(`unexpected arguments: ${rest.join(" ")}`);
	const needName = () => name ?? fail(`${command} needs a host name; see pi-env-mcp --help`);
	switch (command) {
		case "serve":
			await serve(configDir, values.host ?? [], verbose);
			return;
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
