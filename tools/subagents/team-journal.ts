import type { BudgetGrantRecord } from "./team-budget";
import type { ResultRecord, TeamResult, WorkRef } from "./team-protocol";

/**
 * Bounded history facts written synchronously before Runtime publishes them. The journal is
 * history, not a recovery log: it never contains the whole ledger, gates, ACKs or private frames.
 */
export type TeamJournalRecord =
	| { version: 2; kind: "launched"; teamId: string; at: number }
	| { version: 2; kind: "result"; teamId: string; at: number; result: ResultRecord }
	| { version: 2; kind: "decision"; teamId: string; at: number; decision: "revise_work" | "cancel_work"; work: WorkRef; reason?: string }
	| { version: 2; kind: "close_decision"; teamId: string; at: number; closeId: string; outcome: "succeeded" | "partial" | "failed"; resultRefs: string[]; reason?: string }
	| { version: 2; kind: "grant"; teamId: string; at: number; grant: BudgetGrantRecord }
	| { version: 2; kind: "terminal"; teamId: string; at: number; result: TeamResult };

/** A synchronous history writer (for example, the owning session's appendEntry). */
export type TeamJournalSink = (record: TeamJournalRecord) => void;

/**
 * One runtime generation's permission to write history. Once deactivated (session switch, reload,
 * shutdown) it can never write again, so late callbacks cannot append into another branch.
 */
export class TeamJournalGeneration {
	private sink: TeamJournalSink | undefined;

	constructor(sink: TeamJournalSink) {
		this.sink = sink;
	}

	get active(): boolean { return this.sink !== undefined; }

	/** Throws when inactive or when the sink fails; callers must fail closed. */
	write(record: TeamJournalRecord): void {
		const sink = this.sink;
		if (!sink) throw new Error("Team journal generation is inactive");
		sink(record);
	}

	deactivate(): void {
		this.sink = undefined;
	}
}
