import { assertValidAgentAlias, isValidAgentAlias } from "./identity";
import type { AgentRoster, AgentRosterLink } from "./session-broker";

export const SUBAGENT_LINK_ENTRY_TYPE = "rail-subagent-link";

export type SubagentLinkData =
	| { action: "link"; alias: string; agentId: string }
	| { action: "unlink"; alias: string };

export interface SubagentLinkEntry {
	type: "custom";
	id: string;
	parentId: string | null;
	timestamp: string;
	customType: typeof SUBAGENT_LINK_ENTRY_TYPE;
	data?: SubagentLinkData;
}

type AppendEntry = (customType: string, data: SubagentLinkData) => void;

function linkData(entry: unknown): SubagentLinkData | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const candidate = entry as Partial<SubagentLinkEntry>;
	if (candidate.type !== "custom" || candidate.customType !== SUBAGENT_LINK_ENTRY_TYPE) return undefined;
	const data = candidate.data;
	if (!data || typeof data.alias !== "string" || !isValidAgentAlias(data.alias)) return undefined;
	if (data.action === "unlink") return data;
	if (data.action === "link" && typeof data.agentId === "string") return data;
	return undefined;
}

export class SessionAgentRoster implements AgentRoster {
	private readonly aliases = new Map<string, string>();

	constructor(private readonly appendEntry?: AppendEntry) {}

	restore(entries: readonly unknown[]): void {
		this.aliases.clear();
		for (const entry of entries) {
			const data = linkData(entry);
			if (!data) continue;
			if (data.action === "link") this.aliases.set(data.alias, data.agentId);
			else this.aliases.delete(data.alias);
		}
	}

	resolve(target: string): string | undefined {
		return this.aliases.get(target) ?? (Array.from(this.aliases.values()).includes(target) ? target : undefined);
	}

	link(alias: string, agentId: string): void {
		assertValidAgentAlias(alias);
		const existing = this.aliases.get(alias);
		if (existing && existing !== agentId) throw new Error(`Subagent alias already exists: ${alias}`);
		if (existing === agentId) return;
		this.aliases.set(alias, agentId);
		this.appendEntry?.(SUBAGENT_LINK_ENTRY_TYPE, { action: "link", alias, agentId });
	}

	unlink(alias: string): void {
		if (!this.aliases.delete(alias)) return;
		this.appendEntry?.(SUBAGENT_LINK_ENTRY_TYPE, { action: "unlink", alias });
	}

	list(): AgentRosterLink[] {
		return Array.from(this.aliases, ([alias, agentId]) => ({ alias, agentId }))
			.sort((a, b) => a.alias.localeCompare(b.alias));
	}
}