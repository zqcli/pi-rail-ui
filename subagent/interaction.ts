import type { AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { AgentInstance } from "./session-broker";

export interface SubagentMentions {
	targets: string[];
	profiles: string[];
}

export interface MentionAgentItem {
	alias: string;
	description: string;
}

export type MentionProfileItem = string | { name: string; description: string; source?: "user" | "project" };

function uniqueMatches(text: string, pattern: RegExp): string[] {
	const values: string[] = [];
	for (const match of text.matchAll(pattern)) {
		const value = match[1];
		if (value && !values.includes(value)) values.push(value);
	}
	return values;
}

export function extractSubagentMentions(text: string): SubagentMentions {
	return {
		targets: [...new Set([
			...uniqueMatches(text, /@agent\/([A-Za-z0-9][A-Za-z0-9._-]*)/gu),
			...uniqueMatches(text, /\bagent:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)/gu),
		])],
		profiles: [...new Set([
			...uniqueMatches(text, /@new\/([A-Za-z0-9][A-Za-z0-9._-]*)/gu),
			...uniqueMatches(text, /\bnew:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)/gu),
		])],
	};
}

function mentionPrefix(beforeCursor: string): { namespace: "agent" | "new"; prefix: string; query: string } | undefined {
	const match = beforeCursor.match(/(?:^|\s)(@(agent|new)\/([^\s@]*))$/u);
	if (!match) return undefined;
	return {
		namespace: match[2] as "agent" | "new",
		prefix: match[1]!,
		query: match[3] ?? "",
	};
}

export function subagentMentionSuggestions(
	beforeCursor: string,
	agents: MentionAgentItem[],
	profiles: MentionProfileItem[],
): AutocompleteSuggestions | null {
	const mention = mentionPrefix(beforeCursor);
	if (!mention) return null;
	let items: AutocompleteItem[];
	if (mention.namespace === "agent") {
		items = agents
			.filter((agent) => agent.alias.toLowerCase().startsWith(mention.query.toLowerCase()))
			.map((agent) => ({
				value: `@agent/${agent.alias}`,
				label: `@agent/${agent.alias}`,
				description: agent.description,
			}));
	} else {
		items = profiles
			.map((profile) => typeof profile === "string" ? { name: profile, description: "create persistent subagent" } : profile)
			.filter((profile) => profile.name.toLowerCase().startsWith(mention.query.toLowerCase()))
			.map((profile) => ({
				value: `@new/${profile.name}`,
				label: `@new/${profile.name}`,
				description: profile.description,
			}));
	}
	return items.length > 0 ? { prefix: mention.prefix, items } : null;
}

export function applySubagentMentionCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	value: string,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const nextLines = [...lines];
	const line = nextLines[cursorLine] ?? "";
	const start = Math.max(0, cursorCol - prefix.length);
	nextLines[cursorLine] = `${line.slice(0, start)}${value}${line.slice(cursorCol)}`;
	return { lines: nextLines, cursorLine, cursorCol: start + value.length };
}

function compactText(value: string, maxLength = 120): string {
	const oneLine = value.replace(/\s+/gu, " ").trim();
	return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 3)}...`;
}

export function buildSubagentRosterPrompt(
	instances: AgentInstance[],
	mentions: SubagentMentions,
	profiles: Array<{ name: string; source: "user" | "project" }> = [],
): string {
	if (instances.length === 0 && mentions.targets.length === 0 && mentions.profiles.length === 0) return "";
	const lines = [
		"## Persistent Subagents",
		"",
		"Use the subagent tool with `target` to continue a linked instance, or `agent` plus `alias` to create one.",
	];
	for (const instance of instances) {
		lines.push(
			`- ${instance.alias} (${instance.agentId}) [${compactText(instance.profile.name)}, idle]`,
			`  CWD: ${compactText(instance.cwd)}`,
			`  Last task: ${compactText(instance.lastTask)}`,
		);
	}
	if (mentions.targets.length > 0 || mentions.profiles.length > 0) {
		lines.push("", "Explicit routing from the current user message:");
		for (const target of mentions.targets) {
			lines.push(`- The user named @agent/${target}; you must call subagent with target="${target}" and must not substitute another instance.`);
		}
		for (const profile of mentions.profiles) {
			const source = profiles.find((item) => item.name === profile)?.source;
			const scope = source === "project" ? " and agentScope=\"project\"" : "";
			lines.push(`- The user named @new/${profile}; create a persistent subagent with agent="${profile}"${scope} and a concise unique alias.`);
		}
	}
	lines.push("", "For a follow-up concerning an instance's previous files or task, prefer that same target instead of creating a new agent.");
	return lines.join("\n");
}
