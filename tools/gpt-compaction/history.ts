import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionProjection,
	sessionEntryToContextMessages,
	type CompactionEntry,
	type ProjectedSessionEntry,
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

/**
 * A Rail compaction is opaque provider state. It may be replayed only by the
 * matching provider identity; all recovery paths must remove it before asking
 * Pi to project the original transcript.
 */
export function isRailCompactionEntry(entry: SessionEntry | undefined): entry is CompactionEntry {
	return entry?.type === "compaction"
		&& (getGptCompactionDetails(entry) !== undefined || isGptCompactionSummaryText(entry.summary));
}

/**
 * Make a path-shaped copy without changing any source entry. The public
 * projection API follows parentId links, while callers often pass a detached
 * branch slice or a branch with opaque entries removed. Re-linking that copy
 * lets the canonical SessionManager projection still apply ContextEditEntry
 * omission/replacement and native compaction rules.
 */
function relinkLinearEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	let parentId: string | null = null;
	return entries.map((entry) => {
		const copy = structuredClone(entry);
		copy.parentId = parentId;
		parentId = copy.id;
		return copy;
	});
}

function projectLinearEntries(entries: readonly SessionEntry[]): ProjectedSessionEntry[] {
	return buildSessionProjection(relinkLinearEntries(entries)).entries;
}

/**
 * Return a path with Rail checkpoints removed. Context edits remain in the path
 * and are applied by buildSessionProjection(), so omitted responses cannot be
 * revived merely because recovery is rebuilding the raw append-only records.
 */
export function buildRailFreeBranch(branchEntries: readonly SessionEntry[]): SessionEntry[] {
	return relinkLinearEntries(branchEntries.filter((entry) => !isRailCompactionEntry(entry)));
}

/**
 * Materialize the canonical projection as ordinary entries for cut-point
 * decisions. The source IDs are preserved, while context-edit replacements are
 * copied into the source message and omissions remove the source message. This
 * is deliberately only a temporary in-memory view; session history stays
 * append-only and untouched.
 */
export function materializeRailFreeProjection(branchEntries: readonly SessionEntry[]): SessionEntry[] {
	const projection = projectLinearEntries(branchEntries.filter((entry) => !isRailCompactionEntry(entry)));
	const materialized: SessionEntry[] = [];
	for (const projected of projection) {
		const source = projected.sourceEntry;
		if (source.type === "context_edit") continue;
		if (source.type === "compaction") {
			materialized.push(source);
			continue;
		}
		if (projected.messages.length === 0) {
			// Keep state-only entries (usage/model/labels) so raw IDs still mark
			// the same admission boundary; omit only intrinsically visible entries
			// that canonical projection intentionally removed.
			if (sessionEntryToContextMessages(source).length === 0) materialized.push(source);
			continue;
		}
		if (source.type === "message" && projected.messages.length === 1 && projected.messages[0]) {
			const message = projected.messages[0];
			materialized.push({ ...source, message } as SessionEntry);
			continue;
		}
		if (source.type === "custom_message" && projected.messages.length === 1) {
			const message = projected.messages[0];
			if (message?.role === "custom" && "content" in message) {
				materialized.push({ ...source, content: message.content } as SessionEntry);
				continue;
			}
		}
		materialized.push(source);
	}
	return relinkLinearEntries(materialized);
}

export function collectMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	return projectLinearEntries(entries).flatMap((entry) => entry.messages);
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

function projectedMessagesForNativeRange(
	branchEntries: readonly SessionEntry[],
	startIndex: number,
	endIndex: number,
): { messages: AgentMessage[]; nativeBoundary?: NativeHistoryBoundary } {
	const nativeBoundary = findLatestNativeHistoryBoundaryInRange(branchEntries, startIndex, endIndex);
	// Project the complete branch first. An edit may be appended after the
	// requested interval while targeting a retained message inside it; slicing
	// before projection would silently restore the old content.
	const projectedById = new Map(projectLinearEntries(branchEntries).map((entry) => [entry.sourceEntry.id, entry.messages]));
	if (!nativeBoundary) {
		const latestNative = findLatestNativeHistoryBoundary(branchEntries);
		// A prefix ending before the native compaction's logical anchor cannot use
		// the later snapshot: the complete projection intentionally hides that
		// older source range. Project this detached prefix directly instead.
		if (latestNative && latestNative.firstKeptIndex >= endIndex) {
			const selected = branchEntries.slice(startIndex, endIndex).filter((entry) => entry.type !== "compaction");
			return { messages: projectLinearEntries(selected).flatMap((entry) => entry.messages) };
		}
		return {
			messages: branchEntries.slice(startIndex, endIndex)
				.filter((entry) => entry.type !== "compaction")
				.flatMap((entry) => projectedById.get(entry.id) ?? []),
		};
	}

	const messages: AgentMessage[] = [
		// An older native compaction can be hidden by a newer opaque checkpoint in
		// the canonical projection, so restore its own authoritative snapshot here.
		...sessionEntryToContextMessages(nativeBoundary.entry),
	];
	for (let index = nativeBoundary.firstKeptIndex; index < endIndex; index += 1) {
		const entry = branchEntries[index];
		if (!entry || entry.type === "compaction") continue;
		// The native snapshot replaces all system deltas before its physical entry.
		if (index < nativeBoundary.compactionIndex && entry.type === "message" && entry.message.role === "system") continue;
		messages.push(...(projectedById.get(entry.id) ?? []));
	}
	return { messages, nativeBoundary };
}

function projectRecoveryPrefix(
	branchEntries: readonly SessionEntry[],
	endIndex: number,
): { messages: AgentMessage[]; nativeBoundary?: NativeHistoryBoundary } {
	const rawPrefix = branchEntries.slice(0, endIndex);
	const targetIds = new Set(rawPrefix.map((entry) => entry.id));
	const futureEdits = branchEntries.slice(endIndex).filter((entry) => entry.type === "context_edit" && targetIds.has(entry.targetId));
	const nativeBoundary = findLatestNativeHistoryBoundaryInRange(branchEntries, 0, endIndex);
	const selected: SessionEntry[] = [];
	if (nativeBoundary) {
		selected.push(nativeBoundary.entry);
		for (let index = nativeBoundary.firstKeptIndex; index < endIndex; index += 1) {
			const entry = branchEntries[index];
			if (!entry || entry.type === "compaction") continue;
			if (index < nativeBoundary.compactionIndex && entry.type === "message" && entry.message.role === "system") continue;
			selected.push(entry);
		}
	} else {
		selected.push(...rawPrefix.filter((entry) => !isRailCompactionEntry(entry)));
	}
	selected.push(...futureEdits);
	return {
		messages: projectLinearEntries(selected).flatMap((entry) => entry.messages),
		...(nativeBoundary ? { nativeBoundary } : {}),
	};
}

/**
 * Project a logical interval using Pi 0.87's canonical SessionManager rules.
 * The interval is expressed in the original branch's indices; context-edit
 * entries in the interval therefore affect their target before serialization.
 */
export function projectHistoryRange(
	branchEntries: readonly SessionEntry[],
	startIndex: number,
	endIndex: number,
): AgentMessage[] {
	if (startIndex < 0 || endIndex < startIndex || endIndex > branchEntries.length) return [];
	return projectedMessagesForNativeRange(branchEntries, startIndex, endIndex).messages;
}

/**
 * Rebuild the real, provider-independent conversation from session entries.
 *
 * Remote/invalid Rail checkpoints are removed from a path-shaped copy before
 * canonical projection. This preserves ContextEditEntry omissions and content
 * replacements while retaining Pi's latest usable native compaction snapshot.
 */
export function rebuildNativeHistory(branchEntries: readonly SessionEntry[]): HistoryRebuildResult {
	const railFree = buildRailFreeBranch(branchEntries);
	const projection = buildSessionProjection(railFree);
	const nativeBoundary = findLatestNativeHistoryBoundary(branchEntries);
	return {
		messages: projection.messages,
		skippedCompactions: branchEntries.filter((entry) => entry.type === "compaction" && !isNativeCompactionEntry(entry)).length,
		...(nativeBoundary ? { nativeBoundary } : {}),
	};
}

/** Rebuild a branch prefix using the same native-boundary and context-edit rules as full replay. */
export function rebuildNativeHistoryPrefix(
	branchEntries: readonly SessionEntry[],
	endIndex: number,
): HistoryRebuildResult | undefined {
	if (endIndex < 0 || endIndex > branchEntries.length) return undefined;
	const range = projectRecoveryPrefix(branchEntries, endIndex);
	return {
		messages: range.messages,
		skippedCompactions: branchEntries.slice(0, endIndex).filter((entry) => entry.type === "compaction" && !isNativeCompactionEntry(entry)).length,
		...(range.nativeBoundary ? { nativeBoundary: range.nativeBoundary } : {}),
	};
}
