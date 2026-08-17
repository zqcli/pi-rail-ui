import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface LeaseOwner {
	pid: number;
	token: string;
	createdAt: string;
}

export interface SessionLease {
	release(): Promise<void>;
}

export type SessionLeaseInspection =
	| { state: "free" }
	| { state: "owned"; owner: LeaseOwner }
	| { state: "stale"; owner?: LeaseOwner }
	| { state: "unknown" };

const OWNER_FILE = "owner.json";
const OWNER_WRITE_GRACE_MS = 5000;

export function sessionLeaseDirectoryName(key: string): string {
	return `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.lock`;
}

function processExists(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function readOwner(lockDir: string): Promise<LeaseOwner | undefined> {
	try {
		const value = JSON.parse(await readFile(join(lockDir, OWNER_FILE), "utf8")) as Partial<LeaseOwner>;
		if (typeof value.pid !== "number" || typeof value.token !== "string" || typeof value.createdAt !== "string") {
			return undefined;
		}
		return value as LeaseOwner;
	} catch {
		return undefined;
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export class FileSessionLeaseManager {
	private readonly leasesDir: string;

	constructor(baseDir: string) {
		this.leasesDir = join(baseDir, "leases");
	}

	async inspect(key: string): Promise<SessionLeaseInspection> {
		const lockDir = join(this.leasesDir, sessionLeaseDirectoryName(key));
		try {
			const owner = await readOwner(lockDir);
			if (owner) return processExists(owner.pid) ? { state: "owned", owner } : { state: "stale", owner };
			const age = Date.now() - (await stat(lockDir)).mtimeMs;
			return age < OWNER_WRITE_GRACE_MS ? { state: "unknown" } : { state: "stale" };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "free" };
			return { state: "unknown" };
		}
	}

	async acquire(key: string): Promise<SessionLease> {
		await mkdir(this.leasesDir, { recursive: true, mode: 0o700 });
		const lockDir = join(this.leasesDir, sessionLeaseDirectoryName(key));
		const reclaimDir = `${lockDir}.reclaim`;
		const token = randomUUID();
		const finish = async (): Promise<SessionLease> => {
			const owner: LeaseOwner = { pid: process.pid, token, createdAt: new Date().toISOString() };
			await writeFile(join(lockDir, OWNER_FILE), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });
			return {
				release: async () => {
					const current = await readOwner(lockDir);
					if (current?.token === token) await rm(lockDir, { recursive: true, force: true });
				},
			};
		};
		if (await pathExists(reclaimDir)) throw new Error("Subagent session lease is being reclaimed by another process");
		try {
			await mkdir(lockDir, { mode: 0o700 });
			if (await pathExists(reclaimDir)) {
				await rm(lockDir, { recursive: true, force: true });
				throw new Error("Subagent session lease is being reclaimed by another process");
			}
			return finish();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = await readOwner(lockDir);
		if (owner && processExists(owner.pid)) throw new Error(`Subagent session is already owned by process ${owner.pid}`);
		if (!owner) {
			const age = Date.now() - (await stat(lockDir)).mtimeMs;
			if (age < OWNER_WRITE_GRACE_MS) throw new Error("Subagent session is already owned by another process");
		}
		try {
			await mkdir(reclaimDir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Subagent session lease is being reclaimed by another process");
			throw error;
		}
		try {
			const latestOwner = await readOwner(lockDir);
			if (latestOwner && processExists(latestOwner.pid)) throw new Error(`Subagent session is already owned by process ${latestOwner.pid}`);
			if (!latestOwner) {
				const age = Date.now() - (await stat(lockDir)).mtimeMs;
				if (age < OWNER_WRITE_GRACE_MS) throw new Error("Subagent session is already owned by another process");
			}
			await rm(lockDir, { recursive: true, force: true });
			await mkdir(lockDir, { mode: 0o700 });
			return await finish();
		} finally {
			await rm(reclaimDir, { recursive: true, force: true });
		}
	}
}
