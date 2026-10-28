import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { acceptHostKey, forgetHostKey, type SshTarget, scanHostKey } from "@earendil-works/pi-env";

/** What the user's own SSH setup says about a scanned key. */
export type KnownHostsVerdict =
	/** `~/.ssh/known_hosts` holds this very key: the user already trusted it. */
	| "match"
	/** It holds a different key of the same type: possibly a changed host or an attack. */
	| "mismatch"
	/** No key of this type is recorded for the host. */
	| "absent";

export interface HostKeyScan {
	/** Known-hosts lines for this tool's alias, to pass to `trustHostKey`. */
	lines: string[];
	fingerprints: string[];
	verdict: KnownHostsVerdict;
	/** The name the user's SSH looks the host up under, e.g. `[10.0.0.5]:2222`. */
	lookupName: string;
}

function run(program: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

/** The user's effective SSH configuration for the target, as `ssh -G` resolves it. */
async function resolvedConfig(target: SshTarget): Promise<Map<string, string>> {
	const args = [
		...(target.configFile === undefined ? [] : ["-F", target.configFile]),
		"-G",
		...(target.user === undefined ? [] : ["-l", target.user]),
		...(target.port === undefined ? [] : ["-p", String(target.port)]),
		"--",
		target.host,
	];
	const { code, stdout, stderr } = await run(target.ssh ?? "ssh", args);
	if (code !== 0) throw new Error(`ssh -G ${target.host} failed: ${stderr.trim()}`);
	const config = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const space = line.indexOf(" ");
		if (space > 0) config.set(line.slice(0, space).toLowerCase(), line.slice(space + 1).trim());
	}
	return config;
}

/**
 * The control socket the user's own SSH configuration uses for the target (`ControlPath`), or undefined when it uses
 * none. A master the user opened there (`ssh -fN host`) already passed their passphrase or one-time password.
 */
export async function controlPath(target: SshTarget): Promise<string | undefined> {
	const path = (await resolvedConfig(target)).get("controlpath");
	return path === undefined || path === "none" ? undefined : expandHome(path);
}

function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
}

/** `type key` pairs that the user's known-hosts files record for `name`. */
async function recordedKeys(name: string, files: string[]): Promise<{ type: string; key: string }[]> {
	const keys: { type: string; key: string }[] = [];
	for (const file of files) {
		if (!existsSync(file)) continue;
		const { stdout } = await run("ssh-keygen", ["-F", name, "-f", file]);
		for (const line of stdout.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("@")) continue;
			const [, type, key] = trimmed.split(/\s+/);
			if (type !== undefined && key !== undefined) keys.push({ type, key });
		}
	}
	return keys;
}

/**
 * Scan the key the host presents, through the same route real connections take, and compare it with what the user's
 * own `ssh` already trusts for that host.
 */
export async function scanHost(target: SshTarget): Promise<HostKeyScan> {
	const { lines, fingerprints } = await scanHostKey(target);
	let lookupName = target.host;
	let recorded: { type: string; key: string }[] = [];
	try {
		const config = await resolvedConfig(target);
		const hostname = config.get("hostname") ?? target.host;
		const port = config.get("port") ?? "22";
		const alias = config.get("hostkeyalias");
		lookupName = alias !== undefined && alias !== "none" ? alias : port === "22" ? hostname : `[${hostname}]:${port}`;
		const files = (config.get("userknownhostsfile") ?? "~/.ssh/known_hosts ~/.ssh/known_hosts2")
			.split(/\s+/)
			.filter((file) => file !== "" && file !== "none")
			.map(expandHome);
		recorded = await recordedKeys(lookupName, files);
	} catch {
		// Without `ssh -G` or `ssh-keygen` there is nothing to compare against.
	}
	const scanned = lines.map((line) => {
		const [, type = "", key = ""] = line.trim().split(/\s+/);
		return { type, key };
	});
	let verdict: KnownHostsVerdict = "absent";
	for (const { type, key } of scanned) {
		const sameType = recorded.filter((entry) => entry.type === type);
		if (sameType.some((entry) => entry.key === key)) {
			verdict = "match";
			break;
		}
		if (sameType.length > 0) verdict = "mismatch";
	}
	return { lines, fingerprints, verdict, lookupName };
}

/** Trust scanned keys; `replace` first forgets keys trusted earlier, after the user confirmed a changed key. */
export async function trustHostKey(target: SshTarget, lines: string[], replace = false): Promise<void> {
	if (replace) await forgetHostKey(target);
	await acceptHostKey(target, lines);
}

export { forgetHostKey };
