/**
 * MCP servers that run on the hosts, started as pi starts stdio servers on its execution environments: through the
 * host's pi-env connection with the daemon's `process` operation (pi-env's `openProcess`, plain pipes, the process
 * group killed when the server exits, the call is cancelled or the connection drops), and spoken to with pi-mcp's
 * client over its `PipeTransport`. Lifecycle as in pi's coding agent: connect at start, mark the server disconnected
 * when it goes away, and connect again on the next call.
 *
 * The agent reaches their tools through this server, next to its own tools, under `<server>__<tool>`: pi's tool names
 * (`createMcpToolName`) without its `mcp__` prefix, because Claude Code and Codex put their own `mcp__<name>__` in
 * front of every tool of an MCP server.
 */

import { posix as pathsPosix, win32 as pathsWin32 } from "node:path";
import { pathToFileURL } from "node:url";
import { openProcess, RemoteError } from "@earendil-works/pi-env";
import {
	type CallToolResult,
	createMcpToolName,
	McpClient,
	type McpRequestOptions,
	PipeTransport,
	type Tool,
} from "@earendil-works/pi-mcp";
import type { McpServerEntries, McpServerEntry } from "./config.ts";
import { errorMessage } from "./lib/util.ts";
import type { HostManager, HostSession, Logger } from "./session.ts";
import { VERSION } from "./version.ts";

/** pi's per-request timeout of an MCP server without a `timeout`; progress notifications restart it. */
const DEFAULT_TIMEOUT_SECONDS = 60;
/** How much of a failed server's stderr its error shows. */
const STDERR_TAIL_CHARS = 2000;
/** pi's tool names start with this; the agents add their own. */
const PI_PREFIX = "mcp__";

/**
 * `connecting`: starting (also again after it went away); `disconnected`: it went away (exited, or the connection to
 * the host dropped) and the next call starts it again; `failed`: the last start failed; `closed`: shut down.
 */
export type McpServerState = "connecting" | "connected" | "disconnected" | "failed" | "closed";

/** How a server starts on its host: the program, its arguments, working directory and added environment. */
export interface McpLaunch {
	argv: string[];
	cwd: string;
	env: Record<string, string>;
}

/**
 * Where and how a server starts on the host, by pi's rules: a leading `~/` in `command`, an argument or `cwd` names the
 * remote home; a relative `cwd` resolves against the host's configured working directory (else the home); `${NAME}` in
 * `env` values comes from this process's environment (the configuration is the user's own). The host's own `env` is
 * added first, as for every command on it.
 */
export function launchOf(
	entry: McpServerEntry,
	host: { home: string; baseCwd: string; posix: boolean; env?: Record<string, string> | undefined },
	environment: NodeJS.ProcessEnv = process.env,
): McpLaunch {
	const paths = host.posix ? pathsPosix : pathsWin32;
	const expandHome = (value: string): string =>
		value === "~" ? host.home : value.startsWith("~/") ? paths.join(host.home, value.slice(2)) : value;
	const config = entry.config;
	const env: Record<string, string> = { ...host.env };
	for (const [key, value] of Object.entries(config.env ?? {})) {
		env[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
			const variable = environment[name];
			if (variable === undefined) throw new Error(`environment variable ${name} (in env.${key}) is not set`);
			return variable;
		});
	}
	return {
		argv: [expandHome(config.command), ...(config.args ?? []).map(expandHome)],
		cwd: config.cwd === undefined ? host.baseCwd : paths.resolve(host.baseCwd, expandHome(config.cwd)),
		env,
	};
}


function tail(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	return trimmed.length > STDERR_TAIL_CHARS ? `...${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

/** One configured server on its host. Connects on `getClient()`, and again on the next call after it went away. */
export class RemoteMcpServer {
	readonly entry: McpServerEntry;
	state: McpServerState = "connecting";
	/** Why the last start failed or the server went away, with the end of its stderr. */
	error: string | undefined;
	/** Its tools as of the last listing; kept while it is disconnected, so the agent's tool list stays stable. */
	tools: Tool[] = [];
	/** What it says about itself in `initialize`. */
	instructions: string | undefined;
	/** How it was last started. */
	launch: McpLaunch | undefined;
	readonly #manager: HostManager;
	readonly #log: Logger;
	readonly #onChange: (server: RemoteMcpServer, toolsChanged: boolean) => void;
	/** Aborted by `close()`: cancels a start in progress. */
	readonly #shutdown = new AbortController();
	#client: McpClient | undefined;
	/** The host session the client's server runs in: a closed one (hosts reconnect) killed it. */
	#session: HostSession | undefined;
	#opening: Promise<McpClient> | undefined;

	constructor(options: {
		entry: McpServerEntry;
		manager: HostManager;
		log: Logger;
		onChange?: (server: RemoteMcpServer, toolsChanged: boolean) => void;
	}) {
		this.entry = options.entry;
		this.#manager = options.manager;
		this.#log = options.log;
		this.#onChange = options.onChange ?? (() => {});
	}

	get name(): string {
		return this.entry.name;
	}

	get host(): string {
		return this.entry.host;
	}

	get timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	/** The connected client, starting the server first if it is not running. */
	getClient(): Promise<McpClient> {
		if (this.#shutdown.signal.aborted) return Promise.reject(new Error(`MCP server "${this.name}" is shut down`));
		const client = this.#client;
		if (client?.connectionState === "connected") {
			if (this.#session?.closed !== true) return Promise.resolve(client);
			// Its connection was closed on purpose and its server killed; the close may not have reached the client yet.
			this.#client = undefined;
			void client.close().catch(() => undefined);
		}
		this.#opening ??= this.#connect().finally(() => {
			this.#opening = undefined;
		});
		return this.#opening;
	}

	async callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult> {
		const client = await this.getClient();
		return client.callTool(name, args, options);
	}

	/** Stop the server: its stdin is closed, and it is killed if it has not exited 2 s later (MCP's stdio shutdown). */
	async close(): Promise<void> {
		this.#shutdown.abort();
		this.state = "closed";
		const client = this.#client;
		this.#client = undefined;
		await Promise.all([client?.close().catch(() => undefined), this.#opening?.catch(() => undefined)]);
	}

	#changed(toolsChanged = false): void {
		this.#onChange(this, toolsChanged);
	}

	async #connect(): Promise<McpClient> {
		this.state = "connecting";
		this.#changed();
		let transport: PipeTransport | undefined;
		let client: McpClient | undefined;
		// Closing the client fails its pending requests and closes the transport, which kills the program.
		let closing: Promise<void> | undefined;
		const closeClient = () => {
			closing ??= client?.close().catch(() => undefined);
			return closing;
		};
		this.#shutdown.signal.addEventListener("abort", closeClient, { once: true });
		try {
			const session = await this.#manager.session(this.host);
			const launch = launchOf(this.entry, {
				home: session.info.home,
				baseCwd: session.baseCwd,
				posix: session.posix,
				env: session.config.env,
			});
			this.launch = launch;
			const opened = client = new McpClient({
				name: "pi-env-mcp",
				version: VERSION,
				requestTimeoutMs: this.timeoutMs,
				roots: [{ uri: pathToFileURL(launch.cwd, { windows: !session.posix }).href, name: launch.cwd }],
			});
			opened.onNotification("notifications/message", (params) => this.#log.debug(`${this.name}: ${JSON.stringify(params)}`));
			transport = new PipeTransport({
				open: ({ onStdout, onStderr }) => this.#start(session, launch, onStdout, onStderr),
				onStderr: (chunk) => {
					const text = chunk.trimEnd();
					if (text !== "") this.#log.debug(`${this.name} (stderr): ${text}`);
				},
			});
			const piped = transport;
			await opened.connect(piped);
			opened.onNotification("notifications/tools/list_changed", () => void this.#refreshTools(opened));
			opened.onClose(() => this.#wentAway(opened, piped));
			// Servers without the tools capability (prompts or resources only) do not answer tools/list.
			const tools = opened.serverCapabilities?.tools ? await opened.listTools() : [];
			if (this.#shutdown.signal.aborted) throw new Error("shut down while starting");
			if (opened.connectionState !== "connected") throw new Error("the server exited during setup");
			this.#client = opened;
			this.#session = session;
			const toolsChanged = JSON.stringify(tools) !== JSON.stringify(this.tools);
			this.tools = tools;
			this.instructions = opened.instructions?.trim() || undefined;
			this.state = "connected";
			this.error = undefined;
			this.#log.debug(`MCP server ${this.name} on ${this.host}: connected, ${tools.length} tools`);
			this.#changed(toolsChanged);
			return opened;
		} catch (error) {
			await closeClient();
			const stderr = transport === undefined ? undefined : tail(transport.stderr);
			this.error = stderr === undefined ? errorMessage(error) : `${errorMessage(error)}\n${stderr}`;
			this.state = this.#shutdown.signal.aborted ? "closed" : "failed";
			this.#changed();
			throw new Error(`MCP server "${this.name}" on ${this.host} failed to start: ${this.error}`);
		} finally {
			this.#shutdown.signal.removeEventListener("abort", closeClient);
		}
	}

	async #start(
		session: HostSession,
		launch: McpLaunch,
		onStdout: (bytes: Uint8Array) => void,
		onStderr: (bytes: Uint8Array) => void,
	) {
		try {
			return await openProcess(session.connection, { cwd: launch.cwd, argv: launch.argv, env: launch.env, onStdout, onStderr });
		} catch (error) {
			if (error instanceof RemoteError && error.code === "not_supported") {
				throw new Error(`the pi-env daemon on ${this.host} cannot run MCP servers (it predates the process operation)`);
			}
			throw error;
		}
	}

	/** The server exited or the host's connection dropped: the next call starts it again. */
	#wentAway(client: McpClient, transport: PipeTransport): void {
		if (this.#client !== client || this.#shutdown.signal.aborted) return;
		this.#client = undefined;
		this.state = "disconnected";
		const stderr = tail(transport.stderr);
		this.error = stderr === undefined ? "Connection closed" : `Connection closed\n${stderr}`;
		this.#log.debug(`MCP server ${this.name} on ${this.host}: ${this.error}`);
		this.#changed();
	}

	async #refreshTools(client: McpClient): Promise<void> {
		try {
			const tools = await client.listTools();
			if (this.#client !== client || this.#shutdown.signal.aborted) return;
			const toolsChanged = JSON.stringify(tools) !== JSON.stringify(this.tools);
			this.tools = tools;
			this.#changed(toolsChanged);
		} catch (error) {
			this.error = `Failed to refresh tools: ${errorMessage(error)}`;
			this.#changed();
		}
	}
}

/** A server's tool as the agent sees it. */
export interface RemoteTool {
	/** `<server>__<tool>`, sanitized and shortened as pi names MCP tools. */
	readonly name: string;
	readonly server: RemoteMcpServer;
	readonly tool: Tool;
}

/** The MCP servers this pi-env-mcp offers: the enabled ones that run on its hosts. */
export class RemoteMcpServers {
	readonly servers: readonly RemoteMcpServer[];
	/** Configuration entries that were skipped, and why. */
	readonly errors: readonly string[];
	#tools: RemoteTool[] = [];
	readonly #byName = new Map<string, RemoteTool>();
	readonly #listeners = new Set<() => void>();
	#started: Promise<void> | undefined;

	constructor(options: { manager: HostManager; entries: McpServerEntries; log: Logger }) {
		const offered = new Set(options.manager.names());
		this.errors = options.entries.errors;
		this.servers = options.entries.servers
			.filter((entry) => entry.enabled && offered.has(entry.host))
			.map(
				(entry) =>
					new RemoteMcpServer({
						entry,
						manager: options.manager,
						log: options.log,
						onChange: (_server, toolsChanged) => {
							if (toolsChanged) this.#rename();
						},
					}),
			);
	}

	/** Start every server in the background. */
	start(): void {
		this.#started ??= Promise.allSettled(this.servers.map((server) => server.getClient())).then(() => {});
	}

	/** Resolves once every server's first start has finished either way, or after `timeoutMs`. */
	async ready(timeoutMs: number): Promise<void> {
		this.start();
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([this.#started, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
		clearTimeout(timer);
	}

	/** The tools of every server, as the agent sees them. */
	tools(): readonly RemoteTool[] {
		return this.#tools;
	}

	find(name: string): RemoteTool | undefined {
		return this.#byName.get(name);
	}

	/** On this host. */
	on(host: string): RemoteMcpServer[] {
		return this.servers.filter((server) => server.host === host);
	}

	/** `listener` hears when the tools change; the result stops it. */
	onToolsChanged(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async closeAll(): Promise<void> {
		await Promise.all(this.servers.map((server) => server.close()));
	}

	/** Name every tool again, in configuration order, so names stay the same while the tools do. */
	#rename(): void {
		const tools: RemoteTool[] = [];
		const taken = new Set<string>();
		for (const server of this.servers) {
			for (const tool of server.tools) {
				const name = createMcpToolName(server.name, tool.name, (candidate) => taken.has(candidate.slice(PI_PREFIX.length)));
				const short = name.startsWith(PI_PREFIX) ? name.slice(PI_PREFIX.length) : name;
				taken.add(short);
				tools.push({ name: short, server, tool });
			}
		}
		this.#tools = tools;
		this.#byName.clear();
		for (const tool of tools) this.#byName.set(tool.name, tool);
		for (const listener of this.#listeners) listener();
	}
}
