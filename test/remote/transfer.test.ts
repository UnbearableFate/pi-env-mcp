import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logServerOnFailure, prepareConfig, ssh, TEST_HOST, TestClient } from "./helpers.ts";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

describe.skipIf(TEST_HOST === undefined)(`upload and download with ${TEST_HOST}`, () => {
	const host = TEST_HOST!;
	const remote = `/tmp/pi-env-mcp-transfer-${randomBytes(4).toString("hex")}`;
	let configDir: string;
	let local: string;
	let client: TestClient;
	const big = randomBytes(9 * 1024 * 1024 + 123);

	logServerOnFailure(() => client);

	beforeAll(async () => {
		configDir = prepareConfig(host);
		client = await new TestClient(configDir).connect();
		local = mkdtempSync(join(tmpdir(), "pi-env-mcp-transfer-"));
		mkdirSync(join(local, "tree", "nested", "deeper"), { recursive: true });
		writeFileSync(join(local, "tree", "a.txt"), "alpha\n");
		writeFileSync(join(local, "tree", "nested", "big.bin"), big);
		writeFileSync(join(local, "tree", "nested", "deeper", "empty"), "");
		writeFileSync(join(local, "tree", "run.sh"), "#!/bin/sh\necho ran\n", { mode: 0o755 });
		symlinkSync("a.txt", join(local, "tree", "link"));
	});

	afterAll(async () => {
		await client?.call("bash", { command: `rm -rf ${remote}` });
		await client?.close();
		rmSync(local, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	it("uploads a directory tree, keeping contents and executable bits", async () => {
		const result = await client.ok("upload", { local_path: join(local, "tree"), remote_path: `${remote}/` });
		expect(result).toMatch(/Uploaded 4 files \(9\.0 MB\) to .*:\/tmp\/pi-env-mcp-transfer-[0-9a-f]+\/tree/);
		expect(result).toMatch(/Skipped 1 symbolic links or special files: link/);
		// Checked over plain ssh: the files are on the remote machine's own /tmp.
		const sums = ssh(host, `cd ${remote}/tree && sha256sum nested/big.bin a.txt && ./run.sh && stat -c %s nested/deeper/empty`);
		expect(sums).toContain(`${sha256(big)}  nested/big.bin`);
		expect(sums).toContain(`${sha256(Buffer.from("alpha\n"))}  a.txt`);
		expect(sums).toContain("ran\n0");
		expect(existsSync(remote)).toBe(false);
	});

	it("uploads a single file to an exact path, replacing what was there", async () => {
		await client.ok("upload", { local_path: join(local, "tree", "a.txt"), remote_path: `${remote}/single/renamed.txt` });
		writeFileSync(join(local, "changed.txt"), "beta\n");
		await client.ok("upload", { local_path: join(local, "changed.txt"), remote_path: `${remote}/single/renamed.txt` });
		expect(ssh(host, `cat ${remote}/single/renamed.txt; ls -A ${remote}/single`)).toBe("beta\nrenamed.txt\n");
	});

	it("copies into a symbolic link to a directory, and keeps links and permissions of existing files", async () => {
		ssh(host, `mkdir -p ${remote}/real ${remote}/links && ln -s ${remote}/real ${remote}/links/dirlink && printf old > ${remote}/real/secret && chmod 600 ${remote}/real/secret && ln -s ${remote}/real/secret ${remote}/links/filelink`);
		writeFileSync(join(local, "secret"), "new-secret\n");
		// Into the linked directory, not over the link.
		await client.ok("upload", { local_path: join(local, "tree", "a.txt"), remote_path: `${remote}/links/dirlink` });
		// Over an existing 0600 file through a link: the link stays, the file keeps its mode.
		await client.ok("upload", { local_path: join(local, "secret"), remote_path: `${remote}/links/filelink` });
		const state = ssh(host, `cd ${remote} && stat -c '%F %a' links/dirlink links/filelink real/secret && cat real/secret real/a.txt`);
		expect(state).toBe("symbolic link 777\nsymbolic link 777\nregular file 600\nnew-secret\nalpha\n");
	});

	it("downloads a directory tree and a single file", async () => {
		const target = join(local, "back");
		const result = await client.ok("download", { remote_path: `${remote}/tree`, local_path: target });
		expect(result).toMatch(/Downloaded 4 files \(9\.0 MB\)/);
		expect(result).toContain(`from ${host}:${remote}/tree to ${target} in`);
		expect(sha256(readFileSync(join(target, "nested", "big.bin")))).toBe(sha256(big));
		expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("alpha\n");
		expect(statSync(join(target, "nested", "deeper", "empty")).size).toBe(0);

		mkdirSync(join(local, "into"));
		await client.ok("download", { remote_path: `${remote}/single/renamed.txt`, local_path: join(local, "into") });
		expect(readFileSync(join(local, "into", "renamed.txt"), "utf8")).toBe("beta\n");

		// A relative source resolves against the working directory, which a cd in bash moves; the result names it in full.
		await client.ok("bash", { command: `cd ${remote}/single` });
		const relative = await client.ok("download", { remote_path: "renamed.txt", local_path: join(local, "relative.txt") });
		expect(relative).toContain(`from ${host}:${remote}/single/renamed.txt to ${join(local, "relative.txt")} in`);
		await client.ok("bash", { command: "cd ~" });
	});

	it("reports a missing source", async () => {
		const missing = await client.call("download", { remote_path: `${remote}/nope`, local_path: join(local, "x") });
		expect(missing.isError).toBe(true);
		expect(missing.text).toMatch(/No such file or directory/);
		const absent = await client.call("upload", { local_path: join(local, "nope"), remote_path: remote });
		expect(absent.isError).toBe(true);
		expect(absent.text).toMatch(/Local path not found/);
	});
});
