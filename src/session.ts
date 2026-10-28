import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, type PlatformPath, posix, win32 } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import {
	type Connection,
	connectSsh,
	HostKeyChangedError,
	HostKeyUnknownError,
	RemoteExecutionEnv,
	type RemoteInfo,
	type RemotePlatform,
	type SshConnectOptions,
	SshError,
} from "@earendil-works/pi-env";
import {
	type Config,
	DEFAULT_TIMEOUT_SECONDS,
	describeTarget,
	type HostConfig,
	type Limits,
	MAX_TIMEOUT_SECONDS,
	outputLimits,
	readLimits,
	sshOptions,
	validateHostName,
} from "./config.ts";
import { errorMessage, KeyedMutex, shellQuote } from "./lib/util.ts";
import { controlPath } from "./trust.ts";

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
}

export function stderrLogger(verbose: boolean): Logger {
	const write = (level: string, message: string) => process.stderr.write(`[pi-env-mcp] ${level}${message}\n`);
	return {
		debug: (message) => {
			if (verbose) write("", message);
		},
		info: (message) => write("", message),
		warn: (message) => write("warning: ", message),
	};
}

/** The context pi-env operations take: cancelled with the tool call. */
export function contextFor(signal?: AbortSignal): Context {
	return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT);
}

/** What a session knows when it closes things it owns, such as terminals. */
export interface SessionResource {
	close(): void;
}

/** Output of an internal command run without a shell. */
export interface Captured {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * One live connection to a host: a pi-env daemon running there over `ssh`, which every tool call on the host shares.
 * The connection restarts by itself on the next request after it is lost; what lived in the old daemon (terminals,
 * foreground commands) is gone then, while detached background jobs keep running.
 */
export class HostSession {
	readonly name: string;
	readonly config: HostConfig;
	readonly connection: Connection;
	readonly env: RemoteExecutionEnv;
	readonly platform: RemotePlatform;
	readonly info: RemoteInfo;
	readonly outputLimits: Limits;
	readonly readLimits: Limits;
	readonly timeouts: { default: number; max: number };
	readonly connectedAt = Date.now();
	/** Serializes edits and writes of one file. */
	readonly fileLocks = new KeyedMutex();
	/** Terminals and other things that die with this connection. */
	readonly resources = new Set<SessionResource>();
	/** `uname -n` of the remote machine. */
	hostname = "";
	/** Where relative paths and commands start before any `cd`: the configured `cwd`, else the remote home. */
	baseCwd: string;
	#tmpDir: Promise<string> | undefined;
	#ripgrep: Promise<boolean> | undefined;
	#cwdFiles = 0;
	#closed = false;

	constructor(options: {
		name: string;
		config: HostConfig;
		connection: Connection;
		platform: RemotePlatform;
		info: RemoteInfo;
		outputLimits: Limits;
		readLimits: Limits;
		timeouts: { default: number; max: number };
	}) {
		this.name = options.name;
		this.config = options.config;
		this.connection = options.connection;
		this.platform = options.platform;
		this.info = options.info;
		this.outputLimits = options.outputLimits;
		this.readLimits = options.readLimits;
		this.timeouts = options.timeouts;
		this.baseCwd = options.info.home;
		// Bash sources ~/.bashrc for every `bash -c` it thinks sshd started (SSH_CLIENT set, SHLVL below 2), which is
		// slow and noisy; the daemon already inherited that environment when it started.
		const shellEnv: Record<string, string> = options.config.sourceBashrc === true ? {} : { SHLVL: "1" };
		this.env = new RemoteExecutionEnv({
			connection: options.connection,
			id: `pi-env-mcp:${options.name}`,
			cwd: options.info.home,
			shellEnv: { ...shellEnv, ...options.config.env },
		});
	}

	/** The persistent working directory: relative paths resolve against it, and commands start in it. */
	get cwd(): string {
		return this.env.cwd;
	}

	set cwd(value: string) {
		this.env.cwd = value;
	}

	get posix(): boolean {
		return this.platform.platform !== "windows";
	}

	/** Path rules of the remote system. */
	get paths(): PlatformPath {
		return this.posix ? posix : win32;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Learn the host name and settle the working directory; called once after connecting. */
	async init(log: Logger): Promise<void> {
		try {
			this.hostname = (await this.capture(this.posix ? ["uname", "-n"] : ["hostname"])).stdout.trim();
		} catch {
			this.hostname = this.name;
		}
		if (this.config.cwd !== undefined) {
			const context = contextFor();
			const resolved = getOrThrow(await this.env.absolutePath(this.config.cwd, context));
			const info = await this.env.fileInfo(resolved, context);
			if (info.ok && info.value.kind === "directory") {
				this.baseCwd = resolved;
			} else {
				log.warn(`${this.name}: configured cwd ${resolved} is not a directory; using ${this.info.home}`);
			}
		}
		this.cwd = this.baseCwd;
	}

	/** A remote path made absolute against the working directory, with `~` as the remote home. */
	async resolve(path: string, signal?: AbortSignal): Promise<string> {
		return getOrThrow(await this.env.absolutePath(path, contextFor(signal)));
	}

	/**
	 * Run a program directly (no shell) and collect its output, for the tools' own bookkeeping. It runs in the remote
	 * home unless told otherwise: the working directory may have been deleted, and the daemon refuses to start anything
	 * in a missing directory.
	 */
	async capture(
		argv: readonly string[],
		options: { cwd?: string; signal?: AbortSignal; timeoutSeconds?: number } = {},
	): Promise<Captured> {
		let stdout = "";
		let stderr = "";
		const result = await this.env.exec(
			argv,
			{
				cwd: options.cwd ?? this.info.home,
				timeout: options.timeoutSeconds ?? 60,
				onOutput: (text, _context, info) => {
					if (info.stream === "stderr") stderr += text;
					else stdout += text;
				},
			},
			contextFor(options.signal),
		);
		if (!result.ok) throw result.error;
		return { exitCode: result.value.exitCode, stdout, stderr };
	}

	/** A private temporary directory on the remote host for this connection's bookkeeping files. */
	tempDir(): Promise<string> {
		if (this.#tmpDir === undefined) {
			const created = (async () => getOrThrow(await this.env.createTempDir("pi-env-mcp-", contextFor())))();
			this.#tmpDir = created;
			// A failed attempt is not remembered: the next command tries again.
			created.catch(() => {
				if (this.#tmpDir === created) this.#tmpDir = undefined;
			});
		}
		return this.#tmpDir;
	}

	/** A fresh file name for one command to report its final working directory in. */
	async nextCwdFile(): Promise<{ dir: string; file: string }> {
		const dir = await this.tempDir();
		return { dir, file: `${dir}/cwd-${++this.#cwdFiles}` };
	}

	/** Stop using a temporary directory that disappeared (a reboot, a cleanup); the next use makes a new one. */
	forgetTempDir(dir: string): void {
		void this.#tmpDir?.then((current) => {
			if (current === dir) this.#tmpDir = undefined;
		});
	}

	/** Whether ripgrep is installed on the host; asked once per connection. A failed question is asked again. */
	hasRipgrep(): Promise<boolean> {
		if (this.#ripgrep === undefined) {
			const asked = this.capture(["sh", "-c", "command -v rg"]).then(
				(result) => result.exitCode === 0 && result.stdout.trim() !== "",
			);
			this.#ripgrep = asked;
			asked.catch(() => {
				if (this.#ripgrep === asked) this.#ripgrep = undefined;
			});
		}
		return this.#ripgrep;
	}

	/** Close terminals, remove bookkeeping files, and stop the daemon (which kills what it still runs). */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const resource of this.resources) {
			try {
				resource.close();
			} catch {
				// Closing one resource must not keep the others open.
			}
		}
		this.resources.clear();
		const tmpDir = this.#tmpDir;
		if (tmpDir !== undefined) {
			const cleanup = tmpDir.then((dir) =>
				this.env.remove(dir, { recursive: true, force: true }, contextFor(AbortSignal.timeout(2000))),
			);
			await Promise.race([cleanup.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2500))]);
		}
		this.connection.close();
	}
}

/** Turn a failure to connect into a message that tells the agent what the user has to do. */
/**
 * An `ssh` for pi-env that goes through the user's master connection to the target. pi-env passes `ControlPath=none`;
 * ssh keeps the first value it gets for an option, so the path given before pi-env's arguments wins, while pi-env's
 * `ControlMaster=no` still keeps this from ever opening a master itself.
 */
async function sharedConnectionSsh(configDir: string, name: string, target: SshConnectOptions): Promise<string> {
	const socket = await controlPath(target);
	if (socket === undefined) {
		throw new Error(
			`shareConnection is set, but the user's ssh configuration gives ${target.host} no ControlPath. Add ControlMaster auto, ControlPath and ControlPersist for it to ~/.ssh/config`,
		);
	}
	if (!existsSync(socket)) {
		throw new Error(
			`no shared ssh connection to ${target.host} is open (${socket}). Ask the user to open one in a terminal with: ssh -fN ${target.host}`,
		);
	}
	const directory = join(configDir, "ssh");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const wrapper = join(directory, name);
	await writeFile(wrapper, `#!/bin/sh\nexec ssh -o ${shellQuote(`ControlPath=${socket}`)} "$@"\n`, { mode: 0o700 });
	return wrapper;
}

export function connectError(name: string, host: HostConfig, error: unknown): Error {
	const target = describeTarget(name, host);
	if (error instanceof HostKeyUnknownError) {
		return new Error(
			`The SSH host key of "${name}" (${target}) is not trusted by pi-env-mcp yet. Ask the user to run: pi-env-mcp trust ${name}`,
		);
	}
	if (error instanceof HostKeyChangedError) {
		return new Error(
			`The SSH host key of "${name}" (${target}) CHANGED since it was trusted. This can mean a reinstalled server or a man-in-the-middle attack. Ask the user to verify it and run: pi-env-mcp trust ${name} --replace`,
		);
	}
	const message = errorMessage(error);
	if (error instanceof SshError || /^ssh /.test(message)) {
		const hints: string[] = [];
		if (/Permission denied/i.test(message) && host.shareConnection === true) {
			hints.push(
				`The shared ssh connection is probably closed or expired. Ask the user to open it again in a terminal with: ssh -fN ${host.host ?? name}`,
			);
		} else if (/Permission denied/i.test(message)) {
			hints.push(
				"Authentication failed. pi-env-mcp runs ssh with BatchMode (no password prompts): the user needs key-based login, e.g. an ssh-agent or identityFile in the host configuration.",
			);
		}
		if (/Could not resolve hostname|Name or service not known/i.test(message)) hints.push("The host name does not resolve.");
		if (/Connection refused|timed out|No route to host/i.test(message)) hints.push("The SSH server is unreachable.");
		return new Error(`Cannot connect to "${name}" (${target}): ${message}${hints.length ? `\n${hints.join("\n")}` : ""}`);
	}
	return new Error(`Cannot connect to "${name}" (${target}): ${message}`);
}

export interface ManagerOptions {
	configDir: string;
	config: Config;
	/** Hosts named on the command line: only these are offered, the first is the default; unknown names are SSH aliases. */
	hosts?: readonly string[];
	log: Logger;
}

/** All hosts this server offers, each connected on first use and shared by every tool call. */
export class HostManager {
	readonly configDir: string;
	readonly config: Config;
	readonly log: Logger;
	readonly #hosts: Map<string, HostConfig>;
	readonly #defaultHost: string | undefined;
	readonly #connecting = new Map<string, Promise<HostSession>>();
	readonly #sessions = new Map<string, HostSession>();
	readonly #lastError = new Map<string, string>();
	#closed = false;

	constructor(options: ManagerOptions) {
		this.configDir = options.configDir;
		this.config = options.config;
		this.log = options.log;
		this.#hosts = new Map();
		if (options.hosts !== undefined && options.hosts.length > 0) {
			for (const name of options.hosts) {
				validateHostName(name);
				this.#hosts.set(name, options.config.hosts[name] ?? {});
			}
			this.#defaultHost = options.hosts[0];
		} else {
			for (const [name, host] of Object.entries(options.config.hosts)) this.#hosts.set(name, host);
			const configured = options.config.defaultHost;
			this.#defaultHost =
				configured !== undefined && this.#hosts.has(configured)
					? configured
					: this.#hosts.size === 1
						? [...this.#hosts.keys()][0]
						: undefined;
		}
	}

	names(): string[] {
		return [...this.#hosts.keys()];
	}

	get defaultHost(): string | undefined {
		return this.#defaultHost;
	}

	hostConfig(name: string): HostConfig {
		const host = this.#hosts.get(name);
		if (host === undefined) throw new Error(`Unknown host "${name}"`);
		return host;
	}

	/** The host a call means: the one it names, else the default. */
	resolveName(name: string | undefined): string {
		if (name !== undefined && name !== "") {
			if (this.#hosts.has(name)) return name;
			const available = this.names();
			throw new Error(
				`Unknown host "${name}". ${available.length ? `Available: ${available.join(", ")}.` : "No hosts are configured."}`,
			);
		}
		if (this.#defaultHost !== undefined) return this.#defaultHost;
		if (this.#hosts.size === 0) {
			throw new Error(
				"No remote hosts are configured. Ask the user to run: pi-env-mcp add <name> --host <ssh-host>, then pi-env-mcp trust <name>.",
			);
		}
		throw new Error(`Several hosts are configured (${this.names().join(", ")}); pass "host" to choose one.`);
	}

	/** The live session of a host, connecting first if needed. */
	async session(name: string | undefined): Promise<HostSession> {
		if (this.#closed) throw new Error("The server is shutting down");
		const host = this.resolveName(name);
		const live = this.#sessions.get(host);
		if (live !== undefined && !live.closed) return live;
		let pending = this.#connecting.get(host);
		if (pending === undefined) {
			pending = this.#connect(host);
			this.#connecting.set(host, pending);
			pending.then(
				(session) => {
					this.#sessions.set(host, session);
					this.#lastError.delete(host);
				},
				(error: unknown) => this.#lastError.set(host, errorMessage(error)),
			);
			pending
				.finally(() => {
					if (this.#connecting.get(host) === pending) this.#connecting.delete(host);
				})
				.catch(() => {});
		}
		return pending;
	}

	/** The session of a host if it is connected, without connecting. */
	connected(name: string): HostSession | undefined {
		const session = this.#sessions.get(name);
		return session !== undefined && !session.closed ? session : undefined;
	}

	lastError(name: string): string | undefined {
		return this.#lastError.get(name);
	}

	/** Drop the host's connection and start a new one: its terminals close, detached jobs keep running. */
	async reconnect(name: string | undefined): Promise<HostSession> {
		const host = this.resolveName(name);
		await this.#connecting.get(host)?.catch(() => {});
		const session = this.#sessions.get(host);
		this.#sessions.delete(host);
		await session?.close();
		return this.session(host);
	}

	async closeAll(): Promise<void> {
		this.#closed = true;
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		await Promise.all(sessions.map((session) => session.close().catch(() => {})));
	}

	async #connect(name: string): Promise<HostSession> {
		const host = this.hostConfig(name);
		const options = sshOptions(this.configDir, name, host, (text) => {
			const trimmed = text.trim();
			if (trimmed !== "") this.log.debug(`${name}: ${trimmed}`);
		});
		let connection: Connection | undefined;
		try {
			const started = Date.now();
			if (host.shareConnection === true) options.ssh = await sharedConnectionSsh(this.configDir, name, options);
			const connected = await connectSsh(options);
			connection = connected.connection;
			const info = await connection.info();
			const timeouts = {
				default: this.config.timeouts?.default ?? DEFAULT_TIMEOUT_SECONDS,
				max: this.config.timeouts?.max ?? MAX_TIMEOUT_SECONDS,
			};
			const session = new HostSession({
				name,
				config: host,
				connection,
				platform: connected.remote,
				info,
				outputLimits: outputLimits(this.config),
				readLimits: readLimits(this.config),
				timeouts,
			});
			await session.init(this.log);
			for (const warning of connected.remote.warnings) this.log.warn(`${name}: ${warning}`);
			this.log.debug(
				`${name}: connected in ${Date.now() - started} ms (${info.os} ${info.arch}, pi-env ${info.version}, host ${session.hostname})`,
			);
			return session;
		} catch (error) {
			connection?.close();
			throw connectError(name, host, error);
		}
	}
}
