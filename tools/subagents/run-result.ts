import { SubagentTranscript } from "./transcript";
import type { SubagentUsage, WorkerRunResult } from "./session-broker";
import { addCompletedAssistantUsage, emptySubagentUsage, providerReportedUsage, usageWithActiveTurn } from "./usage";

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

export class RunResultCollector {
	private readonly usage = emptySubagentUsage();
	private readonly transcript: SubagentTranscript;
	private readonly extractAssistantText: AssistantTextExtractor;
	private activeUsage: SubagentUsage | undefined;
	private output = "";
	private stopReasonValue: string | undefined;
	private errorMessageValue: string | undefined;
	private isCompactingValue = false;

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
		const activityChanged = this.ingestActivity(event);
		const transcriptChanged = this.transcript.ingest(event);
		if (event.type === "message_update") {
			const reported = providerReportedUsage(event.usage);
			if (reported) this.activeUsage = reported;
		}
		if (event.type === "message_end") {
			const message = event.message;
			const text = this.extractAssistantText(message);
			if (text) this.output = text;
			addCompletedAssistantUsage(this.usage, message);
			if (isAssistantMessage(message)) {
				this.activeUsage = undefined;
				this.stopReasonValue = message.stopReason;
				this.errorMessageValue = message.errorMessage;
			}
		}
		return activityChanged || transcriptChanged || (event.type === "message_update" && this.activeUsage !== undefined);
	}

	// Host-side failures share the same error message slot as message_end folding,
	// matching the stateless process-error behavior.
	noteError(message: string): void {
		this.isCompactingValue = false;
		this.errorMessageValue = message;
	}

	markAborted(): void {
		this.isCompactingValue = false;
		this.stopReasonValue = "aborted";
		this.errorMessageValue = "Subagent request was aborted";
	}

	markSettled(): void {
		this.isCompactingValue = false;
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