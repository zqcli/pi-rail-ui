import {
	ROOT_GRANTABLE_COUNTERS, TEAM_GRANTABLE_COUNTERS, TEAM_BUDGET_PRESETS,
	type ActivationBudgetSummary, type RootGrantCounter, type TeamBudgetGrantView, type TeamBudgetLimits, type TeamRootBudgetView,
} from "./team-protocol";

/**
 * Cumulative execution counters for one Team. This is the only place budget counters live; the
 * WorkLedger stays the authority for work. Counters never reset: revisions, yields, new roots and
 * idle periods only add. Limits grow only through explicit host grants.
 */
export type BudgetScope = { kind: "team" } | { kind: "root"; rootId: string };
export type BudgetCounter = keyof TeamBudgetLimits;
export interface BudgetExhaustion { scope: BudgetScope; counter: BudgetCounter }

/** Per-activation step counters; they belong to exactly one native send. */
export interface ActivationBudget {
	modelRequests: number;
	toolCalls: number;
	emergency: boolean;
}

export type BudgetGrantRecord = TeamBudgetGrantView;
export type { ActivationBudgetSummary };

export interface TeamBudgetUsed {
	teamActivations: number;
	leadActivations: number;
	teamModelRequests: number;
	teamToolCalls: number;
	emergencyLeadActivations: number;
}

interface RootCounters { rootActivations: number; rootModelRequests: number; rootToolCalls: number }

export const TEAM_MAX_BUDGET_GRANTS = 128;

export class TeamBudget {
	readonly used: TeamBudgetUsed = { teamActivations: 0, leadActivations: 0, teamModelRequests: 0, teamToolCalls: 0, emergencyLeadActivations: 0 };
	readonly grants: BudgetGrantRecord[] = [];
	private readonly roots = new Map<string, RootCounters>();
	private readonly rootGrants = new Map<string, Partial<Record<RootGrantCounter, number>>>();

	/** `limits` is the Team's mutable effective limit object; team-scope grants raise it in place. */
	constructor(readonly limits: TeamBudgetLimits) {}

	rootLimit(rootId: string, counter: RootGrantCounter): number {
		return this.limits[counter] + (this.rootGrants.get(rootId)?.[counter] ?? 0);
	}

	rootUsed(rootId: string): Readonly<RootCounters> {
		return this.roots.get(rootId) ?? { rootActivations: 0, rootModelRequests: 0, rootToolCalls: 0 };
	}

	/** Why normal (non-emergency) execution cannot start or continue; undefined when it can. */
	exhausted(rootId: string | undefined, lead: boolean): BudgetExhaustion | undefined {
		return this.teamExhausted(lead) ?? (rootId === undefined ? undefined : this.rootExhausted(rootId));
	}

	teamExhausted(lead: boolean): BudgetExhaustion | undefined {
		const team = { kind: "team" } as const;
		if (this.used.teamActivations >= this.limits.teamActivations) return { scope: team, counter: "teamActivations" };
		if (lead && this.used.leadActivations >= this.limits.leadActivations) return { scope: team, counter: "leadActivations" };
		if (this.used.teamModelRequests >= this.limits.teamModelRequests) return { scope: team, counter: "teamModelRequests" };
		if (this.used.teamToolCalls >= this.limits.teamToolCalls) return { scope: team, counter: "teamToolCalls" };
		return undefined;
	}

	rootExhausted(rootId: string): BudgetExhaustion | undefined {
		const used = this.rootUsed(rootId);
		for (const counter of ["rootActivations", "rootModelRequests", "rootToolCalls"] as const) {
			if (used[counter] >= this.rootLimit(rootId, counter)) return { scope: { kind: "root", rootId }, counter };
		}
		return undefined;
	}

	emergencyAvailable(): boolean {
		return this.used.emergencyLeadActivations < this.limits.emergencyLeadActivations;
	}

	recordActivation(rootId: string | undefined, lead: boolean, emergency: boolean): ActivationBudget {
		if (emergency) this.used.emergencyLeadActivations++;
		else {
			this.used.teamActivations++;
			if (lead) this.used.leadActivations++;
			if (rootId !== undefined) this.root(rootId).rootActivations++;
		}
		return { modelRequests: 0, toolCalls: 0, emergency };
	}

	/** Why one more observable provider request or tool attempt cannot run; undefined when it may. */
	stepExhaustion(kind: "model" | "tool", activation: ActivationBudget, rootId: string | undefined): BudgetExhaustion | undefined {
		const activationCounter = kind === "model" ? "activationModelRequests" : "activationToolCalls";
		const activationUsed = kind === "model" ? activation.modelRequests : activation.toolCalls;
		if (activationUsed >= this.limits[activationCounter]) {
			return { scope: rootId !== undefined ? { kind: "root", rootId } : { kind: "team" }, counter: activationCounter };
		}
		// Emergency activations are bounded only by their per-activation limit and the emergency count.
		if (activation.emergency) return undefined;
		const teamCounter = kind === "model" ? "teamModelRequests" : "teamToolCalls";
		if (this.used[teamCounter] >= this.limits[teamCounter]) return { scope: { kind: "team" }, counter: teamCounter };
		const rootCounter = kind === "model" ? "rootModelRequests" : "rootToolCalls";
		if (rootId !== undefined && this.rootUsed(rootId)[rootCounter] >= this.rootLimit(rootId, rootCounter)) {
			return { scope: { kind: "root", rootId }, counter: rootCounter };
		}
		return undefined;
	}

	/** Record one real attempt in every scope it belongs to. */
	charge(kind: "model" | "tool", activation: ActivationBudget, rootId: string | undefined): void {
		if (kind === "model") activation.modelRequests++;
		else activation.toolCalls++;
		this.used[kind === "model" ? "teamModelRequests" : "teamToolCalls"]++;
		if (rootId !== undefined) this.root(rootId)[kind === "model" ? "rootModelRequests" : "rootToolCalls"]++;
	}

	/** Check and, when allowed, charge one step. */
	admit(kind: "model" | "tool", activation: ActivationBudget, rootId: string | undefined): BudgetExhaustion | undefined {
		const exhausted = this.stepExhaustion(kind, activation, rootId);
		if (!exhausted) this.charge(kind, activation, rootId);
		return exhausted;
	}

	/** Model-facing summary for a new activation, computed before it is recorded (spec 9.4). */
	inputSummary(rootId: string | undefined, lead: boolean, emergency: boolean): ActivationBudgetSummary {
		const left = (limit: number, used: number) => Math.max(0, limit - used);
		let modelRequests = this.limits.activationModelRequests;
		let toolCalls = this.limits.activationToolCalls;
		let activations: number;
		if (emergency) activations = left(this.limits.emergencyLeadActivations, this.used.emergencyLeadActivations + 1);
		else {
			modelRequests = Math.min(modelRequests, left(this.limits.teamModelRequests, this.used.teamModelRequests));
			toolCalls = Math.min(toolCalls, left(this.limits.teamToolCalls, this.used.teamToolCalls));
			activations = left(this.limits.teamActivations, this.used.teamActivations + 1);
			if (lead) activations = Math.min(activations, left(this.limits.leadActivations, this.used.leadActivations + 1));
			if (rootId !== undefined) {
				const used = this.rootUsed(rootId);
				modelRequests = Math.min(modelRequests, left(this.rootLimit(rootId, "rootModelRequests"), used.rootModelRequests));
				toolCalls = Math.min(toolCalls, left(this.rootLimit(rootId, "rootToolCalls"), used.rootToolCalls));
				activations = Math.min(activations, left(this.rootLimit(rootId, "rootActivations"), used.rootActivations + 1));
			}
		}
		return { emergency, modelRequests, toolCalls, activations };
	}

	/** Apply a host grant validated by `validateGrant`; limits only grow. */
	grant(record: Omit<BudgetGrantRecord, "actor">): BudgetGrantRecord {
		const entries = this.validateGrant(record);
		for (const [counter, increment] of entries) {
			if (record.scope.kind === "team") this.limits[counter as keyof TeamBudgetLimits] += increment;
			else {
				const grants = this.rootGrants.get(record.scope.rootId) ?? {};
				grants[counter as RootGrantCounter] = (grants[counter as RootGrantCounter] ?? 0) + increment;
				this.rootGrants.set(record.scope.rootId, grants);
			}
		}
		const applied: BudgetGrantRecord = { ...record, actor: "@host" };
		this.grants.push(applied);
		return applied;
	}

	/**
	 * Validate a complete grant without applying any part of it: Team grants raise Team counters,
	 * root grants raise that root's effective counters, and every raised limit must stay a safe
	 * integer. Throws RangeError.
	 */
	validateGrant(record: Omit<BudgetGrantRecord, "actor">): Array<[string, number]> {
		if (this.grants.length >= TEAM_MAX_BUDGET_GRANTS) throw new RangeError(`At most ${TEAM_MAX_BUDGET_GRANTS} budget grants are retained per Team`);
		if (record.preset && record.scope.kind !== "team") throw new RangeError("Preset raises require Team scope");
		const allowed: readonly string[] = record.preset ? Object.keys(TEAM_BUDGET_PRESETS[record.preset])
			: record.scope.kind === "team" ? TEAM_GRANTABLE_COUNTERS : ROOT_GRANTABLE_COUNTERS;
		const entries = Object.entries(record.increments);
		if (!entries.length) throw new RangeError("A grant needs at least one counter increment");
		const checked: Array<[string, number]> = [];
		for (const [counter, increment] of entries) {
			if (!allowed.includes(counter)) throw new RangeError(`${counter} is not grantable for a ${record.scope.kind} scope`);
			if (typeof increment !== "number" || !Number.isSafeInteger(increment) || increment < 1) throw new RangeError(`${counter} increment must be a positive safe integer`);
			const current = record.scope.kind === "team" ? this.limits[counter as keyof TeamBudgetLimits]
				: this.rootLimit(record.scope.rootId, counter as RootGrantCounter);
			if (!Number.isSafeInteger(current + increment)) throw new RangeError(`${counter} limit would exceed a safe integer`);
			if (record.scope.kind === "team") {
				for (const grants of this.rootGrants.values()) {
					if (!Number.isSafeInteger(current + increment + (grants[counter as RootGrantCounter] ?? 0))) throw new RangeError(`${counter} root limit would exceed a safe integer`);
				}
			}
			checked.push([counter, increment]);
		}
		return checked;
	}

	/** Independent copy for host previews; never shares counters with this budget. */
	clone(): TeamBudget {
		const copy = new TeamBudget({ ...this.limits });
		Object.assign(copy.used, this.used);
		copy.grants.push(...this.grants.map((grant) => structuredClone(grant)));
		for (const [rootId, counters] of this.roots) copy.roots.set(rootId, { ...counters });
		for (const [rootId, grants] of this.rootGrants) copy.rootGrants.set(rootId, { ...grants });
		return copy;
	}

	rootView(rootId: string, rootChildren: number): TeamRootBudgetView {
		return {
			rootId,
			used: { ...this.rootUsed(rootId), rootChildren },
			limits: Object.fromEntries(ROOT_GRANTABLE_COUNTERS.map((counter) => [counter, this.rootLimit(rootId, counter)])) as Record<RootGrantCounter, number>,
		};
	}

	private root(rootId: string): RootCounters {
		let counters = this.roots.get(rootId);
		if (!counters) {
			counters = { rootActivations: 0, rootModelRequests: 0, rootToolCalls: 0 };
			this.roots.set(rootId, counters);
		}
		return counters;
	}
}
