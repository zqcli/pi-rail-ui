import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	sessionEntryToContextMessages,
	type CompactionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	getGptCompactionDetails,
	isGptCompactionSummaryText,
	type GptCompactionDetails,
} from "./types";

export interface CheckpointBoundary {
	/** Index of the compaction entry on the current branch. */
	boundaryIndex: number;
	/** Index of firstKeptEntryId on the branch. */
	firstKeptIndex: number;
	entry: CompactionEntry;
	details: GptCompactionDetails;
	/** Entries strictly after the compaction entry. */
	liveTail: SessionEntry[];
	/** Entries from firstKeptEntryId up to (not including) the compaction entry. */
	retained: SessionEntry[];
}

export function findEntryIndex(entries: readonly SessionEntry[], entryId: string): number {
	return entries.findIndex((entry) => entry.id === entryId);
}

export function findLatestCompactionIndex(entries: readonly SessionEntry[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.type === "compaction") return index;
	}
	return undefined;
}

/**
 * Locate a remote checkpoint on the branch and validate every replay
 * prerequisite. Returns undefined when the checkpoint cannot be replayed:
 * missing/advanced first-kept entry, an empty replacement, a newer compaction,
 * or a branch position the checkpoint no longer belongs to.
 */
export function resolveCheckpointBoundary(
	branchEntries: readonly SessionEntry[],
	entry: CompactionEntry,
	details: GptCompactionDetails,
): CheckpointBoundary | undefined {
	const boundaryIndex = branchEntries.findIndex((candidate) => candidate.id === entry.id);
	if (boundaryIndex < 0) return undefined;
	if (branchEntries.slice(boundaryIndex + 1).some((candidate) => candidate.type === "compaction")) return undefined;
	if (entry.parentId !== details.boundary.parentEntryId) return undefined;
	const firstKeptIndex = findEntryIndex(branchEntries, entry.firstKeptEntryId);
	if (firstKeptIndex < 0 || firstKeptIndex >= boundaryIndex) return undefined;
	if (details.boundary.firstKeptEntryId !== entry.firstKeptEntryId) return undefined;
	if (details.replacement.length === 0) return undefined;
	return {
		boundaryIndex,
		firstKeptIndex,
		entry,
		details,
		liveTail: branchEntries.slice(boundaryIndex + 1),
		retained: branchEntries.slice(firstKeptIndex, boundaryIndex),
	};
}

export function collectMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap(sessionEntryToContextMessages);
}

export interface HistoryRebuildResult {
	messages: AgentMessage[];
	/** Compaction markers skipped while flattening the branch. */
	skippedCompactions: number;
	/** The native boundary whose summary was retained, when one was usable. */
	nativeBoundary?: NativeHistoryBoundary;
}

export interface NativeHistoryBoundary {
	compactionIndex: number;
	firstKeptIndex: number;
	entry: CompactionEntry;
}

function isNativeCompactionEntry(entry: SessionEntry | undefined): entry is CompactionEntry {
	if (!entry || entry.type !== "compaction") return false;
	if (getGptCompactionDetails(entry)) return false;
	return !isGptCompactionSummaryText(entry.summary);
}

/**
 * Find the newest native compaction whose logical retained-history anchor is
 * inside the requested prefix. The compaction entry may be physically after the
 * cut: its summary still covers the history before firstKeptEntryId, and using
 * the complete branch avoids losing that summary at an older retained cut.
 */
export function findLatestNativeHistoryBoundary(entries: readonly SessionEntry[]): NativeHistoryBoundary | undefined {
	return findLatestNativeHistoryBoundaryInRange(entries, 0, entries.length);
}

export function findLatestNativeHistoryBoundaryInRange(
	entries: readonly SessionEntry[],
	startIndex: number,
	endIndex: number,
): NativeHistoryBoundary | undefined {
	for (let compactionIndex = entries.length - 1; compactionIndex >= 0; compactionIndex -= 1) {
		const entry = entries[compactionIndex];
		if (!isNativeCompactionEntry(entry)) continue;
		const firstKeptIndex = findEntryIndex(entries, entry.firstKeptEntryId);
		if (firstKeptIndex >= startIndex && firstKeptIndex < endIndex && firstKeptIndex < compactionIndex) {
			return { compactionIndex, firstKeptIndex, entry };
		}
	}
	return undefined;
}

/**
 * Rebuild the real, provider-independent conversation from session entries.
 *
 * Pi stores every original entry, so flattening every non-compaction entry
 * restores the exact pre-compaction conversation. This is the recovery path
 * used when an opaque checkpoint cannot be replayed: either the feature is off,
 * the active model/account/gateway differs, or native compaction must run.
 * Compaction entries themselves are skipped because their ciphertext is bound
 * to one provider and must never reach another.
 */
export function rebuildNativeHistory(branchEntries: readonly SessionEntry[]): HistoryRebuildResult {
	const messages: AgentMessage[] = [];
	let skippedCompactions = 0;
	const nativeBoundary = findLatestNativeHistoryBoundary(branchEntries);
	const startIndex = nativeBoundary?.firstKeptIndex ?? 0;
	if (nativeBoundary) messages.push(...sessionEntryToContextMessages(nativeBoundary.entry));
	for (let index = startIndex; index < branchEntries.length; index += 1) {
		const entry = branchEntries[index];
		if (!entry) continue;
		if (entry.type === "compaction") {
			skippedCompactions += 1;
			continue;
		}
		// Pi's native checkpoint replaces all system deltas before its physical
		// boundary, including those in the retained range (also for legacy entries).
		if (nativeBoundary && index < nativeBoundary.compactionIndex && entry.type === "message" && entry.message.role === "system") continue;
		messages.push(...sessionEntryToContextMessages(entry));
	}
	return { messages, skippedCompactions, ...(nativeBoundary ? { nativeBoundary } : {}) };
}

/** Rebuild a branch prefix using the same native-boundary rules as full replay. */
export function rebuildNativeHistoryPrefix(
	branchEntries: readonly SessionEntry[],
	endIndex: number,
): HistoryRebuildResult | undefined {
	if (endIndex < 0 || endIndex > branchEntries.length) return undefined;
	const nativeBoundary = findLatestNativeHistoryBoundaryInRange(branchEntries, 0, endIndex);
	if (!nativeBoundary) return rebuildNativeHistory(branchEntries.slice(0, endIndex));
	const messages = [
		...sessionEntryToContextMessages(nativeBoundary.entry),
		...collectMessages(branchEntries.slice(nativeBoundary.firstKeptIndex, endIndex).filter((entry, offset) =>
			entry.type !== "compaction"
			&& !(nativeBoundary.firstKeptIndex + offset < nativeBoundary.compactionIndex && entry.type === "message" && entry.message.role === "system"))),
	];
	return { messages, skippedCompactions: 1, nativeBoundary };
}
