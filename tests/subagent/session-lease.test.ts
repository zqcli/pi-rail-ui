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
