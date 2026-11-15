/**
 * Request ledger for one team: the only source of truth for work obligations, versions,
 * owned children, waits and immutable results. Pure data; TeamRuntime owns every transition.
 */
import {
	isTerminalWorkState, workRefKey,
	type DependencyOutcome, type ResultRecord, type SignalRecord, type WorkRecord, type WorkRef, type WorkVersion,
} from "./team-protocol";

export interface RejectedCandidate { revision: number; reason: string; summary: string }

/** Ledger entry: the public record plus internal indexes that never leave the runtime. */
export interface LedgerWork {
	record: WorkRecord;
	/** Child workIds created by each revision (index = revision - 1). */
	children: string[][];
	rejectedCandidates: RejectedCandidate[];
	/** Staged (not yet committed) wait edges of a running version, reserved for cycle checks. */
	stagedWait?: { revision: number; refs: WorkRef[]; signals?: string[] };
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
	readonly signals = new Map<string, SignalRecord>();
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
	 * Completion edges include owned children. Signal publication only needs the producer to run,
	 * not to finish those children: a parent may publish a phase before its child completes.
	 * Staged waits participate immediately, so two concurrent yields cannot admit a cycle.
	 */
	findCycle(from: WorkRef, targets: readonly WorkRef[], signalIds: readonly string[] = []): string[] | undefined {
		type Node = { work: WorkRef } | { signal: string };
		const workNode = (work: WorkRef): Node => ({ work });
		const signalNode = (signal: string): Node => ({ signal });
		const key = (node: Node): string => "work" in node ? workRefKey(node.work) : node.signal;
		const waits = (ref: WorkRef): Node[] => {
			if (workRefKey(ref) === workRefKey(from)) return [...targets.map(workNode), ...signalIds.map(signalNode)];
			const version = this.version(ref);
			const staged = this.get(ref.workId)?.stagedWait;
			// A child issue can wake a producer (or a prerequisite) with undelivered wait IDs.
			// Runnable history is not a wait edge; a new staged wait supersedes it immediately.
			if (staged?.revision === ref.revision) return [...staged.refs.map(workNode), ...(staged.signals ?? []).map(signalNode)];
			return version?.state === "blocked" ? [...version.waitingFor.map(workNode), ...(version.waitingForSignals ?? []).map(signalNode)] : [];
		};
		const edges = (node: Node): Node[] => {
			if ("signal" in node) {
				const signal = this.signals.get(node.signal);
				return signal?.state === "pending" ? waits(signal.work) : [];
			}
			const version = this.version(node.work);
			return !version || isTerminalWorkState(version.state) ? [] : [...this.ownedChildren(node.work).map(workNode), ...waits(node.work)];
		};
		const done = new Set<string>();
		const visit = (node: Node, path: string[]): string[] | undefined => {
			const id = key(node);
			if (path.includes(id)) return [...path, id];
			if (done.has(id)) return undefined;
			for (const next of edges(node)) {
				const cycle = visit(next, [...path, id]);
				if (cycle) return cycle;
			}
			done.add(id);
			return undefined;
		};
		return visit(workNode(from), []);
	}
}
