import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SshConnectOptions } from "@earendil-works/pi-env";
import { type McpStdioServerConfig, mcpNamespace, validateMcpServerConfig } from "@earendil-works/pi-mcp";

/** One remote machine, as the user configured it. */
export interface HostConfig {
	/** SSH destination: a host name or `~/.ssh/config` alias; default the entry's name. */
	host?: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/** An `ssh` configuration file to use instead of `~/.ssh/config` (`ssh -F`). */
	sshConfig?: string;
	/** Initial working directory for commands and relative paths; default the remote home. `~` is the remote home. */
	cwd?: string;
	/** Start the daemon through the user's login shell, so commands see `~/.profile` and the like; default true. */
	loginShell?: boolean;
	/** Environment variables added to every command, job and terminal. */
	env?: Record<string, string>;
	/**
	 * Let bash source `~/.bashrc` before each command, as it does for `ssh host command` on Debian and Ubuntu; default
	 * false. The daemon already starts with that environment, so this only costs time (often 100+ ms per command).
	 */
	sourceBashrc?: boolean;
	/**
	 * Connect through the master connection the user keeps open with their own `ControlMaster` and `ControlPath`
	 * settings, for hosts that need a passphrase or one-time password at login; default false. pi-env otherwise opens
	 * its own connections, without sharing.
	 */
	shareConnection?: boolean;
}

export interface Limits {
	/** Most UTF-8 bytes of output a tool returns. */
	maxBytes: number;
	/** Most lines of output a tool returns. */
	maxLines: number;
}

export interface Config {
	/** Host used when a tool call names none; default the only host, if there is one. */
	defaultHost?: string;
	hosts: Record<string, HostConfig>;
	/** Bounds of what `bash`, `grep`, jobs and terminals return. */
	output?: Partial<Limits>;
	/** Bounds of what `read` returns. */
	read?: Partial<Limits>;
	/** `bash` timeouts in seconds: the default, and the most a call may ask for. */
	timeouts?: { default?: number; max?: number };
	/**
	 * MCP servers that run on the hosts, in the `mcpServers` shape of pi and other MCP clients, plus `runOn` (which
	 * host). Kept as written: `mcpServers()` checks the entries, so one invalid entry does not disable the others.
	 */
	mcpServers?: Record<string, unknown>;
}

/** A stdio MCP server that runs on a host, from `mcpServers`. */
export interface McpServerEntry {
	readonly name: string;
	/** The host it runs on: `runOn.host`, else the configuration's default host. */
	readonly host: string;
	readonly config: McpStdioServerConfig & Record<string, unknown>;
	readonly enabled: boolean;
}

/** The checked `mcpServers` entries, and why others were skipped. */
export interface McpServerEntries {
	readonly servers: readonly McpServerEntry[];
	readonly errors: readonly string[];
}

/**
 * The `mcpServers` of a configuration, checked by pi-mcp's validator (the shape pi and other MCP clients share) plus
 * pi-env-mcp's `runOn: { "host": NAME }`. Invalid entries are skipped and reported, as pi does. Only stdio servers
 * apply: an HTTP server needs no remote host, so the agent connects to it directly.
 */
export function mcpServers(config: Config): McpServerEntries {
	const servers: McpServerEntry[] = [];
	const errors: string[] = [];
	const namespaces = new Map<string, string>();
	const hostNames = Object.keys(config.hosts);
	const defaultHost = config.defaultHost ?? (hostNames.length === 1 ? hostNames[0] : undefined);
	for (const [name, raw] of Object.entries(config.mcpServers ?? {})) {
		const result = validateMcpServerConfig(name, raw);
		if (result.kind === "invalid") {
			errors.push(result.error);
			continue;
		}
		if (result.kind === "http") {
			errors.push(`server "${name}": pi-env-mcp runs stdio servers on remote hosts; register HTTP servers with the agent directly`);
			continue;
		}
		const runOn = result.config.runOn;
		let host: string | undefined;
		if (runOn === undefined) {
			host = defaultHost;
			if (host === undefined) {
				errors.push(`server "${name}": runOn is missing and there is no default host; set "runOn": { "host": "<name>" }`);
				continue;
			}
		} else if (isRecord(runOn) && Object.keys(runOn).length === 1 && typeof runOn.host === "string" && runOn.host !== "") {
			host = runOn.host;
		} else {
			errors.push(`server "${name}": runOn must be { "host": "<name of a host>" }`);
			continue;
		}
		try {
			validateHostName(host);
		} catch (error) {
			errors.push(`server "${name}": ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		// Tool names replace `-` with `_`: servers whose names differ only there would name their tools alike.
		const taken = namespaces.get(mcpNamespace(name));
		if (taken !== undefined) {
			errors.push(`server "${name}": its tools would be named like those of "${taken}"`);
			continue;
		}
		namespaces.set(mcpNamespace(name), name);
		servers.push({ name, host, config: result.config, enabled: result.config.enabled !== false });
	}
	return { servers, errors };
}

export const DEFAULT_OUTPUT_LIMITS: Limits = { maxBytes: 30_000, maxLines: 2000 };
export const DEFAULT_READ_LIMITS: Limits = { maxBytes: 40_000, maxLines: 2000 };
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 3600;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateHostName(name: string): void {
	if (!NAME.test(name)) {
		throw new Error(
			`Invalid host name ${JSON.stringify(name)}: use letters, digits, ".", "_" and "-", starting with a letter or digit`,
		);
	}
}

/** Where configuration and trusted host keys live: `$PI_ENV_MCP_HOME`, else `$XDG_CONFIG_HOME/pi-env-mcp`. */
export function defaultConfigDir(): string {
	if (process.env.PI_ENV_MCP_HOME) return process.env.PI_ENV_MCP_HOME;
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "pi-env-mcp");
}

export function configFile(dir: string): string {
	return join(dir, "config.json");
}

/** Host keys this tool trusts, separate from `~/.ssh/known_hosts`, as pi-env requires. */
export function knownHostsFile(dir: string): string {
	return join(dir, "known_hosts");
}

/** The name host keys are stored under, independent of the route to the host. */
export function hostKeyAlias(name: string): string {
	return `pi-env-mcp-${name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkHost(name: string, value: unknown): HostConfig {
	validateHostName(name);
	if (!isRecord(value)) throw new Error(`hosts.${name} must be an object`);
	const strings = ["host", "user", "identityFile", "sshConfig", "cwd"] as const;
	for (const key of strings) {
		if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`hosts.${name}.${key} must be a string`);
	}
	if (value.port !== undefined && (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535)) {
		throw new Error(`hosts.${name}.port must be a port number`);
	}
	for (const key of ["loginShell", "sourceBashrc", "shareConnection"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`hosts.${name}.${key} must be true or false`);
	}
	if (value.env !== undefined) {
		if (!isRecord(value.env) || Object.values(value.env).some((v) => typeof v !== "string")) {
			throw new Error(`hosts.${name}.env must map names to strings`);
		}
	}
	return value as HostConfig;
}

/** Parse and check a configuration object. */
export function parseConfig(value: unknown): Config {
	if (!isRecord(value)) throw new Error("The configuration must be a JSON object");
	const hosts: Record<string, HostConfig> = {};
	if (value.hosts !== undefined) {
		if (!isRecord(value.hosts)) throw new Error("hosts must be an object");
		for (const [name, host] of Object.entries(value.hosts)) hosts[name] = checkHost(name, host);
	}
	if (value.defaultHost !== undefined && typeof value.defaultHost !== "string") throw new Error("defaultHost must be a string");
	for (const key of ["output", "read"] as const) {
		const limits = value[key];
		if (limits === undefined) continue;
		if (!isRecord(limits)) throw new Error(`${key} must be an object`);
		for (const field of ["maxBytes", "maxLines"]) {
			const n = limits[field];
			if (n !== undefined && (!Number.isInteger(n) || (n as number) < 1)) throw new Error(`${key}.${field} must be a positive integer`);
		}
	}
	if (value.timeouts !== undefined) {
		if (!isRecord(value.timeouts)) throw new Error("timeouts must be an object");
		for (const field of ["default", "max"]) {
			const n = value.timeouts[field];
			if (n !== undefined && (typeof n !== "number" || !(n > 0))) throw new Error(`timeouts.${field} must be a positive number`);
		}
	}
	if (value.mcpServers !== undefined && !isRecord(value.mcpServers)) throw new Error("mcpServers must be an object");
	return { ...(value as Omit<Config, "hosts">), hosts };
}

export async function loadConfig(dir: string): Promise<Config> {
	const file = configFile(dir);
	if (!existsSync(file)) return { hosts: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return parseConfig(parsed);
	} catch (error) {
		throw new Error(`Invalid ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function saveConfig(dir: string, config: Config): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const file = configFile(dir);
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	await rename(temporary, file);
}

export function outputLimits(config: Config): Limits {
	return { ...DEFAULT_OUTPUT_LIMITS, ...config.output };
}

export function readLimits(config: Config): Limits {
	return { ...DEFAULT_READ_LIMITS, ...config.read };
}

/** How pi-env reaches the host: `ssh` with this tool's known-hosts file and the host's alias. */
export function sshOptions(dir: string, name: string, host: HostConfig, onLog?: (text: string) => void): SshConnectOptions {
	return {
		host: host.host ?? name,
		...(host.user === undefined ? {} : { user: host.user }),
		...(host.port === undefined ? {} : { port: host.port }),
		...(host.identityFile === undefined ? {} : { identityFile: host.identityFile }),
		...(host.sshConfig === undefined ? {} : { configFile: host.sshConfig }),
		knownHostsFile: knownHostsFile(dir),
		hostKeyAlias: hostKeyAlias(name),
		loginShell: host.loginShell ?? true,
		...(onLog === undefined ? {} : { onLog }),
	};
}

/** `user@host:port` for messages. */
export function describeTarget(name: string, host: HostConfig): string {
	const destination = host.host ?? name;
	return `${host.user === undefined ? "" : `${host.user}@`}${destination}${host.port === undefined ? "" : `:${host.port}`}`;
}
