import { boundOutput } from "@earendil-works/chord/output";
import { openTerminal, type RemoteTerminal, type TerminalForeground } from "@earendil-works/pi-env";
import type { Limits } from "./config.ts";
import { keySequence } from "./lib/keys.ts";
import { type ScreenPosition, TerminalScreen } from "./lib/screen.ts";
import { errorMessage, formatDuration } from "./lib/util.ts";
import type { HostSession, SessionResource } from "./session.ts";

/** Output quiet this long while the shell is back at its prompt means a command finished. */
const PROMPT_QUIET_MS = 200;
/** Output quiet this long means a program is waiting (for input, or on something slow). */
const DEFAULT_IDLE_MS = 1500;

export type SettleReason = "idle" | "prompt" | "matched" | "exited" | "timeout";

export interface TerminalOpenOptions {
	cwd: string;
	command?: string;
	cols: number;
	rows: number;
	signal?: AbortSignal;
}

/**
 * A login shell in a pseudo-terminal on the remote host, kept between tool calls. Its output runs through a headless
 * terminal emulator, so reads return what a person would see rather than raw escape sequences.
 */
export class TerminalSession implements SessionResource {
	readonly id: string;
	readonly host: HostSession;
	readonly screen: TerminalScreen;
	readonly startedAt = Date.now();
	readonly command: string | undefined;
	readonly #remote: RemoteTerminal;
	#lastOutputAt = Date.now();
	/** Where the cursor was when input was last sent, and when: `wait_for` only looks at what came after. */
	#inputAt: ScreenPosition | undefined;
	#inputSentAt = 0;
	#exit: { code?: number; error?: string } | undefined;
	#closed = false;
	readonly #listeners = new Set<() => void>();
	readonly #onClose: () => void;

	private constructor(
		id: string,
		host: HostSession,
		screen: TerminalScreen,
		remote: RemoteTerminal,
		command: string | undefined,
		onClose: () => void,
	) {
		this.id = id;
		this.host = host;
		this.screen = screen;
		this.#remote = remote;
		this.command = command;
		this.#onClose = onClose;
	}

	static async open(
		id: string,
		host: HostSession,
		options: TerminalOpenOptions,
		onClose: () => void,
	): Promise<TerminalSession> {
		if (!host.posix) throw new Error("Terminals are not supported on Windows hosts yet");
		const screen = new TerminalScreen(options.cols, options.rows);
		let session: TerminalSession | undefined;
		const early: Uint8Array[] = [];
		const remote = await openTerminal(host.connection, {
			cwd: options.cwd,
			// Pagers would stop and wait for keys on every long output.
			env: { TERM: "xterm-256color", PAGER: "cat", GIT_PAGER: "cat", MANPAGER: "cat", ...host.config.env },
			cols: options.cols,
			rows: options.rows,
			onData: (bytes) => {
				if (session === undefined) early.push(bytes);
				else session.#data(bytes);
			},
		});
		session = new TerminalSession(id, host, screen, remote, options.command, onClose);
		for (const bytes of early) session.#data(bytes);
		const opened = session;
		remote.exited.then(
			(code) => opened.#ended({ code }),
			(error: unknown) => opened.#ended({ error: errorMessage(error) }),
		);
		host.resources.add(session);
		if (options.command !== undefined && options.command !== "") {
			// Type the command once the shell shows its first prompt; typed earlier, the terminal echoes it before the
			// prompt and the start-up looks like the command's output.
			try {
				await session.settle({ timeoutMs: 10_000, ...(options.signal === undefined ? {} : { signal: options.signal }) });
				await session.send(`${options.command}\n`, undefined);
			} catch (error) {
				session.close();
				throw error;
			}
		}
		return session;
	}

	#data(bytes: Uint8Array): void {
		if (this.#closed) return;
		this.screen.write(bytes);
		this.#lastOutputAt = Date.now();
		this.#notify();
	}

	#ended(exit: { code?: number; error?: string }): void {
		this.#exit = exit;
		this.host.resources.delete(this);
		this.#notify();
	}

	#notify(): void {
		for (const listener of [...this.#listeners]) listener();
	}

	get pid(): number {
		return this.#remote.pid;
	}

	get exited(): boolean {
		return this.#exit !== undefined;
	}

	/** How the terminal ended, for status lines. */
	get exitDescription(): string | undefined {
		if (this.#exit === undefined) return undefined;
		if (this.#exit.code !== undefined) return `exited with code ${this.#exit.code}`;
		const error = this.#exit.error ?? "";
		if (/aborted/i.test(error)) return "closed";
		if (/connection/i.test(error)) return "ended: the connection to the host was lost";
		return `ended: ${error}`;
	}

	/**
	 * Type `input` (a line feed is sent as Enter, a carriage return, as terminals do), then press named `keys`. Records
	 * where the cursor was, so that `settle` matches `waitFor` only against what the terminal printed afterwards.
	 */
	async send(input: string | undefined, keys: readonly string[] | undefined): Promise<void> {
		if (this.exited) throw new Error(`Terminal ${this.id} has ${this.exitDescription}`);
		await this.screen.flush();
		// Unknown key names throw here, before anything is sent.
		const sequence = (keys ?? []).map((key) => keySequence(key, this.screen.applicationCursorKeys)).join("");
		this.#inputAt?.marker.dispose();
		this.#inputAt = this.screen.markCursor();
		this.#inputSentAt = Date.now();
		if (input !== undefined && input !== "") this.#remote.write(input.replaceAll("\r\n", "\r").replaceAll("\n", "\r"));
		if (sequence !== "") this.#remote.write(sequence);
	}

	/** Candidates for `waitFor`: what came after the input, or the unread output; untrimmed and trimmed. */
	#matchText(afterInput: boolean): string[] {
		if (this.screen.alternate) return [this.screen.screen(false), this.screen.screen()];
		if (afterInput && this.#inputAt !== undefined) {
			const raw = this.screen.textFrom(this.#inputAt, false);
			if (raw !== undefined) return [raw, this.screen.textFrom(this.#inputAt) ?? raw];
		}
		return [this.screen.peekNew(false), this.screen.peekNew()];
	}

	resize(cols: number, rows: number): void {
		this.screen.resize(cols, rows);
		this.#remote.resize(cols, rows);
	}

	/** The job in front of the shell (e.g. a running command or REPL), undefined at the prompt, null once ended. */
	async foreground(): Promise<TerminalForeground | undefined | null> {
		if (this.exited) return null;
		try {
			return await this.#remote.foreground();
		} catch {
			return null;
		}
	}

	/** Resolves on the next output or exit, or after `ms`. */
	#nextEvent(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.#listeners.delete(done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, Math.max(1, ms));
			this.#listeners.add(done);
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	/**
	 * Wait until the terminal settles: `waitFor` matches the unread output; or, without it, the shell is back at its
	 * prompt with output quiet for a moment, or output stays quiet for `idleMs`; or the program exits; or `timeoutMs`
	 * passes. With `afterInput` (after `send`), only what the terminal printed after the input counts, and only once
	 * it answered at all, so neither the prompt the input was typed at nor a slow link can end the wait early.
	 */
	async settle(options: {
		timeoutMs: number;
		idleMs?: number;
		waitFor?: RegExp;
		afterInput?: boolean;
		signal?: AbortSignal;
	}): Promise<SettleReason> {
		const started = Date.now();
		const deadline = started + options.timeoutMs;
		const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
		let promptCheckedAt = 0;
		while (true) {
			if (options.signal?.aborted) throw options.signal.reason;
			await this.screen.flush();
			const answered = options.afterInput !== true || this.#lastOutputAt >= this.#inputSentAt;
			if (options.waitFor !== undefined && answered) {
				const waitFor = options.waitFor;
				if (this.#matchText(options.afterInput === true).some((text) => waitFor.test(text))) return "matched";
			}
			if (this.exited) return "exited";
			const now = Date.now();
			if (now >= deadline) return "timeout";
			// Quiet time counts from the start of this wait: silence before it says nothing about the input just sent.
			const quiet = now - Math.max(this.#lastOutputAt, started);
			if (options.waitFor === undefined) {
				if (quiet >= idleMs) return "idle";
				// Ask the daemon about the foreground job once per quiet spell. A shell that is busy by itself (sourcing its
				// startup files, or running a builtin) is in the foreground too, so the prompt must also have been drawn:
				// the cursor sits after it rather than at the start of an empty line.
				if (answered && quiet >= PROMPT_QUIET_MS && promptCheckedAt <= this.#lastOutputAt) {
					promptCheckedAt = Date.now();
					if (this.screen.cursor().col > 1 && (await this.foreground()) === undefined) return "prompt";
					continue;
				}
			}
			const untilNext = quiet < PROMPT_QUIET_MS ? PROMPT_QUIET_MS - quiet : idleMs - quiet;
			const wait = options.waitFor === undefined ? Math.min(untilNext, deadline - now) : Math.min(250, deadline - now);
			await this.#nextEvent(wait, options.signal);
		}
	}

	/** Output since the last read (or the screen of a full-screen program), with a status header. */
	async render(limits: Limits, mode: "new" | "screen", reason?: SettleReason): Promise<string> {
		await this.screen.flush();
		let body: string;
		let fullScreen = false;
		let lost = false;
		if (mode === "screen") {
			body = this.screen.screen();
			fullScreen = true;
		} else {
			const taken = this.screen.takeNew();
			body = taken.text;
			fullScreen = taken.screen;
			lost = taken.lost;
		}
		const bounded = boundOutput(body, { ...limits, retain: "tail" });
		const header = await this.#status(reason, fullScreen);
		const notes: string[] = [];
		if (lost) notes.push("[earlier output scrolled out of the terminal's scrollback before it was read]");
		if (bounded.droppedLines > 0) notes.push(`[${bounded.droppedLines} earlier lines not shown]`);
		const text = bounded.text === "" ? "(no new output)" : bounded.text;
		return [header, ...notes, text].join("\n");
	}

	async #status(reason: SettleReason | undefined, fullScreen: boolean): Promise<string> {
		const parts = [`terminal ${this.id} on ${this.host.name}`];
		if (this.exited) {
			parts.push(this.exitDescription ?? "ended");
		} else {
			const foreground = await this.foreground();
			if (foreground === undefined) parts.push("shell at prompt");
			else if (foreground !== null) parts.push(`running ${foreground.name ?? "a program"} (pid ${foreground.pid})`);
			if (reason === "timeout") parts.push("still busy when the wait ended");
			else if (reason === "idle" && foreground) parts.push("no output for a while; waiting for input or still working");
			else if (reason === "matched") parts.push("wait_for matched");
		}
		if (fullScreen) {
			const cursor = this.screen.cursor();
			parts.push(`full screen ${this.screen.cols}x${this.screen.rows}, cursor at row ${cursor.row} col ${cursor.col}`);
		}
		return `[${parts.join(" · ")}]`;
	}

	describe(): string {
		const age = formatDuration(Date.now() - this.startedAt);
		const state = this.exited ? this.exitDescription : `open for ${age}`;
		return `${this.id} (${this.command ?? "shell"}; ${state})`;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#inputAt?.marker.dispose();
		this.#remote.close();
		this.host.resources.delete(this);
		this.screen.dispose();
		this.#onClose();
	}
}

/** Every open terminal, across hosts, by id. */
export class TerminalRegistry {
	readonly #terminals = new Map<string, TerminalSession>();
	#next = 1;

	async open(host: HostSession, options: TerminalOpenOptions): Promise<TerminalSession> {
		const id = `t${this.#next++}`;
		const terminal = await TerminalSession.open(id, host, options, () => this.#terminals.delete(id));
		this.#terminals.set(id, terminal);
		return terminal;
	}

	get(id: string): TerminalSession {
		const terminal = this.#terminals.get(id);
		if (terminal === undefined) {
			const open = [...this.#terminals.keys()];
			throw new Error(`No terminal "${id}". ${open.length ? `Open terminals: ${open.join(", ")}.` : "No terminals are open; use terminal_open."}`);
		}
		return terminal;
	}

	/** Terminals of one host, or all of them. */
	list(host?: string): TerminalSession[] {
		return [...this.#terminals.values()].filter((terminal) => host === undefined || terminal.host.name === host);
	}
}
