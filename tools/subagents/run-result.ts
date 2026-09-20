import { hostedSearchCallsFromEntry } from "../../openai/hosted-search-activity";
import { SubagentTranscript } from "./transcript";
import type { SubagentUsage, WorkerRunResult } from "./session-broker";
import { addCompactionUsage, addCompletedAssistantUsage, addCompletedToolResultUsage, addUsage, emptySubagentUsage, providerReportedUsage, usageWithActiveTurn } from "./usage";

interface JsonAssistantMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
}

export interface SubagentRunEvent {
	type?: string;
	message?: unknown;
	usage?: unknown;
	[key: string]: unknown;
}

type AssistantTextExtractor = (message: unknown) => string;

export function isAssistantMessage(message: unknown): message is JsonAssistantMessage {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
}

// Tolerant extraction skips malformed content parts; RPC events are trusted.
export function assistantText(message: unknown): string {
	if (!isAssistantMessage(message)) return "";
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text!)
		.join("\n");
}

// Strict extraction throws on malformed content parts so the stateless adapter
// can ignore that event's tail (usage/output/stopReason) after transcript ingestion.
export function strictAssistantText(message: unknown): string {
	if (!isAssistantMessage(message)) return "";
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text!)
		.join("\n");
}

export function isSharedImmediateEvent(type: string | undefined): boolean {
	return type === "tool_execution_start"
		|| type === "tool_execution_end"
		|| type === "compaction_start"
		|| type === "compaction_end"
		|| type === "summarization_retry_scheduled"
		|| type === "summarization_retry_attempt_start"
		|| type === "summarization_retry_finished";
}

export class RunResultCollector {
	private readonly usage = emptySubagentUsage();
	private readonly transcript: SubagentTranscript;
	private readonly extractAssistantText: AssistantTextExtractor;
	private readonly hostedSearchEntryIds = new Set<string>();
	private readonly usageEntryIds = new Set<string>();
	private readonly toolUsageCallIds = new Set<string>();
	private settled = false;
	private activeUsage: SubagentUsage | undefined;
	private output = "";
	private stopReasonValue: string | undefined;
	private errorMessageValue: string | undefined;
	private isCompactingValue = false;
	private compactionUsageAdded = false;

	constructor(task: string, extractAssistantText: AssistantTextExtractor) {
		this.transcript = new SubagentTranscript(task);
		this.extractAssistantText = extractAssistantText;
	}

	get errorMessage(): string | undefined {
		return this.errorMessageValue;
	}

	// Returns whether a throttled update is warranted. Immediate flushes are the
	// adapters' call based on event type. Strict extraction may throw here after
	// the transcript was ingested, restoring the stateless malformed-tail behavior.
	ingest(event: SubagentRunEvent): boolean {
		let usageChanged = this.ingestUsageEntry(event);
		if (event.type === "agent_settled" || event.type === "transport_error") this.settled = true;
		// A persistent transport can still deliver events while send() cleans up.
		// Freeze all accounting, including an unfinished active-turn snapshot.
		const searchChanged = !this.settled && this.ingestHostedSearch(event);
		const activityChanged = this.ingestActivity(event);
		const transcriptChanged = this.transcript.ingest(event);
		if (!this.settled && event.type === "message_update") {
			const reported = providerReportedUsage(event.usage);
			if (reported) this.activeUsage = reported;
		}
		if (event.type === "message_end") {
			const message = event.message;
			const text = this.extractAssistantText(message);
			if (text) this.output = text;
			if (!this.settled) {
				addCompletedAssistantUsage(this.usage, message);
				usageChanged = this.ingestToolResultUsage(message) || usageChanged;
			}
			if (isAssistantMessage(message)) {
				if (!this.settled) this.activeUsage = undefined;
				this.stopReasonValue = message.stopReason;
				this.errorMessageValue = message.errorMessage;
			}
		}
		if (event.type === "compaction_start") this.compactionUsageAdded = false;
		if (!this.settled && event.type === "compaction_end" && !this.compactionUsageAdded) {
			this.compactionUsageAdded = addCompactionUsage(this.usage, event["result"]);
		}
		return usageChanged || searchChanged || activityChanged || transcriptChanged || (!this.settled && event.type === "message_update" && this.activeUsage !== undefined);
	}

	// Host-side failures share the same error message slot as message_end folding,
	// matching the stateless process-error behavior.
	noteError(message: string): void {
		this.settled = true;
		this.isCompactingValue = false;
		this.errorMessageValue = message;
	}

	markAborted(): void {
		this.settled = true;
		this.isCompactingValue = false;
		this.stopReasonValue = "aborted";
		this.errorMessageValue = "Subagent request was aborted";
	}

	markSettled(): void {
		this.settled = true;
		this.isCompactingValue = false;
	}

	private ingestToolResultUsage(message: unknown): boolean {
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "toolResult") return false;
		const callId = "toolCallId" in message ? message.toolCallId : undefined;
		if (typeof callId !== "string" || !callId || this.toolUsageCallIds.has(callId)) return false;
		// Only message_end owns tool accounting, not tool_execution_end or the
		// persisted message entry. Keep this dedup separate from assistant turns.
		if (!addCompletedToolResultUsage(this.usage, message)) return false;
		this.toolUsageCallIds.add(callId);
		return true;
	}

	private ingestUsageEntry(event: SubagentRunEvent): boolean {
		// Persistent workers can warm caches while idle after agent_settled.
		// A collector belongs to one send(), not to the worker's whole session.
		if (this.settled || event.type !== "entry_appended") return false;
		const entry = event["entry"];
		if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "usage") return false;
		if (!("id" in entry) || typeof entry.id !== "string" || !entry.id || this.usageEntryIds.has(entry.id)) return false;
		const usage = providerReportedUsage("usage" in entry ? entry.usage : undefined);
		if (!usage) return false;
		this.usageEntryIds.add(entry.id);
		// Message and compaction entries are deliberately excluded: their own
		// completion events already account for that work. Kinds are open-ended.
		addUsage(this.usage, usage, false);
		return true;
	}

	private ingestHostedSearch(event: SubagentRunEvent): boolean {
		if (event.type !== "entry_appended") return false;
		const entry = event["entry"];
		if (!entry || typeof entry !== "object") return false;
		const id = (entry as { id?: unknown }).id;
		if (typeof id !== "string" || id.length === 0) return false;
		if (this.hostedSearchEntryIds.has(id)) return false;
		const calls = hostedSearchCallsFromEntry(entry);
		if (calls === undefined) return false;
		this.hostedSearchEntryIds.add(id);
		if (calls <= 0) return false;
		this.usage.searches = (this.usage.searches ?? 0) + calls;
		return true;
	}

	private ingestActivity(event: SubagentRunEvent): boolean {
		switch (event.type) {
			case "compaction_start":
				return this.setCompacting(true);
			case "compaction_end":
				this.setCompacting(false);
				if (event["aborted"] !== true && event["willRetry"] !== true
					&& typeof event["errorMessage"] === "string" && event["errorMessage"].trim()) {
					this.errorMessageValue = event["errorMessage"];
				}
				return true;
			case "summarization_retry_scheduled":
				return this.isCompactingValue;
			case "summarization_retry_attempt_start":
				if (event["source"] === "compaction") this.setCompacting(true);
				return event["source"] === "compaction";
			case "summarization_retry_finished":
				return this.isCompactingValue;
			case "agent_settled":
			case "transport_error":
				return this.setCompacting(false);
			default:
				return false;
		}
	}

	private setCompacting(value: boolean): boolean {
		if (this.isCompactingValue === value) return false;
		this.isCompactingValue = value;
		return true;
	}

	result(outputFallback: string): WorkerRunResult {
		return {
			output: this.output || outputFallback,
			usage: usageWithActiveTurn(this.usage, this.activeUsage),
			transcript: this.transcript.snapshot(),
			...(this.isCompactingValue ? { isCompacting: true } : {}),
			...(this.stopReasonValue ? { stopReason: this.stopReasonValue } : {}),
			...(this.errorMessageValue ? { errorMessage: this.errorMessageValue } : {}),
		};
	}
}