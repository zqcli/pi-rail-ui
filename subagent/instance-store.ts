import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidAgentAlias } from "./identity";
import type { AgentInstance, AgentInstanceStore } from "./session-broker";

const AGENT_ID_RE = /^agt_[A-Za-z0-9_-]+$/u;

function isAgentInstance(value: unknown): value is AgentInstance {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<AgentInstance>;
	return item.version === 1
		&& typeof item.agentId === "string"
		&& AGENT_ID_RE.test(item.agentId)
		&& typeof item.alias === "string"
		&& isValidAgentAlias(item.alias)
		&& typeof item.sessionId === "string"
		&& typeof item.sessionFile === "string"
		&& typeof item.cwd === "string"
		&& typeof item.profile?.name === "string";
}

export class FileAgentInstanceStore implements AgentInstanceStore {
	private readonly instancesDir: string;

	constructor(baseDir: string) {
		this.instancesDir = join(baseDir, "instances");
	}

	async get(agentId: string): Promise<AgentInstance | undefined> {
		if (!AGENT_ID_RE.test(agentId)) return undefined;
		try {
			const value = JSON.parse(await readFile(this.instancePath(agentId), "utf8")) as unknown;
			return isAgentInstance(value) ? value : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async put(instance: AgentInstance): Promise<void> {
		if (!AGENT_ID_RE.test(instance.agentId)) throw new Error(`Invalid subagent id: ${instance.agentId}`);
		await mkdir(this.instancesDir, { recursive: true, mode: 0o700 });
		const target = this.instancePath(instance.agentId);
		const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(instance, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, target);
	}

	async list(): Promise<AgentInstance[]> {
		try {
			const names = await readdir(this.instancesDir);
			const values = await Promise.all(names
				.filter((name) => name.endsWith(".json"))
				.map((name) => this.get(name.slice(0, -".json".length))));
			return values
				.filter((value): value is AgentInstance => value !== undefined)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	private instancePath(agentId: string): string {
		return join(this.instancesDir, `${agentId}.json`);
	}
}