import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionIdentity } from "./model-eligibility";

/** Marker used by Pi's session format for Rail's remote v2 compactions. */
export const GPT_COMPACTION_STRATEGY = "gpt-remote-compaction-v2";
export const GPT_COMPACTION_DETAILS_VERSION = 2;

/** Marker prefix shared by every Rail checkpoint summary. */
export const GPT_SUMMARY_PREFIX = "[GPT remote compaction checkpoint ";

/**
 * The opaque Codex Remote Compaction v2 checkpoint item. `encrypted_content`
 * is provider-bound ciphertext: it is only ever replayed to the exact
 * provider/api/model/baseUrl identity that produced it, and never enters
 * summaries, notifications, transcripts, or logs.
 */
export interface CompactionItem {
	type: "compaction";
	encrypted_content: string;
	[key: string]: unknown;
}

/**
 * Original boundary captured when the checkpoint was created. `parentEntryId`
 * is the branch leaf the compaction entry was appended to, so replay can prove
 * the checkpoint still belongs to the current branch position instead of
 * resurrecting a superseded or foreign checkpoint.
 */
export interface GptCompactionBoundary {
	parentEntryId: string | null;
	firstKeptEntryId: string;
	tokensBefore: number;
}

export interface GptCompactionRequestMeta {
	tokensBefore?: number;
	previousSummaryPresent?: boolean;
}

export interface GptCompactionDetails {
	version: typeof GPT_COMPACTION_DETAILS_VERSION;
	strategy: typeof GPT_COMPACTION_STRATEGY;
	/**
	 * Unique, non-sensitive checkpoint id. It is the only payload anchor, so
	 * replay never depends on matching a fixed summary string.
	 */
	checkpointId: string;
	/** Identity allowed to replay this checkpoint. */
	consumer: CompactionIdentity;
	/** Identity that produced it; equal to consumer while compaction is same-model. */
	producer: CompactionIdentity;
	/** The single opaque checkpoint produced by the v2 stream. */
	checkpoint: CompactionItem;
	/** Ordered items that replace the compacted span; contains `checkpoint`. */
	replacement: unknown[];
	/** Original boundary this checkpoint was created at. */
	boundary: GptCompactionBoundary;
	compactResponseId?: string;
	createdAt: string;
	requestMeta?: GptCompactionRequestMeta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

const COMPACTION_ITEM_KEYS = new Set(["type", "encrypted_content", "id"]);

function hasOnlyCompactionItemKeys(value: Record<string, unknown>): boolean {
	return Object.keys(value).every((key) => COMPACTION_ITEM_KEYS.has(key));
}

function sameJson(left: unknown, right: unknown): boolean {
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

function isIdentity(value: unknown): value is CompactionIdentity {
	if (!isRecord(value)) return false;
	return isNonEmptyString(value["provider"])
		&& isNonEmptyString(value["api"])
		&& isNonEmptyString(value["model"])
		&& typeof value["baseUrl"] === "string"
		&& (value["authFingerprint"] === undefined || isNonEmptyString(value["authFingerprint"]));
}

function isBoundary(value: unknown): value is GptCompactionBoundary {
	if (!isRecord(value)) return false;
	return (value["parentEntryId"] === null || isNonEmptyString(value["parentEntryId"]))
		&& isNonEmptyString(value["firstKeptEntryId"])
		&& typeof value["tokensBefore"] === "number"
		&& Number.isFinite(value["tokensBefore"])
		&& value["tokensBefore"] >= 0;
}

export function isCompactionItem(value: unknown): value is CompactionItem {
	return isRecord(value)
		&& hasOnlyCompactionItemKeys(value)
		&& value["type"] === "compaction"
		&& isNonEmptyString(value["encrypted_content"])
		&& (value["id"] === undefined || isNonEmptyString(value["id"]));
}

export function isGptCompactionDetails(value: unknown): value is GptCompactionDetails {
	if (!isRecord(value)) return false;
	const requestMeta = value["requestMeta"];
	const requestMetaValid = requestMeta === undefined || (isRecord(requestMeta)
		&& (requestMeta["tokensBefore"] === undefined
			|| (typeof requestMeta["tokensBefore"] === "number" && Number.isFinite(requestMeta["tokensBefore"]) && requestMeta["tokensBefore"] >= 0))
		&& (requestMeta["previousSummaryPresent"] === undefined || typeof requestMeta["previousSummaryPresent"] === "boolean"));
	const replacement = value["replacement"];
	return value["version"] === GPT_COMPACTION_DETAILS_VERSION
		&& value["strategy"] === GPT_COMPACTION_STRATEGY
		&& isNonEmptyString(value["checkpointId"])
		&& isIdentity(value["consumer"])
		&& isIdentity(value["producer"])
		&& isCompactionItem(value["checkpoint"])
		&& isBoundary(value["boundary"])
		&& Array.isArray(replacement)
		&& replacement.length === 1
		&& isCompactionItem(replacement[0])
		&& sameJson(replacement[0], value["checkpoint"])
		&& (value["compactResponseId"] === undefined || isNonEmptyString(value["compactResponseId"]))
		&& isNonEmptyString(value["createdAt"])
		&& requestMetaValid;
}

/** Display summary for a checkpoint entry. Never contains provider ciphertext. */
export function gptCompactionSummary(checkpointId: string): string {
	return `[GPT remote compaction checkpoint ${checkpointId}]`;
}

/** True for the summary text this extension writes, including unreadable details. */
export function isGptCompactionSummaryText(summary: string): boolean {
	const start = summary.indexOf(GPT_SUMMARY_PREFIX);
	if (start < 0) return false;
	const end = summary.indexOf("]", start + GPT_SUMMARY_PREFIX.length);
	return end > start + GPT_SUMMARY_PREFIX.length;
}

export function getGptCompactionDetails(entry: SessionEntry | CompactionEntry | undefined): GptCompactionDetails | undefined {
	if (!entry || entry.type !== "compaction") return undefined;
	return isGptCompactionDetails(entry.details) ? entry.details : undefined;
}

export type SessionCheckpointResolution =
	| { status: "none" }
	| { status: "native"; entry: CompactionEntry }
	| { status: "invalid"; entry: CompactionEntry }
	| { status: "remote"; entry: CompactionEntry; details: GptCompactionDetails };

/**
 * Resolve the latest compaction on the branch. Only that entry may be replayed
 * or repaired: an older checkpoint must never be revived after a newer
 * compaction superseded it.
 */
export function resolveSessionCheckpoint(branchEntries: readonly SessionEntry[]): SessionCheckpointResolution {
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index];
		if (!entry || entry.type !== "compaction") continue;
		if (entry.details === undefined) {
			// A Rail checkpoint whose details failed validation still must not leak
			// its placeholder summary to a provider.
			return isGptCompactionSummaryText(entry.summary) ? { status: "invalid", entry } : { status: "native", entry };
		}
		const details = getGptCompactionDetails(entry);
		if (details) return { status: "remote", entry, details };
		return isGptCompactionSummaryText(entry.summary) ? { status: "invalid", entry } : { status: "native", entry };
	}
	return { status: "none" };
}

export function isGptCompactionEntry(entry: SessionEntry | undefined): entry is CompactionEntry<GptCompactionDetails> {
	return getGptCompactionDetails(entry) !== undefined;
}
