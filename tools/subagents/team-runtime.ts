import { randomUUID } from "node:crypto";
import {
	TEAM_COMMAND_CACHE, TEAM_MAX_DEPENDENCY_PREVIEWS, TEAM_MAX_LIVE_TEAMS, TEAM_MAX_MANAGER_EVENT_BATCH,
	TEAM_MAX_PENDING_OPERATIONS, TEAM_MAX_TERMINAL_INCIDENTS,
	TEAM_MAX_DEPENDENCY_PREVIEW_BYTES, TEAM_MAX_ID_LENGTH, TEAM_MAX_NOTE_BYTES, TEAM_MAX_RESULT_BYTES, TEAM_PROTOCOL_VERSION,
	TEAM_STATUS_DEFAULT_LIMIT, TEAM_STATUS_MAX_LIMIT, DEFAULT_TEAM_BUDGET, isTerminalWorkState, sameWorkRef,
	workRefKey, shortWorkRef, ROOT_GRANTABLE_COUNTERS, TEAM_VIEW_MAX_BUDGET_ROOTS, TEAM_VIEW_MAX_GRANTS, TEAM_VIEW_MAX_INCIDENTS,
	type ActivationInput, type ActivationScope, type HoldReason, type RootGrantCounter, type TeamRootBudgetView, type TeamBudgetGrantView, type BindingV2, type DeliveryRecord, type EndIntent,
	type ManagerEventView, type MemberRecord, type OutcomeView, type ResultRecord,
	type TeamAction, type TeamBudgetLimits, type TeamBudgetView, type TeamErrorCode, type TeamIncidentView, type TeamLifecycle, type GateDecision,
	type TeamMemberPolicy, type TeamMemberView, type TeamPlan, type TeamReply, type TeamResult, type TeamTeamView,
	type TeamWorkSummary, type TeamWorkView, type WorkError, type WorkRecord, type WorkRef, type WorkResult, type WorkVersion,
} from "./team-protocol";
import {
	TeamProtocolError, canonicalJson, encodeActivationInput, errorReply, formatWorkResult, normalizeNativeToolCallId, normalizeTeamAction, normalizeTeamPlan, parseActivationScope, parseBinding, sameScope,
	okReply, previewText, projectActivationInput, projectErrorText, projectWorkChildren, projectWorkError,
} from "./team-codec";
import { WorkLedger } from "./team-work-ledger";
import { addActivationUsage, emptySubagentUsage } from "./usage";
import type { SubagentUsage } from "./session-broker";
import { TeamBudget, type ActivationBudget, type BudgetExhaustion, type BudgetScope } from "./team-budget";
import type { TeamJournalGeneration, TeamJournalRecord } from "./team-journal";

/** Internal evidence keeps every code unit, including malformed Unicode; never compare public truncations. */
function errorFingerprint(error: WorkError): string {
	return canonicalJson({ ...error, code: JSON.stringify(error.code), message: JSON.stringify(error.message) });
}

function completionFingerprint(completion: NativeCompletion | CleanupCompletion): string {
	return canonicalJson({ ...completion,
		...(completion.error ? { error: errorFingerprint(completion.error) } : {}),
		...("finalAssistantText" in completion ? { finalAssistantText: JSON.stringify(completion.finalAssistantText) } : {}),
	});
}

function incidentView(incident: TeamIncidentView): TeamIncidentView {
	return { ...structuredClone(incident), ...projectWorkError(incident) };
}

/** Grant reasons are retained in the bounded Team view; keep them short. */
const TEAM_MAX_GRANT_REASON_BYTES = 512;
const TEAM_MAX_TIMELINE = 60;
const WORK_NOTICE = "Other queued work is not part of this activation. Only the current WorkRef is authorized for this work. "
	+ "If it needs another member's conclusion first, yield {waitingFor:[that member's WorkRef from status work], checkpoint}, "
	+ "or request it from that member and wait on the returned WorkRef, or ask the Manager with yield {attention, checkpoint}. Read a full result with status(result).";
const MANAGEMENT_NOTICE = "Management activation: there is no current WorkRef. Handle these events, then end with yield (checkpoint only, no waitingFor). "
	+ "New results, failures and incidents start the next management activation automatically; do not poll status to wait. "
	+ "A WORK_HELD event is a member asking for input: answer with resume_work {workId, expectedRevision, incidentId, instruction} "
	+ "(for example naming the resultRef or WorkRef it needs), or revise_work/cancel_work. close_team checks every root itself and names any blocker, so no status check is needed before it.";

export interface RuntimeActivation {
	binding: BindingV2;
	scope: ActivationScope;
	deliveryId: string;
	input: ActivationInput;
}

/** Evidence supplied only after the native send has reached its real settled boundary. */
export interface NativeCompletion {
	status: "success" | "error" | "aborted" | "length";
	finalAssistantText?: string;
	pendingToolCalls?: boolean;
	/** The exact staged end-intent tool result observed in the settled native transcript. */
	appliedToolCallId?: string;
	error?: WorkError;
	/** Usage observed from this send's own native events, frozen at agent_settled. */
	usage?: SubagentUsage;
}

export type ActivationCompletionReason = "normal" | "policy_pause" | "policy_superseded" | "policy_cancelled"
	| "budget_hold" | "native_failure" | "transport_failure";

export interface ActivationCompletion {
	native: NativeCompletion;
	reason: ActivationCompletionReason;
}

export interface CleanupCompletion {
	ok: boolean;
	error?: WorkError;
	/** Member close only: the exit was confirmed although the close was not clean (ownership may be released). */
	resourceReleased?: boolean;
}

export interface GrantPreview {
	scope: BudgetScope;
	changes: Array<{ counter: string; used: number; limit: number; proposed: number }>;
	/** Budget-held work that this grant alone would requeue. */
	released: WorkRef[];
}

export interface HostHoldView {
	work: WorkRef;
	assignee: string;
	rootId: string;
	reason: HoldReason;
	incidentId: string;
	message: string;
	task: string;
}

export interface TeamRuntimeOptions {
	now?: () => number;
	createId?: () => string;
	limits?: Partial<TeamBudgetLimits>;
	activationStopTimeoutMs?: number;
	/** Synchronous history writer for this runtime generation; critical writes fail closed. */
	journal?: TeamJournalGeneration;
}

export interface TeamRuntimeExecutor {
	runActivation(activation: RuntimeActivation): Promise<unknown>;
	closeMember(binding: BindingV2, closeId: string): Promise<CleanupCompletion>;
	stopActivation?(binding: BindingV2, activationId: string, reason: ActivationCompletionReason): void;
	/** Escalation after a scoped stop missed its bound: stop the native process and report through the send. */
	terminateActivation?(binding: BindingV2, activationId: string, error: WorkError): void;
}

export type HostControlReceipt =
	| { actor: "@host"; status: "applied" | "unchanged"; teamId: string; lifecycle: TeamLifecycle; reason?: string }
	| { actor: "@host"; status: "applied" | "unchanged"; teamId: string; work: WorkRef }
	| { actor: "@host"; status: "applied" | "unchanged"; teamId: string; eventId: string }
	| { actor: "@host"; status: "applied"; teamId: string; grantId: string; released: WorkRef[] };

export interface TeamHostControl {
	cancel_team(reason: string): HostControlReceipt;
	/** Raise counted limits for the Team or one known root; never resets usage or releases other holds. */
	grant(scope: BudgetScope, increments: Partial<Record<string, number>>, reason: string): HostControlReceipt;
	release_hold(work: WorkRef, incidentId: string, instruction: string): HostControlReceipt;
	message_manager(text: string): HostControlReceipt;
}

interface CachedAction {
	fingerprint: string;
	reply: TeamReply;
}

interface InternalEvent extends ManagerEventView {
	key: string;
	processed: boolean;
	batchId?: string;
}

interface EventBatch {
	id: string;
	eventIds: string[];
}

interface ActiveActivation {
	scope: ActivationScope;
	deliveryId: string;
	inputReady: boolean;
	intent?: EndIntent;
	native?: NativeCompletion;
	completion?: ActivationCompletion;
	cleanup?: CleanupCompletion;
	stopReason?: "cancelled" | "superseded" | "team_cancelled";
	completionReason?: ActivationCompletionReason;
	workerPermitHeld: boolean;
	parked: boolean;
	resumeRequested: boolean;
	providerGatePending: boolean;
	toolCalls: Map<string, { toolName: string; allowed: boolean; denial?: GateDecision }>;
	completedToolCalls: Map<string, string>;
	pauseBlockedToolCalls: number;
	providerGatePromise?: Promise<GateDecision>;
	providerGateResolve?: (decision: GateDecision) => void;
	stopTimer?: ReturnType<typeof setTimeout>;
	budget: ActivationBudget;
	budgetBlockedToolCalls: number;
	/** The budget scope that stopped this activation, for hold/incident attribution. */
	budgetStop?: BudgetExhaustion;
	/** The one end-intent attempt allowed (and charged) after the tool budget was exhausted. */
	budgetFinalAttempt?: boolean;
	postIntentContinuations: number;
	cache: Map<string, CachedAction>;
	lastSequence: number;
}

interface CompletedActivationTombstone {
	activationId: string;
	deliveryId: string;
	native: NativeCompletion;
	completion: ActivationCompletion;
	cleanup: CleanupCompletion;
}

interface RuntimeMember extends MemberRecord {
	policy: TeamMemberPolicy;
	epoch: string;
	active?: ActiveActivation;
	lastActivation?: CompletedActivationTombstone;
	lastLostActivation?: { activationId: string; error: WorkError; resourceReleased: boolean; reason: ActivationCompletionReason };
	closeId?: string;
	/** A driver was issued this prepared member's binding and may hold a native lifetime. */
	nativeClaimed?: boolean;
	usage: SubagentUsage;
}

interface CloseDecision {
	id: string;
	outcome: "succeeded" | "partial" | "failed";
	reason?: string;
	resultRefs: string[];
	roots: TeamResult["roots"];
}

interface TeamState {
	id: string;
	lifecycle: TeamLifecycle;
	health: "ok" | "needs_attention";
	stateVersion: number;
	eventSeq: number;
	createdAt: number;
	deadline: number | null;
	plan: TeamPlan;
	manager: string;
	bootProcessed: boolean;
	cancelRequested: boolean;
	members: Map<string, RuntimeMember>;
	ledger: WorkLedger;
	ready: WorkRef[];
	deliveries: Map<string, DeliveryRecord>;
	events: InternalEvent[];
	eventBatches: Map<string, EventBatch>;
	incidents: TeamIncidentView[];
	/**
	 * `${consumer WorkRef}>${dependency WorkRef}` pairs whose outcome-unknown dependency was explicitly
	 * acknowledged by resume_work/release_hold; only these may be delivered to that consumer version.
	 */
	unknownAcknowledged: Set<string>;
	/** Same object as budget.limits: grants raise effective limits in place. */
	limits: TeamBudgetLimits;
	budget: TeamBudget;
	reservedResultBytes: number;
	/** First failed critical journal write; the Team is failed closed at the end of the transition. */
	journalFailure?: string;
	journalFailureApplied?: boolean;
	terminalJournaled?: boolean;
	/** Display-only schedule of milestones for the host (bounded); never an obligation or a recovery log. */
	timeline: Array<{ at: number; text: string }>;
	timelineOmitted: number;
	outcome?: "succeeded" | "partial" | "failed";
	reason?: string;
	closeDecision?: CloseDecision;
	usage: ReturnType<typeof emptySubagentUsage>;
}

const copy = <T>(value: T): T => structuredClone(value);
const currentVersion = (record: WorkRecord): WorkVersion => record.versions[record.currentRevision - 1]!;
const TERMINAL_TEAM_LIFECYCLES: readonly TeamLifecycle[] = ["closed", "failed", "cancelled", "interrupted"];
function fail(code: TeamErrorCode, message: string, blockers?: TeamProtocolError["blockers"]): never {
	throw new TeamProtocolError(code, message, blockers);
}

/**
 * Synchronous, single-writer Team state machine. It performs no provider, RPC, filesystem or
 * process I/O; activation/settlement/cleanup are explicit evidence transitions supplied by a driver.
 */
export class TeamRuntime {
	private readonly teams = new Map<string, TeamState>();
	private readonly changeListeners = new Set<(teamId: string) => void>();
	private readonly pendingNotifications = new Set<string>();
	private readonly executors = new Map<string, TeamRuntimeExecutor>();
	private readonly scheduledDrains = new Set<string>();
	private readonly closingEffects = new Set<string>();
	private readonly completionWaiters = new Map<string, Set<(result: TeamResult) => void>>();
	private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly limits: TeamBudgetLimits;
	private readonly activationStopTimeoutMs: number;
	private readonly journalGeneration: TeamJournalGeneration | undefined;
	private journalRetiredForHostTransition = false;

	constructor(options: TeamRuntimeOptions = {}) {
		this.journalGeneration = options.journal;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
		this.limits = { ...DEFAULT_TEAM_BUDGET, ...options.limits };
		this.activationStopTimeoutMs = options.activationStopTimeoutMs ?? 5000;
		if (!Number.isSafeInteger(this.activationStopTimeoutMs) || this.activationStopTimeoutMs < 1) throw new Error("Invalid activation stop timeout");
		for (const [key, value] of Object.entries(this.limits)) {
			if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid Team budget ${key}`);
		}
	}

	/** A branch/session transition intentionally seals history before asynchronous native cleanup. */
	retireJournalForHostTransition(): void {
		this.journalRetiredForHostTransition = true;
	}

	/** Validate and reserve the complete plan/initial ledger without starting any member. */
	/**
	 * `resolvedPolicies`, when given, is the host launcher's pinned policy per alias (real model,
	 * cwd, effective Fast/Search, contextWindow). It replaces the model-supplied policy wholesale;
	 * the model itself can never provide searchMode.
	 */
	prepare(rawPlan: unknown, resolvedPolicies?: ReadonlyMap<string, TeamMemberPolicy>): TeamTeamView {
		const plan = normalizeTeamPlan(rawPlan);
		if (resolvedPolicies) {
			for (const member of [plan.manager, ...plan.workers]) {
				const policy = resolvedPolicies.get(member.alias);
				if (!policy) fail("INVALID_ARGUMENT", `No resolved policy for member ${member.alias}`);
				member.policy = copy(policy);
			}
		}
		const liveCount = [...this.teams.values()].filter((team) => !TERMINAL_TEAM_LIFECYCLES.includes(team.lifecycle)).length;
		if (liveCount >= TEAM_MAX_LIVE_TEAMS) fail("TEAM_CAPACITY", `At most ${TEAM_MAX_LIVE_TEAMS} live Teams are allowed`);
		const terminalTeams = [...this.teams.values()].filter((team) => TERMINAL_TEAM_LIFECYCLES.includes(team.lifecycle));
		const unresolvedInitial = new Map<string, number>();
		for (const initial of plan.initialRequests) {
			const count = (unresolvedInitial.get(initial.to) ?? 0) + 1;
			if (count > this.limits.memberUnresolvedWork) {
				fail("REQUEST_QUEUE_FULL", `Initial requests exceed ${initial.to}'s unresolved-work limit (${this.limits.memberUnresolvedWork})`);
			}
			unresolvedInitial.set(initial.to, count);
		}
		const createdAt = this.timestamp();
		const id = this.newId();
		if (this.teams.has(id)) fail("TEAM_CAPACITY", "Team ID collision");
		const initialCount = plan.initialRequests.length;
		const reserved = initialCount * TEAM_MAX_RESULT_BYTES;
		if (initialCount > this.limits.teamWorks || reserved > this.limits.reservedResultBytes) {
			fail("TEAM_CAPACITY", "Initial requests exceed Team work/result capacity");
		}
		const members = new Map<string, RuntimeMember>();
		const roster = [plan.manager, ...plan.workers];
		for (const [index, memberPlan] of roster.entries()) {
			members.set(memberPlan.alias, {
				id: memberPlan.alias,
				role: index === 0 ? "manager" : "worker",
				roleDescription: memberPlan.roleDescription,
				lifecycle: "starting",
				activity: "idle",
				pause: "none",
				resourceState: "starting",
				policy: copy(memberPlan.policy),
				epoch: this.newId(),
				usage: emptySubagentUsage(),
			});
		}
		const budget = new TeamBudget({ ...this.limits });
		const team: TeamState = {
			id, lifecycle: "prepared", health: "ok", stateVersion: 1, eventSeq: 0, createdAt,
			deadline: null,
			plan: copy(plan), manager: plan.manager.alias, bootProcessed: false, cancelRequested: false, members, ledger: new WorkLedger(), ready: [], deliveries: new Map(), unknownAcknowledged: new Set(),
			events: [], eventBatches: new Map(), incidents: [], limits: budget.limits, budget,
			reservedResultBytes: reserved, usage: emptySubagentUsage(), timeline: [], timelineOmitted: 0,
		};
		for (const initial of plan.initialRequests) {
			const record = this.makeWork(team.manager, initial.to, initial.task, initial.inputRefs, undefined, createdAt);
			this.assertInputFits(team, team.members.get(initial.to)!, record);
			team.ledger.add(record);
			team.ready.push({ workId: record.id, revision: 1 });
		}
		this.check(team);
		if (terminalTeams.length >= TEAM_MAX_LIVE_TEAMS) this.teams.delete(terminalTeams[0]!.id);
		this.teams.set(id, team);
		return this.view(team);
	}

	/** Complete the pure-runtime launch admission. Native resource creation is a later driver effect. */
	launch(teamId: string): TeamTeamView {
		const team = this.team(teamId);
		if (team.lifecycle !== "prepared") fail("INVALID_ARGUMENT", `Cannot launch Team in ${team.lifecycle}`);
		if ([...team.members.values()].some((member) => member.lifecycle !== "starting")) {
			fail("MEMBER_UNAVAILABLE", "A Team member was stopped before launch; cancel this prepared Team and prepare with new aliases");
		}
		const launchAt = this.timestamp();
		// History must record admission before any provider can run; a failed write fails startup closed.
		if (!this.tryJournal(team, { version: 2, kind: "launched", teamId, at: launchAt,
			roster: { manager: team.manager, workers: team.plan.workers.map((worker) => worker.alias) }, goal: previewText(team.plan.brief.goal, 512) })) {
			const reason = team.journalFailure;
			this.applyJournalFailure(team);
			fail("PROTOCOL_FAILURE", `Team launch could not be journaled: ${reason}`);
		}
		team.deadline = team.plan.timeoutSeconds === null ? null : launchAt + Math.ceil(team.plan.timeoutSeconds * 1000);
		team.lifecycle = "active";
		for (const member of team.members.values()) {
			member.lifecycle = "open";
			member.resourceState = "owned";
		}
		this.addEvent(team, { key: "BOOT", kind: "BOOT", message: this.bootMessage(team) });
		const initial = team.ledger.order.map((workId) => team.ledger.get(workId)!.record);
		this.note(team, `launch${initial.length ? ` · initial ${initial.map((record) => `${shortWorkRef({ workId: record.id, revision: 1 })} → ${record.assignee}`).join(", ")}` : ""}`);
		this.changed(team);
		this.check(team);
		if (team.plan.timeoutSeconds !== null) {
			const timer = setTimeout(() => {
				this.deadlineTimers.delete(teamId);
				this.cancelTeam(teamId, "DEADLINE: Team runtime deadline expired");
			}, Math.ceil(team.plan.timeoutSeconds * 1000));
			this.deadlineTimers.set(teamId, timer);
		}
		this.requestDrain(teamId);
		return this.view(team);
	}

	/** Attach the sole effect executor before launch; Runtime retains scheduling and reservation authority. */
	attachExecutor(teamId: string, executor: TeamRuntimeExecutor): () => void {
		const team = this.team(teamId);
		if (team.lifecycle !== "prepared") fail("INVALID_ARGUMENT", "An executor must be attached before Team launch");
		if (this.executors.has(teamId)) fail("TEAM_OWNED", "This Team already has an effect executor");
		this.executors.set(teamId, executor);
		return () => {
			if (this.executors.get(teamId) !== executor) return;
			if (team.lifecycle === "prepared") {
				if ([...team.members.values()].some((member) => member.active)
					|| this.scheduledDrains.has(teamId)
					|| [...this.closingEffects].some((key) => key.startsWith(`${teamId}\0`))) {
					throw new Error("Cannot roll back an executor after Team effects have started");
				}
				this.executors.delete(teamId);
				return;
			}
			if (!TERMINAL_TEAM_LIFECYCLES.includes(team.lifecycle)) {
				throw new Error("Cannot detach a Team executor before the Team reaches a terminal lifecycle");
			}
			if ([...team.members.values()].some((member) => member.active)
				|| [...this.closingEffects].some((key) => key.startsWith(`${teamId}\0`))) {
				throw new Error("Cannot detach a Team executor while effects remain in flight");
			}
			this.executors.delete(teamId);
		};
	}

	/** Attach an effect executor only for host-driven stop/close after manual Runtime test runs. */
	attachCleanupExecutor(teamId: string, executor: TeamRuntimeExecutor): () => void {
		const team = this.team(teamId);
		if (team.lifecycle === "prepared") fail("INVALID_ARGUMENT", "Use attachExecutor before launch for a prepared Team");
		if (this.executors.has(teamId)) fail("TEAM_OWNED", "This Team already has an effect executor");
		this.executors.set(teamId, executor);
		this.requestDrain(teamId);
		return () => { if (this.executors.get(teamId) === executor) this.executors.delete(teamId); };
	}

	/** Resolves only after Runtime observes a terminal Team lifecycle and its required exit evidence. */
	waitForCompletion(teamId: string): Promise<TeamResult> {
		const team = this.team(teamId);
		const current = this.getTeamResult(teamId);
		if (current && this.completionReady(team)) return Promise.resolve(current);
		return new Promise((resolve) => {
			const waiters = this.completionWaiters.get(teamId) ?? new Set<(result: TeamResult) => void>();
			waiters.add(resolve);
			this.completionWaiters.set(teamId, waiters);
		});
	}

	/** Narrow, non-model control capability for the owning host/UI layer. */
	hostControl(teamId: string): TeamHostControl {
		this.team(teamId);
		return Object.freeze({
			cancel_team: (reason: string) => this.cancelTeam(teamId, reason),
			grant: (scope: BudgetScope, increments: Partial<Record<string, number>>, reason: string) => this.grantBudget(teamId, scope, increments, reason),
			release_hold: (work: WorkRef, incidentId: string, instruction: string) => this.releaseHold(teamId, work, incidentId, instruction),
			message_manager: (text: string) => this.messageManager(teamId, text),
		});
	}

	/**
	 * Stop one Broker-owned member without widening the action to the Team. Workers lose only their
	 * own work and descendants; an unavailable Manager holds Manager work and pauses workers.
	 */
	hostStopMember(teamId: string, memberId: string, reasonValue: string): BindingV2 {
		const team = this.team(teamId);
		const member = team.members.get(memberId);
		if (!member) fail("UNKNOWN_MEMBER", `Unknown Team member ${memberId}`);
		const reason = this.hostText(reasonValue, "member stop reason");
		if (member.lifecycle === "faulted" || (member.lifecycle === "closed" && member.resourceState === "released")) return this.binding(team, member);
		if (team.lifecycle !== "active" && team.lifecycle !== "prepared") {
			fail("RECIPIENT_CLOSING", `Cannot stop ${memberId} independently while Team is ${team.lifecycle}`);
		}
		if (!member.nativeClaimed) fail("TEAM_OWNED", `Team member ${memberId} has no Broker-owned native lifetime to stop`);
		member.lifecycle = "faulted";
		member.resourceState = member.resourceState === "starting" ? "owned" : member.resourceState;
		member.error = { code: "HOST_MEMBER_STOPPED", message: reason };
		member.pause = "none";
		team.health = "needs_attention";
		if (member.role === "manager") {
			this.holdManagerWork(team);
			this.pauseWorkersForManagerFault(team);
			this.createIncident(team, "MANAGER_UNAVAILABLE", reason, undefined, member.id);
		} else {
			this.stopMemberWork(team, member, reason);
		}
		if (member.active) {
			member.active.stopReason = "cancelled";
			this.requestActivationStop(team, member, "policy_cancelled");
		}
		this.addEvent(team, { key: `host-member-stopped:${member.id}`, kind: "MEMBER_FAULTED",
			message: `${member.id} was stopped by the host; the Team remains host-managed`, memberId: member.id });
		this.changed(team);
		this.wakeWaiters(team);
		this.check(team);
		this.requestDrain(team.id);
		this.settleCompletion(team);
		return this.binding(team, member);
	}

	/** Report the single member's actual Broker exit; an unknown exit retains ownership for retry. */
	memberStopExit(bindingValue: BindingV2, result: CleanupCompletion): TeamReply {
		const binding = this.validateBinding(bindingValue);
		const team = this.team(binding.teamId);
		const member = this.authenticatedMember(binding);
		if (member.lifecycle !== "faulted" || member.active) fail("CLEANUP_FAILED", "Only an inactive faulted member can report a host stop exit");
		if (member.resourceState === "released" && (result.ok || result.resourceReleased)) return okReply(member.id);
		if (result.ok) {
			member.resourceState = "released";
		} else if (result.resourceReleased) {
			member.resourceState = "released";
			member.error = { code: result.error?.code ?? "PROTOCOL_FAILURE", message: result.error?.message ?? "Member protocol cleanup failed after confirmed exit" };
			this.createIncident(team, member.error.code, member.error.message, undefined, member.id);
		} else {
			member.resourceState = "cleanup_failed";
			member.error = { code: result.error?.code ?? "CLEANUP_FAILED", message: result.error?.message ?? "Member exit is not confirmed" };
			this.createIncident(team, member.error.code, member.error.message, undefined, member.id);
		}
		this.changed(team);
		this.check(team);
		this.settleCompletion(team);
		return result.ok ? okReply(member.id) : errorReply(member.id, new TeamProtocolError("CLEANUP_FAILED", member.error?.message ?? "Member exit is not confirmed"));
	}

	/** Terminal host cancellation never asks the Manager model for permission. */
	cancelTeam(teamId: string, reasonValue: string): HostControlReceipt {
		const team = this.team(teamId);
		const reason = this.hostText(reasonValue, "cancel reason");
		if (team.closeDecision) {
			// The committed close decision wins: do not abort the Manager's terminating settlement,
			// but bound any activation still in flight so a hung close cannot outlive the host request.
			if (team.lifecycle !== "closed") {
				for (const member of team.members.values()) if (member.active) this.scheduleActivationStopExpiry(team, member, member.active);
			}
			return { actor: "@host", status: "unchanged", teamId, lifecycle: team.lifecycle, ...(team.reason ? { reason: projectErrorText(team.reason) } : {}) };
		}
		if (["closed", "cancelled", "interrupted"].includes(team.lifecycle) || team.cancelRequested) {
			return { actor: "@host", status: "unchanged", teamId, lifecycle: team.lifecycle, ...(team.reason ? { reason: projectErrorText(team.reason) } : {}) };
		}
		if (team.lifecycle === "prepared") return this.stopPrepared(team, reason, "cancelled");
		this.stopTeamExecution(team, "cancelled", reason, { code: "CANCELLED", message: reason });
		return { actor: "@host", status: "applied", teamId, lifecycle: team.lifecycle, reason: projectErrorText(team.reason ?? reason) };
	}

	/**
	 * Host lifecycle end (reload, session switch, tree navigation, shutdown): the same bounded stop
	 * as cancellation, recorded as `interrupted` because no user decided it. Not a model action.
	 */
	interruptTeam(teamId: string, reasonValue: string): HostControlReceipt {
		const team = this.team(teamId);
		const reason = this.hostText(reasonValue, "interrupt reason");
		if (team.closeDecision || TERMINAL_TEAM_LIFECYCLES.includes(team.lifecycle) || team.cancelRequested) return this.cancelTeam(teamId, reason);
		if (team.lifecycle === "prepared") return this.stopPrepared(team, reason, "interrupted");
		this.stopTeamExecution(team, "interrupted", reason, { code: "INTERRUPTED", message: reason });
		return { actor: "@host", status: "applied", teamId, lifecycle: team.lifecycle, reason: projectErrorText(team.reason ?? reason) };
	}

	/** Driver-only admission failure: consume the prepared attempt, without impersonating a user cancel. */
	failStartup(teamId: string, reasonValue: string): HostControlReceipt {
		const team = this.team(teamId);
		if (team.closeDecision || TERMINAL_TEAM_LIFECYCLES.includes(team.lifecycle) || team.cancelRequested) {
			return { actor: "@host", status: "unchanged", teamId, lifecycle: team.lifecycle, ...(team.reason ? { reason: projectErrorText(team.reason) } : {}) };
		}
		if (team.lifecycle !== "prepared") fail("INVALID_ARGUMENT", "Startup failure requires a never-launched Team");
		// Driver diagnostics are evidence, not bounded host commands. Preserve the original cause;
		// public projections bound it without preventing this failed attempt's resource cleanup.
		if (typeof reasonValue !== "string") fail("INVALID_ARGUMENT", "startup failure must be a string");
		return this.stopPrepared(team, reasonValue, "failed");
	}

	/** Shared terminal stop for host cancellation and fail-closed journal loss; the first terminal lifecycle wins. */
	private stopTeamExecution(team: TeamState, lifecycle: "cancelled" | "failed" | "interrupted", reason: string, workError: WorkError): void {
		if (team.lifecycle === "failed") {
			team.reason = `${team.reason ?? "Team failed"}; ${lifecycle === "cancelled" ? "host cancellation requested" : "additional failure"}: ${reason}`;
		} else {
			team.lifecycle = lifecycle;
			team.reason = reason;
		}
		team.cancelRequested = true;
		this.cancelAllWork(team, lifecycle === "failed" ? "failed" : "cancelled", workError);
		for (const member of team.members.values()) {
			if (member.resourceState === "cleanup_failed" || member.lifecycle === "closed") continue;
			// A faulted member whose exit was already confirmed has nothing left to close.
			if (member.lifecycle === "faulted" && member.resourceState === "released" && !member.active) continue;
			if (!member.closeId) member.closeId = this.id("host-close");
			// A faulted member keeps its fault history; only its still-owned resource is closed.
			if (member.lifecycle !== "faulted") member.lifecycle = "closing";
			member.resourceState = "stopping";
			if (member.active?.scope.kind === "work") {
				const ref = member.active.scope.work!;
				team.ledger.cleanupPending.add(workRefKey(ref));
			}
			if (member.active) {
				member.active.stopReason = "team_cancelled";
				this.requestActivationStop(team, member, "policy_cancelled");
			}
		}
		this.changed(team);
		this.check(team);
		this.clearDeadline(team.id);
		this.requestDrain(team.id);
		this.settleCompletion(team);
	}

	/**
	 * End a never-launched Team without any provider/tool effect. Members whose binding was never
	 * issued hold nothing; a claimed member stays stopping until its driver reports the exit.
	 */
	private stopPrepared(team: TeamState, reason: string, lifecycle: "cancelled" | "interrupted" | "failed",
		workError: WorkError = { code: lifecycle === "failed" ? "STARTUP_FAILURE" : lifecycle === "cancelled" ? "CANCELLED" : "INTERRUPTED", message: reason }): HostControlReceipt {
		team.lifecycle = lifecycle;
		team.reason = reason;
		team.cancelRequested = true;
		if (lifecycle === "failed") team.health = "needs_attention";
		this.cancelAllWork(team, lifecycle === "failed" ? "failed" : "cancelled", workError);
		for (const member of team.members.values()) {
			member.closeId = this.id("host-close");
			if (member.nativeClaimed) {
				member.lifecycle = "closing";
				member.resourceState = "stopping";
			} else {
				member.lifecycle = "closed";
				member.resourceState = "released";
			}
		}
		this.changed(team);
		this.check(team);
		this.requestDrain(team.id);
		this.settleCompletion(team);
		return { actor: "@host", status: "applied", teamId: team.id, lifecycle: team.lifecycle, reason: projectErrorText(reason) };
	}

	private cancelAllWork(team: TeamState, lifecycle: "cancelled" | "failed", error: WorkError): void {
		for (const id of team.ledger.order) {
			const entry = team.ledger.get(id)!;
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if (!isTerminalWorkState(version.state)) {
				version.state = lifecycle;
				version.error = copy(error);
				version.waitingFor = [];
				delete version.hold;
				version.updatedAt = this.timestamp();
				delete entry.stagedWait;
			}
			team.ready = team.ready.filter((queued) => !sameWorkRef(queued, ref));
		}
	}

	/** Resolve one exact hold without changing any budget or reviving a faulted member. */
	releaseHold(teamId: string, refValue: WorkRef, incidentIdValue: string, instructionValue: string): HostControlReceipt {
		const team = this.team(teamId);
		const ref = this.hostWorkRef(refValue);
		const incidentId = this.hostId(incidentIdValue, "incidentId");
		const instruction = this.hostText(instructionValue, "resume instruction");
		const entry = team.ledger.get(ref.workId);
		const version = team.ledger.version(ref);
		if (!entry || !version) fail("UNKNOWN_WORK", `Unknown work ${workRefKey(ref)}`);
		if (entry.record.currentRevision !== ref.revision) fail("STALE_REVISION", "Host hold release must name the current WorkRef");
		if (version.hold?.incidentId !== incidentId) {
			const incident = team.incidents.find((item) => item.id === incidentId && item.state === "resolved" && item.work && sameWorkRef(item.work, ref));
			if (incident && version.resumeInstruction === instruction) return { actor: "@host", status: "unchanged", teamId, work: ref };
			fail("INVALID_ARGUMENT", "The exact WorkRef is not held by this incident");
		}
		this.applyHoldRelease(team, ref, incidentId, instruction);
		this.note(team, `host released the hold on ${shortWorkRef(ref)}`);
		this.requestDrain(teamId);
		return { actor: "@host", status: "applied", teamId, work: ref };
	}

	/** Append a deduplicated, explicitly host-attributed event for a healthy Manager. */
	messageManager(teamId: string, textValue: string): HostControlReceipt {
		const team = this.team(teamId);
		const text = this.hostText(textValue, "Manager message");
		if (team.lifecycle !== "active" || team.members.get(team.manager)!.lifecycle !== "open") {
			fail("MEMBER_UNAVAILABLE", "The Manager cannot receive a host message in its current lifecycle");
		}
		const key = `host-message:${canonicalJson(text)}`;
		const duplicate = team.events.some((event) => event.key === key);
		const event = this.addEvent(team, { key, kind: "USER_COMMAND", actor: "@host", message: text });
		this.requestDrain(teamId);
		return { actor: "@host", status: duplicate ? "unchanged" : "applied", teamId, eventId: event.id };
	}

	/**
	 * Host-only budget grant. Limits grow cumulatively and usage never resets; only budget holds
	 * whose scope is now within limits are released. Attention, pause and Manager-fault holds stay.
	 */
	grantBudget(teamId: string, scopeValue: BudgetScope, incrementsValue: Partial<Record<string, number>>, reasonValue: string): HostControlReceipt {
		const team = this.team(teamId);
		const reason = this.hostText(reasonValue, "grant reason");
		if (Buffer.byteLength(reason, "utf8") > TEAM_MAX_GRANT_REASON_BYTES) fail("INVALID_ARGUMENT", `grant reason exceeds ${TEAM_MAX_GRANT_REASON_BYTES} bytes`);
		const at = this.timestamp();
		const id = this.id("grant");
		// Validate the whole grant first, so journal and apply are atomic.
		const scope = this.validateHostGrant(team, scopeValue, incrementsValue, { id, reason, at });
		const grant = { id, actor: "@host" as const, scope, increments: copy(incrementsValue), reason, at };
		if (!this.tryJournal(team, { version: 2, kind: "grant", teamId, at, grant })) {
			this.applyJournalFailure(team);
			fail("PROTOCOL_FAILURE", "Budget grant could not be written to the Team journal");
		}
		team.budget.grant({ id, scope, increments: copy(incrementsValue), reason, at });
		const released = this.releaseBudgetHolds(team);
		this.addEvent(team, { key: `host-grant:${id}`, kind: "USER_COMMAND", actor: "@host",
			message: `Host granted budget for ${scope.kind === "team" ? "the Team" : `root ${scope.rootId}`}: ${reason}` });
		this.changed(team);
		this.check(team);
		this.requestDrain(teamId);
		return { actor: "@host", status: "applied", teamId, grantId: id, released };
	}

	/**
	 * Host preview for an explicit grant: the counters it raises and the budget-held work it would
	 * requeue. Nothing is applied or journaled; attention/protocol/pause holds are never listed.
	 */
	previewGrant(teamId: string, scopeValue: BudgetScope, incrementsValue: Partial<Record<string, number>>): GrantPreview {
		const team = this.team(teamId);
		const record = { id: "preview", reason: "preview", at: this.timestamp() };
		const scope = this.validateHostGrant(team, scopeValue, incrementsValue, record);
		const proposed = team.budget.clone();
		proposed.grant({ ...record, scope, increments: copy(incrementsValue) });
		const rootUsed = scope.kind === "root" ? { ...team.budget.rootUsed(scope.rootId), rootChildren: this.rootChildCount(team, scope.rootId) } : undefined;
		const changes = Object.keys(incrementsValue).map((counter) => scope.kind === "team"
			? { counter, used: counter in team.budget.used ? team.budget.used[counter as keyof typeof team.budget.used] : 0,
				limit: team.limits[counter as keyof TeamBudgetLimits], proposed: proposed.limits[counter as keyof TeamBudgetLimits] }
			: { counter, used: rootUsed![counter as keyof typeof rootUsed & string] ?? 0,
				limit: team.budget.rootLimit(scope.rootId, counter as RootGrantCounter), proposed: proposed.rootLimit(scope.rootId, counter as RootGrantCounter) });
		const released = this.budgetHeld(team).filter(({ rootId, manager }) => !proposed.exhausted(rootId, manager)).map(({ work }) => work);
		return { scope, changes, released };
	}

	/** Host inspection of every root budget (the Team view is a bounded summary). */
	inspectBudget(teamId: string): { limits: TeamBudgetLimits; used: TeamBudgetView["used"]; roots: TeamRootBudgetView[]; grants: TeamBudgetGrantView[] } {
		const team = this.team(teamId);
		const roots = team.ledger.order.map((id) => team.ledger.get(id)!.record).filter((record) => !record.parent);
		return { limits: copy(team.limits), used: { teamWorks: team.ledger.order.length, ...copy(team.budget.used), reservedResultBytes: team.reservedResultBytes },
			roots: roots.map((record) => team.budget.rootView(record.id, this.rootChildCount(team, record.id))), grants: copy(team.budget.grants) };
	}

	/** Host view of every current hold with its reason and incident, for explicit release or grant decisions. */
	listHolds(teamId: string): HostHoldView[] {
		const team = this.team(teamId);
		return team.ledger.order.flatMap((id) => {
			const entry = team.ledger.get(id)!;
			const version = currentVersion(entry.record);
			if (!version.hold) return [];
			const incident = team.incidents.find((item) => item.id === version.hold!.incidentId);
			return [{ work: { workId: id, revision: entry.record.currentRevision }, assignee: entry.record.assignee, rootId: entry.record.rootId,
				reason: version.hold.reason, incidentId: version.hold.incidentId, message: incident ? projectErrorText(incident.message) : "", task: previewText(version.task, 512) }];
		});
	}

	/** Host view of every work item's current revision (the model-facing status is paginated). */
	listWorks(teamId: string): TeamWorkSummary[] {
		return this.workSummaries(this.team(teamId));
	}

	/** Every Team this runtime generation still retains (live and recent terminal). */
	listTeams(): TeamTeamView[] {
		return [...this.teams.values()].map((team) => this.view(team));
	}

	/** Host observation, coalesced to one call per Team per microtask; listeners must only read. */
	onChange(listener: (teamId: string) => void): () => void {
		this.changeListeners.add(listener);
		return () => { this.changeListeners.delete(listener); };
	}

	private validateHostGrant(team: TeamState, scopeValue: BudgetScope, incrementsValue: Partial<Record<string, number>>,
		record: { id: string; reason: string; at: number }): BudgetScope {
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		let scope: BudgetScope;
		if (scopeValue?.kind === "team") scope = { kind: "team" };
		else if (scopeValue?.kind === "root") {
			const rootId = this.hostId(scopeValue.rootId, "rootId");
			if (team.ledger.get(rootId)?.record.parent !== undefined || !team.ledger.get(rootId)) fail("UNKNOWN_WORK", `Unknown root ${rootId}`);
			scope = { kind: "root", rootId };
		} else fail("INVALID_ARGUMENT", "Grant scope must be the Team or a known root");
		if (!incrementsValue || typeof incrementsValue !== "object" || Array.isArray(incrementsValue)) fail("INVALID_ARGUMENT", "Grant increments must be an object");
		try {
			team.budget.validateGrant({ ...record, scope, increments: copy(incrementsValue) });
		} catch (error) {
			fail("INVALID_ARGUMENT", error instanceof Error ? error.message : String(error));
		}
		return scope;
	}

	private budgetHeld(team: TeamState): Array<{ work: WorkRef; rootId: string; manager: boolean }> {
		return team.ledger.order.flatMap((id) => {
			const entry = team.ledger.get(id)!;
			const version = currentVersion(entry.record);
			return version.state === "blocked" && version.hold?.reason === "budget"
				? [{ work: { workId: id, revision: entry.record.currentRevision }, rootId: entry.record.rootId, manager: entry.record.assignee === team.manager }] : [];
		});
	}

	private rootChildCount(team: TeamState, rootId: string): number {
		return team.ledger.order.filter((id) => {
			const record = team.ledger.get(id)!.record;
			return record.rootId === rootId && record.parent !== undefined;
		}).length;
	}

	/** Requeue budget-held work whose Team/root budget now allows execution; resolve lifted budget incidents. */
	private releaseBudgetHolds(team: TeamState): WorkRef[] {
		const released: WorkRef[] = [];
		for (const id of team.ledger.order) {
			const entry = team.ledger.get(id)!;
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if (version.state !== "blocked" || version.hold?.reason !== "budget") continue;
			const manager = entry.record.assignee === team.manager;
			if (team.budget.exhausted(entry.record.rootId, manager)) continue;
			delete version.hold;
			version.state = "queued";
			version.updatedAt = this.timestamp();
			if (!team.ready.some((item) => sameWorkRef(item, ref))) team.ready.push(copy(ref));
			released.push(copy(ref));
		}
		for (const incident of team.incidents) {
			if (incident.state !== "open" || incident.code !== "BUDGET_HIT") continue;
			const lifted = incident.rootId && !incident.work ? !team.budget.rootExhausted(incident.rootId)
				: !team.budget.teamExhausted(true);
			const stillHeld = team.ledger.order.some((id) => team.ledger.current(id)?.hold?.incidentId === incident.id);
			if (lifted && !stillHeld) incident.state = "resolved";
		}
		if (!team.incidents.some((incident) => incident.state === "open")) team.health = "ok";
		return released;
	}

	/** One open incident per exhausted Team/root scope; repeated hits reuse it instead of re-notifying. */
	private budgetIncident(team: TeamState, hit: BudgetExhaustion): TeamIncidentView {
		const rootId = hit.scope.kind === "root" ? hit.scope.rootId : undefined;
		return this.createIncident(team, "BUDGET_HIT", `${rootId ? `Root ${rootId}` : "Team"} budget ${hit.counter} is exhausted; a host grant or cancellation is required`,
			undefined, undefined, rootId);
	}

	/** Critical history write. Returns false (and records the failure) instead of publishing an unjournaled fact. */
	private tryJournal(team: TeamState, record: TeamJournalRecord): boolean {
		if (this.journalRetiredForHostTransition) return true;
		if (!this.journalGeneration) return true;
		try {
			this.journalGeneration.write(record);
			return true;
		} catch (error) {
			team.journalFailure ??= error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	private writeJournal(team: TeamState, record: TeamJournalRecord): void {
		if (!this.tryJournal(team, record)) fail("PROTOCOL_FAILURE", `Team journal write failed: ${team.journalFailure}`);
	}

	/** Fail the Team closed after a lost critical journal write; nothing unjournaled is reported as committed. */
	private applyJournalFailure(team: TeamState): void {
		if (!team.journalFailure || team.journalFailureApplied) return;
		team.journalFailureApplied = true;
		const reason = `Team journal write failed: ${team.journalFailure}`;
		team.health = "needs_attention";
		if (TERMINAL_TEAM_LIFECYCLES.includes(team.lifecycle) || team.lifecycle === "closing") {
			if (team.lifecycle === "closed" || team.lifecycle === "closing") team.lifecycle = "failed";
			team.reason = team.reason ? `${team.reason}; ${reason}` : reason;
			this.changed(team);
			return;
		}
		if (team.lifecycle === "prepared") this.stopPrepared(team, reason, "failed", { code: "JOURNAL_FAILURE", message: reason });
		else this.stopTeamExecution(team, "failed", reason, { code: "JOURNAL_FAILURE", message: reason });
	}

	/**
	 * Explicit reservation seam for pure/fake-driver tests. A bound production executor is the only
	 * caller allowed to reserve activations once attached.
	 */
	takeNextActivation(teamId: string): RuntimeActivation | undefined {
		if (this.executors.has(teamId)) fail("TEAM_OWNED", "The attached Runtime executor owns activation scheduling");
		return this.reserveNextActivation(teamId);
	}

	private reserveNextActivation(teamId: string): RuntimeActivation | undefined {
		const team = this.team(teamId);
		if (team.lifecycle !== "active") return undefined;
		const manager = team.members.get(team.manager)!;
		if (manager.lifecycle !== "open") return undefined;
		if (!manager.active && manager.pause === "none") {
			const pendingEvents = () => team.events.map((event, index) => ({ event, index }))
				.filter(({ event }) => !event.processed && event.batchId === undefined)
				.sort((left, right) => this.managerEventPriority(left.event.kind) - this.managerEventPriority(right.event.kind)
					|| left.index - right.index)
				.slice(0, TEAM_MAX_MANAGER_EVENT_BATCH)
				.map(({ event }) => event);
			if (pendingEvents().length) {
				const exhausted = team.budget.teamExhausted(true);
				// An exhausted Manager gets a bounded number of restricted emergency activations; after
				// that only the host can grant or cancel. Workers with remaining budget keep running.
				if (exhausted) this.budgetIncident(team, exhausted);
				if (!exhausted || team.budget.emergencyAvailable()) {
					const activation = this.reserveManagement(team, manager, pendingEvents(), exhausted !== undefined);
					this.check(team);
					return activation;
				}
			}
		}
		this.holdUnknownDependencies(team);
		const workerPermits = this.usedWorkerPermits(team);
		for (let index = 0; index < team.ready.length; index++) {
			const ref = team.ready[index]!;
			const entry = team.ledger.get(ref.workId);
			const version = team.ledger.version(ref);
			if (!entry || !version || version.state !== "queued" || !sameWorkRef(team.ledger.currentRef(ref.workId)!, ref)) {
				team.ready.splice(index--, 1);
				continue;
			}
			const member = team.members.get(entry.record.assignee)!;
			if (member.lifecycle !== "open" || member.pause !== "none" || member.active) continue;
			if (member.role === "worker" && workerPermits >= team.limits.workerPermits) continue;
			const exhausted = team.budget.exhausted(entry.record.rootId, member.role === "manager");
			if (exhausted) {
				this.holdForBudget(team, ref, exhausted);
				index--;
				continue;
			}
			const activation = this.reserveWork(team, member, ref);
			team.ready.splice(index, 1);
			this.check(team);
			return activation;
		}
		this.check(team);
		return undefined;
	}

	private managerEventPriority(kind: ManagerEventView["kind"]): number {
		if (kind === "MEMBER_FAULTED" || kind === "DECISION_REQUEST" || kind === "BUDGET_HIT") return 0;
		return kind === "USER_COMMAND" ? 1 : 2;
	}

	/** Exact input_ready acknowledgment. A duplicate matching acknowledgment is harmless. */
	inputReady(bindingValue: BindingV2, activationId: string, deliveryId: string): TeamReply {
		const binding = this.validateBinding(bindingValue);
		const member = this.authenticatedMember(binding);
		const team = this.team(binding.teamId);
		const active = member.active?.scope.activationId === activationId ? member.active : undefined;
		if (!active) {
			if (member.lastActivation?.activationId === activationId && member.lastActivation.deliveryId === deliveryId
				&& team.deliveries.get(deliveryId)?.state === "delivered") return okReply(member.id);
			fail("WORK_NOT_RUNNING", "No matching active activation");
		}
		if (active.deliveryId !== deliveryId) fail("DELIVERY_UNKNOWN", "input_ready does not match the active delivery");
		const delivery = team.deliveries.get(deliveryId);
		if (!delivery || delivery.activationId !== activationId || delivery.memberId !== member.id) fail("DELIVERY_UNKNOWN", "Unknown active delivery");
		if (delivery.state === "delivered") return okReply(member.id);
		if (delivery.state !== "in_flight") fail("DELIVERY_UNKNOWN", `Delivery is ${delivery.state}`);
		if (active.native) fail("ACTIVATION_ENDING", "input_ready arrived after native settlement");
		const version = active.scope.kind === "work" ? team.ledger.version(active.scope.work!) : undefined;
		if (active.scope.kind === "work" && !version) fail("UNKNOWN_WORK", "Activation work no longer exists");
		delivery.state = "delivered";
		if (active.scope.kind === "work") {
			const observed = new Map(version!.observedOutcomes.map((ref) => [workRefKey(ref), ref]));
			for (const ref of delivery.dependencyOutcomes) observed.set(workRefKey(ref), ref);
			version!.observedOutcomes = [...observed.values()];
			const deliveredKeys = new Set(delivery.dependencyOutcomes.map(workRefKey));
			version!.waitingFor = version!.waitingFor.filter((ref) => !deliveredKeys.has(workRefKey(ref)));
			version!.updatedAt = this.timestamp();
		}
		active.inputReady = true;
		this.changed(team);
		this.check(team);
		return okReply(member.id);
	}

	/** Synchronous permission check used by tool_call preflight and pure Runtime tests. */
	gate(bindingValue: BindingV2, scopeValue: ActivationScope, phase: "provider_gate" | "tool_gate",
		toolCallId?: string, toolName?: string, endIntent = false): GateDecision {
		let binding: BindingV2;
		let scope: ActivationScope;
		let member: RuntimeMember;
		let team: TeamState;
		try {
			binding = parseBinding(bindingValue);
			scope = parseActivationScope(scopeValue);
			member = this.authenticatedMember(binding);
			team = this.team(binding.teamId);
		} catch (error) {
			return { allow: false, reason: "stale_scope", message: error instanceof Error ? error.message : "Unknown Team activation" };
		}
		const active = member.active;
		if (!active || !sameScope(active.scope, scope)) return { allow: false, reason: "stale_scope", message: "This Team activation scope is no longer current" };
		let nativeToolCallId: string | undefined;
		if (phase === "tool_gate" && toolCallId !== undefined) {
			try { nativeToolCallId = normalizeNativeToolCallId(toolCallId, "toolCallId"); }
			catch (error) { return { allow: false, reason: "stale_scope", message: error instanceof Error ? error.message : "Invalid native tool-call ID" }; }
			const existing = active.toolCalls.get(nativeToolCallId);
			if (existing) {
				if (existing.toolName !== toolName) return { allow: false, reason: "stale_scope", message: "A native tool-call ID changed tool name" };
				return existing.allowed ? { allow: true } : existing.denial ?? { allow: false, reason: "paused", message: "This tool call was blocked at its Team safety gate" };
			}
			if (active.completedToolCalls.has(nativeToolCallId)) return { allow: false, reason: "activation_ending", message: "This native tool call already completed" };
			if (active.toolCalls.size >= TEAM_MAX_PENDING_OPERATIONS) return { allow: false, reason: "budget", message: "Native tool-call tracking capacity is full" };
		}
		// A09: a provider continuation after a staged end intent (another extension or native queue) keeps
		// the activation settling; it is recorded and counted, never granted new business side effects.
		if (phase === "provider_gate" && active.intent && !active.native && !active.stopReason && member.lifecycle !== "faulted"
			&& (team.lifecycle === "active" || team.lifecycle === "closing")) {
			this.recordPostIntentContinuation(team, member, active);
			return this.admitProvider(team, active);
		}
		const endIntentTool = phase === "tool_gate" && toolName === "team" && endIntent;
		let decision = this.gateDecision(team, member, active, scope, phase, endIntentTool);
		if (decision.allow && phase === "provider_gate") decision = this.admitProvider(team, active);
		else if (decision.allow) {
			// Every real tool attempt is charged once, including end intents that later fail validation.
			// After exhaustion exactly one end-intent attempt may still run (and is charged) so a legal
			// reply/yield/close_team can finish; repeated invalid end intents cannot bypass the budget.
			const rootId = this.activationRootId(team, active);
			const exhausted = team.budget.stepExhaustion("tool", active.budget, rootId);
			if (!exhausted || (endIntentTool && !active.budgetFinalAttempt)) {
				if (exhausted) active.budgetFinalAttempt = true;
				team.budget.charge("tool", active.budget, rootId);
			} else {
				active.budgetBlockedToolCalls++;
				active.budgetStop ??= exhausted;
				decision = { allow: false, reason: "budget", message: this.budgetMessage(exhausted) };
			}
		}
		if (nativeToolCallId) {
			active.toolCalls.set(nativeToolCallId, { toolName: toolName ?? "", allowed: decision.allow, ...(!decision.allow ? { denial: decision } : {}) });
			if (!decision.allow && decision.reason === "paused") active.pauseBlockedToolCalls++;
		}
		return decision;
	}

	/** Count one observable provider request; exhaustion stops this activation as a budget hold. */
	private admitProvider(team: TeamState, active: ActiveActivation): GateDecision {
		// A tool refused for budget ends this activation at its next provider safe point.
		const exhausted = active.budgetStop ?? team.budget.admit("model", active.budget, this.activationRootId(team, active));
		if (!exhausted) return { allow: true };
		active.budgetStop ??= exhausted;
		active.completionReason ??= "budget_hold";
		return { allow: false, reason: "budget", message: this.budgetMessage(exhausted) };
	}

	private budgetMessage(exhausted: BudgetExhaustion): string {
		return `${exhausted.scope.kind === "root" ? `Root ${exhausted.scope.rootId}` : "Team"} budget ${exhausted.counter} is exhausted`;
	}

	private activationRootId(team: TeamState, active: ActiveActivation): string | undefined {
		return active.scope.kind === "work" ? team.ledger.get(active.scope.work!.workId)?.record.rootId : undefined;
	}

	/** Diagnostic only: resolved at creation, it neither wakes the Manager nor blocks a close. */
	private recordPostIntentContinuation(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		if (active.postIntentContinuations++ > 0) return;
		const work = active.scope.kind === "work" ? active.scope.work : undefined;
		const rootId = work ? team.ledger.get(work.workId)?.record.rootId : undefined;
		team.incidents.push({ id: this.id("incident"), code: "POST_INTENT_CONTINUATION", state: "resolved", createdAt: this.timestamp(),
			message: "A native continuation followed a staged end intent; business side effects were refused and the intent was kept",
			...(work ? { work: copy(work) } : {}), ...(rootId ? { rootId } : {}), memberId: member.id });
		this.changed(team);
	}

	/** Provider gates park a paused activation until resume has reacquired a worker permit. */
	waitAtProviderGate(bindingValue: BindingV2, scopeValue: ActivationScope): Promise<GateDecision> {
		const decision = this.gate(bindingValue, scopeValue, "provider_gate");
		if (decision.allow || decision.reason !== "paused") return Promise.resolve(decision);
		let binding: BindingV2;
		let scope: ActivationScope;
		try { binding = this.validateBinding(bindingValue); scope = this.validateScope(scopeValue); }
		catch (error) { return Promise.resolve({ allow: false, reason: "stale_scope", message: error instanceof Error ? error.message : "Invalid Team gate" }); }
		const team = this.team(binding.teamId);
		const member = this.authenticatedMember(binding);
		const active = member.active;
		if (!active || !sameScope(active.scope, scope) || member.role !== "worker") return Promise.resolve(decision);
		if (active.providerGatePromise) return active.providerGatePromise;
		active.providerGatePending = true;
		active.providerGatePromise = new Promise<GateDecision>((resolve) => { active.providerGateResolve = resolve; });
		this.tryParkAtProviderGate(team, member, active);
		return active.providerGatePromise;
	}

	/** A real native tool_result closes only the exact preflighted tool-call slot. */
	toolResult(bindingValue: BindingV2, scopeValue: ActivationScope, toolCallId: string, toolName: string): TeamReply {
		const binding = this.validateBinding(bindingValue);
		const scope = this.validateScope(scopeValue);
		const team = this.team(binding.teamId);
		const member = this.authenticatedMember(binding);
		const active = member.active;
		if (!active || !sameScope(active.scope, scope)) fail("WORK_NOT_RUNNING", "Tool result has no matching active scope");
		const id = normalizeNativeToolCallId(toolCallId, "toolCallId");
		const completedToolName = active.completedToolCalls.get(id);
		if (completedToolName !== undefined) {
			if (completedToolName !== toolName) fail("PROTOCOL_FAILURE", "Duplicate tool result changed its exact tool name");
			return okReply(member.id);
		}
		const call = active.toolCalls.get(id);
		if (!call || call.toolName !== toolName) fail("PROTOCOL_FAILURE", "Tool result does not match its exact preflighted native tool call");
		active.toolCalls.delete(id);
		active.completedToolCalls.set(id, call.toolName);
		if (active.completedToolCalls.size > TEAM_COMMAND_CACHE) active.completedToolCalls.delete(active.completedToolCalls.keys().next().value!);
		if (active.providerGatePending) this.tryParkAtProviderGate(team, member, active);
		// Let the matching private ACK reach Pi before denying its next provider gate.
		// The stop-expiry timer remains the fallback if the native turn never reaches that safe point.
		this.changed(team);
		this.check(team);
		return okReply(member.id);
	}

	private gateDecision(team: TeamState, member: RuntimeMember, active: ActiveActivation, scope: ActivationScope,
		phase: "provider_gate" | "tool_gate", allowPausedEndIntent = false): GateDecision {
		if (team.lifecycle !== "active") return { allow: false, reason: "team_stopping", message: `Team is ${team.lifecycle}` };
		if (member.lifecycle !== "open" || member.activity !== "running") {
			return { allow: false, reason: "stale_scope", message: "This member is not running the exact active scope" };
		}
		if (active.stopReason) return { allow: false, reason: "policy_stop", message: "This activation's exact work scope has ended" };
		if (member.pause !== "none" && !allowPausedEndIntent) return { allow: false, reason: "paused", message: "This member is paused by TeamRuntime" };
		const delivery = team.deliveries.get(active.deliveryId);
		if (!active.inputReady || delivery?.state !== "delivered") {
			return { allow: false, reason: "delivery_pending", message: "The exact activation input is not acknowledged yet" };
		}
		if (active.intent || active.native || active.cleanup) {
			return { allow: false, reason: "activation_ending", message: "This activation already has an ending intent or native settlement" };
		}
		if (scope.kind === "work") {
			const record = team.ledger.get(scope.work!.workId)?.record;
			const current = team.ledger.currentRef(scope.work!.workId);
			const version = team.ledger.version(scope.work!);
			if (!record || record.assignee !== member.id || !current || !sameWorkRef(current, scope.work!)
				|| !version || version.state !== "running" || !member.currentWork || !sameWorkRef(member.currentWork, scope.work!)) {
				return { allow: false, reason: "stale_scope", message: "The active WorkRef is no longer the current assigned revision" };
			}
		} else if (!team.eventBatches.has(scope.eventBatchId!)) {
			return { allow: false, reason: "stale_scope", message: "The active Manager event batch is no longer current" };
		}
		void phase;
		return { allow: true };
	}

	private hasRunningToolCalls(active: ActiveActivation): boolean {
		return [...active.toolCalls.values()].some((call) => call.allowed);
	}

	private tryParkAtProviderGate(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		if (!active.providerGatePending || this.hasRunningToolCalls(active)) return;
		if (member.pause === "none" && !active.stopReason && team.lifecycle === "active") {
			const resolve = active.providerGateResolve;
			active.providerGatePending = false;
			delete active.providerGateResolve;
			delete active.providerGatePromise;
			resolve?.(this.admitProvider(team, active));
			return;
		}
		if (active.stopReason || team.lifecycle !== "active") {
			const resolve = active.providerGateResolve;
			active.providerGatePending = false;
			delete active.providerGateResolve;
			delete active.providerGatePromise;
			resolve?.({ allow: false, reason: "activation_ending", message: "This activation is being stopped by TeamRuntime" });
			return;
		}
		active.providerGatePending = false;
		active.parked = true;
		active.workerPermitHeld = false;
		member.pause = "confirmed";
		this.changed(team);
		this.requestDrain(team.id);
	}

	private usedWorkerPermits(team: TeamState): number {
		return [...team.members.values()].filter((member) => member.role === "worker" && member.active?.workerPermitHeld).length;
	}

	/** Parked native gates have priority over new work when a worker permit becomes available. */
	private resumeParkedActivations(team: TeamState): void {
		if (team.lifecycle !== "active" || team.members.get(team.manager)?.lifecycle !== "open") return;
		let permits = this.usedWorkerPermits(team);
		for (const member of team.members.values()) {
			const active = member.active;
			if (member.role !== "worker" || !active?.parked || !active.resumeRequested) continue;
			if (member.lifecycle !== "open" || active.stopReason) continue;
			if (permits >= team.limits.workerPermits) break;
			permits++;
			active.workerPermitHeld = true;
			active.parked = false;
			active.resumeRequested = false;
			member.pause = "none";
			const resolve = active.providerGateResolve;
			delete active.providerGateResolve;
			delete active.providerGatePromise;
			// Resume never bypasses budget: the released gate is still a counted provider request.
			resolve?.(this.admitProvider(team, active));
			this.changed(team);
		}
	}

	private requestActivationStop(team: TeamState, member: RuntimeMember, reason: ActivationCompletionReason): void {
		const active = member.active;
		if (!active) return;
		active.completionReason = reason;
		this.resolveProviderGate(active, { allow: false, reason: "activation_ending", message: "This activation was stopped by a Team control" });
		this.scheduleActivationStopExpiry(team, member, active);
		// Interrupt first: approved tools receive Pi's abort signal instead of being awaited to completion.
		try {
			this.executors.get(team.id)?.stopActivation?.(this.binding(team, member), active.scope.activationId, reason);
		} catch (error) {
			const workError = { code: "TRANSPORT_FAILURE", message: `Activation-only stop could not be delivered: ${error instanceof Error ? error.message : String(error)}`, outcomeUnknown: true };
			if (active.native) this.cleanupFinished(this.binding(team, member), active.scope.activationId, { ok: false, error: workError });
			else this.activationLost(this.binding(team, member), active.scope.activationId, workError, false);
		}
	}

	/** Settle a parked/pending provider gate exactly once; it no longer holds a worker permit. */
	private resolveProviderGate(active: ActiveActivation, decision: GateDecision): void {
		const resolve = active.providerGateResolve;
		delete active.providerGateResolve;
		delete active.providerGatePromise;
		active.providerGatePending = false;
		active.parked = false;
		active.resumeRequested = false;
		resolve?.(decision);
	}

	private scheduleActivationStopExpiry(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		if (active.stopTimer) return;
		active.stopTimer = setTimeout(() => {
			delete active.stopTimer;
			if (member.active !== active) return;
			const binding = this.binding(team, member);
			const error = { code: "NATIVE_OUTCOME_UNKNOWN", message: "Activation did not reach a confirmed native/cleanup boundary after a scoped stop", outcomeUnknown: true };
			const terminate = this.executors.get(team.id)?.terminateActivation;
			if (terminate) {
				// The native process must actually stop; its send then reports loss/cleanup with real exit evidence.
				try { terminate(binding, active.scope.activationId, error); return; }
				catch (cause) { error.message += `; process termination could not be requested: ${cause instanceof Error ? cause.message : String(cause)}`; }
			}
			if (active.native) this.cleanupFinished(binding, active.scope.activationId, { ok: false, error });
			else this.activationLost(binding, active.scope.activationId, error, false);
		}, this.activationStopTimeoutMs);
	}

	private clearActivationStopExpiry(active: ActiveActivation): void {
		if (active.stopTimer) clearTimeout(active.stopTimer);
		delete active.stopTimer;
	}

	private clearDeadline(teamId: string): void {
		const timer = this.deadlineTimers.get(teamId);
		if (timer) clearTimeout(timer);
		this.deadlineTimers.delete(teamId);
	}

	/** Validate identity, activation-local order, idempotency and public action before transition. */
	handleAction(
		bindingValue: BindingV2,
		scopeValue: ActivationScope,
		sequence: number,
		rpcRequestId: string,
		rawAction: unknown,
		toolCallId = rpcRequestId,
	): TeamReply {
		let memberId = typeof bindingValue?.memberId === "string" ? bindingValue.memberId : "";
		try {
			const binding = this.validateBinding(bindingValue);
			memberId = binding.memberId;
			const team = this.team(binding.teamId);
			const stateVersionBefore = team.stateVersion;
			const member = this.authenticatedMember(binding);
			const scope = this.validateScope(scopeValue);
			if (!Number.isSafeInteger(sequence) || sequence < 1) fail("PROTOCOL_FAILURE", "sequence must be a positive safe integer");
			const normalizedId = this.validOpaqueId(rpcRequestId, "rpcRequestId");
			const normalizedToolCallId = this.validOpaqueId(toolCallId, "toolCallId");
			const action = normalizeTeamAction(rawAction);
			const fingerprint = canonicalJson({ scope, sequence, action, toolCallId: normalizedToolCallId });
			const key = `${binding.epoch}\0${scope.activationId}\0${normalizedId}`;
			const cached = member.active?.cache.get(key);
			if (cached) {
				if (cached.fingerprint !== fingerprint) fail("PROTOCOL_FAILURE", "Conflicting duplicate rpcRequestId");
				return copy(cached.reply);
			}
			const active = this.requireScope(member, scope);
			if (sequence <= active.lastSequence) fail("PROTOCOL_FAILURE", "Stale activation-local sequence");
			active.lastSequence = sequence;
			let reply: TeamReply;
			try {
				if (action.action !== "status" && active.intent) reply = this.repeatOrRejectIntent(team, member, active, action, normalizedToolCallId);
				else {
					if (action.action !== "status" && !active.inputReady) fail("DELIVERY_UNKNOWN", "Business actions are blocked until the exact activation input is ready");
					if (action.action !== "status" && team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
					reply = this.applyAction(team, member, active, action, normalizedToolCallId);
				}
			} catch (error) {
				if (!(error instanceof TeamProtocolError)) throw error;
				reply = errorReply(member.id, error);
			}
			this.cacheAction(active, key, fingerprint, reply);
			this.applyJournalFailure(team);
			if (reply.ok) {
				this.check(team);
				if (team.stateVersion !== stateVersionBefore) this.requestDrain(team.id);
			}
			return copy(reply);
		} catch (error) {
			return errorReply(memberId, error);
		}
	}

	/** Record the real Pi agent_settled boundary without releasing this Member's writer slot. */
	nativeSettled(bindingValue: BindingV2, activationId: string, completion: NativeCompletion): TeamReply {
		const binding = this.validateBinding(bindingValue);
		const team = this.team(binding.teamId);
		const member = this.authenticatedMember(binding);
		const active = member.active?.scope.activationId === activationId ? member.active : undefined;
		if (!active) {
			if (member.lastActivation?.activationId === activationId
				&& completionFingerprint(member.lastActivation.native) === completionFingerprint(completion)) return okReply(member.id);
			fail("WORK_NOT_RUNNING", "No matching active activation");
		}
		if (active.native) {
			if (completionFingerprint(active.native) !== completionFingerprint(completion)) fail("PROTOCOL_FAILURE", "Conflicting native settlement evidence");
			return okReply(member.id);
		}
		if (completion.status === "success" && completion.pendingToolCalls) fail("PROTOCOL_FAILURE", "Native success cannot retain pending tool calls");
		if (completion.finalAssistantText !== undefined && typeof completion.finalAssistantText !== "string") {
			fail("PROTOCOL_FAILURE", "finalAssistantText must be a string");
		}
		if (completion.usage !== undefined) this.validUsage(completion.usage);
		active.native = copy(completion);
		// Usage is folded exactly once, at the first accepted settlement of this activation.
		if (completion.usage) this.foldUsage(team, member, completion.usage);
		// A still-parked provider gate belongs to a native run that has now ended; release its private request.
		this.resolveProviderGate(active, { allow: false, reason: "activation_ending", message: "The native activation already settled" });
		// Gate-blocked tool batches without an end intent are controlled stops, not protocol failures.
		const gateStop: ActivationCompletionReason | undefined = active.intent ? undefined
			: active.pauseBlockedToolCalls > 0 && member.pause !== "none" ? "policy_pause"
			: active.budgetBlockedToolCalls > 0 ? "budget_hold" : undefined;
		const reason: ActivationCompletionReason = completion.status === "error" || completion.status === "length" ? "native_failure"
			: completion.status === "aborted" ? active.completionReason ?? gateStop ?? "native_failure"
			: active.completionReason ?? gateStop ?? "normal";
		active.completion = { native: copy(completion), reason };
		member.activity = "settling";
		this.changed(team);
		this.check(team);
		return okReply(member.id);
	}

	/** Runtime-authored classification; native providers never supply policy completion reasons. */
	activationCompletion(bindingValue: BindingV2, activationId: string): ActivationCompletion | undefined {
		const binding = this.validateBinding(bindingValue);
		const member = this.authenticatedMember(binding);
		const active = member.active?.scope.activationId === activationId ? member.active : undefined;
		if (active?.completion) return copy(active.completion);
		if (member.lastActivation?.activationId === activationId) return copy(member.lastActivation.completion);
		return;
	}

	activationCompletionReason(bindingValue: BindingV2, activationId: string): ActivationCompletionReason | undefined {
		const binding = this.validateBinding(bindingValue);
		const member = this.authenticatedMember(binding);
		const active = member.active?.scope.activationId === activationId ? member.active : undefined;
		if (active?.completion) return active.completion.reason;
		if (active?.completionReason) return active.completionReason;
		if (member.lastActivation?.activationId === activationId) return member.lastActivation.completion.reason;
		if (member.lastLostActivation?.activationId === activationId) return member.lastLostActivation.reason;
		return;
	}

	/** Cleanup is separate evidence: no result commit or next activation can pass this boundary early. */
	cleanupFinished(bindingValue: BindingV2, activationId: string, cleanup: CleanupCompletion): TeamReply {
		const binding = this.validateBinding(bindingValue);
		const team = this.team(binding.teamId);
		const member = this.authenticatedMember(binding);
		const active = member.active?.scope.activationId === activationId ? member.active : undefined;
		if (!active) {
			if (member.lastActivation?.activationId === activationId
				&& completionFingerprint(member.lastActivation.cleanup) === completionFingerprint(cleanup)) return okReply(member.id);
			fail("WORK_NOT_RUNNING", "No matching active activation");
		}
		if (!active.native) fail("PROTOCOL_FAILURE", "Cleanup cannot complete before native settlement");
		if (active.cleanup) {
			if (completionFingerprint(active.cleanup) !== completionFingerprint(cleanup)) fail("PROTOCOL_FAILURE", "Conflicting cleanup evidence");
			return okReply(member.id);
		}
		active.cleanup = copy(cleanup);
		this.clearActivationStopExpiry(active);
		if (cleanup.ok) member.lastActivation = { activationId, deliveryId: active.deliveryId, native: copy(active.native),
			completion: copy(active.completion!), cleanup: copy(cleanup) };
		this.finishActivation(team, member, active);
		this.applyJournalFailure(team);
		this.check(team);
		this.requestDrain(team.id);
		this.settleCompletion(team);
		return okReply(member.id);
	}

	/** Explicit transport/send loss before agent_settled. This is never a native completion. */
	/**
	 * Isolate an activation that never reached an accepted native settlement. `usage` is the real
	 * cost observed before the loss; it is folded here only because no settlement folded it.
	 */
	activationLost(bindingValue: BindingV2, activationId: string, error: WorkError, resourceReleased: boolean, usage?: SubagentUsage): TeamReply {
		const binding = this.validateBinding(bindingValue);
		const team = this.team(binding.teamId);
		const member = this.authenticatedMember(binding);
		const active = member.active?.scope.activationId === activationId ? member.active : undefined;
		if (!active) {
			const lost = member.lastLostActivation;
			if (lost?.activationId === activationId && errorFingerprint(lost.error) === errorFingerprint(error)
				&& lost.resourceReleased === resourceReleased) return okReply(member.id);
			fail("WORK_NOT_RUNNING", "No matching unsettled activation to isolate");
		}
		if (active.native) fail("PROTOCOL_FAILURE", "A settled activation must use nativeSettled and cleanupFinished");
		// Malformed evidence cannot block isolation; it is simply not billed.
		if (usage && this.isValidUsage(usage)) this.foldUsage(team, member, usage);
		this.clearActivationStopExpiry(active);
		this.resolveProviderGate(active, { allow: false, reason: "stale_scope", message: "The native activation was isolated by Runtime" });
		const delivery = team.deliveries.get(active.deliveryId);
		if (delivery) delivery.state = "unknown";
		const ref = active.scope.kind === "work" ? active.scope.work : undefined;
		if (ref) {
			const version = team.ledger.version(ref);
			if (version && !isTerminalWorkState(version.state)) {
				version.state = "failed";
				version.error = { ...copy(error), outcomeUnknown: true };
				version.updatedAt = this.timestamp();
			}
			// A staged wait edge belongs to the lost activation's intent; it must not outlive it.
			delete team.ledger.get(ref.workId)!.stagedWait;
			if (resourceReleased) team.ledger.cleanupPending.delete(workRefKey(ref));
			else team.ledger.cleanupPending.add(workRefKey(ref));
		}
		member.lifecycle = "faulted";
		member.activity = "idle";
		member.resourceState = resourceReleased ? "released" : "cleanup_failed";
		member.error = { code: error.code, message: error.message };
		member.lastLostActivation = { activationId, error: copy(error), resourceReleased, reason: "transport_failure" };
		this.note(team, `${member.id} activation lost (${error.code})`);
		delete member.active;
		delete member.currentWork;
		this.resumeParkedActivations(team);
		team.health = "needs_attention";
		if (team.lifecycle === "closing") {
			team.lifecycle = "failed";
			team.reason = "Team member transport failed before native settlement";
		}
		if (member.role === "manager") {
			this.holdManagerWork(team);
			this.pauseWorkersForManagerFault(team);
		} else if (ref) this.failWorkerWork(team, member, ref);
		this.createIncident(team, resourceReleased ? "NATIVE_OUTCOME_UNKNOWN" : "CLEANUP_FAILED",
			`${member.id} lost its native activation before settlement: ${error.message}`, ref, member.id);
		this.changed(team);
		// Known failures (e.g. unstarted MEMBER_UNAVAILABLE work) wake their waiters; outcome-unknown work holds them.
		this.wakeWaiters(team);
		this.check(team);
		this.requestDrain(team.id);
		this.settleCompletion(team);
		return okReply(member.id);
	}

	/** Explicit Manager-only host observation for the fakeable resource-close boundary. */
	memberReleased(bindingValue: BindingV2, closeId: string, result: CleanupCompletion): TeamReply {
		const binding = this.validateBinding(bindingValue);
		const team = this.team(binding.teamId);
		const member = this.authenticatedMember(binding);
		if ((member.lifecycle === "closed" || member.lifecycle === "faulted") && member.closeId === closeId && result.ok
			&& member.resourceState === "released") return okReply(member.id);
		if (member.lifecycle === "faulted" && member.closeId === closeId && !result.ok
			&& member.resourceState === (result.resourceReleased ? "released" : "cleanup_failed")) {
			return errorReply(member.id, new TeamProtocolError("CLEANUP_FAILED", member.error?.message ?? "Member exit was not confirmed"));
		}
		const faultedRelease = member.lifecycle === "faulted" && member.resourceState === "stopping";
		if ((member.lifecycle !== "closing" && !faultedRelease) || member.closeId !== closeId) fail("CLEANUP_FAILED", "Member close operation does not match");
		if (member.active) fail("CLOSE_BLOCKED", "Member still has an activation or cleanup in flight");
		if (result.ok && faultedRelease) {
			// The confirmed exit releases the resource; the member's fault history stays authoritative.
			member.resourceState = "released";
		} else if (result.ok) {
			member.lifecycle = "closed";
			member.resourceState = "released";
			delete member.error;
		} else {
			// An unclean close whose exit was confirmed releases the resource but is still not a closed member.
			member.lifecycle = "faulted";
			member.resourceState = result.resourceReleased ? "released" : "cleanup_failed";
			member.error = { code: result.error?.code ?? "CLEANUP_FAILED", message: result.error?.message ?? "Member exit was not confirmed" };
			team.health = "needs_attention";
			if (team.lifecycle === "closing") {
				team.lifecycle = "failed";
				team.reason = "Team close cleanup failed";
			}
		}
		if (result.ok && !faultedRelease) this.addEvent(team, {
			key: `member-closed:${member.id}:${closeId}`, kind: "MEMBER_CLOSED", message: `${member.id} closed after confirmed resource release`, memberId: member.id,
		});
		this.note(team, `${member.id} ${result.ok && !faultedRelease ? "closed" : "exit failed"}`);
		this.changed(team);
		this.finishTeamCloseIfReady(team);
		this.check(team);
		this.requestDrain(team.id);
		this.settleCompletion(team);
		return result.ok
			? okReply(member.id, { receipt: { status: "applied", command: "close_member", memberId: member.id } })
			: errorReply(member.id, new TeamProtocolError("CLEANUP_FAILED", member.error?.message ?? "Member exit was not confirmed"));
	}

	/**
	 * A later, explicitly retried cleanup confirmed the exit of a faulted member whose exit was unknown.
	 * Only the resource fact changes: fault history, work outcomes and outcomeUnknown evidence stay as recorded.
	 */
	memberExitConfirmed(bindingValue: BindingV2): TeamReply {
		const binding = this.validateBinding(bindingValue);
		const team = this.team(binding.teamId);
		const member = this.authenticatedMember(binding);
		if (member.lifecycle === "faulted" && member.resourceState === "released" && !member.active) return okReply(member.id);
		if (member.lifecycle !== "faulted" || member.resourceState !== "cleanup_failed") {
			fail("INVALID_ARGUMENT", `Member ${member.id} has no unconfirmed exit to reconcile`);
		}
		member.resourceState = "released";
		// The process can no longer act, so its terminal work's cleanup is confirmed; outcomeUnknown stays recorded.
		for (const id of team.ledger.order) {
			if (team.ledger.get(id)!.record.assignee !== member.id) continue;
			for (const version of team.ledger.get(id)!.record.versions) {
				if (isTerminalWorkState(version.state)) team.ledger.cleanupPending.delete(workRefKey({ workId: id, revision: version.revision }));
			}
		}
		// A retained unknown activation cannot outlive the confirmed process exit; its work/delivery evidence is unchanged.
		delete member.active;
		delete member.currentWork;
		member.activity = "idle";
		this.changed(team);
		this.wakeWaiters(team);
		this.check(team);
		this.settleCompletion(team);
		return okReply(member.id);
	}

	getTeam(teamId: string): TeamTeamView { return this.view(this.team(teamId)); }

	/** Host/driver-only lifetime capability; never include this in a Team view or model input. */
	bindingForDriver(teamId: string, memberId: string): BindingV2 {
		const team = this.team(teamId);
		const member = team.members.get(memberId);
		if (!member) fail("UNKNOWN_MEMBER", `Unknown member ${memberId}`);
		return this.binding(team, member);
	}

	/**
	 * Issue a prepared member's binding for native lifetime creation. A cancelled prepared Team then
	 * waits for that driver's exit report instead of assuming no resource was ever opened.
	 */
	claimNativeLifetime(teamId: string, memberId: string): BindingV2 {
		const team = this.team(teamId);
		const member = team.members.get(memberId);
		if (!member) fail("UNKNOWN_MEMBER", `Unknown member ${memberId}`);
		if (team.lifecycle !== "prepared") fail("INVALID_ARGUMENT", `Cannot open a native lifetime for a ${team.lifecycle} Team`);
		if (member.nativeClaimed) fail("TEAM_OWNED", `Team member ${memberId} already has a native lifetime claim`);
		member.nativeClaimed = true;
		return this.binding(team, member);
	}

	getWork(teamId: string, ref: WorkRef): TeamWorkView | undefined {
		const entry = this.team(teamId).ledger.get(ref.workId);
		const current = this.team(teamId).ledger.version(ref);
		if (!entry || !current) return undefined;
		return {
			id: entry.record.id, requester: entry.record.requester, assignee: entry.record.assignee, rootId: entry.record.rootId,
			...(entry.record.parent ? { parent: copy(entry.record.parent) } : {}), depth: entry.record.depth,
			currentRevision: entry.record.currentRevision, current: { ...copy(current), ...(current.error ? { error: projectWorkError(current.error) } : {}) },
			...projectWorkChildren(this.team(teamId).ledger.ownedChildren(ref)),
			revisions: entry.record.versions.map((version) => ({ revision: version.revision, state: version.state, ...(version.resultRef ? { resultRef: version.resultRef } : {}) })),
			...(entry.rejectedCandidates.length ? { rejectedCandidates: copy(entry.rejectedCandidates) } : {}),
		};
	}

	getResult(teamId: string, resultRef: string): ResultRecord | undefined {
		const result = this.team(teamId).ledger.results.get(resultRef);
		return result ? copy(result) : undefined;
	}

	/** Host panel facts outside the member-facing view: waiting Manager events, each author's results, the milestone timeline. */
	panelFacts(teamId: string): {
		pendingManagerEvents: number;
		results: Map<string, { count: number; latest: ResultRecord }>;
		timeline: Array<{ at: number; text: string }>;
		timelineOmitted: number;
	} {
		const team = this.team(teamId);
		const latest = new Map<string, { count: number; id: string }>();
		for (const id of team.ledger.resultOrder) {
			const author = team.ledger.results.get(id)!.author;
			latest.set(author, { count: (latest.get(author)?.count ?? 0) + 1, id });
		}
		const results = new Map([...latest].map(([author, { count, id }]) => [author, { count, latest: copy(team.ledger.results.get(id)!) }]));
		// After close, leftover notices (for example MEMBER_CLOSED) are no longer work for the Manager.
		const pendingManagerEvents = team.lifecycle === "active"
			? team.events.filter((event) => !event.processed && event.batchId === undefined).length : 0;
		return { pendingManagerEvents, results, timeline: copy(team.timeline), timelineOmitted: team.timelineOmitted };
	}

	listResultRefsPage(teamId: string, cursor?: string, limit = TEAM_STATUS_DEFAULT_LIMIT): {
		items: Array<{ id: string; work: WorkRef; author: string; status: WorkResult["status"]; summaryPreview: string }>;
		cursor?: string; hasMore: boolean; total: number;
	} {
		const team = this.team(teamId);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > TEAM_STATUS_MAX_LIMIT) fail("INVALID_ARGUMENT", `Result page limit must be 1-${TEAM_STATUS_MAX_LIMIT}`);
		const offset = cursor ? this.cursorOffset(cursor) : 0;
		const summaries = this.resultSummaries(team);
		const items = summaries.slice(offset, offset + limit);
		const next = offset + items.length;
		return { items, ...(next < summaries.length ? { cursor: `page:${next}` } : {}), hasMore: next < summaries.length, total: summaries.length };
	}

	getTeamResult(teamId: string): TeamResult | undefined {
		const team = this.team(teamId);
		if (["prepared", "active", "closing"].includes(team.lifecycle)) return undefined;
		const roots = team.ledger.order.map((id) => team.ledger.get(id)!.record).filter((record) => !record.parent);
		const unresolvedIncidents = team.incidents.filter((incident) => incident.state === "open");
		return {
			version: TEAM_PROTOCOL_VERSION,
			teamId: team.id,
			lifecycle: team.lifecycle as TeamResult["lifecycle"],
			...(team.outcome ? { outcome: team.outcome } : {}),
			...(team.reason ? { reason: projectErrorText(team.reason) } : {}),
			finalResultRefs: copy(team.closeDecision?.resultRefs ?? []),
			roots: team.closeDecision ? copy(team.closeDecision.roots) : roots.map((record) => {
				const version = currentVersion(record);
				return { work: { workId: record.id, revision: record.currentRevision }, state: version.state,
					...(version.resultRef ? { resultRef: version.resultRef } : {}), ...(version.review ? { review: copy(version.review) } : {}) };
			}),
			members: [...team.members.values()].map(({ id, role, lifecycle, resourceState }) => ({ id, role, lifecycle, resourceState })),
			usage: copy(team.usage),
			unresolvedIncidents: unresolvedIncidents.slice(-TEAM_MAX_TERMINAL_INCIDENTS).map(({ id, code, message }) => ({ id, ...projectWorkError({ code, message }) })),
			...(unresolvedIncidents.length > TEAM_MAX_TERMINAL_INCIDENTS
				? { unresolvedIncidentsOmitted: unresolvedIncidents.length - TEAM_MAX_TERMINAL_INCIDENTS }
				: {}),
		};
	}

	/** Test-only invariant entry point; production callers may use it for diagnostics as well. */
	assertInvariants(teamId: string): void { this.check(this.team(teamId)); }

	/** Diagnostic count of Runtime-held effects for one Team; a converged terminal Team holds none. */
	liveEffects(teamId: string): { executor: boolean; scheduledDrain: boolean; closingEffects: number; completionWaiters: number;
		deadlineTimer: boolean; activeActivations: number; stopTimers: number; ready: number; unprocessedManagerEvents: number } {
		const team = this.team(teamId);
		const active = [...team.members.values()].flatMap((member) => member.active ? [member.active] : []);
		return {
			executor: this.executors.has(teamId), scheduledDrain: this.scheduledDrains.has(teamId),
			closingEffects: [...this.closingEffects].filter((key) => key.startsWith(`${teamId}\0`)).length,
			completionWaiters: this.completionWaiters.get(teamId)?.size ?? 0, deadlineTimer: this.deadlineTimers.has(teamId),
			activeActivations: active.length, stopTimers: active.filter((activation) => activation.stopTimer).length, ready: team.ready.length,
			unprocessedManagerEvents: team.events.filter((event) => !event.processed).length,
		};
	}

	private applyAction(team: TeamState, member: RuntimeMember, active: ActiveActivation, action: TeamAction, toolCallId: string): TeamReply {
		// Emergency Manager activations may only diagnose, cancel, review/waive, close or yield.
		if (active.budget.emergency && action.action !== "status" && action.action !== "yield"
			&& !(action.action === "control" && ["cancel_work", "accept_result", "close_member", "close_team"].includes(action.control.command))) {
			fail("BUDGET_BLOCKED", "Emergency Manager activations cannot create or revise work; only status, cancel_work, accept_result, close_member, close_team and yield are allowed");
		}
		switch (action.action) {
			case "status": return this.status(team, member, action);
			case "request": return this.acceptRequest(team, member, active, action);
			case "reply": return this.stageReply(team, member, active, action.result, toolCallId);
			case "yield": return this.stageYield(team, member, active, action, toolCallId);
			case "control": return this.control(team, member, active, action.control, toolCallId);
		}
	}

	private acceptRequest(team: TeamState, requester: RuntimeMember, active: ActiveActivation, action: Extract<TeamAction, { action: "request" }>): TeamReply {
		if (requester.id === action.to) fail("SELF_REQUEST", "A member cannot request work from itself");
		const recipient = team.members.get(action.to);
		if (!recipient) fail("UNKNOWN_MEMBER", `Unknown recipient ${action.to}`);
		if (recipient.lifecycle === "closing") fail("RECIPIENT_CLOSING", `Recipient ${recipient.id} is closing`);
		if (recipient.lifecycle !== "open") fail("RECIPIENT_CLOSED", `Recipient ${recipient.id} is not open`);
		if (team.ledger.order.length >= team.limits.teamWorks) fail("TEAM_CAPACITY", "Team work ledger is full");
		if (team.reservedResultBytes + TEAM_MAX_RESULT_BYTES > team.limits.reservedResultBytes) {
			fail("TEAM_CAPACITY", "Reserved result capacity is full");
		}
		const unresolved = team.ledger.order.reduce((count, id) => {
			const entry = team.ledger.get(id)!;
			return count + (entry.record.assignee === recipient.id && !isTerminalWorkState(currentVersion(entry.record).state) ? 1 : 0);
		}, 0);
		if (unresolved >= team.limits.memberUnresolvedWork) fail("REQUEST_QUEUE_FULL", `Recipient ${recipient.id} already has ${unresolved} unresolved works`);
		const parent = active.scope.kind === "work" ? active.scope.work : undefined;
		let rootId: string | undefined;
		let depth = 0;
		if (parent) {
			const parentRecord = team.ledger.get(parent.workId)?.record;
			const parentVersion = team.ledger.version(parent);
			if (!parentRecord || !parentVersion || parentRecord.currentRevision !== parent.revision || parentVersion.state !== "running") {
				fail("WORK_NOT_RUNNING", "Child requests require the current running work activation");
			}
			rootId = parentRecord.rootId;
			depth = parentRecord.depth + 1;
			if (depth > team.limits.depth) fail("TEAM_CAPACITY", `Causal depth exceeds ${team.limits.depth}`);
			const rootChildren = team.ledger.order.filter((id) => team.ledger.get(id)!.record.rootId === rootId && team.ledger.get(id)!.record.parent).length;
			if (rootChildren >= team.budget.rootLimit(rootId, "rootChildren")) fail("BUDGET_BLOCKED", `Root ${rootId} exceeded its child-work limit`);
			if (isTerminalWorkState(parentVersion.state)) fail("WORK_NOT_RUNNING", "Cannot create children from terminal work");
		}
		for (const resultRef of action.inputRefs) if (!team.ledger.results.has(resultRef)) fail("UNKNOWN_RESULT", `Unknown result reference ${resultRef}`);
		const at = this.timestamp();
		const work = this.makeWork(requester.id, recipient.id, action.task, action.inputRefs, parent, at, rootId, depth);
		this.assertInputFits(team, recipient, work, parent);
		team.ledger.add(work);
		team.ready.push({ workId: work.id, revision: 1 });
		team.reservedResultBytes += TEAM_MAX_RESULT_BYTES;
		this.note(team, `${requester.id} requested ${shortWorkRef({ workId: work.id, revision: 1 })} → ${recipient.id}`);
		this.changed(team);
		return okReply(requester.id, { receipt: { status: "accepted", work: { workId: work.id, revision: 1 }, recipient: recipient.id, ...(recipient.pause !== "none" ? { paused: true } : {}) } });
	}

	private stageReply(team: TeamState, member: RuntimeMember, active: ActiveActivation, result: WorkResult, toolCallId: string): TeamReply {
		const ref = this.requireWorkScope(team, member, active);
		const version = team.ledger.version(ref)!;
		const openChildren = team.ledger.openSubtree(ref);
		const cleanupPending = team.ledger.ownedChildren(ref).filter((child) => team.ledger.cleanupPending.has(workRefKey(child)));
		if (openChildren.length || cleanupPending.length) {
			const blockers = [
				...openChildren.map((work) => ({ kind: "child", id: workRefKey(work), reason: "owned child is not terminal" })),
				...cleanupPending.map((work) => ({ kind: "child_cleanup", id: workRefKey(work), reason: "owned child is terminal but native cleanup is unconfirmed" })),
			];
			fail("UNRESOLVED_CHILDREN", "Work cannot reply while owned child work or cleanup remains unresolved", blockers);
		}
		const unobserved = team.ledger.ownedChildren(ref).filter((child) => team.ledger.outcomeReady(child)
			&& !version.observedOutcomes.some((observed) => sameWorkRef(observed, child)));
		if (unobserved.length) fail("UNOBSERVED_CHILD_RESULTS", "Work must receive owned child outcomes before reply", unobserved.map((work) => ({ kind: "child_result", id: workRefKey(work), reason: "outcome has not been delivered to this parent" })));
		active.intent = { kind: "reply", work: ref, result: copy(result), toolCallId };
		member.activity = "settling";
		version.updatedAt = this.timestamp();
		this.changed(team);
		return okReply(member.id, { receipt: { status: "staged", intent: "reply", work: ref } });
	}

	private stageYield(team: TeamState, member: RuntimeMember, active: ActiveActivation, action: Extract<TeamAction, { action: "yield" }>, toolCallId: string): TeamReply {
		if (active.scope.kind === "management") {
			if (action.waitingFor.length || action.attention !== undefined) fail("INVALID_ARGUMENT", "A Manager never waits inside an activation: end it with yield {checkpoint?} and no waitingFor/attention. New results, failures and incidents start the next management activation automatically; do not poll status to wait.");
			active.intent = { kind: "manager_idle", ...(action.checkpoint ? { checkpoint: action.checkpoint } : {}), toolCallId };
			member.activity = "settling";
			this.changed(team);
			return okReply(member.id, { receipt: { status: "staged", intent: "manager_idle" } });
		}
		const ref = this.requireWorkScope(team, member, active);
		if (action.attention !== undefined) {
			if (!action.checkpoint) fail("INVALID_ARGUMENT", "Attention yield requires a checkpoint");
			active.intent = { kind: "yield_attention", work: ref, attention: action.attention, checkpoint: action.checkpoint, toolCallId };
			team.ledger.version(ref)!.updatedAt = this.timestamp();
			member.activity = "settling";
			this.changed(team);
			return okReply(member.id, { receipt: { status: "staged", intent: "yield_attention", work: ref } });
		}
		if (!action.waitingFor.length || !action.checkpoint) fail("INVALID_ARGUMENT", "Work yield requires waitingFor and checkpoint, or attention and checkpoint");
		const version = team.ledger.version(ref)!;
		const alreadyObserved = action.waitingFor.every((target) => version.observedOutcomes.some((item) => sameWorkRef(item, target)));
		if (alreadyObserved) fail("NO_NEW_DEPENDENCY", "All requested outcomes were already delivered to this work version");
		for (const target of action.waitingFor) {
			const record = team.ledger.get(target.workId)?.record;
			if (!record || target.revision > record.currentRevision || !team.ledger.version(target)) fail("UNKNOWN_WORK", `Unknown dependency ${workRefKey(target)}`);
			if (sameWorkRef(target, ref)) fail("DEPENDENCY_CYCLE", "Work cannot wait for itself", [{ kind: "cycle", id: workRefKey(ref), reason: "self dependency" }]);
		}
		const newWaits = action.waitingFor.filter((target) => !version.observedOutcomes.some((observed) => sameWorkRef(observed, target)));
		const cycle = team.ledger.findCycle(ref, newWaits);
		if (cycle) fail("DEPENDENCY_CYCLE", `Dependency cycle: ${cycle.map(workRefKey).join(" -> ")}`, [{ kind: "cycle", reason: cycle.map(workRefKey).join(" -> ") }]);
		const entry = team.ledger.get(ref.workId)!;
		entry.stagedWait = { revision: ref.revision, refs: copy(newWaits) };
		active.intent = { kind: "yield_dependencies", work: ref, waitingFor: copy(action.waitingFor), checkpoint: action.checkpoint, toolCallId };
		member.activity = "settling";
		version.updatedAt = this.timestamp();
		this.changed(team);
		return okReply(member.id, { receipt: { status: "staged", intent: "yield_dependencies", work: ref } });
	}

	private control(team: TeamState, member: RuntimeMember, active: ActiveActivation, control: NonNullable<Extract<TeamAction, { action: "control" }>["control"]>, toolCallId: string): TeamReply {
		if (member.role !== "manager") fail("FORBIDDEN_ACTION", "Only the Team Manager may control work or close members");
		switch (control.command) {
			case "revise_work": return this.reviseWork(team, member, control);
			case "cancel_work": return this.cancelWork(team, member, control);
			case "accept_result": return this.acceptResult(team, member, control);
			case "close_member": return this.closeMember(team, member, control.memberId);
			case "pause_member": return this.pauseMember(team, member, control.memberId);
			case "resume_member": return this.resumeMember(team, member, control.memberId);
			case "resume_work": return this.resumeWork(team, member, control.workId, control.expectedRevision, control.incidentId, control.instruction);
			case "close_team": return this.closeTeam(team, member, active, control.resultRefs, control.outcome, control.reason, toolCallId);
		}
	}

	private pauseMember(team: TeamState, manager: RuntimeMember, memberId: string): TeamReply {
		const target = team.members.get(memberId);
		if (!target || target.role !== "worker") fail("UNKNOWN_MEMBER", `Unknown worker ${memberId}`);
		if (target.lifecycle !== "open" || target.resourceState !== "owned") fail("MEMBER_UNAVAILABLE", `Worker ${memberId} is not available to pause`);
		if (target.pause !== "none") {
			// A parked activation still waiting for a permit after resume stays parked when paused again.
			const parked = target.active?.parked && target.active.resumeRequested ? target.active : undefined;
			if (!parked) return okReply(manager.id, { receipt: { status: "unchanged", command: "pause_member", memberId } });
			parked.resumeRequested = false;
			target.pause = "confirmed";
			this.changed(team);
			return okReply(manager.id, { receipt: { status: "applied", command: "pause_member", memberId } });
		}
		target.pause = target.active ? "requested" : "confirmed";
		this.changed(team);
		this.requestDrain(team.id);
		return okReply(manager.id, { receipt: { status: "applied", command: "pause_member", memberId } });
	}

	private resumeMember(team: TeamState, manager: RuntimeMember, memberId: string): TeamReply {
		const target = team.members.get(memberId);
		if (!target || target.role !== "worker") fail("UNKNOWN_MEMBER", `Unknown worker ${memberId}`);
		if (target.lifecycle !== "open" || target.resourceState !== "owned") fail("MEMBER_UNAVAILABLE", `Worker ${memberId} cannot be resumed in its current lifecycle`);
		const active = target.active;
		if (target.pause === "none" || active?.resumeRequested) {
			return okReply(manager.id, { receipt: { status: "unchanged", command: "resume_member", memberId } });
		}
		if (active?.parked) {
			active.resumeRequested = true;
			target.pause = "requested";
			this.resumeParkedActivations(team);
		} else {
			target.pause = "none";
			if (active?.providerGatePending) this.tryParkAtProviderGate(team, target, active);
		}
		this.changed(team);
		this.requestDrain(team.id);
		return okReply(manager.id, { receipt: { status: "applied", command: "resume_member", memberId } });
	}

	private resumeWork(team: TeamState, manager: RuntimeMember, workId: string, expectedRevision: number, incidentId: string, instruction: string): TeamReply {
		const entry = team.ledger.get(workId);
		if (!entry) fail("UNKNOWN_WORK", `Unknown work ${workId}`);
		if (entry.record.currentRevision !== expectedRevision) fail("STALE_REVISION", `Expected revision ${expectedRevision}, current revision is ${entry.record.currentRevision}`);
		const ref = { workId, revision: expectedRevision };
		const version = team.ledger.version(ref)!;
		if (version.hold?.incidentId !== incidentId) {
			const incident = team.incidents.find((item) => item.id === incidentId && item.state === "resolved" && item.work && sameWorkRef(item.work, ref));
			if (incident && version.resumeInstruction === instruction) {
				return okReply(manager.id, { receipt: { status: "unchanged", command: "resume_work", work: ref } });
			}
			fail("INVALID_ARGUMENT", "The current WorkRef is not held by this incident");
		}
		this.applyHoldRelease(team, ref, incidentId, instruction);
		this.note(team, `${manager.id} resumed ${shortWorkRef(ref)}`);
		this.requestDrain(team.id);
		return okReply(manager.id, { receipt: { status: "applied", command: "resume_work", work: ref } });
	}

	private applyHoldRelease(team: TeamState, ref: WorkRef, incidentId: string, instruction: string): void {
		// Every check precedes the mutation below: a rejected release leaves the ledger untouched.
		const entry = team.ledger.get(ref.workId)!;
		const version = team.ledger.version(ref)!;
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		const manager = team.members.get(team.manager)!;
		if (manager.lifecycle !== "open" || manager.resourceState !== "owned") {
			fail("MEMBER_UNAVAILABLE", "The Manager is unavailable; a hold release cannot bypass the Manager-fault safety pause");
		}
		if (version.state !== "blocked" || version.hold?.incidentId !== incidentId) fail("INVALID_ARGUMENT", "The exact WorkRef is not held by this incident");
		if (version.hold.reason === "budget") fail("BUDGET_BLOCKED", "A budget hold cannot be released without an explicit budget grant");
		if (version.hold.reason !== "attention" && version.hold.reason !== "protocol") {
			fail("FORBIDDEN_ACTION", `A ${version.hold.reason} hold cannot be released by resume_work or release_hold`);
		}
		const assignee = team.members.get(entry.record.assignee)!;
		if (assignee.lifecycle !== "open" || assignee.resourceState !== "owned") fail("MEMBER_UNAVAILABLE", `Assignee ${assignee.id} is not available`);
		if (assignee.active?.scope.kind === "work" && sameWorkRef(assignee.active.scope.work!, ref)) {
			fail("INVALID_ARGUMENT", "The held WorkRef still has a native activation running or settling");
		}
		if (team.ledger.cleanupPending.has(workRefKey(ref))) fail("CLEANUP_FAILED", "Work cannot resume before its prior native cleanup is confirmed");
		// Only releasing the dependency incident itself is a decision about the unknown outcomes it names.
		const releasesDependency = team.incidents.find((item) => item.id === incidentId)?.code === "DEPENDENCY_UNAVAILABLE";
		const unknown = releasesDependency ? this.unknownDependencies(team, ref, version) : [];
		const unconfirmed = unknown.filter((dependency) => team.ledger.cleanupPending.has(workRefKey(dependency)));
		if (unconfirmed.length) fail("CLEANUP_FAILED", "An outcome-unknown dependency has no confirmed native exit yet",
			unconfirmed.map((dependency) => ({ kind: "dependency", id: workRefKey(dependency), reason: "native exit is not confirmed" })));
		// The explicit decision acknowledges each unknown outcome; its failure and outcomeUnknown evidence stay unchanged.
		for (const dependency of unknown) team.unknownAcknowledged.add(`${workRefKey(ref)}>${workRefKey(dependency)}`);
		delete version.hold;
		version.resumeInstruction = instruction;
		version.updatedAt = this.timestamp();
		// Releasing a hold never satisfies an AND wait: unmet dependencies keep the work blocked.
		if (version.waitingFor.length && !version.waitingFor.every((dependency) => team.ledger.outcomeReady(dependency))) {
			version.state = "blocked";
		} else {
			version.state = "queued";
			if (!team.ready.some((item) => sameWorkRef(item, ref))) team.ready.push(copy(ref));
		}
		this.resolveIncident(team, incidentId);
		this.changed(team);
		// Releasing any other hold never acknowledges an unknown dependency: it is held again for that decision.
		this.holdUnknownDependencies(team);
	}

	private reviseWork(team: TeamState, manager: RuntimeMember, control: Extract<NonNullable<Extract<TeamAction, { action: "control" }>["control"]>, { command: "revise_work" }>): TeamReply {
		const entry = team.ledger.get(control.workId);
		if (!entry) fail("UNKNOWN_WORK", `Unknown work ${control.workId}`);
		const current = currentVersion(entry.record);
		if (entry.record.currentRevision !== control.expectedRevision) fail("STALE_REVISION", `Expected revision ${control.expectedRevision}, current revision is ${entry.record.currentRevision}`);
		if (entry.record.versions.length >= team.limits.workRevisions) fail("TEAM_CAPACITY", "Work revision limit reached");
		const assignee = team.members.get(entry.record.assignee)!;
		if (assignee.lifecycle === "closing") fail("RECIPIENT_CLOSING", `Assignee ${assignee.id} is closing`);
		if (assignee.lifecycle !== "open" || assignee.resourceState !== "owned") fail("RECIPIENT_CLOSED", `Assignee ${assignee.id} is not available for revised work`);
		if (entry.record.parent) {
			const parent = team.ledger.version(entry.record.parent);
			if (!parent || isTerminalWorkState(parent.state)) fail("INVALID_ARGUMENT", "A child of a terminal parent cannot be revised; create independent work");
		}
		for (const inputRef of control.inputRefs) if (!team.ledger.results.has(inputRef)) fail("UNKNOWN_RESULT", `Unknown result reference ${inputRef}`);
		if (team.reservedResultBytes + TEAM_MAX_RESULT_BYTES > team.limits.reservedResultBytes) fail("TEAM_CAPACITY", "Reserved result capacity is full");
		const nextRevision = entry.record.currentRevision + 1;
		const candidate = this.makeVersion(nextRevision, control.task, control.inputRefs, this.timestamp());
		this.assertInputFits(team, assignee, { ...entry.record, currentRevision: nextRevision, versions: [...entry.record.versions, candidate] }, entry.record.parent);
		const currentRef = { workId: entry.record.id, revision: entry.record.currentRevision };
		this.writeJournal(team, { version: 2, kind: "decision", teamId: team.id, at: candidate.createdAt, decision: "revise_work", work: currentRef });
		this.note(team, `${manager.id} revised ${shortWorkRef(currentRef)}`);
		if (!isTerminalWorkState(current.state)) {
			this.cancelDescendants(team, currentRef, "superseded");
			current.state = "superseded";
			current.waitingFor = [];
			this.dropHold(team, current);
			current.updatedAt = this.timestamp();
		}
		delete entry.stagedWait;
		const active = assignee.active;
		if (active?.scope.kind === "work" && sameWorkRef(active.scope.work!, currentRef)) {
			active.stopReason = "superseded";
			team.ledger.cleanupPending.add(workRefKey(currentRef));
			this.requestActivationStop(team, assignee, "policy_superseded");
		}
		team.ready = team.ready.filter((ref) => !sameWorkRef(ref, currentRef));
		team.ledger.addRevision(entry.record.id, candidate);
		team.ready.push({ workId: entry.record.id, revision: nextRevision });
		team.reservedResultBytes += TEAM_MAX_RESULT_BYTES;
		this.wakeWaiters(team);
		this.changed(team);
		return okReply(manager.id, { receipt: { status: "applied", command: "revise_work", work: { workId: entry.record.id, revision: nextRevision } } });
	}

	private cancelWork(team: TeamState, manager: RuntimeMember, control: Extract<NonNullable<Extract<TeamAction, { action: "control" }>["control"]>, { command: "cancel_work" }>): TeamReply {
		const entry = team.ledger.get(control.workId);
		if (!entry) fail("UNKNOWN_WORK", `Unknown work ${control.workId}`);
		if (entry.record.currentRevision !== control.expectedRevision) fail("STALE_REVISION", `Expected revision ${control.expectedRevision}, current revision is ${entry.record.currentRevision}`);
		const ref = { workId: entry.record.id, revision: entry.record.currentRevision };
		if (isTerminalWorkState(currentVersion(entry.record).state)) {
			return okReply(manager.id, { receipt: { status: "unchanged", command: "cancel_work", work: ref } });
		}
		this.writeJournal(team, { version: 2, kind: "decision", teamId: team.id, at: this.timestamp(), decision: "cancel_work", work: ref, reason: control.reason });
		this.note(team, `${manager.id} cancelled ${shortWorkRef(ref)}`);
		const affected = [ref, ...team.ledger.openSubtree(ref)];
		for (const work of affected) {
			const version = team.ledger.version(work)!;
			if (isTerminalWorkState(version.state)) continue;
			version.state = "cancelled";
			version.error = { code: "CANCELLED", message: control.reason };
			version.waitingFor = [];
			this.dropHold(team, version);
			version.updatedAt = this.timestamp();
			delete team.ledger.get(work.workId)!.stagedWait;
			const assignee = team.members.get(team.ledger.get(work.workId)!.record.assignee)!;
			if (assignee.active?.scope.kind === "work" && sameWorkRef(assignee.active.scope.work!, work)) {
				assignee.active.stopReason = "cancelled";
				team.ledger.cleanupPending.add(workRefKey(work));
				this.requestActivationStop(team, assignee, "policy_cancelled");
			}
		}
		team.ready = team.ready.filter((queued) => !affected.some((item) => sameWorkRef(item, queued)));
		this.wakeWaiters(team);
		this.changed(team);
		return okReply(manager.id, { receipt: { status: "applied", command: "cancel_work", work: ref } });
	}

	private acceptResult(team: TeamState, manager: RuntimeMember, control: Extract<NonNullable<Extract<TeamAction, { action: "control" }>["control"]>, { command: "accept_result" }>): TeamReply {
		const entry = team.ledger.get(control.work.workId);
		const version = team.ledger.version(control.work);
		if (!entry || !version) fail("UNKNOWN_WORK", `Unknown work ${workRefKey(control.work)}`);
		if (entry.record.parent || entry.record.currentRevision !== control.work.revision) fail("INVALID_ARGUMENT", "Only a current root work version can be reviewed");
		if (version.review) {
			if (version.review.disposition === control.disposition && version.review.reason === control.reason) {
				return okReply(manager.id, { receipt: { status: "unchanged", command: "accept_result", work: control.work } });
			}
			fail("INTENT_CONFLICT", "This root already has a different review decision");
		}
		if (control.disposition === "accepted") {
			if (version.state !== "resolved" || !version.resultRef || team.ledger.results.get(version.resultRef)?.result.status !== "succeeded") {
				fail("INVALID_TEAM_OUTCOME", "accepted requires a current resolved succeeded result");
			}
		} else if (!isTerminalWorkState(version.state)) {
			fail("INVALID_TEAM_OUTCOME", "A non-terminal root must be cancelled or completed before it can be waived");
		}
		version.review = { disposition: control.disposition, ...(control.reason ? { reason: control.reason } : {}) };
		this.note(team, `${manager.id} ${control.disposition} ${shortWorkRef(control.work)}`);
		version.updatedAt = this.timestamp();
		this.changed(team);
		return okReply(manager.id, { receipt: { status: "applied", command: "accept_result", work: control.work } });
	}

	private closeMember(team: TeamState, manager: RuntimeMember, memberId: string): TeamReply {
		if (memberId === manager.id) fail("FORBIDDEN_ACTION", "Manager cannot close itself; use close_team");
		const target = team.members.get(memberId);
		if (!target || target.role !== "worker") fail("UNKNOWN_MEMBER", `Unknown worker ${memberId}`);
		if (target.lifecycle === "closing" && target.closeId) return okReply(manager.id, { receipt: { status: "closing", command: "close_member", memberId, closeId: target.closeId } });
		if (target.lifecycle === "closed") return okReply(manager.id, { receipt: { status: "applied", command: "close_member", memberId } });
		if (target.lifecycle !== "open") fail("RECIPIENT_CLOSED", `Worker ${memberId} is ${target.lifecycle}`);
		const blockers: Array<{ kind: string; id?: string; reason: string }> = [];
		if (target.active) blockers.push({ kind: "activation", id: target.id, reason: "native activation or cleanup is still in flight" });
		for (const workId of team.ledger.order) {
			const record = team.ledger.get(workId)!.record;
			const version = currentVersion(record);
			if (!isTerminalWorkState(version.state) && record.assignee === memberId) blockers.push({ kind: "assigned_work", id: workRefKey({ workId, revision: record.currentRevision }), reason: `work is ${version.state}` });
			if (!isTerminalWorkState(version.state) && record.requester === memberId) blockers.push({ kind: "requested_work", id: workRefKey({ workId, revision: record.currentRevision }), reason: "requester still owns an unresolved child obligation" });
		}
		for (const delivery of team.deliveries.values()) if (delivery.memberId === memberId && delivery.state !== "delivered" && delivery.state !== "cancelled") {
			blockers.push({ kind: "delivery", id: memberId, reason: "required input is in flight" });
		}
		if (blockers.length) fail("CLOSE_BLOCKED", `Cannot close ${memberId} while obligations remain`, blockers);
		const closeId = this.id("close");
		target.lifecycle = "closing";
		target.resourceState = "stopping";
		target.closeId = closeId;
		this.changed(team);
		this.check(team);
		return okReply(manager.id, { receipt: { status: "closing", command: "close_member", memberId, closeId } });
	}

	private closeTeam(team: TeamState, manager: RuntimeMember, active: ActiveActivation, resultRefs: string[], outcome: "succeeded" | "partial" | "failed", reason: string | undefined, toolCallId: string): TeamReply {
		if (manager.id !== team.manager || active.scope.kind !== "management") fail("FORBIDDEN_ACTION", "close_team requires the Manager's management activation");
		const blockers: Array<{ kind: string; id?: string; reason: string }> = [];
		const roots = team.ledger.order.map((id) => team.ledger.get(id)!.record).filter((record) => !record.parent);
		for (const root of roots) {
			const version = currentVersion(root);
			if (!isTerminalWorkState(version.state)) blockers.push({ kind: "root_work", id: workRefKey({ workId: root.id, revision: root.currentRevision }), reason: `root is ${version.state}` });
			if (!version.review) blockers.push({ kind: "root_review", id: workRefKey({ workId: root.id, revision: root.currentRevision }),
				reason: "root has not been reviewed: accept_result it (accepted, or waived with a reason)" });
		}
		for (const id of team.ledger.order) {
			const record = team.ledger.get(id)!.record;
			const version = currentVersion(record);
			if (!isTerminalWorkState(version.state)) blockers.push({ kind: "work", id: workRefKey({ workId: id, revision: record.currentRevision }), reason: `work is ${version.state}` });
		}
		for (const member of team.members.values()) if (member.id !== manager.id) {
			if (member.active) blockers.push({ kind: "activation", id: member.id, reason: `${member.id} still has an active activation` });
			if (member.role === "worker" && !((member.lifecycle === "open" && member.resourceState === "owned")
				|| (member.resourceState === "released" && (member.lifecycle === "closed" || member.lifecycle === "faulted")))) {
				blockers.push({ kind: "member_resource", id: member.id, reason: `${member.id} is ${member.lifecycle} with resources ${member.resourceState}` });
			}
		}
		for (const delivery of team.deliveries.values()) if (delivery.state !== "delivered" && delivery.state !== "cancelled" && delivery.activationId !== active.scope.activationId) {
			blockers.push({ kind: "delivery", id: delivery.memberId, reason: "required input is in flight" });
		}
		for (const event of team.events) if (!event.processed && event.kind !== "TEAM_QUIESCENT" && event.batchId !== active.scope.eventBatchId) {
			blockers.push({ kind: "manager_event", id: event.id, reason: "an unprocessed Manager event is outside the closing activation batch; end this activation with yield to receive it, then close" });
		}
		// An exhausted-budget notice that holds no work is not an unresolved obligation; held work blocks on its own.
		const holdsWork = (incidentId: string) => team.ledger.order.some((id) => team.ledger.current(id)?.hold?.incidentId === incidentId);
		if (outcome === "succeeded" && team.incidents.some((incident) => incident.state === "open"
			&& (incident.code !== "BUDGET_HIT" || holdsWork(incident.id)))) {
			blockers.push({ kind: "incident", reason: "succeeded close cannot leave an unresolved incident" });
		}
		for (const resultRef of resultRefs) if (!team.ledger.results.has(resultRef)) fail("UNKNOWN_RESULT", `Unknown result reference ${resultRef}`);
		if (outcome === "succeeded") {
			const unsuccessful = roots.filter((root) => currentVersion(root).review?.disposition !== "accepted"
				|| team.ledger.results.get(currentVersion(root).resultRef ?? "")?.result.status !== "succeeded");
			if (unsuccessful.length || resultRefs.length === 0) {
				// Name every root that prevents success so the Manager can fix all of them in one step.
				fail("INVALID_TEAM_OUTCOME", "succeeded requires every current root accepted with a succeeded result and at least one final resultRef. "
					+ "A cancelled, failed or waived root (for example a duplicate) can only close as partial: waive it with accept_result disposition waived and a reason.",
				unsuccessful.slice(0, 32).map((root) => {
					const version = currentVersion(root);
					return { kind: "root_outcome", id: workRefKey({ workId: root.id, revision: root.currentRevision }),
						reason: version.review ? `root is ${version.state} and ${version.review.disposition}` : `root is ${version.state} and not accepted` };
				}));
			}
		} else if (outcome === "partial") {
			if (!reason || resultRefs.length === 0) fail("INVALID_TEAM_OUTCOME", "partial requires a reason and at least one resultRef");
		} else if (!reason) fail("INVALID_TEAM_OUTCOME", "failed requires a reason");
		if (blockers.length) fail("CLOSE_BLOCKED", "Team close is blocked by unresolved obligations", blockers);
		if (active.intent) fail("ACTIVATION_ENDING", "Manager activation already staged another intent");
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		const closeId = this.id("close");
		const rootSnapshot: TeamResult["roots"] = roots.map((root) => {
			const version = currentVersion(root);
			return { work: { workId: root.id, revision: root.currentRevision }, state: version.state,
				...(version.resultRef ? { resultRef: version.resultRef } : {}), ...(version.review ? { review: copy(version.review) } : {}) };
		});
		this.writeJournal(team, { version: 2, kind: "close_decision", teamId: team.id, at: this.timestamp(), closeId, outcome,
			resultRefs: copy(resultRefs), roots: copy(rootSnapshot), ...(reason ? { reason } : {}) });
		this.note(team, `${manager.id} close_team ${outcome}`);
		team.closeDecision = { id: closeId, outcome, ...(reason ? { reason } : {}), resultRefs: copy(resultRefs), roots: copy(rootSnapshot) };
		team.lifecycle = "closing";
		team.outcome = outcome;
		if (reason) team.reason = reason;
		for (const target of team.members.values()) {
			if (target.id === manager.id) {
				target.lifecycle = "closing";
				target.resourceState = "stopping";
				target.closeId = closeId;
			} else if (target.lifecycle === "open") {
				target.lifecycle = "closing";
				target.resourceState = "stopping";
				target.closeId = closeId;
			}
		}
		active.intent = { kind: "close_team", closeId, toolCallId };
		manager.activity = "settling";
		this.consumeBatch(team, active.scope.eventBatchId);
		for (const event of team.events) if (event.kind === "TEAM_QUIESCENT" && !event.processed) {
			event.processed = true;
			delete event.batchId;
		}
		this.changed(team);
		this.check(team);
		return okReply(manager.id, { receipt: { status: "closing", command: "close_team", closeId } });
	}

	private status(team: TeamState, member: RuntimeMember, action: Extract<TeamAction, { action: "status" }>): TeamReply {
		if (action.view === "team") return okReply(member.id, { data: this.view(team) });
		if (action.id) {
			if (action.view === "work") {
				const entry = team.ledger.get(action.id);
				if (!entry) fail("UNKNOWN_WORK", `Unknown work ${action.id}`);
				if (member.role !== "manager" && entry.record.assignee !== member.id) {
					const summary = this.workSummaries(team).find((item) => item.work.workId === action.id);
					if (!summary) fail("UNKNOWN_WORK", `Unknown work ${action.id}`);
					return okReply(member.id, { data: { view: "work", items: [summary], hasMore: false } });
				}
				return okReply(member.id, { data: this.getWork(team.id, { workId: action.id, revision: entry.record.currentRevision })! });
			}
			if (action.view === "result") {
				const result = team.ledger.results.get(action.id);
				if (!result) fail("UNKNOWN_RESULT", `Unknown result ${action.id}`);
				return okReply(member.id, { data: copy(result) });
			}
			const incident = team.incidents.find((item) => item.id === action.id);
			if (!incident) fail("UNKNOWN_WORK", `Unknown incident ${action.id}`);
			return okReply(member.id, { data: incidentView(incident) });
		}
		const offset = action.cursor ? this.cursorOffset(action.cursor) : 0;
		const items = action.view === "work" ? this.workSummaries(team)
			: action.view === "result" ? this.resultSummaries(team)
			: team.incidents.map(incidentView);
		const pageItems = items.slice(offset, offset + action.limit);
		const next = offset + pageItems.length;
		return okReply(member.id, { data: { view: action.view, items: pageItems, ...(next < items.length ? { cursor: `page:${next}` } : {}), hasMore: next < items.length } });
	}

	private reserveManagement(team: TeamState, member: RuntimeMember, events: InternalEvent[], emergency: boolean): RuntimeActivation {
		const batchId = this.id("batch");
		const scope: ActivationScope = { activationId: this.id("activation"), kind: "management", eventBatchId: batchId };
		const deliveryId = this.id("delivery");
		let selected = events;
		let input: ActivationInput;
		for (;;) {
			try {
				input = this.activationInput(team, member, deliveryId, { kind: "management", eventBatchId: batchId,
					events: selected.map(({ key: _key, processed: _processed, batchId: _batchId, ...view }) => view), emergency },
				team.budget.inputSummary(undefined, true, emergency));
				break;
			} catch (error) {
				if (!(error instanceof TeamProtocolError) || error.code !== "INPUT_BUDGET_EXCEEDED" || selected.length <= 1) throw error;
				// Preserve the brief and event contents; unselected notices stay pending for the next batch.
				selected = selected.slice(0, -1);
			}
		}
		const eventBatch: EventBatch = { id: batchId, eventIds: selected.map((event) => event.id) };
		for (const event of selected) event.batchId = batchId;
		team.eventBatches.set(batchId, eventBatch);
		const activation: ActiveActivation = { scope, deliveryId, inputReady: false, workerPermitHeld: false, parked: false, resumeRequested: false,
			providerGatePending: false, toolCalls: new Map(), completedToolCalls: new Map(), pauseBlockedToolCalls: 0, cache: new Map(), lastSequence: 0,
			budget: team.budget.recordActivation(undefined, true, emergency), budgetBlockedToolCalls: 0, postIntentContinuations: 0 };
		member.active = activation;
		member.activity = "running";
		this.note(team, `${member.id} management activation (${selected.map((event) => event.kind).join(", ")})`);
		this.addDelivery(team, member, scope, input, eventBatch.eventIds);
		this.changed(team);
		return { binding: this.binding(team, member), scope: copy(scope), deliveryId, input };
	}

	private reserveWork(team: TeamState, member: RuntimeMember, ref: WorkRef): RuntimeActivation {
		const version = team.ledger.version(ref)!;
		const at = this.timestamp();
		const deliveryId = this.id("delivery");
		const scope: ActivationScope = { activationId: this.id("activation"), kind: "work", work: copy(ref) };
		const input = this.activationInput(team, member, deliveryId, {
			kind: "work", work: copy(ref), task: version.task, requester: team.ledger.get(ref.workId)!.record.requester,
			rootId: team.ledger.get(ref.workId)!.record.rootId,
			...(team.ledger.get(ref.workId)!.record.parent ? { parent: copy(team.ledger.get(ref.workId)!.record.parent!) } : {}),
			depth: team.ledger.get(ref.workId)!.record.depth, inputRefs: copy(version.inputRefs), waitingFor: copy(version.waitingFor),
			...(version.checkpoint ? { checkpoint: version.checkpoint } : {}), ...(version.resumeInstruction ? { resumeInstruction: version.resumeInstruction } : {}),
			...(ref.revision > 1 ? { previous: this.previousVersion(team, ref) } : {}),
		}, team.budget.inputSummary(team.ledger.get(ref.workId)!.record.rootId, member.role === "manager", false));
		version.state = "running";
		version.updatedAt = at;
		member.active = { scope, deliveryId, inputReady: false, workerPermitHeld: member.role === "worker", parked: false, resumeRequested: false,
			providerGatePending: false, toolCalls: new Map(), completedToolCalls: new Map(), pauseBlockedToolCalls: 0, cache: new Map(), lastSequence: 0,
			budget: team.budget.recordActivation(team.ledger.get(ref.workId)!.record.rootId, member.role === "manager", false),
			budgetBlockedToolCalls: 0, postIntentContinuations: 0 };
		member.currentWork = copy(ref);
		member.activity = "running";
		this.note(team, `${member.id} started ${shortWorkRef(ref)}`);
		this.addDelivery(team, member, scope, input);
		this.changed(team);
		return { binding: this.binding(team, member), scope: copy(scope), deliveryId, input };
	}

	private activationInput(team: TeamState, member: RuntimeMember, deliveryId: string, scope: ActivationInput["scope"],
		budget: ActivationInput["budget"]): ActivationInput {
		const outcomes: OutcomeView[] = [];
		let candidates: WorkRef[] = [];
		let ownedChildren: Array<{ work: WorkRef; state: WorkVersion["state"] }> = [];
		if (scope.kind === "work") {
			const version = team.ledger.version(scope.work)!;
			candidates = [...version.waitingFor, ...team.ledger.ownedChildren(scope.work)];
			ownedChildren = team.ledger.ownedChildren(scope.work).map((work) => ({ work, state: team.ledger.version(work)!.state }));
			const seen = new Set<string>();
			for (const ref of candidates) {
				const key = workRefKey(ref);
				if (seen.has(key) || version.observedOutcomes.some((old) => workRefKey(old) === key) || !team.ledger.outcomeReady(ref)
					|| (this.isUnknownOutcome(team, ref) && !team.unknownAcknowledged.has(`${workRefKey(scope.work)}>${key}`))) continue;
				seen.add(key);
				const outcome = team.ledger.outcome(ref)!;
				const record = outcome.resultRef ? team.ledger.results.get(outcome.resultRef) : undefined;
				outcomes.push({ work: copy(ref), state: outcome.state, ...(outcome.resultRef ? { resultRef: outcome.resultRef } : {}),
					...(outcome.error ? { error: copy(outcome.error) } : {}),
					...(record && outcomes.length < TEAM_MAX_DEPENDENCY_PREVIEWS ? { preview: {
						status: record.result.status,
						summary: previewText(record.result.summary, Math.floor(TEAM_MAX_DEPENDENCY_PREVIEW_BYTES / TEAM_MAX_DEPENDENCY_PREVIEWS) - 96),
					} } : {}) });
			}
		}
		const result: ActivationInput = {
			version: TEAM_PROTOCOL_VERSION, teamId: team.id, deliveryId,
			member: { id: member.id, role: member.role, roleDescription: member.roleDescription },
			brief: copy(team.plan.brief),
			roster: [...team.members.values()].map((item) => ({ id: item.id, role: item.role, lifecycle: item.lifecycle,
				rolePreview: previewText(item.roleDescription, 512) })),
			scope: copy(scope), outcomes, omittedOutcomes: 0,
			ownedChildren, budget, notice: scope.kind === "work" ? WORK_NOTICE : MANAGEMENT_NOTICE,
		};
		return projectActivationInput(result);
	}

	private addDelivery(team: TeamState, member: RuntimeMember, scope: ActivationScope, input: ActivationInput, eventIds?: string[]): void {
		// Only these outcomes survived size projection and the per-consumer unknown-outcome gate.
		const dependencyOutcomes = input.outcomes.map((outcome) => copy(outcome.work));
		team.deliveries.set(input.deliveryId, { id: input.deliveryId, memberId: member.id, activationId: scope.activationId,
			...(scope.kind === "work" ? { work: copy(scope.work!) } : {}), ...(eventIds ? { eventIds: copy(eventIds) } : {}),
			state: "in_flight", dependencyOutcomes });
	}

	private finishActivation(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		const cleanup = active.cleanup!;
		const scope = active.scope;
		const delivery = team.deliveries.get(active.deliveryId)!;
		if (!cleanup.ok) {
			this.clearActivationStopExpiry(active);
			member.lifecycle = "faulted";
			member.resourceState = "cleanup_failed";
			member.error = { code: cleanup.error?.code ?? "CLEANUP_FAILED", message: cleanup.error?.message ?? "Activation cleanup failed" };
			team.health = "needs_attention";
			if (team.lifecycle === "closing") {
				team.lifecycle = "failed";
				team.reason = "Team close activation cleanup failed";
			}
			if (scope.kind === "work") {
				const version = team.ledger.version(scope.work!);
				if (version && !isTerminalWorkState(version.state)) {
					version.state = "failed";
					version.error = { code: member.error.code, message: member.error.message, outcomeUnknown: true };
					version.updatedAt = this.timestamp();
					team.ledger.cleanupPending.add(workRefKey(scope.work!));
				}
				delete team.ledger.get(scope.work!.workId)!.stagedWait;
			}
			if (member.role === "manager") {
				this.holdManagerWork(team);
				this.pauseWorkersForManagerFault(team);
			} else if (scope.kind === "work") this.failWorkerWork(team, member, scope.work!);
			delivery.state = "unknown";
			this.createIncident(team, "CLEANUP_FAILED", `${member.id} could not confirm activation cleanup: ${member.error.message}`,
				scope.kind === "work" ? scope.work : undefined, member.id);
			this.note(team, `${member.id} activation cleanup failed`);
			member.activity = "settling";
			this.changed(team);
			this.wakeWaiters(team);
			return;
		}
		if (delivery.state === "in_flight") delivery.state = active.inputReady ? "delivered" : "unknown";
		if (scope.kind === "management") this.finishManagement(team, member, active);
		else this.finishWork(team, member, active);
		this.note(team, `${member.id} ended ${scope.kind === "work" ? shortWorkRef(scope.work!) : "management activation"}${active.intent ? ` (${active.intent.kind.replaceAll("_", " ")})` : ""}`);
		if (member.active === active) delete member.active;
		delete member.currentWork;
		member.activity = "idle";
		this.resumeParkedActivations(team);
		if (member.role === "worker" && member.lifecycle === "open" && member.pause === "requested") member.pause = "confirmed";
		if (member.lifecycle === "closing" && member.id === team.manager) member.resourceState = "stopping";
		this.changed(team);
		this.updateQuiescence(team);
		this.finishTeamCloseIfReady(team);
	}

	private finishWork(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		const ref = active.scope.work!;
		const version = team.ledger.version(ref);
		team.ledger.cleanupPending.delete(workRefKey(ref));
		if (!version) return;
		const current = team.ledger.currentRef(ref.workId);
		const entry = team.ledger.get(ref.workId)!;
		const completion = active.completion;
		const completionReason = completion?.reason ?? (active.native?.status === "success" ? "normal" : "native_failure");
		const controlledAbort = active.native?.status === "aborted"
			&& ["policy_pause", "policy_superseded", "policy_cancelled", "budget_hold"].includes(completionReason);
		if (active.native?.status !== "success" && !controlledAbort) {
			delete team.ledger.get(ref.workId)!.stagedWait;
			const error = active.native?.error ?? { code: active.native?.status === "length" ? "NATIVE_LENGTH" : "NATIVE_FAILURE",
				message: `Native activation ended with ${active.native?.status ?? "unknown"}` };
			if (!isTerminalWorkState(version.state)) {
				version.state = "failed";
				version.error = copy(error);
				version.updatedAt = this.timestamp();
			} else {
				this.createIncident(team, error.code, error.message, ref, member.id);
			}
			member.error = { code: error.code, message: error.message };
			team.health = "needs_attention";
			if (member.lifecycle !== "closing") {
				member.lifecycle = "faulted";
				member.resourceState = "owned";
				this.addEvent(team, { key: `member-fault:${member.id}:${active.scope.activationId}`, kind: "MEMBER_FAULTED", message: `${member.id} failed during native activation`, memberId: member.id, work: ref });
				if (member.role === "manager") {
					this.holdManagerWork(team);
					this.pauseWorkersForManagerFault(team);
				} else this.failWorkerWork(team, member, ref);
			}
			this.wakeWaiters(team);
			return;
		}
		if ((controlledAbort || (active.native?.status === "success" && (completionReason === "policy_pause" || completionReason === "budget_hold")))
			&& (completionReason === "policy_pause" || completionReason === "budget_hold") && !active.intent) {
			delete entry.stagedWait;
			if (current && sameWorkRef(current, ref) && version.state === "running") {
				const progress = active.native?.finalAssistantText?.trim();
				if (progress) version.checkpoint = previewText(progress, TEAM_MAX_NOTE_BYTES);
				version.updatedAt = this.timestamp();
				if (completionReason === "policy_pause") {
					version.state = "queued";
					member.pause = "confirmed";
					if (!team.ready.some((queued) => sameWorkRef(queued, ref))) team.ready.push(copy(ref));
				} else {
					const incident = this.budgetIncident(team, active.budgetStop ?? { scope: { kind: "team" }, counter: "teamModelRequests" });
					version.state = "blocked";
					version.hold = { reason: "budget", incidentId: incident.id };
				}
			}
			this.wakeWaiters(team);
			return;
		}
		if (active.stopReason) {
			if (active.intent?.kind === "reply") entry.rejectedCandidates.push({ revision: ref.revision,
				reason: active.stopReason === "superseded" ? "policy_superseded" : "policy_cancelled",
				summary: previewText(active.intent.result.summary, 512) });
			delete entry.stagedWait;
			this.wakeWaiters(team);
			return;
		}
		if (!current || !sameWorkRef(current, ref) || isTerminalWorkState(version.state)) {
			delete entry.stagedWait;
			this.wakeWaiters(team);
			return;
		}
		const intent = active.intent;
		if (intent && active.native?.appliedToolCallId !== intent.toolCallId) {
			delete team.ledger.get(ref.workId)!.stagedWait;
			this.holdWork(team, member, ref, "PROTOCOL_FAILURE", "The staged end-intent result was not confirmed in the native transcript", "protocol");
			this.wakeWaiters(team);
			return;
		}
		if (intent?.kind === "reply") {
			this.commitResult(team, member, ref, intent.result, "explicit_reply");
		} else if (intent?.kind === "yield_dependencies") {
			const record = team.ledger.get(ref.workId)!;
			delete record.stagedWait;
			version.waitingFor = intent.waitingFor.filter((dependency) => !version.observedOutcomes.some((observed) => sameWorkRef(observed, dependency)));
			version.checkpoint = intent.checkpoint;
			const allReady = version.waitingFor.every((dependency) => team.ledger.outcomeReady(dependency));
			version.state = allReady ? "queued" : "blocked";
			version.updatedAt = this.timestamp();
			if (allReady && !team.ready.some((item) => sameWorkRef(item, ref))) team.ready.push(copy(ref));
			this.updateQuiescence(team);
		} else if (intent?.kind === "yield_attention") {
			this.holdWork(team, member, ref, "WORK_HELD", intent.attention, "attention");
			version.checkpoint = intent.checkpoint;
			version.waitingFor = [];
		} else if (intent?.kind === "manager_idle") {
			version.state = "failed";
			version.error = { code: "PROTOCOL_FAILURE", message: "A work activation cannot use a management-idle intent" };
			version.updatedAt = this.timestamp();
		} else if (this.canCommitNaturalFinal(team, ref, active)) {
			const result: WorkResult = { status: "succeeded", summary: active.native!.finalAssistantText!.trim() };
			this.commitResult(team, member, ref, result, "natural_final");
		} else {
			this.holdWork(team, member, ref, "PROTOCOL_FAILURE", "Native work ended without a valid reply or yield", "protocol");
		}
		this.wakeWaiters(team);
	}

	private finishManagement(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		const intent = active.intent;
		const intentApplied = !intent || active.native?.appliedToolCallId === intent.toolCallId;
		const budgetStopped = active.native?.status === "aborted" && active.completion?.reason === "budget_hold";
		if (budgetStopped && !intent) {
			// The Manager's own budget stopped it before any decision. It stays open; the delivered batch
			// is not replayed automatically. The deduplicated budget incident drives any emergency activation.
			this.consumeBatch(team, active.scope.eventBatchId);
			this.budgetIncident(team, active.budgetStop ?? { scope: { kind: "team" }, counter: "teamModelRequests" });
			return;
		}
		// A legal end intent already confirmed in the transcript survives a later budget stop of a continuation.
		if ((active.native?.status !== "success" && !(budgetStopped && intentApplied)) || !intentApplied) {
			const closing = member.lifecycle === "closing";
			if (team.lifecycle === "closing") {
				team.lifecycle = "failed";
				team.reason = `Manager close activation lacked confirmed native evidence (status=${active.native?.status ?? "missing"}, hasIntent=${!!intent}, hasAppliedId=${!!active.native?.appliedToolCallId}, intentApplied=${intentApplied})`;
			}
			if (!closing) member.lifecycle = "faulted";
			member.error = { code: active.native?.error?.code ?? (intentApplied ? "MANAGER_FAILURE" : "PROTOCOL_FAILURE"),
				message: active.native?.error?.message ?? (intentApplied ? "Manager activation failed" : "Staged intent was not confirmed in the native transcript") };
			if (!closing) member.resourceState = "owned";
			team.health = "needs_attention";
			this.addEvent(team, { key: `manager-fault:${active.scope.activationId}`, kind: "MEMBER_FAULTED", message: "Manager activation failed; no automatic successor is available", memberId: member.id });
			this.holdManagerWork(team);
			this.pauseWorkersForManagerFault(team);
			return;
		}
		this.consumeBatch(team, active.scope.eventBatchId);
		if (active.intent?.kind === "close_team") {
			member.lifecycle = "closing";
			member.resourceState = "stopping";
			member.closeId = active.intent.closeId;
		}
	}

	private commitResult(team: TeamState, member: RuntimeMember, ref: WorkRef, result: WorkResult, source: ResultRecord["source"]): void {
		const version = team.ledger.version(ref)!;
		if (team.ledger.currentRef(ref.workId)?.revision !== ref.revision || version.state !== "running") return;
		if (Buffer.byteLength(JSON.stringify(result), "utf8") > TEAM_MAX_RESULT_BYTES) {
			this.holdWork(team, member, ref, "RESULT_TOO_LARGE", "Candidate result exceeds its reserved result slot", "protocol");
			return;
		}
		const record = team.ledger.get(ref.workId)!.record;
		const children = team.ledger.ownedChildren(ref);
		if (children.some((child) => !team.ledger.outcomeReady(child)
			|| !version.observedOutcomes.some((observed) => sameWorkRef(observed, child)))) {
			this.holdWork(team, member, ref, "UNOBSERVED_CHILD_RESULTS", "Result commit was blocked by an unobserved child outcome", "protocol");
			return;
		}
		const resultRef = this.id("result");
		const committed: ResultRecord = { id: resultRef, work: copy(ref), author: member.id, result: copy(result), committedAt: this.timestamp(), source };
		if (!this.tryJournal(team, { version: 2, kind: "result", teamId: team.id, at: committed.committedAt, result: copy(committed) })) {
			// Never publish an unjournaled result; the Team is failed closed at the end of this transition.
			version.state = "failed";
			version.error = { code: "JOURNAL_FAILURE", message: `Result could not be journaled: ${team.journalFailure}`, outcomeUnknown: true };
			version.updatedAt = committed.committedAt;
			return;
		}
		team.ledger.commitResult(committed);
		this.note(team, `${member.id} ${result.status} result for ${shortWorkRef(ref)}`);
		version.resultRef = resultRef;
		version.state = "resolved";
		if (result.status === "failed") version.error = { code: "BUSINESS_FAILED", message: result.summary };
		else delete version.error;
		version.updatedAt = committed.committedAt;
		if (!record.parent) this.addEvent(team, { key: `root-result:${workRefKey(ref)}:${resultRef}`, kind: "ROOT_RESULT_READY",
			message: `Root work ${workRefKey(ref)} has a committed ${result.status} result ${resultRef} from ${member.id}, in full below; review it and accept_result or waive it without a status call:\n\n${formatWorkResult(result)}`, work: ref, resultRef });
		this.wakeWaiters(team);
	}

	/** Host display milestone (wall clock, so the injectable Runtime clock is unaffected); bounded, keeping the launch line. */
	private note(team: TeamState, text: string): void {
		team.timeline.push({ at: Date.now(), text });
		if (team.timeline.length > TEAM_MAX_TIMELINE) {
			team.timeline.splice(1, 1);
			team.timelineOmitted++;
		}
	}

	/** Tell the Manager which roots already run from initialRequests, so it never requests them again. */
	private bootMessage(team: TeamState): string {
		const initial = team.ledger.order.map((id) => team.ledger.get(id)!.record);
		const outcomeRule = "Every root must end accepted with a succeeded result (close succeeded) or waived (close partial), so request only work you need; "
			+ "close_team itself closes idle workers.";
		if (!initial.length) {
			return `Team is active. No work is assigned yet: request work from workers per the brief, then yield. ${outcomeRule} Close explicitly.`;
		}
		const assigned = initial.map((record) => `${record.assignee} ${workRefKey({ workId: record.id, revision: record.currentRevision })} "${previewText(currentVersion(record).task, 160)}"`);
		return `Team is active. ${initial.length} initial request(s) are already assigned and run without Manager action: ${assigned.join("; ")}. `
			+ `Do not request them again; each root result arrives as an event. ${outcomeRule} Close explicitly.`;
	}

	private canCommitNaturalFinal(team: TeamState, ref: WorkRef, active: ActiveActivation): boolean {
		const text = active.native?.finalAssistantText;
		if (!active.inputReady || active.native?.status !== "success" || active.native.pendingToolCalls || typeof text !== "string" || !text.trim()) return false;
		const candidate: WorkResult = { status: "succeeded", summary: text.trim() };
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > TEAM_MAX_RESULT_BYTES) return false;
		const version = team.ledger.version(ref);
		if (!version) return false;
		return team.ledger.ownedChildren(ref).every((child) => team.ledger.outcomeReady(child)
			&& version.observedOutcomes.some((observed) => sameWorkRef(observed, child)));
	}

	/** A terminal dependency whose external side effects are not known to have ended (spec 13.3/13.5). */
	private isUnknownOutcome(team: TeamState, ref: WorkRef): boolean {
		const version = team.ledger.version(ref);
		return !!version && isTerminalWorkState(version.state) && version.error?.outcomeUnknown === true;
	}

	/** Unobserved, unacknowledged outcome-unknown waits and owned children of one consumer version. */
	private unknownDependencies(team: TeamState, ref: WorkRef, version: WorkVersion): WorkRef[] {
		const seen = new Set<string>();
		return [...version.waitingFor, ...team.ledger.ownedChildren(ref)].filter((dependency) => {
			const key = workRefKey(dependency);
			if (seen.has(key)) return false;
			seen.add(key);
			return this.isUnknownOutcome(team, dependency) && !version.observedOutcomes.some((observed) => sameWorkRef(observed, dependency))
				&& !team.unknownAcknowledged.has(`${workRefKey(ref)}>${key}`);
		});
	}

	/**
	 * An outcome-unknown dependency never wakes its consumer automatically: every waiting consumer or
	 * owned-child parent that is not running gets one stable DEPENDENCY_UNAVAILABLE incident and an
	 * attention hold that only an explicit resume_work/release_hold can lift.
	 */
	private holdUnknownDependencies(team: TeamState): void {
		for (const id of team.ledger.order) {
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if ((version.state !== "queued" && version.state !== "blocked") || version.hold) continue;
			const unknown = this.unknownDependencies(team, ref, version);
			if (!unknown.length) continue;
			const incident = this.createIncident(team, "DEPENDENCY_UNAVAILABLE",
				`Dependency outcome is unknown (${unknown.map(workRefKey).join(", ")}); an explicit resume or cancel decision is required`,
				ref, team.ledger.get(id)!.record.assignee);
			version.state = "blocked";
			version.hold = { reason: "attention", incidentId: incident.id };
			version.updatedAt = this.timestamp();
			team.ready = team.ready.filter((item) => !sameWorkRef(item, ref));
			this.changed(team);
		}
	}

	private wakeWaiters(team: TeamState): void {
		this.holdUnknownDependencies(team);
		for (const id of team.ledger.order) {
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if (version.state !== "blocked" || version.hold || !version.waitingFor.length) continue;
			if (!version.waitingFor.every((waited) => team.ledger.outcomeReady(waited))) continue;
			version.state = "queued";
			version.updatedAt = this.timestamp();
			if (!team.ready.some((item) => sameWorkRef(item, ref))) team.ready.push(copy(ref));
		}
		this.updateQuiescence(team);
	}

	private updateQuiescence(team: TeamState): void {
		if (!team.bootProcessed || team.lifecycle !== "active" || [...team.members.values()].some((member) => member.active)) return;
		if (team.ledger.order.some((id) => !isTerminalWorkState(team.ledger.current(id)!.state)
			&& team.ledger.current(id)!.state !== "blocked")) return;
		const signature = team.ledger.order.map((id) => {
			const record = team.ledger.get(id)!.record;
			const version = currentVersion(record);
			return `${id}@${record.currentRevision}:${version.state}:${version.hold?.incidentId ?? ""}:${version.resultRef ?? ""}:${version.review?.disposition ?? ""}:${version.review?.reason ?? ""}`;
		}).join("|");
		this.addEvent(team, { key: `quiescent:${signature}`, kind: "TEAM_QUIESCENT", message: "No work is runnable; review blocked work or decide whether to close", });
	}

	private cancelDescendants(team: TeamState, ref: WorkRef, state: "cancelled" | "superseded", unknownActiveOutcome = false): void {
		for (const child of team.ledger.openSubtree(ref)) {
			const version = team.ledger.version(child)!;
			const member = team.members.get(team.ledger.get(child.workId)!.record.assignee)!;
			const active = member.active?.scope.kind === "work" && sameWorkRef(member.active.scope.work!, child);
			version.state = state;
			version.waitingFor = [];
			this.dropHold(team, version);
			version.updatedAt = this.timestamp();
			version.error = { code: state.toUpperCase(), message: `Parent work ${workRefKey(ref)} was ${state}`,
				...(unknownActiveOutcome && active ? { outcomeUnknown: true } : {}) };
			delete team.ledger.get(child.workId)!.stagedWait;
			if (active) {
				member.active!.stopReason = state;
				team.ledger.cleanupPending.add(workRefKey(child));
				this.requestActivationStop(team, member, state === "superseded" ? "policy_superseded" : "policy_cancelled");
			}
			team.ready = team.ready.filter((queued) => !sameWorkRef(queued, child));
		}
	}

	private stopMemberWork(team: TeamState, member: RuntimeMember, reason: string): void {
		for (const id of team.ledger.order) {
			const entry = team.ledger.get(id)!;
			const record = entry.record;
			if (record.assignee !== member.id && record.requester !== member.id) continue;
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if (isTerminalWorkState(version.state)) continue;
			const activeMember = team.members.get(record.assignee)!;
			const active = activeMember.active?.scope.kind === "work" && sameWorkRef(activeMember.active.scope.work!, ref);
			const assignedToStoppedMember = record.assignee === member.id;
			version.state = assignedToStoppedMember ? "failed" : "cancelled";
			version.error = { code: "MEMBER_UNAVAILABLE", message: `${member.id} stopped by the host: ${reason}`,
				...(active ? { outcomeUnknown: true } : {}) };
			version.waitingFor = [];
			delete version.hold;
			version.updatedAt = this.timestamp();
			delete entry.stagedWait;
			team.ready = team.ready.filter((queued) => !sameWorkRef(queued, ref));
			if (active) {
				activeMember.active!.stopReason = "cancelled";
				team.ledger.cleanupPending.add(workRefKey(ref));
				this.requestActivationStop(team, activeMember, "policy_cancelled");
			}
			this.cancelDescendants(team, ref, "cancelled", true);
		}
	}

	private failWorkerWork(team: TeamState, member: RuntimeMember, failedRef: WorkRef): void {
		this.cancelDescendants(team, failedRef, "cancelled");
		for (const id of team.ledger.order) {
			const entry = team.ledger.get(id)!;
			if (entry.record.assignee !== member.id) continue;
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if (isTerminalWorkState(version.state)) continue;
			version.state = "failed";
			version.waitingFor = [];
			delete version.hold;
			version.error = { code: "MEMBER_UNAVAILABLE", message: `${member.id} faulted before this work could finish` };
			version.updatedAt = this.timestamp();
			delete entry.stagedWait;
			team.ready = team.ready.filter((queued) => !sameWorkRef(queued, ref));
			this.cancelDescendants(team, ref, "cancelled");
		}
	}

	private pauseWorkersForManagerFault(team: TeamState): void {
		for (const member of team.members.values()) {
			if (member.role !== "worker" || member.lifecycle !== "open" || member.pause !== "none") continue;
			member.pause = member.active ? "requested" : "confirmed";
			this.changed(team);
		}
	}

	private holdManagerWork(team: TeamState): void {
		for (const id of team.ledger.order) {
			const entry = team.ledger.get(id)!;
			if (entry.record.assignee !== team.manager) continue;
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if (isTerminalWorkState(version.state)) continue;
			const incident = this.createIncident(team, "MANAGER_UNAVAILABLE", "Manager is unavailable; host cancellation or a new Team is required", ref, team.manager);
			version.state = "blocked";
			version.waitingFor = [];
			version.hold = { reason: "manager_unavailable", incidentId: incident.id };
			version.updatedAt = this.timestamp();
			delete entry.stagedWait;
			team.ready = team.ready.filter((queued) => !sameWorkRef(queued, ref));
		}
	}

	private holdForBudget(team: TeamState, ref: WorkRef, exhausted: BudgetExhaustion): void {
		const version = team.ledger.version(ref)!;
		if (version.state !== "queued") return;
		const incident = this.budgetIncident(team, exhausted);
		version.state = "blocked";
		version.hold = { reason: "budget", incidentId: incident.id };
		version.updatedAt = this.timestamp();
		team.ready = team.ready.filter((item) => !sameWorkRef(item, ref));
	}

	/** Ending held work (cancel, revise) is the Manager's answer to its attention/protocol incident. */
	private dropHold(team: TeamState, version: WorkVersion): void {
		if (version.hold?.reason === "attention" || version.hold?.reason === "protocol") this.resolveIncident(team, version.hold.incidentId);
		delete version.hold;
	}

	private resolveIncident(team: TeamState, incidentId: string): void {
		const incident = team.incidents.find((item) => item.id === incidentId);
		if (incident) incident.state = "resolved";
		// Faults and stopped members keep the Team flagged; only answered incidents clear it.
		if (!team.incidents.some((item) => item.state === "open") && ![...team.members.values()].some((member) => member.error)) team.health = "ok";
	}

	/** Hold a work version for a Manager decision, announced as WORK_HELD (answered by resume_work, revise or cancel). */
	private holdWork(team: TeamState, member: RuntimeMember, ref: WorkRef, code: string, message: string, reason: "attention" | "protocol"): void {
		const incident = this.createIncident(team, code, message, ref, member.id, undefined, "WORK_HELD");
		const version = team.ledger.version(ref)!;
		version.state = "blocked";
		version.hold = { reason, incidentId: incident.id };
		version.updatedAt = this.timestamp();
	}

	private createIncident(team: TeamState, code: string, message: string, work?: WorkRef, memberId?: string, scopeRootId?: string,
		kind: ManagerEventView["kind"] = code === "BUDGET_HIT" || code === "DEPENDENCY_UNAVAILABLE" ? code : "MEMBER_FAULTED"): TeamIncidentView {
		const rootId = work ? team.ledger.get(work.workId)?.record.rootId : scopeRootId;
		const current = team.incidents.find((incident) => incident.state === "open" && incident.code === code
			&& incident.memberId === memberId && incident.rootId === rootId && (incident.work ? work && sameWorkRef(incident.work, work) : !work));
		if (current) return current;
		const incident: TeamIncidentView = { id: this.id("incident"), code, message, state: "open", createdAt: this.timestamp(),
			...(work ? { work: copy(work) } : {}), ...(rootId ? { rootId } : {}), ...(memberId ? { memberId } : {}) };
		team.incidents.push(incident);
		this.addEvent(team, { key: `incident:${incident.id}`, kind, message, ...(work ? { work: copy(work) } : {}), ...(memberId ? { memberId } : {}), incidentId: incident.id });
		team.health = "needs_attention";
		return incident;
	}

	private addEvent(team: TeamState, event: Omit<InternalEvent, "id" | "processed">): InternalEvent {
		const duplicate = team.events.find((item) => item.key === event.key);
		if (duplicate) return duplicate;
		const created: InternalEvent = { ...event, id: this.id("event"), processed: false };
		team.events.push(created);
		team.eventSeq++;
		this.changed(team);
		return created;
	}

	private consumeBatch(team: TeamState, batchId: string | undefined): void {
		if (!batchId) return;
		const batch = team.eventBatches.get(batchId);
		if (!batch) return;
		for (const id of batch.eventIds) {
			const event = team.events.find((item) => item.id === id);
			if (event) {
				if (event.kind === "BOOT") team.bootProcessed = true;
				event.processed = true;
				delete event.batchId;
			}
		}
		team.eventBatches.delete(batchId);
	}

	private finishTeamCloseIfReady(team: TeamState): void {
		if (team.lifecycle !== "closing" || !team.closeDecision) return;
		if ([...team.members.values()].some((member) => member.id === team.manager
			? member.lifecycle !== "closed" || member.resourceState !== "released"
			: !((member.lifecycle === "closed" || member.lifecycle === "faulted") && member.resourceState === "released"))) return;
		team.lifecycle = "closed";
		this.clearDeadline(team.id);
		team.outcome = team.closeDecision.outcome;
		if (team.closeDecision.reason) team.reason = team.closeDecision.reason;
		else delete team.reason;
		this.changed(team);
		this.settleCompletion(team);
	}

	private requestDrain(teamId: string): void {
		if (!this.executors.has(teamId) || this.scheduledDrains.has(teamId)) return;
		this.scheduledDrains.add(teamId);
		queueMicrotask(() => {
			this.scheduledDrains.delete(teamId);
			this.drainEffects(teamId);
		});
	}

	private drainEffects(teamId: string): void {
		const executor = this.executors.get(teamId);
		if (!executor) return;
		const team = this.teams.get(teamId);
		if (!team) return;

		if (team.lifecycle === "active") {
			this.resumeParkedActivations(team);
			for (let count = 0; count < team.limits.workerPermits + 1; count++) {
				const activation = this.reserveNextActivation(teamId);
				if (!activation) break;
				void Promise.resolve().then(() => executor.runActivation(activation)).catch((error: unknown) => {
					try {
						this.activationEffectFailed(teamId, activation, error);
					} catch (reportError) {
						const effectMessage = error instanceof Error ? error.message : String(error);
						const reportMessage = reportError instanceof Error ? reportError.message : String(reportError);
						this.recordEffectFailure(teamId, activation.binding.memberId, "activation cleanup report",
							new AggregateError([error, reportError], `Native activation effect failed (${effectMessage}); Runtime cleanup report failed (${reportMessage})`));
					}
				});
			}
		}

		// close_team must not stop even an idle worker until the Manager's own final activation
		// has crossed native settlement and cleanup. Individual close_member remains independent.
		const manager = team.members.get(team.manager)!;
		if (team.lifecycle === "closing" && manager.active) return;
		for (const member of team.members.values()) {
			if ((member.lifecycle !== "closing" && member.lifecycle !== "faulted") || member.resourceState !== "stopping"
				|| member.active || !member.closeId) continue;
			const effectKey = `${teamId}\0${member.id}\0${member.closeId}`;
			if (this.closingEffects.has(effectKey)) continue;
			this.closingEffects.add(effectKey);
			const binding = this.binding(team, member);
			void this.executeCloseEffect(executor, binding, member.closeId!, effectKey)
				.catch((error: unknown) => this.recordEffectFailure(teamId, member.id, "member exit effect", error));
		}
	}

	private async executeCloseEffect(executor: TeamRuntimeExecutor, binding: BindingV2, closeId: string, effectKey: string): Promise<void> {
		try {
			let result: CleanupCompletion;
			try {
				// The transport owns bounded stop/exit confirmation. An outer activation-stop timer
				// can discard a later confirmed exit after the driver has already released its handle.
				result = await executor.closeMember(binding, closeId);
			} catch (error) {
				result = { ok: false, error: { code: "CLEANUP_FAILED", message: error instanceof Error ? error.message : String(error), outcomeUnknown: true } };
			}
			try {
				const reply = this.memberReleased(binding, closeId, result);
				if (result.ok && !reply.ok) throw new Error(reply.error.message);
			} catch (error) {
				this.failRuntimeEffect(binding.teamId, binding.memberId, "member exit report", error);
			}
		} catch (error) {
			this.failRuntimeEffect(binding.teamId, binding.memberId, "member exit", error);
		} finally {
			this.closingEffects.delete(effectKey);
			this.requestDrain(binding.teamId);
			const team = this.teams.get(binding.teamId);
			if (team) this.settleCompletion(team);
		}
	}

	private activationEffectFailed(teamId: string, activation: RuntimeActivation, error: unknown): void {
		const team = this.teams.get(teamId);
		const member = team?.members.get(activation.binding.memberId);
		const active = member?.active;
		if (team && member && active && sameScope(active.scope, activation.scope)) {
			const message = error instanceof Error ? error.message : String(error);
			if (active.native && !active.cleanup) {
				this.cleanupFinished(activation.binding, activation.scope.activationId, {
					ok: false, error: { code: "CLEANUP_FAILED", message, outcomeUnknown: true },
				});
			} else if (!active.native) {
				this.activationLost(activation.binding, activation.scope.activationId,
					{ code: "DRIVER_FAILURE", message, outcomeUnknown: true }, false);
			}
		}
		this.requestDrain(teamId);
		if (team) this.settleCompletion(team);
	}

	private failRuntimeEffect(teamId: string, memberId: string, phase: string, error: unknown): void {
		const team = this.teams.get(teamId);
		if (!team) return;
		const member = team.members.get(memberId);
		const detail = error instanceof Error ? error.message : String(error);
		const message = `Runtime ${phase} processing failed: ${detail}`;
		if (member) {
			if (member.lifecycle !== "closed" || member.resourceState !== "released") {
				member.lifecycle = "faulted";
				member.resourceState = "cleanup_failed";
			}
			member.error = { code: "RUNTIME_EFFECT_FAILURE", message };
		}
		team.lifecycle = "failed";
		team.health = "needs_attention";
		team.reason = message;
		this.changed(team);
		this.requestDrain(teamId);
		this.settleCompletion(team);
	}

	private recordEffectFailure(teamId: string, memberId: string, phase: string, error: unknown): void {
		try {
			this.failRuntimeEffect(teamId, memberId, phase, error);
		} catch (reportError) {
			const team = this.teams.get(teamId);
			if (!team) return;
			const detail = (value: unknown) => value instanceof Error ? value.message : String(value);
			const message = `Runtime ${phase} failed (${detail(error)}); fail-closed reporting also failed (${detail(reportError)})`;
			const member = team.members.get(memberId);
			if (member && !(member.lifecycle === "closed" && member.resourceState === "released")) {
				member.lifecycle = "faulted";
				member.resourceState = "cleanup_failed";
				member.error = { code: "RUNTIME_EFFECT_FAILURE", message };
			}
			team.lifecycle = "failed";
			team.health = "needs_attention";
			team.reason = message;
			team.stateVersion++;
			try { this.requestDrain(teamId); }
			catch (drainError) { team.reason += `; Runtime could not resume effect drain: ${detail(drainError)}`; }
			try { this.settleCompletion(team); }
			catch (settleError) { team.reason += `; Runtime could not settle Team lifetime: ${detail(settleError)}`; }
		}
	}

	private settleCompletion(team: TeamState): void {
		if (!this.completionReady(team)) return;
		if (!team.terminalJournaled) {
			team.terminalJournaled = true;
			this.note(team, `Team ${team.lifecycle}${team.outcome ? ` · outcome ${team.outcome}` : ""}`);
			const terminal = this.getTeamResult(team.id);
			// A closed success is only reported once its terminal history is written.
			if (terminal && !this.tryJournal(team, { version: 2, kind: "terminal", teamId: team.id, at: this.timestamp(),
				...(team.closeDecision ? { closeId: team.closeDecision.id } : {}), result: terminal })) {
				this.applyJournalFailure(team);
			}
		}
		const result = this.getTeamResult(team.id);
		if (!result) return;
		const waiters = this.completionWaiters.get(team.id);
		if (!waiters) return;
		this.completionWaiters.delete(team.id);
		this.clearDeadline(team.id);
		for (const resolve of waiters) resolve(copy(result));
	}

	private completionReady(team: TeamState): boolean {
		return TERMINAL_TEAM_LIFECYCLES.includes(team.lifecycle)
			&& ![...team.members.values()].some((member) => {
				if (TERMINAL_TEAM_LIFECYCLES.includes(team.lifecycle) && team.lifecycle !== "closed"
					&& member.lifecycle === "faulted" && member.resourceState === "cleanup_failed") return false;
				return member.active !== undefined || member.lifecycle === "closing" || member.resourceState === "stopping";
			})
			&& ![...this.closingEffects].some((key) => key.startsWith(`${team.id}\0`));
	}

	private requireWorkScope(team: TeamState, member: RuntimeMember, active: ActiveActivation): WorkRef {
		if (active.scope.kind !== "work" || !active.scope.work) fail("WORK_NOT_RUNNING", "This activation has no business work");
		const ref = active.scope.work;
		const record = team.ledger.get(ref.workId)?.record;
		const version = team.ledger.version(ref);
		if (!record || !version) fail("UNKNOWN_WORK", `Unknown work ${workRefKey(ref)}`);
		if (record.assignee !== member.id) fail("WRONG_WORK_OWNER", `Work ${workRefKey(ref)} is assigned to ${record.assignee}`);
		if (record.currentRevision !== ref.revision || version.state !== "running") fail("STALE_REVISION", `Work ${workRefKey(ref)} is no longer current and running`);
		return ref;
	}

	private requireScope(member: RuntimeMember, scope: ActivationScope): ActiveActivation {
		const active = member.active;
		if (!active || !sameScope(active.scope, scope)) fail("WORK_NOT_RUNNING", "Activation scope does not match the member's current activation");
		return active;
	}

	private authenticatedMember(binding: BindingV2): RuntimeMember {
		const team = this.team(binding.teamId);
		const member = team.members.get(binding.memberId);
		if (!member || member.epoch !== binding.epoch || member.role !== binding.role) fail("PROTOCOL_FAILURE", "Binding does not match a member lifetime");
		return member;
	}

	private validateBinding(value: BindingV2): BindingV2 {
		return parseBinding(value);
	}

	private validateScope(value: ActivationScope): ActivationScope {
		return parseActivationScope(value);
	}

	private binding(team: TeamState, member: RuntimeMember): BindingV2 {
		return { version: TEAM_PROTOCOL_VERSION, teamId: team.id, memberId: member.id, role: member.role, epoch: member.epoch };
	}

	private makeWork(requester: string, assignee: string, task: string, inputRefs: string[], parent: WorkRef | undefined, at: number, rootId?: string, depth = 0): WorkRecord {
		const id = this.id("work");
		const version = this.makeVersion(1, task, inputRefs, at);
		return { id, requester, assignee, rootId: rootId ?? id, ...(parent ? { parent: copy(parent) } : {}), depth, currentRevision: 1, versions: [version] };
	}

	private makeVersion(revision: number, task: string, inputRefs: string[], at: number): WorkVersion {
		return { revision, task, inputRefs: copy(inputRefs), state: "queued", waitingFor: [], observedOutcomes: [], createdAt: at, updatedAt: at };
	}

	private assertInputFits(team: TeamState, member: RuntimeMember, work: WorkRecord, parent?: WorkRef): void {
		const version = currentVersion(work);
		const scope: ActivationInput["scope"] = {
			kind: "work", work: { workId: work.id, revision: work.currentRevision }, task: version.task,
			requester: work.requester, rootId: work.rootId, ...(parent ? { parent } : {}), depth: work.depth, inputRefs: version.inputRefs, waitingFor: version.waitingFor,
		};
		this.previewInput(team, member, `input-check:${work.id}`, scope);
	}

	private previewInput(team: TeamState, member: RuntimeMember, deliveryId: string, scope: ActivationInput["scope"]): ActivationInput {
		const input: ActivationInput = {
			version: TEAM_PROTOCOL_VERSION, teamId: team.id, deliveryId,
			member: { id: member.id, role: member.role, roleDescription: member.roleDescription }, brief: copy(team.plan.brief),
			roster: [...team.members.values()].map((item) => ({ id: item.id, role: item.role, lifecycle: item.lifecycle, rolePreview: previewText(item.roleDescription, 512) })),
			scope, outcomes: [], omittedOutcomes: 0, ownedChildren: [],
			// Size check only: the largest possible budget summary.
			budget: { emergency: false, modelRequests: Number.MAX_SAFE_INTEGER, toolCalls: Number.MAX_SAFE_INTEGER, activations: Number.MAX_SAFE_INTEGER },
			notice: WORK_NOTICE,
		};
		try { encodeActivationInput(input); } catch (error) {
			if (error instanceof TeamProtocolError) fail("INPUT_BUDGET_EXCEEDED", `Required Team input cannot fit: ${error.message}`);
			throw error;
		}
		return input;
	}

	private previousVersion(team: TeamState, ref: WorkRef): NonNullable<Extract<ActivationInput["scope"], { kind: "work" }> ["previous"]> {
		const previous = team.ledger.version({ workId: ref.workId, revision: ref.revision - 1 })!;
		return { revision: previous.revision, state: previous.state, ...(previous.checkpoint ? { checkpoint: previous.checkpoint } : {}),
			...(previous.resultRef ? { resultRef: previous.resultRef } : {}), ...(previous.error ? { error: projectWorkError(previous.error) } : {}) };
	}

	private workSummaries(team: TeamState): TeamWorkSummary[] {
		return team.ledger.order.map((id) => {
			const record = team.ledger.get(id)!.record;
			const version = currentVersion(record);
			return { work: { workId: id, revision: record.currentRevision }, requester: record.requester, assignee: record.assignee,
				...(record.parent ? { parent: copy(record.parent) } : {}),
				state: version.state, taskPreview: previewText(version.task, 512), ...(version.hold ? { hold: version.hold.reason } : {}),
				...(version.resultRef ? { resultRef: version.resultRef } : {}), ...(version.review ? { review: version.review.disposition } : {}) };
		});
	}

	private resultSummaries(team: TeamState): Array<{ id: string; work: WorkRef; author: string; status: WorkResult["status"]; summaryPreview: string }> {
		return team.ledger.resultOrder.map((id) => {
			const result = team.ledger.results.get(id)!;
			return { id, work: copy(result.work), author: result.author, status: result.result.status, summaryPreview: previewText(result.result.summary, 512) };
		});
	}

	private cursorOffset(cursor: string): number {
		const match = /^page:(0|[1-9][0-9]*)$/u.exec(cursor);
		if (!match) fail("INVALID_ARGUMENT", "Invalid status cursor");
		const value = Number(match[1]);
		if (!Number.isSafeInteger(value)) fail("INVALID_ARGUMENT", "Invalid status cursor");
		return value;
	}

	private cacheAction(active: ActiveActivation, key: string, fingerprint: string, reply: TeamReply): void {
		while (active.cache.size >= 128) {
			const oldest = active.cache.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			active.cache.delete(oldest);
		}
		active.cache.set(key, { fingerprint, reply: copy(reply) });
	}

	private repeatOrRejectIntent(team: TeamState, member: RuntimeMember, active: ActiveActivation, action: TeamAction, toolCallId: string): TeamReply {
		const current = active.intent!;
		if (current.toolCallId !== toolCallId) fail("INTENT_CONFLICT", "An end intent from a different tool call is already staged");
		if (action.action === "reply" && current.kind === "reply" && active.scope.kind === "work"
			&& canonicalJson({ ...current, toolCallId: "" }) === canonicalJson({ kind: "reply", work: active.scope.work, result: action.result, toolCallId: "" })) {
			return okReply(member.id, { receipt: { status: "staged", intent: "reply", work: active.scope.work! } });
		}
		if (action.action === "yield") {
			const expected: EndIntent | undefined = active.scope.kind === "management"
				? action.waitingFor.length === 0 && action.attention === undefined
					? { kind: "manager_idle", ...(action.checkpoint ? { checkpoint: action.checkpoint } : {}), toolCallId }
					: undefined
				: action.attention !== undefined && action.checkpoint
					? { kind: "yield_attention", work: active.scope.work!, attention: action.attention, checkpoint: action.checkpoint, toolCallId }
					: action.waitingFor.length && action.checkpoint
						? { kind: "yield_dependencies", work: active.scope.work!, waitingFor: action.waitingFor, checkpoint: action.checkpoint, toolCallId }
						: undefined;
			if (expected && canonicalJson(current) === canonicalJson(expected)) {
				return okReply(member.id, { receipt: { status: "staged", intent: current.kind, ...(current.kind === "yield_attention" || current.kind === "yield_dependencies" ? { work: current.work } : {}) } });
			}
		}
		if (action.action === "control" && action.control.command === "close_team" && current.kind === "close_team"
			&& team.closeDecision && canonicalJson({ resultRefs: action.control.resultRefs, outcome: action.control.outcome, reason: action.control.reason })
				=== canonicalJson({ resultRefs: team.closeDecision.resultRefs, outcome: team.closeDecision.outcome, reason: team.closeDecision.reason })) {
			return okReply(member.id, { receipt: { status: "closing", command: "close_team", closeId: current.closeId } });
		}
		fail("INTENT_CONFLICT", "The same tool call attempted a conflicting end intent");
	}

	private view(team: TeamState): TeamTeamView {
		const current = team.ledger.order.map((id) => currentVersion(team.ledger.get(id)!.record));
		const members: TeamMemberView[] = [...team.members.values()].map((member) => ({
			id: member.id, role: member.role, roleDescription: member.roleDescription, lifecycle: member.lifecycle,
			activity: member.activity, pause: member.pause, ...(member.currentWork ? { currentWork: copy(member.currentWork) } : {}),
			resourceState: member.resourceState,
			...(member.error ? { error: projectWorkError(member.error) } : {}),
			queued: current.filter((version, index) => version.state === "queued" && team.ledger.get(team.ledger.order[index]!)!.record.assignee === member.id).length,
			blocked: current.filter((version, index) => version.state === "blocked" && team.ledger.get(team.ledger.order[index]!)!.record.assignee === member.id).length,
			held: current.filter((version, index) => !!version.hold && team.ledger.get(team.ledger.order[index]!)!.record.assignee === member.id).length,
			policy: copy(member.policy),
			usage: copy(member.usage),
		}));
		const roots = team.ledger.order.map((id) => team.ledger.get(id)!.record).filter((record) => !record.parent);
		const used: TeamBudgetView["used"] = { teamWorks: team.ledger.order.length, ...team.budget.used, reservedResultBytes: team.reservedResultBytes };
		const rootChildren = (rootId: string) => this.rootChildCount(team, rootId);
		// Bounded summaries (one private reply frame): exhausted, then granted, then used roots; untouched
		// roots show the Team-wide default limits. Open incidents first, then the newest resolved ones.
		const budgetRoots = roots.map((record) => team.budget.rootView(record.id, rootChildren(record.id)))
			.map((root) => ({ root, exhausted: team.budget.rootExhausted(root.rootId) !== undefined,
				granted: ROOT_GRANTABLE_COUNTERS.some((counter) => root.limits[counter] !== team.limits[counter]) }))
			.filter(({ root, exhausted, granted }) => exhausted || granted || Object.values(root.used).some((value) => value > 0));
		const rank = ({ exhausted, granted }: { exhausted: boolean; granted: boolean }) => exhausted ? 0 : granted ? 1 : 2;
		const shownRoots = budgetRoots.map((item, index) => ({ ...item, index }))
			.sort((left, right) => rank(left) - rank(right) || left.index - right.index)
			.slice(0, TEAM_VIEW_MAX_BUDGET_ROOTS).map(({ root }) => root);
		const open = team.incidents.filter((incident) => incident.state === "open");
		const selected = new Set([...open.slice(-TEAM_VIEW_MAX_INCIDENTS),
			...team.incidents.filter((incident) => incident.state !== "open").slice(-Math.max(0, TEAM_VIEW_MAX_INCIDENTS - open.length))]);
		const incidents = team.incidents.filter((incident) => selected.has(incident));
		return {
			version: TEAM_PROTOCOL_VERSION, teamId: team.id, lifecycle: team.lifecycle, health: team.health, stateVersion: team.stateVersion,
			eventSeq: team.eventSeq, manager: team.manager, timeoutSeconds: team.plan.timeoutSeconds, deadline: team.deadline, brief: copy(team.plan.brief), members,
			works: { total: current.length, queued: current.filter((version) => version.state === "queued").length,
				running: current.filter((version) => version.state === "running").length,
				blocked: current.filter((version) => version.state === "blocked").length,
				held: current.filter((version) => !!version.hold).length,
				resolved: current.filter((version) => version.state === "resolved").length,
				failed: current.filter((version) => version.state === "failed").length,
				cancelled: current.filter((version) => version.state === "cancelled" || version.state === "superseded").length,
				roots: roots.length, rootsReviewed: roots.filter((record) => !!currentVersion(record).review).length },
			incidents: incidents.map(incidentView), incidentsOmitted: team.incidents.length - incidents.length,
			budget: { limits: copy(team.limits), used,
				exhausted: team.budget.teamExhausted(false) !== undefined || team.ledger.order.length >= team.limits.teamWorks
					|| team.reservedResultBytes >= team.limits.reservedResultBytes,
				roots: shownRoots, rootsOmitted: budgetRoots.length - shownRoots.length,
				grants: copy(team.budget.grants.slice(-TEAM_VIEW_MAX_GRANTS)), grantsOmitted: Math.max(0, team.budget.grants.length - TEAM_VIEW_MAX_GRANTS) },
			usage: copy(team.usage),
			...(team.outcome ? { outcome: team.outcome } : {}), ...(team.reason ? { reason: projectErrorText(team.reason) } : {}),
		};
	}

	private newId(): string { return this.createId(); }
	private id(kind: string): string {
		const id = `${this.newId()}:${kind}:${this.createId()}`;
		if (id.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) fail("TEAM_CAPACITY", "ID generator returned an invalid identifier");
		return id;
	}
	private validOpaqueId(value: string, field: string): string {
		if (typeof value !== "string" || value.length < 1 || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail("PROTOCOL_FAILURE", `${field} is invalid`);
		return value;
	}
	private hostId(value: string, field: string): string {
		if (typeof value !== "string" || value.length < 1 || value.length > TEAM_MAX_ID_LENGTH
			|| !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail("INVALID_ARGUMENT", `${field} is invalid`);
		return value;
	}
	private hostText(value: string, field: string): string {
		if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > TEAM_MAX_NOTE_BYTES) {
			fail("INVALID_ARGUMENT", `${field} must be non-empty and within the Team note limit`);
		}
		return value.trim();
	}
	private validUsage(usage: SubagentUsage): void {
		if (!this.isValidUsage(usage)) fail("PROTOCOL_FAILURE", "Native usage must contain finite non-negative counters");
	}

	private isValidUsage(usage: SubagentUsage): boolean {
		if (!usage || typeof usage !== "object") return false;
		return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost, usage.contextTokens, usage.turns, usage.searches ?? 0]
			.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
	}

	private foldUsage(team: TeamState, member: RuntimeMember, usage: SubagentUsage): void {
		addActivationUsage(team.usage, usage);
		addActivationUsage(member.usage, usage);
	}
	private hostWorkRef(value: WorkRef): WorkRef {
		if (!value || typeof value !== "object" || typeof value.workId !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
			fail("INVALID_ARGUMENT", "Host WorkRef is invalid");
		}
		return { workId: this.hostId(value.workId, "workId"), revision: value.revision };
	}
	private timestamp(): number {
		const value = this.now();
		if (!Number.isFinite(value) || value < 0) fail("PROTOCOL_FAILURE", "Runtime clock returned an invalid timestamp");
		return value;
	}
	private team(id: string): TeamState {
		const team = this.teams.get(id);
		if (!team) fail("UNKNOWN_WORK", `Unknown Team ${id}`);
		return team;
	}
	private changed(team: TeamState): void {
		team.stateVersion++;
		if (!this.changeListeners.size) return;
		const first = this.pendingNotifications.size === 0;
		this.pendingNotifications.add(team.id);
		if (first) queueMicrotask(() => this.flushChanges());
	}

	private flushChanges(): void {
		const teamIds = [...this.pendingNotifications];
		this.pendingNotifications.clear();
		for (const teamId of teamIds) {
			for (const listener of [...this.changeListeners]) {
				try { listener(teamId); } catch { /* An observer failure never affects Team state. */ }
			}
		}
	}

	private check(team: TeamState): void {
		const ready = new Set<string>();
		for (const ref of team.ready) {
			const key = workRefKey(ref);
			if (ready.has(key)) throw new Error(`Invariant I14: duplicate ready item ${key}`);
			ready.add(key);
			const record = team.ledger.get(ref.workId)?.record;
			const version = team.ledger.version(ref);
			if (!record || record.currentRevision !== ref.revision || version?.state !== "queued") throw new Error(`Invariant: stale/non-queued ready item ${key}`);
		}
		if (new Set(team.ledger.order).size !== team.ledger.order.length || team.ledger.order.length !== team.ledger.works.size) {
			throw new Error("Invariant I02: WorkLedger order and records are not one-to-one");
		}
		let workerActivations = 0;
		for (const member of team.members.values()) {
			if (member.active) {
				if (member.activity === "idle") throw new Error(`Invariant I01: active member ${member.id} is idle`);
				if (member.active.scope.kind === "work") {
					const ref = member.active.scope.work!;
					const record = team.ledger.get(ref.workId)?.record;
					const version = team.ledger.version(ref);
					if (!record || record.assignee !== member.id || !version) throw new Error(`Invariant I06: activation owner does not match ${workRefKey(ref)}`);
					if (!isTerminalWorkState(version.state) && version.state !== "running") throw new Error(`Invariant: active work ${workRefKey(ref)} is ${version.state}`);
					if (version.state === "resolved" && version.resultRef) throw new Error(`Invariant I09: staged activation already committed ${workRefKey(ref)}`);
					if (member.active.scope.work?.workId !== ref.workId || member.active.scope.work.revision !== ref.revision) throw new Error("Invariant I07: active WorkRef changed after reservation");
					const delivery = team.deliveries.get(member.active.deliveryId);
					if (!delivery || delivery.memberId !== member.id || delivery.activationId !== member.active.scope.activationId) throw new Error("Invariant I01: activation has no matching delivery");
					// A retained activation whose cleanup failed has an explicitly unknown delivery.
					const deliveryConsistent = member.active.cleanup?.ok === false ? delivery.state === "unknown"
						: member.active.inputReady === (delivery.state === "delivered");
					if (!deliveryConsistent) throw new Error("Invariant D01: input_ready and delivery state disagree");
					if (member.active.intent && version.state !== "running" && !isTerminalWorkState(version.state)) throw new Error("Invariant I09: staged intent changed work state before settlement");
				}
				if (member.active.native && member.activity !== "settling") throw new Error(`Invariant I01: settled activation ${member.id} is not settling`);
				if (member.active.cleanup && !member.active.native) throw new Error(`Invariant I09: cleanup preceded native settlement for ${member.id}`);
				if (member.role === "worker" && member.active.workerPermitHeld) workerActivations++;
			} else if (member.activity !== "idle" && member.lifecycle !== "faulted") {
				throw new Error(`Invariant I01: inactive member ${member.id} is not idle`);
			}
			if (team.lifecycle === "active" && member.lifecycle === "open" && member.resourceState !== "owned") throw new Error(`Invariant I26: open member ${member.id} does not own its lifetime resources`);
			if (member.lifecycle === "closed" && member.resourceState !== "released") throw new Error(`Invariant I16: closed member ${member.id} still owns resources`);
			if (member.lifecycle === "closed" && !member.closeId) throw new Error(`Invariant I04: closed member ${member.id} has no close decision`);
			if (member.lifecycle === "faulted") {
				for (const id of team.ledger.order) {
					const record = team.ledger.get(id)!.record;
					if (record.assignee !== member.id) continue;
					const version = currentVersion(record);
					if (isTerminalWorkState(version.state)) continue;
					const managerHold = member.role === "manager" && version.state === "blocked" && version.hold?.reason === "manager_unavailable";
					if (!managerHold) throw new Error(`Invariant I17: faulted member ${member.id} still owns runnable work ${id}`);
				}
			}
		}
		if (workerActivations > team.limits.workerPermits) throw new Error("Invariant: worker activation permit limit exceeded");
		const budgetUsed = team.budget.used;
		if (budgetUsed.teamActivations > team.limits.teamActivations || budgetUsed.managerActivations > team.limits.managerActivations
			|| budgetUsed.managerActivations > budgetUsed.teamActivations
			|| budgetUsed.emergencyManagerActivations > team.limits.emergencyManagerActivations || team.ledger.order.length > team.limits.teamWorks
			|| team.reservedResultBytes > team.limits.reservedResultBytes) throw new Error("Invariant I20/I24: Team budget or reserved result capacity exceeded");
		let versionCount = 0;
		for (const id of team.ledger.order) {
			const entry = team.ledger.get(id)!;
			const record = entry.record;
			if (record.id !== id || record.currentRevision !== record.versions.length) throw new Error(`Invariant I02: malformed work record ${id}`);
			if (!team.members.has(record.requester) || !team.members.has(record.assignee)) throw new Error(`Invariant I06: work ${id} has an unknown requester or assignee`);
			if (record.parent) {
				const parent = team.ledger.get(record.parent.workId);
				if (!parent || !parent.children[record.parent.revision - 1]?.includes(id)) throw new Error(`Invariant I02: parent/child index is inconsistent for ${id}`);
			}
			if (entry.children.length !== record.versions.length) throw new Error(`Invariant I02: child index revision count is inconsistent for ${id}`);
			for (const version of record.versions) {
				versionCount++;
				const ref = { workId: id, revision: version.revision };
				if (version.revision < 1 || version.revision > record.versions.length) throw new Error(`Invariant I02: invalid WorkRef revision ${workRefKey(ref)}`);
				if (version.hold && isTerminalWorkState(version.state)) throw new Error(`Invariant I15: terminal ${workRefKey(ref)} still carries a scheduling hold`);
				if (new Set(version.waitingFor.map(workRefKey)).size !== version.waitingFor.length
					|| new Set(version.observedOutcomes.map(workRefKey)).size !== version.observedOutcomes.length) throw new Error(`Invariant I14: duplicate dependency observation on ${workRefKey(ref)}`);
				if (version.waitingFor.some((dependency) => !team.ledger.version(dependency))) throw new Error(`Invariant I11: unknown dependency on ${workRefKey(ref)}`);
				if (version.state === "queued" && !ready.has(workRefKey(ref))) throw new Error(`Invariant I14: queued work ${workRefKey(ref)} has no ready item`);
				if (version.revision === record.currentRevision && (version.state === "queued" || (version.state === "blocked" && !version.hold))
					&& this.unknownDependencies(team, ref, version).length) throw new Error(`Invariant 13.5: ${workRefKey(ref)} may run on an unacknowledged outcome-unknown dependency`);
				if (version.state === "blocked" && !version.hold && version.waitingFor.length > 0
					&& version.waitingFor.every((dependency) => team.ledger.outcomeReady(dependency))) throw new Error(`Invariant I13: ready dependency was not scheduled for ${workRefKey(ref)}`);
				if (entry.stagedWait?.revision === version.revision) {
					const assignee = team.members.get(record.assignee)!;
					if (assignee.active?.scope.kind !== "work" || !sameWorkRef(assignee.active.scope.work!, ref)
						|| assignee.active.intent?.kind !== "yield_dependencies") throw new Error(`Invariant I09: staged wait has no matching activation intent for ${workRefKey(ref)}`);
				}
				if (version.state === "resolved" && version.resultRef) {
					const result = team.ledger.results.get(version.resultRef);
					if (!result || !sameWorkRef(result.work, { workId: id, revision: version.revision })) throw new Error(`Invariant I08: invalid result reference on ${id}@${version.revision}`);
				}
				if (version.state === "resolved" && !version.resultRef) throw new Error(`Invariant I08: resolved work ${workRefKey(ref)} has no committed result`);
				if (version.resultRef) {
					const result = team.ledger.results.get(version.resultRef);
					if (!result || !sameWorkRef(result.work, ref)) throw new Error(`Invariant I08: resultRef does not match ${workRefKey(ref)}`);
				}
			}
		}
		if (team.reservedResultBytes !== versionCount * TEAM_MAX_RESULT_BYTES) throw new Error("Invariant I24: result slots do not match accepted WorkVersions");
		for (const ref of team.ledger.cleanupPending) {
			const version = team.ledger.version(this.parseWorkRefKey(ref));
			if (!version || !isTerminalWorkState(version.state)) throw new Error(`Invariant I09: cleanupPending does not refer to terminal evidence ${ref}`);
		}
		for (const delivery of team.deliveries.values()) {
			if (delivery.state === "in_flight") {
				const owner = team.members.get(delivery.memberId);
				if (!owner?.active || owner.active.scope.activationId !== delivery.activationId) throw new Error(`Invariant: in-flight delivery ${delivery.id} has no active scope`);
			}
		}
		if (team.lifecycle === "closed") {
			if (!team.closeDecision || [...team.members.values()].some((member) => member.id === team.manager
				? member.lifecycle !== "closed" || member.resourceState !== "released"
				: !((member.lifecycle === "closed" || member.lifecycle === "faulted") && member.resourceState === "released"))) {
				throw new Error("Invariant I28: Team cannot be closed before a committed close and release");
			}
		}
		if (team.lifecycle === "closing" && (!team.closeDecision || [...team.members.values()].some((member) => member.active
			&& (member.id !== team.manager || member.active.intent?.kind !== "close_team")))) throw new Error("Invariant I27: close_team has an unrelated active operation");
	}

	private parseWorkRefKey(key: string): WorkRef {
		const split = key.lastIndexOf("@");
		const revision = Number(key.slice(split + 1));
		if (split < 1 || !Number.isSafeInteger(revision) || revision < 1) throw new Error(`Invalid internal WorkRef key ${key}`);
		return { workId: key.slice(0, split), revision };
	}
}
