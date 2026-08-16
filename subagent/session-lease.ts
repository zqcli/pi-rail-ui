import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface LeaseOwner {
	pid: number;
	token: string;
	createdAt: string;
}

export interface SessionLease {
	release(): Promise<void>;
}

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

export class FileSessionLeaseManager {
	private readonly leasesDir: string;

	constructor(baseDir: string) {
		this.leasesDir = join(baseDir, "leases");
	}

	async acquire(key: string): Promise<SessionLease> {
		await mkdir(this.leasesDir, { recursive: true, mode: 0o700 });
		const lockDir = join(this.leasesDir, sessionLeaseDirectoryName(key));
		const token = randomUUID();
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await mkdir(lockDir, { mode: 0o700 });
				const owner: LeaseOwner = { pid: process.pid, token, createdAt: new Date().toISOString() };
				await writeFile(join(lockDir, OWNER_FILE), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });
				return {
					release: async () => {
						const current = await readOwner(lockDir);
						if (current?.token === token) await rm(lockDir, { recursive: true, force: true });
					},
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const owner = await readOwner(lockDir);
				if (owner && processExists(owner.pid)) throw new Error(`Subagent session is already owned by process ${owner.pid}`);
				if (!owner) {
					const age = Date.now() - (await stat(lockDir)).mtimeMs;
					if (age < OWNER_WRITE_GRACE_MS) throw new Error("Subagent session is already owned by another process");
				}
				await rm(lockDir, { recursive: true, force: true });
			}
		}
		throw new Error("Failed to acquire subagent session lease");
	}
}
