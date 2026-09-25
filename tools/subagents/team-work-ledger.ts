/**
 * Request ledger for one team: the only source of truth for work obligations, versions,
 * owned children, waits and immutable results. Pure data; TeamRuntime owns every transition.
 */
import {
	isTerminalWorkState, workRefKey,
	type DependencyOutcome, type ResultRecord, type WorkRecord, type WorkRef, type WorkVersion,
} from "./team-protocol";

export interface RejectedCandidate { revision: number; reason: string; summary: string }

/** Ledger entry: the public record plus internal indexes that never leave the runtime. */
export interface LedgerWork {
	record: WorkRecord;
	/** Child workIds created by each revision (index = revision - 1). */
	children: string[][];
	rejectedCandidates: RejectedCandidate[];
	/** Staged (not yet committed) wait edges of a running version, reserved for cycle checks. */
	stagedWait?: { revision: number; refs: WorkRef[] };
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}

export class WorkLedger {
	readonly works = new Map<string, LedgerWork>();
	/** Creation order; entries are never removed while the team exists. */
	readonly order: string[] = [];
	readonly results = new Map<string, ResultRecord>();
	readonly resultOrder: string[] = [];
	/** Terminal versions whose native activation has not finished cleanup yet. */
	readonly cleanupPending = new Set<string>();

	get(workId: string): LedgerWork | undefined { return this.works.get(workId); }

	version(ref: WorkRef): WorkVersion | undefined {
		return this.works.get(ref.workId)?.record.versions[ref.revision - 1];
	}

	current(workId: string): WorkVersion | undefined {
		const work = this.works.get(workId);
		return work?.record.versions[work.record.currentRevision - 1];
	}

	currentRef(workId: string): WorkRef | undefined {
		const work = this.works.get(workId);
		return work ? { workId, revision: work.record.currentRevision } : undefined;
	}

	add(record: WorkRecord): LedgerWork {
		if (this.works.has(record.id)) throw new Error(`Duplicate work id ${record.id}`);
		if (record.currentRevision !== 1 || record.versions.length !== 1 || record.versions[0]?.revision !== 1) {
			throw new Error("A new work record must start at revision 1");
		}
		if (record.parent) {
			const parent = this.works.get(record.parent.workId);
			if (!parent || !parent.record.versions[record.parent.revision - 1]) throw new Error("Parent WorkRef must exist before child admission");
		}
		const owned = structuredClone(record);
		const entry: LedgerWork = { record: owned, children: [[]], rejectedCandidates: [] };
		this.works.set(owned.id, entry);
		this.order.push(owned.id);
		if (owned.parent) this.works.get(owned.parent.workId)!.children[owned.parent.revision - 1]!.push(owned.id);
		return entry;
	}

	addRevision(workId: string, version: WorkVersion): void {
		const entry = this.works.get(workId);
		if (!entry || version.revision !== entry.record.currentRevision + 1) throw new Error("Work revision must advance exactly once");
		entry.record.versions.push(version);
		entry.record.currentRevision = version.revision;
		entry.children.push([]);
	}

	commitResult(record: ResultRecord): ResultRecord {
		if (this.results.has(record.id)) throw new Error(`Duplicate result id ${record.id}`);
		const work = this.version(record.work);
		if (!work || work.state !== "running") throw new Error("A result can only be committed for a running WorkRef");
		const frozen = deepFreeze(structuredClone(record));
		this.results.set(frozen.id, frozen);
		this.resultOrder.push(frozen.id);
		return frozen;
	}

	/** Current refs of every child created by this version (a revised child counts by its current revision). */
	ownedChildren(ref: WorkRef): WorkRef[] {
		const ids = this.works.get(ref.workId)?.children[ref.revision - 1] ?? [];
		return ids.map((id) => this.currentRef(id)!);
	}

	/** A dependency outcome is deliverable only once terminal and its native cleanup finished. */
	outcomeReady(ref: WorkRef): boolean {
		const version = this.version(ref);
		return !!version && isTerminalWorkState(version.state) && !this.cleanupPending.has(workRefKey(ref));
	}

	outcome(ref: WorkRef): DependencyOutcome | undefined {
		const version = this.version(ref);
		if (!version || !this.outcomeReady(ref)) return undefined;
		return {
			work: { ...ref },
			state: version.state as DependencyOutcome["state"],
			...(version.resultRef ? { resultRef: version.resultRef } : {}),
			...(version.error ? { error: { ...version.error } } : {}),
		};
	}

	/** Non-terminal current versions in the owned-child subtree of `ref`, children before parents. */
	openSubtree(ref: WorkRef): WorkRef[] {
		const found: WorkRef[] = [];
		const visit = (parent: WorkRef): void => {
			for (const child of this.ownedChildren(parent)) {
				visit(child);
				const version = this.version(child);
				if (version && !isTerminalWorkState(version.state)) found.push(child);
			}
		};
		visit(ref);
		return found;
	}

	/**
	 * Edges out of a non-terminal version: completion constraints (to each owned child's current
	 * version) plus suspended or staged waits. Terminal versions have none.
	 */
	private edges(ref: WorkRef): WorkRef[] {
		const version = this.version(ref);
		const work = this.works.get(ref.workId);
		if (!version || !work || isTerminalWorkState(version.state)) return [];
		const next = [...this.ownedChildren(ref), ...version.waitingFor];
		if (work.stagedWait?.revision === ref.revision) next.push(...work.stagedWait.refs);
		return next;
	}

	/** Path from→target→…→from if adding wait edges from→targets would close a cycle. */
	findCycle(from: WorkRef, targets: readonly WorkRef[]): WorkRef[] | undefined {
		const goal = workRefKey(from);
		const seen = new Set<string>();
		const visit = (ref: WorkRef, path: WorkRef[]): WorkRef[] | undefined => {
			const key = workRefKey(ref);
			if (key === goal) return path;
			if (seen.has(key)) return undefined;
			seen.add(key);
			for (const next of this.edges(ref)) {
				const found = visit(next, [...path, next]);
				if (found) return found;
			}
			return undefined;
		};
		for (const target of targets) {
			const found = visit(target, [from, target]);
			if (found) return found;
		}
		return undefined;
	}

	/** Current blocked versions that wait on `ref`. */
	waiters(ref: WorkRef): WorkRef[] {
		const key = workRefKey(ref);
		const found: WorkRef[] = [];
		for (const id of this.order) {
			const current = this.currentRef(id)!;
			const version = this.version(current)!;
			if (version.state === "blocked" && version.waitingFor.some((item) => workRefKey(item) === key)) found.push(current);
		}
		return found;
	}
}
