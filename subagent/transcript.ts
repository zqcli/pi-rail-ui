import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_ENTRIES = 18;
const MAX_ENTRY_CHARS = 4000;
const COLLAPSED_ROWS = 10;
const EXPANDED_ROWS = 16;
const MAX_ENTRY_ROWS = 5;

export type SubagentTranscriptKind = "user" | "assistant" | "thinking" | "tool" | "toolResult";
export type SubagentTranscriptStatus = "running" | "completed" | "failed";

export interface SubagentTranscriptEntry {
	id: string;
	kind: SubagentTranscriptKind;
	label?: string;
	groupId?: string;
	text: string;
	status?: SubagentTranscriptStatus;
	order: number;
}

export interface SubagentTranscriptSnapshot {
	entries: SubagentTranscriptEntry[];
	omittedEntries: number;
}

export interface SubagentTranscriptOptions {
	maxEntries?: number;
}

export interface SubagentTranscriptRun {
	alias: string;
	model?: string;
	status: SubagentTranscriptStatus;
	output: string;
	persistent: boolean;
	transcript?: SubagentTranscriptSnapshot;
}

type UnknownRecord = Record<string, unknown>;
let activityOrder = 0;

function nextActivityOrder(): number {
	return ++activityOrder;
}

function groupKey(entry: SubagentTranscriptEntry): string {
	return entry.groupId ?? entry.id;
}

function activityGroups(entries: SubagentTranscriptEntry[]): Map<string, number> {
	const groups = new Map<string, number>();
	for (const entry of entries) groups.set(groupKey(entry), Math.max(groups.get(groupKey(entry)) ?? 0, entry.order));
	return groups;
}

function oldestActivityGroup(entries: SubagentTranscriptEntry[]): string | undefined {
	let oldest: string | undefined;
	let oldestOrder = Number.POSITIVE_INFINITY;
	for (const [key, order] of activityGroups(entries)) {
		if (order < oldestOrder) {
			oldest = key;
			oldestOrder = order;
		}
	}
	return oldest;
}

function record(value: unknown): UnknownRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function cleanText(value: string): string {
	const clean = stripTerminalSequences(value)
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
		.trim();
	if (clean.length <= MAX_ENTRY_CHARS) return clean;
	return `[… earlier text omitted]\n${clean.slice(-(MAX_ENTRY_CHARS - 28))}`;
}

function cleanStreamingText(value: string): string {
	const clean = stripTerminalSequences(value)
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
	if (clean.length <= MAX_ENTRY_CHARS) return clean;
	return `[… earlier text omitted]\n${clean.slice(-(MAX_ENTRY_CHARS - 28))}`;
}

function safeJson(value: unknown): string {
	try {
		return cleanText(JSON.stringify(value, null, 2) ?? String(value));
	} catch {
		return cleanText(String(value));
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return cleanText(content);
	if (!Array.isArray(content)) return "";
	return cleanText(content.map((part) => {
		const item = record(part);
		if (item?.["type"] === "text" && typeof item["text"] === "string") return item["text"];
		if (item?.["type"] === "image") return "[image]";
		return "";
	}).filter(Boolean).join("\n"));
}

function toolCallText(toolCall: UnknownRecord): string {
	return safeJson(toolCall["arguments"] ?? {});
}

export class SubagentTranscript {
	private readonly maxEntries: number;
	private readonly entries: SubagentTranscriptEntry[] = [];
	private readonly byId = new Map<string, SubagentTranscriptEntry>();
	private omittedEntries = 0;
	private assistantSequence = 0;
	private userSequence = 0;
	private anonymousResultSequence = 0;
	private activeAssistant: number | undefined;
	private readonly toolCallDrafts = new Map<string, string>();
	private readonly toolCalls = new Map<string, { label: string; text: string }>();

	constructor(task: string, options: SubagentTranscriptOptions = {}) {
		this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
		this.addUser(task);
	}

	ingest(value: unknown): boolean {
		const event = record(value);
		if (!event || typeof event["type"] !== "string") return false;
		switch (event["type"]) {
			case "message_start":
				return this.messageStart(record(event["message"]));
			case "message_update":
				return this.messageUpdate(record(event["assistantMessageEvent"]));
			case "message_end":
				return this.messageEnd(record(event["message"]));
			case "tool_execution_start":
				return this.toolStart(event);
			case "tool_execution_update":
				return this.toolUpdate(event);
			case "tool_execution_end":
				return this.toolEnd(event);
			default:
				return false;
		}
	}

	snapshot(): SubagentTranscriptSnapshot {
		return {
			entries: this.entries.map((entry) => ({ ...entry })),
			omittedEntries: this.omittedEntries,
		};
	}

	private messageStart(message: UnknownRecord | undefined): boolean {
		if (message?.["role"] === "assistant") {
			this.activeAssistant = ++this.assistantSequence;
			return false;
		}
		if (message?.["role"] === "user") return this.addUser(contentText(message["content"]));
		return false;
	}

	private messageUpdate(update: UnknownRecord | undefined): boolean {
		if (!update || typeof update["type"] !== "string") return false;
		const messageId = this.ensureAssistant();
		const contentIndex = typeof update["contentIndex"] === "number" ? update["contentIndex"] : 0;
		if (update["type"] === "text_delta" || update["type"] === "thinking_delta") {
			const delta = typeof update["delta"] === "string" ? update["delta"] : "";
			if (!delta) return false;
			const kind = update["type"] === "thinking_delta" ? "thinking" : "assistant";
			return this.upsert(`${kind}:${messageId}:${contentIndex}`, { kind, text: delta }, true);
		}
		if (update["type"] === "text_end" || update["type"] === "thinking_end") {
			const text = typeof update["content"] === "string" ? update["content"] : "";
			if (!text) return false;
			const kind = update["type"] === "thinking_end" ? "thinking" : "assistant";
			return this.upsert(`${kind}:${messageId}:${contentIndex}`, { kind, text });
		}
		if (update["type"] === "toolcall_start") {
			const draftId = `toolDraft:${messageId}:${contentIndex}`;
			this.toolCallDrafts.set(draftId, "");
			return this.upsert(draftId, {
				kind: "tool",
				label: "tool",
				groupId: draftId,
				text: "(preparing arguments...)",
				status: "running",
			});
		}
		if (update["type"] === "toolcall_delta") {
			const draftId = `toolDraft:${messageId}:${contentIndex}`;
			const delta = typeof update["delta"] === "string" ? update["delta"] : "";
			if (!delta) return false;
			const args = `${this.toolCallDrafts.get(draftId) ?? ""}${delta}`;
			this.toolCallDrafts.set(draftId, args);
			return this.upsert(draftId, {
				kind: "tool",
				label: "tool",
				groupId: draftId,
				text: args,
				status: "running",
			});
		}
		if (update["type"] === "toolcall_end") {
			const call = record(update["toolCall"]);
			if (!call || typeof call["id"] !== "string") return false;
			const draftId = `toolDraft:${messageId}:${contentIndex}`;
			this.toolCallDrafts.delete(draftId);
			this.toolCalls.set(call["id"], {
				label: typeof call["name"] === "string" ? call["name"] : "tool",
				text: toolCallText(call),
			});
			return this.promote(draftId, `tool:${call["id"]}`, {
				kind: "tool",
				label: typeof call["name"] === "string" ? call["name"] : "tool",
				groupId: `tool:${call["id"]}`,
				text: toolCallText(call),
				status: "running",
			});
		}
		return false;
	}

	private messageEnd(message: UnknownRecord | undefined): boolean {
		if (!message || typeof message["role"] !== "string") return false;
		if (message["role"] === "user") return this.addUser(contentText(message["content"]));
		if (message["role"] === "toolResult") {
			const callId = typeof message["toolCallId"] === "string" ? message["toolCallId"] : `message-${++this.anonymousResultSequence}`;
			let changed = this.restoreToolCall(callId);
			changed = this.upsert(`toolResult:${callId}`, {
				kind: "toolResult",
				label: typeof message["toolName"] === "string" ? message["toolName"] : "tool",
				groupId: `tool:${callId}`,
				text: contentText(message["content"]) || "(no output)",
				status: message["isError"] === true ? "failed" : "completed",
			}) || changed;
			this.toolCalls.delete(callId);
			return changed;
		}
		if (message["role"] !== "assistant" || !Array.isArray(message["content"])) return false;
		const messageId = this.ensureAssistant();
		let changed = false;
		for (let index = 0; index < message["content"].length; index++) {
			const part = record(message["content"][index]);
			if (!part || typeof part["type"] !== "string") continue;
			if (part["type"] === "text" && typeof part["text"] === "string") {
				changed = this.upsert(`assistant:${messageId}:${index}`, { kind: "assistant", text: part["text"] }) || changed;
			} else if (part["type"] === "thinking" && typeof part["thinking"] === "string") {
				changed = this.upsert(`thinking:${messageId}:${index}`, { kind: "thinking", text: part["thinking"] }) || changed;
			} else if (part["type"] === "toolCall" && typeof part["id"] === "string") {
				this.toolCalls.set(part["id"], {
					label: typeof part["name"] === "string" ? part["name"] : "tool",
					text: toolCallText(part),
				});
				changed = this.upsert(`tool:${part["id"]}`, {
					kind: "tool",
					label: typeof part["name"] === "string" ? part["name"] : "tool",
					groupId: `tool:${part["id"]}`,
					text: toolCallText(part),
					status: this.byId.get(`tool:${part["id"]}`)?.status ?? "running",
				}) || changed;
			}
		}
		if (typeof message["errorMessage"] === "string" && message["errorMessage"].trim()) {
			changed = this.upsert(`assistant:${messageId}:error`, {
				kind: "assistant",
				text: message["errorMessage"],
				status: "failed",
			}) || changed;
		}
		this.activeAssistant = undefined;
		return changed;
	}

	private toolStart(event: UnknownRecord): boolean {
		if (typeof event["toolCallId"] !== "string") return false;
		this.toolCalls.set(event["toolCallId"], {
			label: typeof event["toolName"] === "string" ? event["toolName"] : "tool",
			text: safeJson(event["args"] ?? {}),
		});
		return this.upsert(`tool:${event["toolCallId"]}`, {
			kind: "tool",
			label: typeof event["toolName"] === "string" ? event["toolName"] : "tool",
			groupId: `tool:${event["toolCallId"]}`,
			text: safeJson(event["args"] ?? {}),
			status: "running",
		});
	}

	private toolUpdate(event: UnknownRecord): boolean {
		if (typeof event["toolCallId"] !== "string") return false;
		const result = record(event["partialResult"]);
		let changed = this.restoreToolCall(event["toolCallId"]);
		changed = this.upsert(`toolResult:${event["toolCallId"]}`, {
			kind: "toolResult",
			label: typeof event["toolName"] === "string" ? event["toolName"] : "tool",
			groupId: `tool:${event["toolCallId"]}`,
			text: contentText(result?.["content"]) || "(running...)",
			status: "running",
		}) || changed;
		return changed;
	}

	private toolEnd(event: UnknownRecord): boolean {
		if (typeof event["toolCallId"] !== "string") return false;
		const failed = event["isError"] === true;
		const callId = event["toolCallId"];
		let changed = this.restoreToolCall(callId);
		const call = this.byId.get(`tool:${callId}`);
		if (call) changed = this.upsert(call.id, { ...call, status: failed ? "failed" : "completed" }) || changed;
		const result = record(event["result"]);
		changed = this.upsert(`toolResult:${callId}`, {
			kind: "toolResult",
			label: typeof event["toolName"] === "string" ? event["toolName"] : "tool",
			groupId: `tool:${callId}`,
			text: contentText(result?.["content"]) || "(no output)",
			status: failed ? "failed" : "completed",
		}) || changed;
		return changed;
	}

	private ensureAssistant(): number {
		if (this.activeAssistant === undefined) this.activeAssistant = ++this.assistantSequence;
		return this.activeAssistant;
	}

	private addUser(text: string): boolean {
		const clean = cleanText(text);
		if (!clean) return false;
		const previous = [...this.entries].reverse().find((entry) => entry.kind === "user");
		if (previous?.text === clean) return false;
		return this.upsert(`user:${++this.userSequence}`, { kind: "user", text: clean });
	}

	private upsert(
		id: string,
		value: Omit<SubagentTranscriptEntry, "id" | "order">,
		append = false,
	): boolean {
		const existing = this.byId.get(id);
		const nextText = append && existing
			? cleanStreamingText(`${existing.text}${value.text}`)
			: cleanText(value.text);
		if (!nextText && !existing) return false;
		if (existing) {
			existing.kind = value.kind;
			if (value.label === undefined) delete existing.label;
			else existing.label = value.label;
			if (value.groupId === undefined) delete existing.groupId;
			else existing.groupId = value.groupId;
			existing.text = nextText;
			if (value.status === undefined) delete existing.status;
			else existing.status = value.status;
			existing.order = nextActivityOrder();
			return true;
		}
		const entry: SubagentTranscriptEntry = {
			id,
			kind: value.kind,
			...(value.label ? { label: value.label } : {}),
			...(value.groupId ? { groupId: value.groupId } : {}),
			text: nextText,
			...(value.status ? { status: value.status } : {}),
			order: nextActivityOrder(),
		};
		this.entries.push(entry);
		this.byId.set(id, entry);
		while (activityGroups(this.entries).size > this.maxEntries) {
			const oldestGroup = oldestActivityGroup(this.entries);
			if (!oldestGroup) break;
			for (let index = this.entries.length - 1; index >= 0; index--) {
				const item = this.entries[index]!;
				if (groupKey(item) !== oldestGroup) continue;
				this.entries.splice(index, 1);
				this.byId.delete(item.id);
				this.omittedEntries++;
			}
		}
		return true;
	}

	private restoreToolCall(callId: string): boolean {
		if (this.byId.has(`tool:${callId}`)) return false;
		const call = this.toolCalls.get(callId);
		if (!call) return false;
		return this.upsert(`tool:${callId}`, {
			kind: "tool",
			label: call.label,
			groupId: `tool:${callId}`,
			text: call.text,
			status: "running",
		});
	}

	private promote(
		oldId: string,
		newId: string,
		value: Omit<SubagentTranscriptEntry, "id" | "order">,
	): boolean {
		const existing = this.byId.get(oldId);
		if (!existing) return this.upsert(newId, value);
		this.byId.delete(oldId);
		existing.id = newId;
		this.byId.set(newId, existing);
		return this.upsert(newId, value);
	}
}

interface RenderEntry {
	entry: SubagentTranscriptEntry;
	scope?: string;
}

interface RenderGroup {
	entries: RenderEntry[];
	order: number;
}

interface LocatedEntry {
	runIndex: number;
	entry: SubagentTranscriptEntry;
}

interface LocatedGroup {
	entries: LocatedEntry[];
	order: number;
}

function collectTranscriptGroups(runs: SubagentTranscriptRun[]): LocatedGroup[] {
	const groups = new Map<string, LocatedGroup>();
	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		const transcript = runs[runIndex]!.transcript;
		if (!transcript) continue;
		for (const entry of transcript.entries) {
			const key = `${runIndex}:${entry.groupId ?? entry.id}`;
			const group = groups.get(key);
			if (group) {
				group.entries.push({ runIndex, entry });
				group.order = Math.max(group.order, entry.order);
			} else {
				groups.set(key, { entries: [{ runIndex, entry }], order: entry.order });
			}
		}
	}
	for (const group of groups.values()) {
		group.entries.sort((left, right) => {
			const leftRank = left.entry.kind === "tool" ? 0 : left.entry.kind === "toolResult" ? 1 : 0;
			const rightRank = right.entry.kind === "tool" ? 0 : right.entry.kind === "toolResult" ? 1 : 0;
			return leftRank - rightRank || left.entry.order - right.entry.order;
		});
	}
	return [...groups.values()].sort((left, right) => left.order - right.order);
}

export function boundSubagentRunTranscripts<T extends SubagentTranscriptRun>(
	runs: T[],
	maxEntries = DEFAULT_MAX_ENTRIES,
): T[] {
	const groups = collectTranscriptGroups(runs);
	const selected = new Map<number, Set<string>>();
	let remaining = Math.max(0, maxEntries);
	for (let index = groups.length - 1; index >= 0; index--) {
		const group = groups[index]!;
		if (group.entries.length > remaining) break;
		for (const item of group.entries) {
			const ids = selected.get(item.runIndex) ?? new Set<string>();
			ids.add(item.entry.id);
			selected.set(item.runIndex, ids);
		}
		remaining -= group.entries.length;
	}
	return runs.map((run, runIndex) => {
		if (!run.transcript) return run;
		const ids = selected.get(runIndex) ?? new Set<string>();
		const entries = run.transcript.entries.filter((entry) => ids.has(entry.id));
		return {
			...run,
			transcript: {
				entries,
				omittedEntries: run.transcript.omittedEntries + run.transcript.entries.length - entries.length,
			},
		};
	});
}

export function appendSubagentTranscriptFailure(
	snapshot: SubagentTranscriptSnapshot | undefined,
	task: string,
	message: string,
): SubagentTranscriptSnapshot {
	const entries = snapshot?.entries.map((entry) => ({ ...entry })) ?? [{
		id: "user:1",
		kind: "user" as const,
		text: cleanText(task),
		order: nextActivityOrder(),
	}];
	const order = nextActivityOrder();
	entries.push({
		id: `failure:${order}`,
		kind: "assistant",
		text: cleanText(message),
		status: "failed",
		order,
	});
	let omittedEntries = snapshot?.omittedEntries ?? 0;
	while (entries.length > DEFAULT_MAX_ENTRIES) {
		const oldestGroup = oldestActivityGroup(entries);
		if (!oldestGroup) break;
		for (let index = entries.length - 1; index >= 0; index--) {
			if (groupKey(entries[index]!) !== oldestGroup) continue;
			entries.splice(index, 1);
			omittedEntries++;
		}
	}
	return { entries, omittedEntries };
}

class BoundedTranscriptView implements Component {
	constructor(
		private readonly header: string,
		private readonly groups: RenderGroup[],
		private readonly omittedEntries: number,
		private readonly maxRows: number,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const headerLines = new Text(this.header, 0, 0).render(width).slice(0, 1);
		const rendered = this.groups.map((group) => group.entries.flatMap((item) => this.renderEntry(item, width)));
		const budget = Math.max(0, this.maxRows - headerLines.length);
		let selected = this.selectLatest(rendered, budget);
		const hidden = this.omittedEntries > 0 || selected.hidden;
		if (hidden && budget > 0) selected = this.selectLatest(rendered, Math.max(0, budget - 1));
		const marker = hidden
			? [truncateToWidth(this.theme.fg("dim", `… earlier activity hidden${this.omittedEntries > 0 ? ` (${this.omittedEntries}+ events)` : ""}`), Math.max(1, width), "", true)]
			: [];
		return [...headerLines, ...marker, ...selected.lines].slice(0, this.maxRows);
	}

	invalidate(): void {}

	private renderEntry(item: RenderEntry, width: number): string[] {
		const entry = item.entry;
		const failed = entry.status === "failed";
		const icon = entry.kind === "user" ? "›"
			: entry.kind === "assistant" ? "●"
				: entry.kind === "thinking" ? "◇"
					: entry.kind === "tool" ? (failed ? "✗" : entry.status === "completed" ? "✓" : "⚙")
						: (failed ? "↳✗" : "↳");
		const label = entry.kind === "tool" ? `tool ${entry.label ?? ""}`.trim()
			: entry.kind === "toolResult" ? `result ${entry.label ?? ""}`.trim()
				: entry.kind;
		const scope = item.scope ? `${item.scope} · ` : "";
		const titleColor = failed ? "error" : entry.kind === "thinking" ? "dim" : entry.kind === "user" ? "accent" : "toolTitle";
		const bodyColor = failed ? "error" : entry.kind === "thinking" ? "dim" : "toolOutput";
		const logical = entry.text.split("\n");
		const first = logical.shift() ?? "";
		const title = `${this.theme.fg(titleColor, `${icon} ${scope}${label}`)}${first ? this.theme.fg(bodyColor, `  ${first}`) : ""}`;
		const rest = logical.map((line) => this.theme.fg(bodyColor, `   ${line}`));
		const lines = new Text([title, ...rest].join("\n"), 0, 0).render(width);
		if (lines.length <= MAX_ENTRY_ROWS) return lines;
		return [lines[0]!, this.theme.fg("dim", "   …"), ...lines.slice(-(MAX_ENTRY_ROWS - 2))];
	}

	private selectLatest(rendered: string[][], budget: number): { lines: string[]; hidden: boolean } {
		if (budget <= 0) return { lines: [], hidden: rendered.length > 0 };
		const selected: string[][] = [];
		let remaining = budget;
		let hidden = false;
		for (let index = rendered.length - 1; index >= 0; index--) {
			const lines = rendered[index]!;
			if (lines.length <= remaining) {
				selected.unshift(lines);
				remaining -= lines.length;
				continue;
			}
			hidden = true;
			if (selected.length === 0 && remaining > 0) {
				selected.unshift(remaining === 1 ? [lines[0]!] : [lines[0]!, ...lines.slice(-(remaining - 1))]);
			}
			break;
		}
		return { lines: selected.flat(), hidden };
	}
}

export function renderSubagentTranscript(
	runs: SubagentTranscriptRun[],
	expanded: boolean,
	theme: Theme,
): Component {
	const boundedRuns = boundSubagentRunTranscripts(runs);
	const completed = boundedRuns.filter((run) => run.status === "completed").length;
	const failed = boundedRuns.filter((run) => run.status === "failed").length;
	const running = boundedRuns.length - completed - failed;
	const persistent = boundedRuns.filter((run) => run.persistent).length;
	const stateless = boundedRuns.length - persistent;
	const identity = (run: SubagentTranscriptRun) => `${run.alias} · ${run.persistent ? "persistent" : "stateless"} · ${run.model ?? "model unavailable"}`;
	const header = boundedRuns.length === 1
		? `${boundedRuns[0]!.status === "failed" ? theme.fg("error", "✗") : boundedRuns[0]!.status === "running" ? theme.fg("warning", "…") : theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(boundedRuns[0]!.alias))}${theme.fg("dim", ` · ${boundedRuns[0]!.persistent ? "persistent" : "stateless"} · ${boundedRuns[0]!.model ?? "model unavailable"}`)}`
		: `${theme.fg("toolTitle", theme.bold(`${boundedRuns.length} model sessions`))}${theme.fg("dim", ` · ${persistent} persistent · ${stateless} stateless · ${completed} complete · ${running} running · ${failed} failed`)}`;
	const multiple = boundedRuns.length > 1;
	let omittedEntries = 0;
	for (const run of boundedRuns) {
		if (run.transcript) {
			omittedEntries += run.transcript.omittedEntries;
		}
	}
	const groups: RenderGroup[] = collectTranscriptGroups(boundedRuns).map((group) => ({
		order: group.order,
		entries: group.entries.map(({ runIndex, entry }) => ({
			entry,
			...(multiple ? { scope: identity(boundedRuns[runIndex]!) } : {}),
		})),
	}));
	for (let runIndex = 0; runIndex < boundedRuns.length; runIndex++) {
		const run = boundedRuns[runIndex]!;
		if (run.transcript !== undefined) continue;
		groups.push({
			order: 0,
			entries: [{
				entry: {
					id: `fallback:${run.alias}`,
					kind: "assistant",
					text: run.output || "(running...)",
					status: run.status,
					order: 0,
				},
				...(multiple ? { scope: identity(run) } : {}),
			}],
		});
	}
	groups.sort((left, right) => left.order - right.order);
	return new BoundedTranscriptView(header, groups, omittedEntries, expanded ? EXPANDED_ROWS : COLLAPSED_ROWS, theme);
}
