import type { AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { railModelReference } from "./models";
import type { AgentInstance } from "./session-broker";

export interface SubagentMentions {
	targets: string[];
	models: string[];
}

export interface MentionAgentItem {
	alias: string;
	description: string;
}

export type MentionModelItem = string | { reference: string; description: string };

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
		models: [...new Set([
			...uniqueMatches(text, /@new\/([A-Za-z0-9][A-Za-z0-9._:/-]*)/gu),
			...uniqueMatches(text, /\bnew:\/\/([A-Za-z0-9][A-Za-z0-9._:/-]*)/gu),
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
	models: MentionModelItem[],
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
		items = models
			.map((model) => typeof model === "string" ? { reference: model, description: "start a persistent model session" } : model)
			.filter((model) => model.reference.toLowerCase().startsWith(mention.query.toLowerCase()))
			.map((model) => ({
				value: `@new/${model.reference}`,
				label: `@new/${model.reference}`,
				description: model.description,
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

export function buildSubagentRosterPrompt(instances: AgentInstance[], mentions: SubagentMentions): string {
	if (instances.length === 0 && mentions.targets.length === 0 && mentions.models.length === 0) return "";
	const lines = [
		"## Persistent Rail Model Sessions",
		"",
		"Use the subagent tool with `target` to continue a linked session, or `model` plus `alias` to create one.",
	];
	for (const instance of instances) {
		lines.push(
			`- ${instance.alias} (${instance.agentId}) [${compactText(railModelReference(instance.model))}, idle]`,
			`  CWD: ${compactText(instance.cwd)}`,
			`  Last task: ${compactText(instance.lastTask)}`,
		);
	}
	if (mentions.targets.length > 0 || mentions.models.length > 0) {
		lines.push("", "Explicit routing from the current user message:");
		for (const target of mentions.targets) {
			lines.push(`- The user named @agent/${target}; you must call subagent with target="${target}" and must not substitute another session.`);
		}
		for (const model of mentions.models) {
			lines.push(`- The user named @new/${model}; create a persistent model session with model="${model}" and a concise unique alias.`);
		}
	}
	lines.push("", "For follow-up work on the same files or topic, prefer the same target instead of creating a new session.");
	return lines.join("\n");
}
