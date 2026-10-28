/** Small helpers shared by the tools. */

/** POSIX shell quoting: one single-quoted word. */
export function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** `1.2 KB`, `3.4 MB`: sizes for people, in powers of 1024. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** `850 ms`, `12.3 s`, `4 min 05 s`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	if (minutes < 60) return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
	return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Serializes async work per key, such as edits of one file. */
export class KeyedMutex {
	readonly #tails = new Map<string, Promise<unknown>>();

	async run<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#tails.get(key) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(work);
		this.#tails.set(key, current);
		try {
			return await current;
		} finally {
			if (this.#tails.get(key) === current) this.#tails.delete(key);
		}
	}
}

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** `cat -n` style: the line number right-aligned in six columns, a tab, the text. */
export function numberLine(lineNumber: number, text: string): string {
	return `${String(lineNumber).padStart(6)}\t${text}`;
}
