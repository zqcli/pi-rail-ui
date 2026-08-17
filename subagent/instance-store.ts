import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidAgentAlias } from "./identity";
import type { RailModelRef, RailThinkingLevel } from "./models";
import type { AgentInstance, AgentInstanceStore } from "./session-broker";

const AGENT_ID_RE = /^agt_[A-Za-z0-9_-]+$/u;
const THINKING_LEVELS = new Set<RailThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface LegacyAgentInstance {
	version: 1;
	agentId: string;
	alias: string;
	profile?: { model?: string };
	sessionId: string;
	sessionFile: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	lastTask: string;
	lastOutput?: string;
}

interface SessionEntryCandidate {
	type?: string;
	thinkingLevel?: unknown;
	provider?: unknown;
	modelId?: unknown;
	message?: {
		role?: unknown;
		provider?: unknown;
		model?: unknown;
	};
}

function validIdentity(item: Partial<AgentInstance>): boolean {
	return typeof item.agentId === "string"
		&& AGENT_ID_RE.test(item.agentId)
		&& typeof item.alias === "string"
		&& isValidAgentAlias(item.alias)
		&& typeof item.sessionId === "string"
		&& typeof item.sessionFile === "string"
		&& typeof item.cwd === "string"
		&& typeof item.createdAt === "string"
		&& typeof item.updatedAt === "string"
		&& typeof item.lastTask === "string";
}

function isAgentInstance(value: unknown): value is AgentInstance {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<AgentInstance>;
	return item.version === 2
		&& validIdentity(item)
		&& typeof item.model?.provider === "string"
		&& typeof item.model.modelId === "string"
		&& (item.model.thinkingLevel === undefined || THINKING_LEVELS.has(item.model.thinkingLevel));
}

function parseModelReference(reference: string | undefined): RailModelRef | undefined {
	if (!reference) return undefined;
	let normalized = reference.trim();
	let thinkingLevel: RailThinkingLevel | undefined;
	const separator = normalized.lastIndexOf(":");
	if (separator >= 0) {
		const suffix = normalized.slice(separator + 1) as RailThinkingLevel;
		if (THINKING_LEVELS.has(suffix)) {
			thinkingLevel = suffix;
			normalized = normalized.slice(0, separator);
		}
	}
	const slash = normalized.indexOf("/");
	if (slash <= 0 || slash === normalized.length - 1) return undefined;
	return {
		provider: normalized.slice(0, slash),
		modelId: normalized.slice(slash + 1),
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

async function modelFromSession(sessionFile: string): Promise<RailModelRef | undefined> {
	try {
		const lines = (await readFile(sessionFile, "utf8")).split("\n");
		let model: RailModelRef | undefined;
		let thinkingLevel: RailThinkingLevel | undefined;
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: SessionEntryCandidate;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string"
				&& THINKING_LEVELS.has(entry.thinkingLevel as RailThinkingLevel)) {
				thinkingLevel = entry.thinkingLevel as RailThinkingLevel;
			}
			if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
				model = { provider: entry.provider, modelId: entry.modelId };
			}
			if (entry.type === "message" && entry.message?.role === "assistant"
				&& typeof entry.message.provider === "string" && typeof entry.message.model === "string") {
				model = { provider: entry.message.provider, modelId: entry.message.model };
			}
		}
		return model ? { ...model, ...(thinkingLevel ? { thinkingLevel } : {}) } : undefined;
	} catch {
		return undefined;
	}
}

async function migrateLegacy(value: unknown): Promise<AgentInstance | undefined> {
	if (!value || typeof value !== "object") return undefined;
	const legacy = value as LegacyAgentInstance;
	if (legacy.version !== 1 || !validIdentity(legacy as unknown as Partial<AgentInstance>)) return undefined;
	const model = await modelFromSession(legacy.sessionFile) ?? parseModelReference(legacy.profile?.model);
	if (!model) return undefined;
	return {
		version: 2,
		agentId: legacy.agentId,
		alias: legacy.alias,
		model,
		sessionId: legacy.sessionId,
		sessionFile: legacy.sessionFile,
		cwd: legacy.cwd,
		createdAt: legacy.createdAt,
		updatedAt: legacy.updatedAt,
		lastTask: legacy.lastTask,
		...(legacy.lastOutput ? { lastOutput: legacy.lastOutput } : {}),
	};
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
			if (isAgentInstance(value)) return value;
			const migrated = await migrateLegacy(value);
			if (migrated) await this.put(migrated);
			return migrated;
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
