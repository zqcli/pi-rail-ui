import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileSessionLeaseManager, sessionLeaseDirectoryName } from "../../subagent/session-lease";

test("FileSessionLeaseManager grants one owner and releases cleanly", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagent-lease-"));
	try {
		const manager = new FileSessionLeaseManager(dir);
		const lease = await manager.acquire("/tmp/child.jsonl");
		await assert.rejects(() => manager.acquire("/tmp/child.jsonl"), /already owned/);
		await lease.release();
		const reacquired = await manager.acquire("/tmp/child.jsonl");
		await reacquired.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("FileSessionLeaseManager reclaims a lease whose process no longer exists", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagent-stale-"));
	try {
		const leasesDir = join(dir, "leases");
		const lockDir = join(leasesDir, sessionLeaseDirectoryName("/tmp/stale.jsonl"));
		await mkdir(lockDir, { recursive: true });
		await writeFile(join(lockDir, "owner.json"), JSON.stringify({
			pid: 999_999,
			token: "stale",
			createdAt: "2000-01-01T00:00:00.000Z",
		}));
		const manager = new FileSessionLeaseManager(dir);

		const lease = await manager.acquire("/tmp/stale.jsonl");

		await lease.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("FileSessionLeaseManager inspects live, free, and stale owners without acquiring", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagent-inspect-"));
	try {
		const manager = new FileSessionLeaseManager(dir);
		assert.deepEqual(await manager.inspect("session:free"), { state: "free" });
		const lease = await manager.acquire("session:live");
		const live = await manager.inspect("session:live");
		assert.equal(live.state, "owned");
		if (live.state === "owned") assert.equal(live.owner.pid, process.pid);
		await lease.release();

		const lockDir = join(dir, "leases", sessionLeaseDirectoryName("session:stale"));
		await mkdir(lockDir, { recursive: true });
		await writeFile(join(lockDir, "owner.json"), JSON.stringify({
			pid: 999_999,
			token: "stale",
			createdAt: "2000-01-01T00:00:00.000Z",
		}));
		assert.equal((await manager.inspect("session:stale")).state, "stale");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("only one contender can reclaim the same stale lease", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-subagent-reclaim-race-"));
	try {
		const key = "session:stale-race";
		const lockDir = join(dir, "leases", sessionLeaseDirectoryName(key));
		await mkdir(lockDir, { recursive: true });
		await writeFile(join(lockDir, "owner.json"), JSON.stringify({
			pid: 999_999,
			token: "stale",
			createdAt: "2000-01-01T00:00:00.000Z",
		}));
		const first = new FileSessionLeaseManager(dir);
		const second = new FileSessionLeaseManager(dir);

		const results = await Promise.allSettled([first.acquire(key), second.acquire(key)]);

		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		for (const result of results) if (result.status === "fulfilled") await result.value.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
