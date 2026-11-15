import { createHash, randomInt, randomUUID } from "node:crypto";
import {
	TEAM_COMMAND_CACHE, TEAM_LOOP_REPEATS, TEAM_MAX_CHILD_ISSUE_MESSAGE_BYTES, TEAM_MAX_DEPENDENCY_PREVIEWS, TEAM_MAX_LIVE_TEAMS, TEAM_MAX_EVENT_BATCH,
	TEAM_MAX_PENDING_OPERATIONS, TEAM_MAX_TERMINAL_INCIDENTS, TEAM_MAX_MESSAGES, TEAM_MAX_MEMBER_MESSAGES, TEAM_MAX_SIGNALS, TEAM_MAX_WORK_SIGNALS,
	TEAM_MAX_DEPENDENCY_PREVIEW_BYTES, TEAM_MAX_ID_LENGTH, TEAM_MAX_NOTE_BYTES, TEAM_MAX_RESULT_BYTES, TEAM_MAX_TEXT_ITEM_BYTES, TEAM_PROTOCOL_VERSION,
	TEAM_STATUS_DEFAULT_LIMIT, TEAM_STATUS_MAX_LIMIT, TEAM_BUDGET_PRESETS, TEAM_BUDGET_UNLIMITED, TEAM_MAX_REVIEWS, isTerminalWorkState, reviewVerdict, reviewTiming, sameWorkRef,
	workRefKey, shortWorkRef, ROOT_GRANTABLE_COUNTERS, TEAM_VIEW_MAX_BUDGET_ROOTS, TEAM_VIEW_MAX_GRANTS, TEAM_VIEW_MAX_INCIDENTS,
	type ActivationInput, type ActivationScope, type ChildIssue, type HoldReason, type RootGrantCounter, type TeamRootBudgetView, type TeamBudgetGrantView, type BindingV2, type DeliveryRecord, type EndIntent,
	type TeamEventView, type MemberRecord, type OutcomeView, type ResultRecord, type SignalRecord,
	type TeamAction, type TeamBudgetLimits, type TeamBudgetView, type TeamErrorCode, type TeamIncidentView, type TeamLifecycle, type GateDecision,
	type TeamBudgetPreset, type TeamMemberPolicy, type TeamMemberView, type TeamPlan, type TeamReply, type TeamResult, type TeamReviewPlan, type TeamReviewRecord, type TeamTeamView,
	type TeamWorkSummary, type TeamWorkView, type WorkError, type WorkRecord, type WorkRef, type WorkResult, type WorkVersion,
} from "./team-protocol";
import {
	TeamProtocolError, canonicalJson, encodeActivationInput, errorReply, formatWorkResult, normalizeNativeToolCallId, normalizeReviewPlan, normalizeTeamAction, normalizeTeamPlan, normalizeTitle, normalizeTeamBudgetPreset, parseActivationScope, parseBinding, sameScope,
	okReply, jsonTextBytes, previewText, projectActivationInput, projectErrorText, projectWorkChildren, projectWorkError,
} from "./team-codec";
import { readCompactThreshold } from "./team-compaction-settings";
import { RETRY_DELAYS_MS } from "./retry";
import { WorkLedger } from "./team-work-ledger";
import { prompt } from "../../core/prompts";
import { addActivationUsage, emptySubagentUsage } from "./usage";
import type { SubagentUsage } from "./session-broker";
import { TeamBudget, type ActivationBudget, type BudgetExhaustion, type BudgetScope } from "./team-budget";
import type { TeamJournalGeneration, TeamJournalRecord } from "./team-journal";
import { flowRows, flowStats, flowSummary, newFlow, pushFlow, tickFlow, tokens as tokenText, type FlowState, type TeamFlowStats } from "./team-flow";

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
const TEAM_MAX_TIMELINE = 1000;
/** Once the timeline is full its first entries stay (a long run keeps its start); the oldest after them go. */
export const TEAM_TIMELINE_HEAD = 30;
/** In-place retries of a transient provider error use the subagent RETRY_DELAYS_MS; the lead keeps retrying every 5 minutes until its window ends. */
const LEAD_RETRY_WINDOW_MS = 30 * 60_000;
/** A fresh work queued this long competes for a work permit like resumed work, so priority never starves it. */
const READY_AGING_MS = 10 * 60_000;
/** Names the exact work, because a member's session outlives its works and a model may answer an earlier one. */
/** Events that only advise the lead: they never block close_team and are marked processed when the Team closes. */
const ADVISORY_EVENTS: readonly string[] = ["REVIEW_READY", "TEAM_QUIESCENT", "COMPACTION"];
const loopKey = (toolName: string, inputHash?: string): string | undefined => inputHash === undefined ? undefined : `${toolName}\0${inputHash}`;
const workNotice = (work: WorkRef): string => `${prompt("team", "work_notice", { work: workRefKey(work) })} ${prompt("team", "brief_pointer")}`;

export interface RuntimeActivation {
	binding: BindingV2;
	scope: ActivationScope;
	deliveryId: string;
	input: ActivationInput;
}

/** Evidence supplied only after the native send has reached its real settled boundary. */
export interface NativeCompletion {
	status: "success" | "error" | "aborted" | "length";
	overflow?: boolean;
	finalAssistantText?: string;
	pendingToolCalls?: boolean;
	/** The exact staged end-intent tool result observed in the settled native transcript. */
	appliedToolCallId?: string;
	error?: WorkError & { transient?: true };
	/** Usage observed from this send's own native events, frozen at agent_settled. */
	usage?: SubagentUsage;
}

export type ActivationCompletionReason = "normal" | "policy_pause" | "policy_superseded" | "policy_cancelled"
	| "budget_hold" | "loop_hold" | "native_failure" | "transport_failure";

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
	existingTeamIds?: () => readonly string[];
	limits?: Partial<TeamBudgetLimits>;
	activationStopTimeoutMs?: number;
	/** Synchronous history writer for this runtime generation; critical writes fail closed. */
	journal?: TeamJournalGeneration;
	/** Run the full-ledger invariant sweep on hot paths (default true); `assertInvariants` always runs it. */
	checkInvariants?: boolean;
}

export type CompactionResult = { ok: true; tokensBefore?: number; tokensAfter?: number; usage?: SubagentUsage } | { ok: false; error: string };
type CompactionRequest = { trigger: "threshold" | "host" | "lead" | "overflow"; instructions?: string };

export interface TeamRuntimeExecutor {
	compactMember?(binding: BindingV2, instructions?: string): Promise<CompactionResult>;
	abortCompaction?(binding: BindingV2): void;
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
	| { actor: "@host"; status: "applied"; teamId: string; grantId: string; released: WorkRef[] }
	| { actor: "@host"; status: "applied"; teamId: string; lead: string }
	| { actor: "@host"; status: "applied"; teamId: string; memberId: string; compaction?: "started" | "scheduled" };

export interface TeamHostControl {
	cancel_team(reason: string): HostControlReceipt;
	/** Raise counted limits for the Team or one known root; never resets usage or releases other holds. */
	grant(scope: BudgetScope, increments: Partial<Record<string, number>>, reason: string): HostControlReceipt;
	release_hold(work: WorkRef, incidentId: string, instruction: string): HostControlReceipt;
	message_lead(text: string): HostControlReceipt;
}

interface CachedAction {
	fingerprint: string;
	reply: TeamReply;
}

interface InternalEvent extends TeamEventView {
	key: string;
	processed: boolean;
	/** An explicit failed disposition, not a read receipt. */
	deliveryFailure?: string;
	batchId?: string;
	/** Report-only: never starts an events activation by itself, it rides along with the lead's next batch. */
	passive?: true;
}

interface EventBatch {
	eventIds: string[];
}

type WorkScope = Extract<ActivationInput["scope"], { kind: "work" }>;

/** Read-only dependency facts for an exact consumer version; never scheduling instructions. */
export interface TeamWaitFact {
	work: WorkRef;
	assignee: string;
	/** A phase handle is distinct from completion of its exact producer WorkRef. */
	signal?: { id: string; name: string };
	/** Signal state, or Work state ("held" when a hold keeps the Work from finishing). */
	state: string;
	/** One of the waiting version's own children rather than a peer's work. */
	child: boolean;
	/** Outcome not ready, not a claim that the consumer itself is blocked. Work cleanup/unknown gates never apply to signal outcomes. */
	blocking: boolean;
	reason?: string;
	/** An exact older dependency is never silently retargeted to this revision. */
	latestRevision?: number;
}

interface ActiveActivation {
	/** Team-active clock when this native activation was reserved. */
	startedActiveMs: number;
	activeTimeFolded?: boolean;
	scope: ActivationScope;
	deliveryId: string;
	inputReady: boolean;
	intent?: EndIntent;
	native?: NativeCompletion;
	completion?: ActivationCompletion;
	cleanup?: CleanupCompletion;
	stopReason?: "cancelled" | "superseded" | "team_cancelled";
	completionReason?: ActivationCompletionReason;
	workPermitHeld: boolean;
	/** Set while this activation counts in the flow metrics. */
	flowRole?: "lead" | "worker";
	parked: boolean;
	resumeRequested: boolean;
	providerGatePending: boolean;
	toolCalls: Map<string, { toolName: string; inputHash?: string; allowed: boolean; denial?: GateDecision }>;
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
	/** The current run of consecutive failed results of one identical call (tool name + input fingerprint). */
	loop?: { key: string; count: number };
	/** Set when a work activation hit the tool-loop limit: it stops at its next gate and the work is held. */
	loopStop?: { tool: string };
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
	compaction?: CompactionRequest & { state: "pending" | "running" };
	pendingCompaction?: CompactionRequest;
	lastCompaction?: { tokensBefore?: number; tokensAfter?: number };
	compactedAtBoundary?: boolean;
	nativeContextWindow?: number;
	overflowRecoveries?: Set<string>;
	policy: TeamMemberPolicy;
	epoch: string;
	active?: ActiveActivation;
	/** Team active time (flow.activeMs) when the member's last activation ended; the lead's roster shows idle minutes from it. */
	idleSinceActiveMs?: number;
	/** Member pause clock in Team active milliseconds, used only by ready-wait metrics. */
	flowPausedMs?: number;
	flowPauseAt?: number;
	/** Kind of the last activation reserved for this member: an idle lead alternates its runnable work with event batches. */
	lastActivationKind?: "events" | "work";
	lastActivation?: CompletedActivationTombstone;
	lastLostActivation?: { activationId: string; error: WorkError; resourceReleased: boolean; reason: ActivationCompletionReason };
	/** Transient provider errors since the last successful completion; nothing is scheduled for this member before `nextAt`. */
	retry?: { attempts: number; firstAt: number; nextAt: number; error: string };
	closeId?: string;
	/** A driver was issued this prepared member's binding and may hold a native lifetime. */
	nativeClaimed?: boolean;
	usage: SubagentUsage;
	activeMs: number;
}

interface CloseDecision {
	id: string;
	outcome: "succeeded" | "partial" | "failed";
	reason?: string;
	resultRefs: string[];
	roots: TeamResult["roots"];
}

interface ReviewSnapshot {
	sequence: number;
	baseline: { finished: ReadonlySet<string>; wall: number };
	snapshotAt: number;
	snapshot: TeamReviewRecord["snapshot"];
	signature: string;
	finished: Set<string>;
	wall: number;
}

/** Periodic review: the (host-changeable) schedule and what completed reviews already saw. */
interface ReviewState {
	schedule: TeamReviewPlan | null;
	nextAt: number | null;
	startedAt: number;
	/** Non-review works seen by the newest completed snapshot: change detection. */
	signature: string;
	/** Non-review works already terminal then, and the wall clock then (timeline cut). */
	finished: Set<string>;
	wall: number;
	/** Capture order, so a late result cannot move the comparison baseline backwards, even when timestamps tie. */
	sequence: number;
	reviewedSequence: number;
	/** Only started, unfinished WorkRefs; each keeps its own baseline across retries/resumes. */
	pending: Map<string, ReviewSnapshot>;
	/** Original focus survives completion so revising an old review cannot inherit another review's schedule. */
	focus: Map<string, string>;
	records: TeamReviewRecord[];
}

interface TeamState {
	id: string;
	lifecycle: TeamLifecycle;
	health: "ok" | "needs_attention";
	stateVersion: number;
	eventSeq: number;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	workStats: Map<string, { activeMs: number; usage: SubagentUsage }>;
	pausedMs: number;
	deadline: number | null;
	plan: TeamPlan;
	lead: string;
	bootProcessed: boolean;
	cancelRequested: boolean;
	members: Map<string, RuntimeMember>;
	ledger: WorkLedger;
	ready: WorkRef[];
	/** Ready works requeued by a transient-error retry or overflow recovery: they lead the ready order. */
	interrupted: Set<string>;
	deliveries: Map<string, DeliveryRecord>;
	events: InternalEvent[];
	eventBatches: Map<string, EventBatch>;
	/** A mailbox admission yields the next available worker permit to runnable Work. */
	mailboxLast?: boolean;
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
	/** Display-only schedule of milestones for the host (bounded: the first TEAM_TIMELINE_HEAD and the newest); never an obligation or a recovery log. */
	timeline: Array<{ at: number; text: string }>;
	timelineOmitted: number;
	review: ReviewState;
	/** While the host has frozen the Team: since when, and the members this pause paused (a member the lead paused itself is not listed). */
	hostPause?: { at: number; members: Set<string> };
	flow: FlowState;
	dependencyWaits: number;
	questions: number;
	toolErrors: number;
	transientRetries: number;
	outcome?: "succeeded" | "partial" | "failed";
	reason?: string;
	closeDecision?: CloseDecision;
	usage: ReturnType<typeof emptySubagentUsage>;
}

/**
 * The IDs members copy into text are `<kind>:<code>`, a 4-character random code that is
 * unique within its Team. The alphabet leaves out 0/o/1/l/i, and sparse random codes (not a sequence)
 * make a mistyped code almost never another valid ID.
 */
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
type ModelIdKind = "work" | "result" | "incident" | "event" | "review" | "signal";
/**
 * An ID in that form quoted in text. Every code has a digit, so a word such as `result:pass` is not read as
 * an ID; longer (old UUID-format) IDs do not fit and are left alone.
 */
const QUOTED_ID = new RegExp(`\\b(?:work|result|incident|event|review|signal):(?=[a-z]{0,3}[2-9])[${ID_ALPHABET}]{4}\\b`, "gu");

/** One substitution or one adjacent transposition apart: the slips made when copying an ID. */
function isTypo(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	const at = [...left].flatMap((char, index) => char === right[index] ? [] : [index]);
	return at.length === 1 || (at.length === 2 && at[1] === at[0]! + 1 && left[at[0]!] === right[at[1]!] && left[at[1]!] === right[at[0]!]);
}

/** The model-written text of an action that the runtime hands on to another party; a checkpoint stays with its author. */
function forwardedText(action: TeamAction): string | undefined {
	switch (action.action) {
		case "reply": return formatWorkResult(action.result);
		case "request": return action.task;
		case "message": return action.text;
		case "signal": return action.operation === "publish" ? action.text : undefined;
		case "yield": return action.attention;
		case "status": return undefined;
		case "control": {
			const { control } = action;
			return "task" in control ? control.task : "instruction" in control ? control.instruction : "reason" in control ? control.reason : undefined;
		}
	}
}

const copy = <T>(value: T): T => structuredClone(value);
const currentVersion = (record: WorkRecord): WorkVersion => record.versions[record.currentRevision - 1]!;
const TERMINAL_TEAM_LIFECYCLES: readonly TeamLifecycle[] = ["closed", "failed", "cancelled", "interrupted"];
const plural = (count: number): string => count === 1 ? "" : "s";
export const clock = (ms: number): string => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Bounded status timeline: head 30, newest entries, and one in-place omission marker (100 rows total). */
export function formatTimeline(timeline: readonly { at: number; text: string }[], omitted: number, origin: number): string[] {
	const needsMarker = omitted > 0 || timeline.length > 100;
	const skipped = Math.max(0, timeline.length - (needsMarker ? 99 : 100));
	const entries = skipped ? [...timeline.slice(0, TEAM_TIMELINE_HEAD), ...timeline.slice(TEAM_TIMELINE_HEAD + skipped)] : timeline;
	const lines = entries.map((entry) => `- ${clock(entry.at - origin)} ${entry.text}`);
	if (needsMarker) lines.splice(TEAM_TIMELINE_HEAD, 0, `- … ${omitted + skipped} milestones omitted …`);
	return lines;
}

/** At most `cap` items, then "+N more". */
export const capped = (items: readonly string[], cap: number, separator = ", "): string =>
	items.slice(0, cap).join(separator) + (items.length > cap ? ` +${items.length - cap} more` : "");
/** The distinct kinds of an event batch, at most three named. */
const eventKinds = (events: readonly { kind: string }[]): string => capped([...new Set(events.map((event) => event.kind))], 3);
/** Panel text for what the lead is processing. */
export const handlingText = (events: readonly { kind: string }[]): string => `handling ${eventKinds(events)}`;
/** Short panel words for a hold that is not a question for the lead. */
const HELD_REASON = { budget: "budget exhausted", protocol: "protocol", lead_unavailable: "lead unavailable" } as const;

/** Panel phrase for what a member waits on; one dependency also shows its ref. */
function waitingOnText(waits: readonly TeamWaitFact[]): string {
	const named = waits.map((wait) => `${waitTargetText(wait)} (${wait.state}${waits.length === 1 ? ` ${shortWorkRef(wait.work)}` : ""}${wait.reason ? ` · ${wait.reason}` : ""})`);
	return waits.every((wait) => wait.child)
		? `waiting on ${waits.length} sub-task${plural(waits.length)}: ${capped(named, 3)}`
		: `waiting on ${capped(named, 3)}`;
}

/** Brief identity shared by member, Team and task rows; phase names never substitute for handles. */
export const waitTargetText = (wait: TeamWaitFact): string => wait.signal ? `phase ${wait.signal.id} from ${wait.assignee}` : wait.assignee;

/** One exact target, including ready outcomes that no longer block scheduling. */
export function waitFactText(wait: TeamWaitFact): string {
	const target = wait.signal ? `${wait.signal.id} «${previewText(wait.signal.name, 64)}» (${shortWorkRef(wait.work)})` : shortWorkRef(wait.work);
	return `${target} → ${wait.assignee} · ${wait.state}${wait.reason ? ` · ${wait.reason}` : ""}`
		+ (wait.latestRevision === undefined ? "" : ` · current @${wait.latestRevision}`);
}

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
	private readonly reviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly existingTeamIds: () => readonly string[];
	private liveUsage?: (teamId: string, memberId: string) => SubagentUsage | undefined;
	/** Without an injected createId (tests), model-visible IDs are short random codes. */
	private readonly shortIds: boolean;
	private readonly limitOverrides: Partial<TeamBudgetLimits>;
	private readonly activationStopTimeoutMs: number;
	private readonly journalGeneration: TeamJournalGeneration | undefined;
	private journalRetiredForHostTransition = false;
	private readonly checkInvariants: boolean;

	constructor(options: TeamRuntimeOptions = {}) {
		this.checkInvariants = options.checkInvariants ?? true;
		this.journalGeneration = options.journal;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
		this.existingTeamIds = options.existingTeamIds ?? (() => []);
		this.shortIds = !options.createId;
		this.limitOverrides = { ...options.limits };
		this.activationStopTimeoutMs = options.activationStopTimeoutMs ?? 5000;
		if (!Number.isSafeInteger(this.activationStopTimeoutMs) || this.activationStopTimeoutMs < 1) throw new Error("Invalid activation stop timeout");
		for (const [key, value] of Object.entries(this.limitOverrides)) {
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
		// Every member other than the lead (which has its own slot) may run at once; a host override still applies.
		const limits = { ...TEAM_BUDGET_PRESETS[plan.budget ?? "long"], workPermits: Math.max(1, plan.members.length - 1), ...this.limitOverrides };
		if (resolvedPolicies) {
			for (const member of plan.members) {
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
			if (count > limits.memberUnresolvedWork) {
				fail("REQUEST_QUEUE_FULL", `Initial requests exceed ${initial.to}'s unresolved-work limit (${limits.memberUnresolvedWork})`);
			}
			unresolvedInitial.set(initial.to, count);
		}
		const createdAt = this.timestamp();
		const existing = new Set([...this.teams.keys(), ...this.existingTeamIds()]);
		let id: string;
		do { id = this.shortIds ? Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz234567".charAt(randomInt(32))).join("") : this.newId(); } while (existing.has(id));
		this.hostId(id, "teamId");
		const initialCount = plan.initialRequests.length;
		const reserved = initialCount * TEAM_MAX_RESULT_BYTES;
		if (initialCount > limits.teamWorks || reserved > limits.reservedResultBytes) {
			fail("TEAM_CAPACITY", "Initial requests exceed Team work/result capacity");
		}
		const members = new Map<string, RuntimeMember>();
		for (const memberPlan of plan.members) {
			members.set(memberPlan.alias, {
				id: memberPlan.alias,
				roleDescription: memberPlan.roleDescription,
				lifecycle: "starting",
				activity: "idle",
				pause: "none",
				resourceState: "starting",
				policy: copy(memberPlan.policy),
				epoch: this.newId(),
				usage: emptySubagentUsage(), activeMs: 0,
			});
		}
		const budget = new TeamBudget(limits);
		const team: TeamState = {
			id, lifecycle: "prepared", health: "ok", stateVersion: 1, eventSeq: 0, createdAt, workStats: new Map(), pausedMs: 0,
			deadline: null,
			plan: copy(plan), lead: plan.lead, bootProcessed: false, cancelRequested: false, members, ledger: new WorkLedger(), ready: [], interrupted: new Set(), deliveries: new Map(), unknownAcknowledged: new Set(),
			events: [], eventBatches: new Map(), incidents: [], limits: budget.limits, budget,
			reservedResultBytes: reserved, usage: emptySubagentUsage(), timeline: [], timelineOmitted: 0,
			review: { schedule: copy(plan.review), nextAt: null, startedAt: createdAt, signature: "", finished: new Set(), wall: 0,
				sequence: 0, reviewedSequence: 0, pending: new Map(), focus: new Map(), records: [] },
			flow: newFlow(createdAt), dependencyWaits: 0, questions: 0, toolErrors: 0, transientRetries: 0,
		};
		for (const initial of plan.initialRequests) {
			const record = this.makeWork(team, team.lead, initial.to, initial.task, initial.inputRefs, undefined, createdAt, undefined, 0, initial.title);
			this.assertInputFits(team, team.members.get(initial.to)!, record);
			team.ledger.add(record);
			this.enqueueWork(team, { workId: record.id, revision: 1 });
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
			roster: { lead: team.lead, members: team.plan.members.map((member) => member.alias) }, goal: previewText(team.plan.brief.goal, 512), title: team.plan.title!,
			...(team.plan.review ? { review: team.plan.review } : {}) })) {
			const reason = team.journalFailure;
			this.applyJournalFailure(team);
			fail("PROTOCOL_FAILURE", `Team launch could not be journaled: ${reason}`);
		}
		team.deadline = team.plan.timeoutSeconds === null ? null : launchAt + Math.ceil(team.plan.timeoutSeconds * 1000);
		team.lifecycle = "active";
		team.flow.lastAt = launchAt;
		team.review.startedAt = launchAt;
		team.startedAt = launchAt;
		for (const member of team.members.values()) {
			member.lifecycle = "open";
			member.resourceState = "owned";
		}
		this.addEvent(team, { key: "BOOT", kind: "BOOT", message: this.bootMessage(team) });
		const initial = team.ledger.order.map((workId) => team.ledger.get(workId)!.record);
		this.note(team, `launch${initial.length ? ` · initial ${initial.map((record) => `${shortWorkRef({ workId: record.id, revision: 1 })} → ${record.assignee}`).join(", ")}` : ""}`);
		this.changed(team);
		this.check(team);
		if (team.plan.timeoutSeconds !== null) this.armDeadline(team, Math.ceil(team.plan.timeoutSeconds * 1000));
		this.armReview(team);
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
			message_lead: (text: string) => this.messageLead(teamId, text),
		});
	}

	/**
	 * Stop one Broker-owned member without widening the action to the Team. A member loses only its
	 * own work and descendants; an unavailable lead holds its own work and pauses the other members.
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
		this.failMessages(team, member, reason);
		this.setMemberPause(team, member, "none");
		team.health = "needs_attention";
		if (member.id === team.lead) {
			this.holdLeadWork(team);
			this.pauseMembersForLeadFault(team);
			this.createIncident(team, "LEAD_UNAVAILABLE", reason, undefined, member.id);
		} else {
			this.stopMemberWork(team, member, reason);
		}
		if (member.active) {
			member.active.stopReason = "cancelled";
			this.requestActivationStop(team, member, "policy_cancelled");
		}
		this.addEvent(team, { key: `host-member-stopped:${member.id}`, kind: "MEMBER_FAULTED",
			message: prompt("team", "event_member_stopped", { member: member.id }), memberId: member.id });
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

	/** Terminal host cancellation never asks the lead model for permission. */
	cancelTeam(teamId: string, reasonValue: string): HostControlReceipt {
		const team = this.team(teamId);
		const reason = this.hostText(reasonValue, "cancel reason");
		if (team.closeDecision) {
			// The committed close decision wins: do not abort the lead's terminating settlement,
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
		this.tickFlow(team);
		team.endedAt ??= this.timestamp();
		if (team.lifecycle === "failed") {
			team.reason = `${team.reason ?? "Team failed"}; ${lifecycle === "cancelled" ? "host cancellation requested" : "additional failure"}: ${reason}`;
		} else {
			team.lifecycle = lifecycle;
			team.reason = reason;
		}
		team.cancelRequested = true;
		this.cancelAllWork(team, lifecycle === "failed" ? "failed" : "cancelled", workError);
		team.review.pending.clear();
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
				delete version.waitingForSignals;
				delete version.hold;
				version.updatedAt = this.timestamp();
				delete entry.stagedWait;
			}
			this.dequeueWork(team, ref);
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

	/** Append a deduplicated, explicitly host-attributed event for a healthy lead. */
	messageLead(teamId: string, textValue: string): HostControlReceipt {
		const team = this.team(teamId);
		const text = this.hostText(textValue, "lead message");
		if (team.lifecycle !== "active" || team.members.get(team.lead)!.lifecycle !== "open") {
			fail("MEMBER_UNAVAILABLE", "The lead cannot receive a host message in its current lifecycle");
		}
		// Only a still-pending identical message is a duplicate; a later repeat ("continue") is a new request.
		const pending = team.events.find((event) => !event.processed && event.kind === "USER_COMMAND" && event.actor === "@host" && event.message === text);
		if (pending) return { actor: "@host", status: "unchanged", teamId, eventId: pending.id };
		const event = this.addEvent(team, { key: `host-message:${team.eventSeq}`, kind: "USER_COMMAND", actor: "@host", message: text });
		this.requestDrain(teamId);
		return { actor: "@host", status: "applied", teamId, eventId: event.id };
	}

	private armDeadline(team: TeamState, ms: number): void {
		this.deadlineTimers.set(team.id, setTimeout(() => {
			this.deadlineTimers.delete(team.id);
			this.cancelTeam(team.id, "DEADLINE: Team runtime deadline expired");
		}, ms));
	}

	/**
	 * Host-only: freeze the Team in this process. Every running activation (the lead's too) finishes its current request and the
	 * tool calls already issued, then parks at its next provider gate; nothing new starts. The paused time does not count against the deadline.
	 */
	pauseTeam(teamId: string, reasonValue?: string): HostControlReceipt {
		const team = this.team(teamId);
		const reason = reasonValue === undefined ? undefined : this.hostText(reasonValue, "pause reason");
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		if (team.hostPause) return { actor: "@host", status: "unchanged", teamId, lifecycle: team.lifecycle };
		this.tickFlow(team);
		const members = new Set<string>();
		for (const member of team.members.values()) {
			if (member.lifecycle !== "open" || member.pause !== "none") continue;
			this.setMemberPause(team, member, member.active ? "requested" : "confirmed");
			members.add(member.id);
		}
		team.hostPause = { at: this.timestamp(), members };
		clearTimeout(this.deadlineTimers.get(teamId));
		this.deadlineTimers.delete(teamId);
		this.clearReview(team);
		this.note(team, `host paused the Team${reason ? `: ${reason}` : ""}`);
		this.changed(team);
		return { actor: "@host", status: "applied", teamId, lifecycle: team.lifecycle };
	}

	/** Host-only: resume what pauseTeam froze (parked activations continue their native run) and tell the lead. */
	continueTeam(teamId: string): HostControlReceipt {
		const team = this.team(teamId);
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		const paused = team.hostPause;
		if (!paused) return { actor: "@host", status: "unchanged", teamId, lifecycle: team.lifecycle };
		this.tickFlow(team);
		delete team.hostPause;
		const now = this.timestamp();
		team.pausedMs += now - paused.at;
		for (const id of paused.members) this.liftPause(team, team.members.get(id)!);
		if (team.deadline !== null) {
			team.deadline += now - paused.at;
			this.armDeadline(team, team.deadline - now);
		}
		this.armReview(team);
		this.addEvent(team, { key: `host-continue:${team.eventSeq}`, kind: "USER_COMMAND", actor: "@host",
			message: prompt("team", "event_team_continued", { minutes: String(Math.max(1, Math.round((now - paused.at) / 60_000))) }) });
		this.note(team, "host continued the Team");
		this.changed(team);
		this.requestDrain(teamId);
		return { actor: "@host", status: "applied", teamId, lifecycle: team.lifecycle };
	}

	/**
	 * Host-only: make another open member the Team's lead. The previous lead stays a member. Unprocessed Team events
	 * go to the new lead; after a lead fault the lead-unavailable incidents resolve, the previous lead's stranded work
	 * fails like any faulted member's, and the safety pause of the other members ends.
	 */
	handoverLead(teamId: string, aliasValue: string, reasonValue?: string): HostControlReceipt {
		const team = this.team(teamId);
		const reason = reasonValue === undefined ? "Host handover" : this.hostText(reasonValue, "handover reason");
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		const target = team.members.get(aliasValue);
		if (!target) fail("UNKNOWN_MEMBER", `Unknown member ${aliasValue}`);
		const previous = team.members.get(team.lead)!;
		if (target === previous) fail("INVALID_ARGUMENT", `${target.id} is already the lead`);
		if (target.lifecycle !== "open" || target.resourceState !== "owned") fail("MEMBER_UNAVAILABLE", `${target.id} is not an open member`);
		if (previous.lifecycle === "open" && previous.active?.scope.kind === "events") {
			fail("INVALID_ARGUMENT", `${previous.id} is handling Team events; hand over when its events activation has ended`);
		}
		this.writeJournal(team, { version: 2, kind: "handover", teamId, at: this.timestamp(), lead: target.id });
		// Permits stay as reserved: a work run of the previous lead finishes without one (one bounded extra run),
		// and a parked one takes a permit when it resumes; the new lead's running work keeps its permit until it ends.
		team.lead = target.id;
		// A batch the previous lead never finished is processed again by the new lead.
		this.requeueOrphanEventBatches(team);
		const stranded = team.ledger.order.map((id) => team.ledger.currentRef(id)!).find((ref) => team.ledger.version(ref)!.hold?.reason === "lead_unavailable");
		if (stranded) this.failMemberWork(team, previous, stranded);
		for (const incident of team.incidents) if (incident.code === "LEAD_UNAVAILABLE" && incident.state === "open") this.resolveIncident(team, incident.id);
		for (const member of team.members.values()) {
			if (member.lifecycle === "open" && (member === target || previous.lifecycle !== "open")) this.liftPause(team, member);
		}
		this.addEvent(team, { key: `handover:${team.eventSeq}`, kind: "USER_COMMAND", actor: "@host", message: prompt("team", "event_lead_handover", { reason }) });
		this.note(team, `host made ${target.id} the lead`);
		this.wakeWaiters(team);
		this.changed(team);
		this.check(team);
		this.requestDrain(teamId);
		return { actor: "@host", status: "applied", teamId, lead: target.id };
	}

	/**
	 * Host-only: reopen a faulted member whose process is still alive (the lead included). Reviving the lead undoes
	 * its fault the way a handover does, minus the lead change: its events are delivered again, its held work is queued
	 * instead of failed, and the safety pause of the other members ends.
	 */
	reviveMember(teamId: string, aliasValue: string): HostControlReceipt {
		const team = this.team(teamId);
		const member = team.members.get(aliasValue);
		if (!member) fail("UNKNOWN_MEMBER", `Unknown member ${aliasValue}`);
		this.revive(team, member, "host");
		if (member.id === team.lead) {
			this.requeueOrphanEventBatches(team);
			for (const id of team.ledger.order) {
				const ref = team.ledger.currentRef(id)!;
				const version = team.ledger.version(ref)!;
				if (version.hold?.reason !== "lead_unavailable") continue;
				delete version.hold;
				version.state = "queued";
				version.updatedAt = this.timestamp();
				this.enqueueWork(team, ref);
			}
			for (const incident of team.incidents) if (incident.code === "LEAD_UNAVAILABLE" && incident.state === "open") this.resolveIncident(team, incident.id);
			for (const other of team.members.values()) if (other.lifecycle === "open") this.liftPause(team, other);
		}
		this.addEvent(team, { key: `revive:${team.eventSeq}`, kind: "USER_COMMAND", actor: "@host", message: prompt("team", "event_member_revived", { member: member.id }) });
		this.check(team);
		this.requestDrain(teamId);
		return { actor: "@host", status: "applied", teamId, memberId: member.id };
	}

	/** The current periodic-review schedule (nextAt: when the timer fires next, null while it is not running); undefined without one. */
	reviewSchedule(teamId: string): (TeamReviewPlan & { nextAt: number | null }) | undefined {
		const { schedule, nextAt } = this.team(teamId).review;
		return schedule ? { ...schedule, nextAt } : undefined;
	}

	/** The Team's reviews, oldest first (the newest TEAM_MAX_REVIEWS). */
	listReviews(teamId: string): TeamReviewRecord[] {
		return copy(this.team(teamId).review.records);
	}

	/** Host-only: set the periodic review (without `by` the current reviewer stays), or stop it with null. Restarts the interval. */
	setReview(teamId: string, value: { by?: string; everyMinutes: number } | null): HostControlReceipt {
		const team = this.team(teamId);
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		const by = value?.by ?? team.review.schedule?.by;
		if (value && !by) fail("INVALID_ARGUMENT", "Name the reviewer: review every <N> by <alias>");
		const schedule = value ? normalizeReviewPlan({ by, everyMinutes: value.everyMinutes, focus: team.review.schedule?.focus }, "review", [...team.members.keys()], team.lead) : null;
		if (canonicalJson(schedule) === canonicalJson(team.review.schedule)) return { actor: "@host", status: "unchanged", teamId, lifecycle: team.lifecycle };
		this.writeJournal(team, { version: 2, kind: "review_schedule", teamId, at: this.timestamp(), review: copy(schedule) });
		team.review.schedule = schedule;
		this.armReview(team);
		this.note(team, schedule ? `host set the review: ${schedule.by} every ${schedule.everyMinutes} min` : "host stopped the periodic review");
		this.changed(team);
		return { actor: "@host", status: "applied", teamId, lifecycle: team.lifecycle };
	}

	/** Host-only: start a review now, even if nothing changed since the last one. */
	reviewNow(teamId: string): Extract<HostControlReceipt, { work: WorkRef }> {
		const team = this.team(teamId);
		const blocked = this.reviewBlocker(team, true);
		if (blocked) fail("INVALID_ARGUMENT", `No review started: ${blocked}`);
		const work = this.startReview(team);
		this.armReview(team);
		return { actor: "@host", status: "applied", teamId, work };
	}

	/** What the review timer runs (public so a test can drive it): start a review if one is due. */
	runReviewTick(teamId: string): WorkRef | undefined {
		const team = this.team(teamId);
		if (this.reviewBlocker(team, false)) return undefined;
		try { return this.startReview(team); }
		catch (error) {
			if (!(error instanceof TeamProtocolError)) throw error;
			this.note(team, `review skipped: ${error.message}`);
			return undefined;
		}
	}

	private armReview(team: TeamState): void {
		this.clearReview(team);
		if (!team.review.schedule || team.lifecycle !== "active" || team.hostPause) return;
		const ms = team.review.schedule.everyMinutes * 60_000;
		team.review.nextAt = this.timestamp() + ms;
		const timer = setTimeout(() => {
			this.reviewTimers.delete(team.id);
			this.runReviewTick(team.id);
			this.armReview(team);
		}, ms);
		// A review timer alone never keeps the process alive.
		timer.unref();
		this.reviewTimers.set(team.id, timer);
	}

	private clearReview(team: TeamState): void {
		clearTimeout(this.reviewTimers.get(team.id));
		this.reviewTimers.delete(team.id);
		team.review.nextAt = null;
	}

	/** Why no review can start now, if so. Without `force`, an unchanged Team (nothing created or moved since the last review) is skipped too. */
	private reviewBlocker(team: TeamState, force: boolean): string | undefined {
		const reviewer = team.review.schedule && team.members.get(team.review.schedule.by);
		if (team.lifecycle !== "active") return `Team is ${team.lifecycle}`;
		if (team.hostPause) return "the Team is paused by the host";
		if (!reviewer) return "no reviewer is set (review every <N> by <alias>)";
		if (team.members.get(team.lead)!.lifecycle !== "open") return "the lead is not open";
		if (reviewer.lifecycle !== "open" || reviewer.id === team.lead) return `${reviewer.id} is not an open reviewer`;
		if (team.ledger.order.some((id) => this.isReview(team, { workId: id, revision: 1 }) && !isTerminalWorkState(team.ledger.current(id)!.state))) return "a review is still open";
		if (team.ledger.order.length >= team.limits.teamWorks || team.reservedResultBytes + TEAM_MAX_RESULT_BYTES > team.limits.reservedResultBytes) return "the Team work ledger is full";
		return !force && this.reviewSignature(team) === team.review.signature ? "nothing changed since the last review" : undefined;
	}

	/** Deliverable and sub-task works: every work that is not a review. */
	private plainRecords(team: TeamState): WorkRecord[] {
		return team.ledger.order.map((id) => team.ledger.get(id)!.record).filter((record) => record.kind !== "review");
	}

	/** The roots a Team delivers: parent-less works other than reviews. */
	private rootRecords(team: TeamState): WorkRecord[] {
		return this.plainRecords(team).filter((record) => !record.parent);
	}

	private isReview(team: TeamState, ref: WorkRef | undefined): boolean {
		return !!ref && team.ledger.get(ref.workId)?.record.kind === "review";
	}

	private reviewSignature(team: TeamState): string {
		return this.plainRecords(team).map((record) => `${record.id}@${record.currentRevision}:${currentVersion(record).state}:${currentVersion(record).hold?.incidentId ?? ""}`).join("|");
	}

	/** Queue one review; its provisional snapshot is refreshed when an activation can actually start. */
	private startReview(team: TeamState): WorkRef {
		const reviewer = team.members.get(team.review.schedule!.by)!;
		const { task, pending } = this.captureReview(team, team.review.schedule!.focus);
		const work = this.makeWork(team, team.lead, reviewer.id, task, [], undefined, pending.snapshotAt);
		work.kind = "review";
		this.assertInputFits(team, reviewer, work);
		team.ledger.add(work);
		const ref = { workId: work.id, revision: 1 };
		this.enqueueWork(team, ref);
		team.reservedResultBytes += TEAM_MAX_RESULT_BYTES;
		if (team.review.schedule!.focus) team.review.focus.set(work.id, team.review.schedule!.focus);
		this.note(team, `review ${shortWorkRef(ref)} → ${reviewer.id}`);
		this.changed(team);
		this.check(team);
		this.requestDrain(team.id);
		return copy(ref);
	}

	private captureReview(team: TeamState, focus?: string, baseline: ReviewSnapshot["baseline"] = { finished: team.review.finished, wall: team.review.wall }): { task: string; pending: ReviewSnapshot } {
		const at = this.timestamp();
		const records = this.plainRecords(team);
		const done = records.filter((record) => isTerminalWorkState(currentVersion(record).state));
		const fresh = done.filter((record) => !baseline.finished.has(record.id));
		const state = (pick: (version: WorkVersion) => boolean) => records.filter((record) => pick(currentVersion(record))).length;
		const used: Record<string, number> = { teamWorks: team.ledger.order.length, ...team.budget.used };
		const snapshot: TeamReviewRecord["snapshot"] = {
			elapsedMs: at - team.review.startedAt,
			works: { total: records.length, resolved: state((v) => v.state === "resolved"), running: state((v) => v.state === "running"),
				blocked: state((v) => v.state === "blocked"), held: state((v) => !!v.hold), failed: state((v) => v.state === "failed"),
				cancelled: state((v) => v.state === "cancelled" || v.state === "superseded") },
			finishedSinceLast: fresh.length,
			budget: (["teamActivations", "leadActivations", "teamModelRequests", "teamToolCalls", "teamWorks"] as const)
				.map((counter) => ({ counter, used: used[counter]!, limit: team.limits[counter] })),
		};
		return { task: this.reviewTask(team, snapshot, fresh, records, at, baseline.wall, focus),
			pending: { sequence: ++team.review.sequence, baseline, snapshotAt: at, snapshot, signature: this.reviewSignature(team),
				finished: new Set(done.map((record) => record.id)), wall: Date.now() } };
	}

	/** The host-built snapshot (bounded well under 16 KiB: every list is capped and previewed) plus the instructions. */
	private reviewTask(team: TeamState, snapshot: TeamReviewRecord["snapshot"], fresh: readonly WorkRecord[], records: readonly WorkRecord[], now: number, since: number, focus?: string): string {
		const facts = this.panelFacts(team.id);
		const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
		const w = snapshot.works;
		const outcome = (record: WorkRecord) => {
			const version = currentVersion(record);
			return `- ${workRefKey({ workId: record.id, revision: record.currentRevision })} ${record.assignee} ${version.state}: `
				+ previewText(team.ledger.results.get(version.resultRef ?? "")?.result.summary ?? version.error?.message ?? version.task, 160);
		};
		const members = [...team.members.values()].map((member) => {
			const last = Math.max(0, ...records.filter((record) => record.assignee === member.id).map((record) => currentVersion(record).updatedAt));
			const doing = member.lifecycle !== "open" ? member.lifecycle : member.currentWork ? `running ${workRefKey(member.currentWork)}` : facts.retrying.get(member.id) ?? facts.stalled.get(member.id) ?? "idle";
			return `- ${member.id}${member.id === team.lead ? " (lead)" : ""} · ${doing} · ${last ? `last activity ${minutes(now - last)} ago` : "no work yet"}`;
		});
		const incidents = team.incidents.filter((incident) => incident.state === "open");
		const previous = team.review.records.at(-1);
		const finishedAt = Math.max(0, ...records.filter((record) => isTerminalWorkState(currentVersion(record).state)).map((record) => currentVersion(record).updatedAt));
		let stale = fresh.length === 0 ? 1 : 0;
		if (stale) for (const record of team.review.records.toReversed()) if (record.snapshot.finishedSinceLast === 0) stale++; else break;
		const held = records.flatMap((record) => {
			const version = currentVersion(record);
			const incident = version.hold && team.incidents.find((item) => item.id === version.hold!.incidentId);
			return incident ? [`- ${workRefKey({ workId: record.id, revision: record.currentRevision })} ${record.assignee} held ${minutes(now - incident.createdAt)} (${version.hold!.reason}): ${previewText(incident.message, 120)}`] : [];
		});
		const flow = flowRows(this.flowStats(team.id));
		const flowFacts = [`Flow: ${flow.flow}`, `Lead: ${flow.lead}`, `Waits: ${flow.waits}`, prompt("team", "review_flow_note")];
		const signals = prompt("team", "review_signals", {
			taken: new Date(now).toISOString(), lead: team.members.get(team.lead)!.activity === "idle" ? "idle" : "active", queued: String(facts.pendingEvents),
			last_finished: finishedAt ? `${minutes(now - finishedAt)} ago` : "none yet", stale: String(stale),
			held: held.length ? `${held.slice(0, 8).join("\n")}${held.length > 8 ? `\n+${held.length - 8} more` : ""}` : "none",
		});
		const timeline = formatTimeline(facts.timeline.filter((entry) => entry.at > since).slice(-25), 0, facts.timeline[0]?.at ?? 0);
		return [
			`Team progress review · elapsed ${minutes(snapshot.elapsedMs)}`,
			`Goal: ${previewText(team.plan.brief.goal, 600)}`,
			`Works (reviews excluded): ${w.total} total · resolved ${w.resolved} · running ${w.running} · blocked ${w.blocked} · held ${w.held} · failed ${w.failed} · cancelled ${w.cancelled}`,
			...(facts.waitingFor ? [`Waiting for: ${facts.waitingFor}`] : []),
			`Finished since the last review (${fresh.length}):`, ...fresh.slice(0, 12).map(outcome), ...(fresh.length > 12 ? [`+${fresh.length - 12} more`] : []),
			"Members:", ...members,
			`Open incidents: ${incidents.length ? "" : "none"}${incidents.slice(0, 5).map((incident) => `\n- ${incident.id} [${incident.code}]${incident.work ? ` ${workRefKey(incident.work)}` : ""}: ${previewText(incident.message, 160)}`).join("")}`,
			...flowFacts,
			`Budget: ${snapshot.budget.map(({ counter, used, limit }) => `${counter} ${limit >= TEAM_BUDGET_UNLIMITED ? `${used} (unlimited)` : `${Math.round(100 * used / limit)}% (${used}/${limit})`}`).join(" · ")}`,
			signals,
			...(facts.retrying.size ? [prompt("team", "review_retry_note")] : []),
			`Previous review: ${previous ? `${previous.verdict?.replace("_", " ").toUpperCase() ?? "no verdict"} — ${previewText(previous.summary, 400)}` : "none"}`,
			"Timeline since the last review (m:ss from launch):", ...timeline.map((line) => previewText(line, 200)),
			"", prompt("team", "review_instructions"),
			...(focus ? ["", prompt("team", "review_focus", { focus })] : []),
		].join("\n");
	}

	/** Store (and journal) a review's outcome; a missing result means the review work failed. */
	private recordReview(team: TeamState, member: RuntimeMember, ref: WorkRef, resultRef: string | undefined,
		result: Pick<WorkResult, "status" | "summary" | "findings" | "limitations">): TeamReviewRecord {
		const verdict = reviewVerdict(result.summary);
		const at = this.timestamp();
		const pending = team.review.pending.get(workRefKey(ref))!;
		const record: TeamReviewRecord = { id: this.modelId(team, "review"), at, snapshotAt: pending.snapshotAt, reviewedAt: at, by: member.id, work: copy(ref),
			...(resultRef ? { resultRef } : {}), status: result.status, ...(verdict ? { verdict } : {}),
			summary: previewText(result.summary, TEAM_MAX_TEXT_ITEM_BYTES), ...(result.findings ? { findings: copy(result.findings) } : {}),
			...(result.limitations ? { limitations: copy(result.limitations) } : {}), snapshot: pending.snapshot };
		this.tryJournal(team, { version: 2, kind: "review", teamId: team.id, at: record.at, review: copy(record) });
		team.review.records.push(record);
		if (team.review.records.length > TEAM_MAX_REVIEWS) team.review.records.shift();
		if (pending.sequence > team.review.reviewedSequence) {
			team.review.reviewedSequence = pending.sequence;
			team.review.signature = pending.signature;
			team.review.finished = pending.finished;
			team.review.wall = pending.wall;
		}
		team.review.pending.delete(workRefKey(ref));
		return record;
	}

	/** A member fault can end an already-started review while it waits outside its own activation. */
	private recordFailedReview(team: TeamState, member: RuntimeMember, ref: WorkRef, message: string): void {
		if (!this.isReview(team, ref) || ![...team.deliveries.values()].some((delivery) => delivery.work && sameWorkRef(delivery.work, ref))
			|| team.review.records.some((record) => sameWorkRef(record.work, ref))) return;
		this.recordReview(team, member, ref, undefined, { status: "failed", summary: message });
	}

	/**
	 * Host-only budget grant. Limits grow cumulatively and usage never resets; only budget holds
	 * whose scope is now within limits are released. Attention, pause and lead-fault holds stay.
	 */
	grantBudget(teamId: string, scopeValue: BudgetScope, incrementsValue: Partial<Record<string, number>>, reasonValue: string): HostControlReceipt {
		return this.applyBudgetGrant(teamId, scopeValue, incrementsValue, reasonValue);
	}

	/** Raise all preset limits monotonically, using the same journal and hold-release path as grants. */
	raiseBudget(teamId: string, preset: TeamBudgetPreset): HostControlReceipt {
		const increments = this.presetIncrements(teamId, preset);
		if (!Object.keys(increments).length) return { actor: "@host", status: "unchanged", teamId, lifecycle: this.team(teamId).lifecycle };
		return this.applyBudgetGrant(teamId, { kind: "team" }, increments, `Raise to ${preset}`, preset);
	}

	previewRaiseBudget(teamId: string, preset: TeamBudgetPreset): GrantPreview {
		const increments = this.presetIncrements(teamId, preset);
		return Object.keys(increments).length ? this.previewBudgetGrant(teamId, { kind: "team" }, increments, preset)
			: { scope: { kind: "team" }, changes: [], released: [] };
	}

	private presetIncrements(teamId: string, preset: TeamBudgetPreset): Partial<TeamBudgetLimits> {
		const team = this.team(teamId);
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		const target = TEAM_BUDGET_PRESETS[normalizeTeamBudgetPreset(preset)];
		return Object.fromEntries((Object.keys(target) as Array<keyof TeamBudgetLimits>)
			.filter((key) => target[key] > team.limits[key]).map((key) => [key, target[key] - team.limits[key]]));
	}

	private applyBudgetGrant(teamId: string, scopeValue: BudgetScope, incrementsValue: Partial<Record<string, number>>, reasonValue: string, preset?: TeamBudgetPreset): HostControlReceipt {
		const team = this.team(teamId);
		const reason = this.hostText(reasonValue, "grant reason");
		if (Buffer.byteLength(reason, "utf8") > TEAM_MAX_GRANT_REASON_BYTES) fail("INVALID_ARGUMENT", `grant reason exceeds ${TEAM_MAX_GRANT_REASON_BYTES} bytes`);
		const at = this.timestamp();
		const id = this.id("grant");
		// Validate the whole grant first, so journal and apply are atomic.
		const scope = this.validateHostGrant(team, scopeValue, incrementsValue, { id, reason, at, ...(preset ? { preset } : {}) });
		const grant = { id, actor: "@host" as const, scope, increments: copy(incrementsValue), reason, at, ...(preset ? { preset } : {}) };
		if (!this.tryJournal(team, { version: 2, kind: "grant", teamId, at, grant })) {
			this.applyJournalFailure(team);
			fail("PROTOCOL_FAILURE", "Budget grant could not be written to the Team journal");
		}
		team.budget.grant(grant);
		const released = this.releaseBudgetHolds(team);
		this.addEvent(team, { key: `host-grant:${id}`, kind: "USER_COMMAND", actor: "@host",
			message: prompt("team", "event_budget_granted", { scope: scope.kind === "team" ? "the Team" : `root ${scope.rootId}`, reason }) });
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
		return this.previewBudgetGrant(teamId, scopeValue, incrementsValue);
	}

	private previewBudgetGrant(teamId: string, scopeValue: BudgetScope, incrementsValue: Partial<Record<string, number>>, preset?: TeamBudgetPreset): GrantPreview {
		const team = this.team(teamId);
		const record = { id: "preview", reason: "preview", at: this.timestamp(), ...(preset ? { preset } : {}) };
		const scope = this.validateHostGrant(team, scopeValue, incrementsValue, record);
		const proposed = team.budget.clone();
		proposed.grant({ ...record, scope, increments: copy(incrementsValue) });
		const rootUsed = scope.kind === "root" ? { ...team.budget.rootUsed(scope.rootId), rootChildren: this.rootChildCount(team, scope.rootId) } : undefined;
		const budget = this.inspectBudget(teamId);
		const records = team.ledger.order.map((id) => team.ledger.get(id)!.record);
		const members = [...team.members.values()];
		const used: Partial<TeamBudgetLimits> = { ...budget.used,
			workRevisions: Math.max(0, ...records.map((record) => record.versions.length)),
			depth: Math.max(0, ...records.map((record) => record.depth)),
			workPermits: this.usedWorkPermits(team),
			memberUnresolvedWork: Math.max(0, ...members.map((member) => records.filter((record) => record.assignee === member.id && !isTerminalWorkState(currentVersion(record).state)).length)),
		};
		for (const counter of ROOT_GRANTABLE_COUNTERS) used[counter] = Math.max(0, ...budget.roots.map((root) => root.used[counter]));
		const changes = Object.keys(incrementsValue).map((counter) => scope.kind === "team"
			? { counter, used: used[counter as keyof TeamBudgetLimits] ?? 0,
				limit: team.limits[counter as keyof TeamBudgetLimits], proposed: proposed.limits[counter as keyof TeamBudgetLimits] }
			: { counter, used: rootUsed![counter as keyof typeof rootUsed & string] ?? 0,
				limit: team.budget.rootLimit(scope.rootId, counter as RootGrantCounter), proposed: proposed.rootLimit(scope.rootId, counter as RootGrantCounter) });
		const released = this.budgetHeld(team).filter(({ rootId, lead }) => !proposed.exhausted(rootId, lead)).map(({ work }) => work);
		return { scope, changes, released };
	}

	/** Host inspection of every root budget (the Team view is a bounded summary). */
	inspectBudget(teamId: string): { limits: TeamBudgetLimits; used: TeamBudgetView["used"]; roots: TeamRootBudgetView[]; grants: TeamBudgetGrantView[] } {
		const team = this.team(teamId);
		const { rootBudgets } = this.workCounts(team);
		return { limits: copy(team.limits), used: { teamWorks: team.ledger.order.length, ...copy(team.budget.used), reservedResultBytes: team.reservedResultBytes },
			roots: rootBudgets, grants: copy(team.budget.grants) };
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

	/** Remove an ended Team after its member sessions have been deleted. */
	forgetTeam(teamId: string): void {
		const team = this.team(teamId);
		if (!["closed", "failed", "cancelled", "interrupted"].includes(team.lifecycle)
			|| [...team.members.values()].some((member) => member.resourceState !== "released")) {
			fail("INVALID_ARGUMENT", `Team ${teamId} has not ended with all members released; cancel it first`);
		}
		this.teams.delete(teamId);
		this.executors.delete(teamId);
	}

	/** Host observation, coalesced to one call per Team per microtask; listeners must only read. */
	onChange(listener: (teamId: string) => void): () => void {
		this.changeListeners.add(listener);
		return () => { this.changeListeners.delete(listener); };
	}

	private validateHostGrant(team: TeamState, scopeValue: BudgetScope, incrementsValue: Partial<Record<string, number>>,
		record: { id: string; reason: string; at: number; preset?: TeamBudgetPreset }): BudgetScope {
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

	private budgetHeld(team: TeamState): Array<{ work: WorkRef; rootId: string; lead: boolean }> {
		return team.ledger.order.flatMap((id) => {
			const entry = team.ledger.get(id)!;
			const version = currentVersion(entry.record);
			return version.state === "blocked" && version.hold?.reason === "budget"
				? [{ work: { workId: id, revision: entry.record.currentRevision }, rootId: entry.record.rootId, lead: entry.record.assignee === team.lead }] : [];
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
			const lead = entry.record.assignee === team.lead;
			if (team.budget.exhausted(entry.record.rootId, lead)) continue;
			delete version.hold;
			version.state = "queued";
			version.updatedAt = this.timestamp();
			if (!team.ready.some((item) => sameWorkRef(item, ref))) this.enqueueWork(team, ref);
			released.push(copy(ref));
		}
		for (const incident of team.incidents) {
			if (incident.state !== "open" || incident.code !== "BUDGET_HIT") continue;
			const lifted = incident.rootId && !incident.work ? !team.budget.rootExhausted(incident.rootId)
				: !team.budget.teamExhausted(true);
			const stillHeld = team.ledger.order.some((id) => team.ledger.current(id)?.hold?.incidentId === incident.id);
			if (lifted && !stillHeld) incident.state = "resolved";
		}
		this.refreshHealth(team);
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

	setMemberContextWindow(teamId: string, memberId: string, window: number): void {
		const member = this.team(teamId).members.get(memberId);
		if (member) member.nativeContextWindow = window;
	}

	compactMember(teamId: string, memberId: string, instructions?: string): Extract<HostControlReceipt, { memberId: string }> {
		const team = this.team(teamId);
		if (instructions !== undefined && (typeof instructions !== "string" || Buffer.byteLength(instructions, "utf8") > 2048)) fail("INVALID_ARGUMENT", "Compaction instructions must be at most 2 KiB");
		const compaction = this.requestCompaction(team, memberId, { trigger: "host", ...(instructions !== undefined ? { instructions } : {}) });
		return { actor: "@host", status: "applied", teamId, memberId, compaction };
	}

	private memberContext(member: RuntimeMember): TeamMemberView["context"] {
		const window = member.policy.contextWindow ?? member.nativeContextWindow;
		return window ? { used: member.usage.contextTokens, window, percent: Math.round(member.usage.contextTokens / window * 100) } : undefined;
	}

	private requestCompaction(team: TeamState, memberId: string, request: CompactionRequest): "started" | "scheduled" {
		const member = team.members.get(memberId);
		if (!member) fail("UNKNOWN_MEMBER", `Unknown member ${memberId}`);
		if (member.lifecycle !== "open") fail("MEMBER_UNAVAILABLE", `Member ${memberId} is ${member.lifecycle}`);
		if (member.compaction?.state === "running") member.pendingCompaction = request;
		else member.compaction = { ...request, state: "pending" };
		const started = this.startCompaction(team, member);
		this.changed(team);
		this.requestDrain(team.id);
		return started ? "started" : "scheduled";
	}

	private thresholdCompaction(team: TeamState, member: RuntimeMember): boolean {
		const threshold = readCompactThreshold();
		const context = this.memberContext(member);
		if (member.compactedAtBoundary || threshold === null || !context || context.used / context.window * 100 < threshold) return false;
		this.requestCompaction(team, member.id, { trigger: "threshold" });
		return true;
	}

	private startCompaction(team: TeamState, member: RuntimeMember): boolean {
		const request = member.compaction;
		const executor = this.executors.get(team.id);
		if (!request || request.state !== "pending" || member.active || member.lifecycle !== "open"
			|| !["active", "closing"].includes(team.lifecycle) || (team.hostPause && request.trigger !== "host") || !executor?.compactMember) return false;
		request.state = "running";
		member.compactedAtBoundary = true;
		const before = member.usage.contextTokens;
		void Promise.resolve().then(() => member.compaction === request
			? executor.compactMember!(this.binding(team, member), request.instructions) : { ok: false as const, error: "Compaction cancelled" })
			.catch((error: unknown): CompactionResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
			.then((result) => {
				if (member.compaction !== request) return;
				if (result.ok) {
					if (result.usage) this.foldUsage(team, member, result.usage);
					if (result.tokensAfter !== undefined) member.usage.contextTokens = result.tokensAfter;
					const tokensBefore = result.tokensBefore ?? before;
					member.lastCompaction = { tokensBefore, ...(result.tokensAfter !== undefined ? { tokensAfter: result.tokensAfter } : {}) };
					this.note(team, `${member.id} compacted (${request.trigger}) ${tokensBefore}→${result.tokensAfter ?? "?"}`);
					// A done report needs no decision, so it waits for the lead's next batch; a failure wakes the lead.
					if (request.trigger === "lead") this.addEvent(team, { key: `compaction:${this.newId()}`, kind: "COMPACTION", memberId: member.id, passive: true,
						message: prompt("team", "compaction_done", { member: member.id, before: tokenText(tokensBefore), after: result.tokensAfter === undefined ? "?" : tokenText(result.tokensAfter) }) });
				} else {
					this.note(team, `${member.id} compaction failed (${request.trigger}): ${result.error}`);
					if (request.trigger === "lead") this.addEvent(team, { key: `compaction:${this.newId()}`, kind: "COMPACTION", memberId: member.id,
						message: prompt("team", "compaction_failed", { member: member.id, reason: result.error }) });
				}
				if (member.pendingCompaction) member.compaction = { ...member.pendingCompaction, state: "pending" };
				else delete member.compaction;
				delete member.pendingCompaction;
				this.changed(team);
				this.requestDrain(team.id);
			});
		return true;
	}

	private scheduleOverflow(team: TeamState, member: RuntimeMember, active: ActiveActivation): boolean {
		if (!active.native?.overflow || active.intent || member.lifecycle !== "open" || team.lifecycle !== "active") return false;
		const key = active.scope.work ? workRefKey(active.scope.work) : "events";
		if (member.overflowRecoveries?.has(key)) return false;
		(member.overflowRecoveries ??= new Set()).add(key);
		member.compaction = { trigger: "overflow", state: "pending" };
		this.note(team, `${member.id} context overflow; compacting before redelivery`);
		return true;
	}

	private reserveNextActivation(teamId: string): RuntimeActivation | undefined {
		const team = this.team(teamId);
		if (team.lifecycle !== "active") return undefined;
		const lead = team.members.get(team.lead)!;
		if (lead.lifecycle !== "open") return undefined;
		// Before the lead's work turn is decided: a work held here raises its event in this same pass.
		this.holdUnknownDependencies(team);
		if (team.budget.teamExhausted(false)) {
			// Advisory mail is not a Work obligation: once no new ordinary activation can run,
			// close its idle recipients' pending mail explicitly instead of forcing a host grant.
			for (const member of team.members.values()) if (!member.active) this.failMessages(team, member, "Team budget cannot admit a mailbox activation");
		}
		team.ready = team.ready.filter((ref) => this.isReady(team, ref));
		for (const key of team.interrupted) if (!team.ready.some((ref) => workRefKey(ref) === key)) team.interrupted.delete(key);
		if (!lead.active && !lead.compaction && lead.pause === "none" && !this.retryWaitMs(lead)) {
			const pendingEvents = () => team.events.map((event, index) => ({ event, index }))
				.filter(({ event }) => !event.processed && event.batchId === undefined && (event.recipient ?? team.lead) === lead.id)
				.sort((left, right) => this.eventPriority(left.event.kind) - this.eventPriority(right.event.kind)
					|| Number(!!left.event.passive) - Number(!!right.event.passive) || left.index - right.index)
				.slice(0, TEAM_MAX_EVENT_BATCH)
				.map(({ event }) => event);
			const events = pendingEvents();
			// After an events activation, a runnable lead work goes first unless a fault, budget or host event waits:
			// a steady stream of result events must not starve the lead's own (usually unblocking) work.
			const workTurn = lead.lastActivationKind === "events" && events.every((event) => this.eventPriority(event.kind) > 1)
				&& this.hasRunnableLeadWork(team);
			// Passive reports alone never wake the lead; the sort puts any waking event first.
			if (events.length && !events[0]!.passive && !workTurn) {
				const exhausted = team.budget.teamExhausted(true);
				// An exhausted lead gets a bounded number of restricted emergency activations; after
				// that only the host can grant or cancel. Members with remaining budget keep running.
				if (exhausted) this.budgetIncident(team, exhausted);
				if (!exhausted || team.budget.emergencyAvailable()) {
					// requestCompaction schedules another drain pass, so workers still start right after.
					if (this.thresholdCompaction(team, lead)) return undefined;
					lead.compactedAtBoundary = false;
					const activation = this.reserveEvents(team, lead, pendingEvents(), exhausted !== undefined);
					this.check(team);
					return activation;
				}
			}
		}
		const workPermits = this.usedWorkPermits(team);
		if (!team.mailboxLast) {
			const mailbox = this.reserveMailbox(team, workPermits);
			if (mailbox) return mailbox;
		}
		for (const ref of this.readyOrder(team)) {
			const entry = team.ledger.get(ref.workId)!;
			const member = team.members.get(entry.record.assignee)!;
			if (member.lifecycle !== "open" || member.pause !== "none" || member.active || member.compaction || this.retryWaitMs(member)) continue;
			if (this.needsWorkPermit(team, member) && workPermits >= team.limits.workPermits) continue;
			const exhausted = team.budget.exhausted(entry.record.rootId, member.id === team.lead);
			if (exhausted) {
				this.holdForBudget(team, ref, exhausted);
				continue;
			}
			if (this.thresholdCompaction(team, member)) continue;
			member.compactedAtBoundary = false;
			const activation = this.reserveWork(team, member, ref);
			if (member.id !== team.lead) team.mailboxLast = false;
			this.dequeueWork(team, ref);
			team.interrupted.delete(workRefKey(ref));
			this.check(team);
			return activation;
		}
		const mailbox = this.reserveMailbox(team, workPermits);
		if (mailbox) return mailbox;
		this.check(team);
		return undefined;
	}

	private reserveMailbox(team: TeamState, workPermits: number): RuntimeActivation | undefined {
		if (workPermits >= team.limits.workPermits || team.budget.teamExhausted(false)) return undefined;
		// Global event order is FIFO between recipients; mailbox and Work admissions alternate.
		for (const event of team.events) {
			if (event.processed || event.batchId || !event.recipient || event.recipient === team.lead) continue;
			const member = team.members.get(event.recipient)!;
			if (member.lifecycle !== "open" || member.pause !== "none" || member.active || member.compaction || this.retryWaitMs(member)) continue;
			if (this.thresholdCompaction(team, member)) continue;
			member.compactedAtBoundary = false;
			const messages = team.events.filter((message) => !message.processed && !message.batchId && message.recipient === member.id).slice(0, TEAM_MAX_EVENT_BATCH);
			const activation = this.reserveEvents(team, member, messages, false);
			team.mailboxLast = true;
			this.check(team);
			return activation;
		}
		return undefined;
	}

	private isReady(team: TeamState, ref: WorkRef): boolean {
		const version = team.ledger.version(ref);
		return !!team.ledger.get(ref.workId) && version?.state === "queued" && sameWorkRef(team.ledger.currentRef(ref.workId)!, ref);
	}

	/**
	 * The order in which ready works compete for members and work permits (stable within a class):
	 * 0. works interrupted by a transient-error retry or overflow recovery: they had a permit already;
	 * 1. works named by an un-held blocked work's dependency wait: finishing them unblocks someone;
	 * 2. continuations (a checkpoint or observed outcomes from an earlier activation), revisions of already assigned work,
	 *    and works queued for READY_AGING_MS;
	 * 3. other fresh works, first come first served.
	 * A member's blocked work never sits in the ready list, so it never holds back that member's later works.
	 */
	private readyOrder(team: TeamState): WorkRef[] {
		if (team.ready.length < 2) return [...team.ready];
		const waitedOn = new Set<string>();
		for (const id of team.ledger.order) {
			const version = team.ledger.version(team.ledger.currentRef(id)!)!;
			// A held waiter stays held whatever it waits on, so it confers no priority.
			if (version.state === "blocked" && !version.hold) for (const ref of version.waitingFor) waitedOn.add(workRefKey(ref));
		}
		const now = this.timestamp();
		const rank = (ref: WorkRef): number => {
			const key = workRefKey(ref);
			if (team.interrupted.has(key)) return 0;
			if (waitedOn.has(key)) return 1;
			const version = team.ledger.version(ref)!;
			return version.checkpoint !== undefined || version.observedOutcomes.length || ref.revision > 1
				|| now - version.updatedAt >= READY_AGING_MS ? 2 : 3;
		};
		return team.ready.map((ref, index) => ({ ref, index, rank: rank(ref) }))
			.sort((left, right) => left.rank - right.rank || left.index - right.index)
			.map(({ ref }) => ref);
	}

	/** The lead is one serial actor whose activations (events or work) share one slot outside workPermits. */
	private needsWorkPermit(team: TeamState, member: RuntimeMember): boolean {
		return member.id !== team.lead;
	}

	/** A queued lead work the work loop below would start now (not budget-held). */
	private hasRunnableLeadWork(team: TeamState): boolean {
		return team.ready.some((ref) => {
			const entry = team.ledger.get(ref.workId);
			return entry?.record.assignee === team.lead && this.isReady(team, ref) && !team.budget.exhausted(entry.record.rootId, true);
		});
	}

	private eventPriority(kind: TeamEventView["kind"]): number {
		if (kind === "MEMBER_FAULTED" || kind === "BUDGET_HIT") return 0;
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
			if (delivery.signalOutcomes?.length) {
				version!.observedSignals = [...new Set([...(version!.observedSignals ?? []), ...delivery.signalOutcomes])];
				version!.waitingForSignals = version!.waitingForSignals?.filter((id) => !delivery.signalOutcomes!.includes(id)) ?? [];
			}
			const undelivered = this.pendingChildIssues(team, version!).filter((issue) => !delivery.childIssueIds?.includes(issue.incidentId));
			if (undelivered.length) version!.childIssues = undelivered;
			else delete version!.childIssues;
			version!.updatedAt = this.timestamp();
		}
		active.inputReady = true;
		this.changed(team);
		this.check(team);
		return okReply(member.id);
	}

	/** Synchronous permission check used by tool_call preflight and pure Runtime tests. */
	gate(bindingValue: BindingV2, scopeValue: ActivationScope, phase: "provider_gate" | "tool_gate",
		toolCallId?: string, toolName?: string, endIntent = false, inputHash?: string): GateDecision {
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
		// A call that already failed TEAM_LOOP_REPEATS times in a row is not run again (the lead's events activation has no hold to fall back on).
		if (decision.allow && phase === "tool_gate" && active.loop?.count === TEAM_LOOP_REPEATS && active.loop.key === loopKey(toolName!, inputHash)) {
			decision = this.loopDenial(toolName!);
		}
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
		if (decision.allow && phase === "tool_gate" && scope.kind === "events" && member.id !== team.lead && toolName !== "team") {
			decision = { allow: false, reason: "policy_stop", message: "Mailbox activations only communicate; base tools require a Work activation" };
		}
		if (nativeToolCallId) {
			active.toolCalls.set(nativeToolCallId, { toolName: toolName ?? "", ...(inputHash ? { inputHash } : {}), allowed: decision.allow, ...(!decision.allow ? { denial: decision } : {}) });
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

	private loopDenial(tool: string): GateDecision {
		return { allow: false, reason: "policy_stop", message: prompt("team", "tool_loop_denied", { tool, count: String(TEAM_LOOP_REPEATS) }) };
	}

	private budgetMessage(exhausted: BudgetExhaustion): string {
		return `${exhausted.scope.kind === "root" ? `Root ${exhausted.scope.rootId}` : "Team"} budget ${exhausted.counter} is exhausted`;
	}

	private activationRootId(team: TeamState, active: ActiveActivation): string | undefined {
		return active.scope.kind === "work" ? team.ledger.get(active.scope.work!.workId)?.record.rootId : undefined;
	}

	/** Diagnostic only: resolved at creation, it neither wakes the lead nor blocks a close. */
	private recordPostIntentContinuation(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		if (active.postIntentContinuations++ > 0) return;
		const work = active.scope.kind === "work" ? active.scope.work : undefined;
		const rootId = work ? team.ledger.get(work.workId)?.record.rootId : undefined;
		team.incidents.push({ id: this.modelId(team, "incident"), code: "POST_INTENT_CONTINUATION", state: "resolved", createdAt: this.timestamp(),
			message: "A native continuation followed a staged end intent; business side effects were refused and the intent was kept",
			...(work ? { work: copy(work) } : {}), ...(rootId ? { rootId } : {}), memberId: member.id });
		this.changed(team);
	}

	/** Provider gates park a paused activation until resume has reacquired a work permit. */
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
		if (!active || !sameScope(active.scope, scope)) return Promise.resolve(decision);
		if (active.providerGatePromise) return active.providerGatePromise;
		active.providerGatePending = true;
		active.providerGatePromise = new Promise<GateDecision>((resolve) => { active.providerGateResolve = resolve; });
		this.tryParkAtProviderGate(team, member, active);
		return active.providerGatePromise;
	}

	/** A real native tool_result closes only the exact preflighted tool-call slot. */
	toolResult(bindingValue: BindingV2, scopeValue: ActivationScope, toolCallId: string, toolName: string, isError?: boolean): TeamReply {
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
		// Tool loop: the same call (tool + input) failing again and again. A call denied at the gate is not a real result.
		const key = loopKey(call.toolName, call.inputHash);
		if (!call.denial) {
			if (!isError || key === undefined) delete active.loop;
			else {
				active.loop = { key, count: active.loop?.key === key ? active.loop.count + 1 : 1 };
				if (active.loop.count === TEAM_LOOP_REPEATS) {
					this.note(team, `${member.id} tool loop: ${call.toolName} failed ${TEAM_LOOP_REPEATS}× with the same input`);
					if (active.scope.kind === "work") {
						active.loopStop = { tool: call.toolName };
						active.completionReason ??= "loop_hold";
					}
				}
			}
		}
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
		if (active.loopStop) return this.loopDenial(active.loopStop.tool);
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
			return { allow: false, reason: "stale_scope", message: "The active Team event batch is no longer current" };
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
		this.endFlow(team, active);
		active.workPermitHeld = false;
		this.setMemberPause(team, member, "confirmed");
		this.changed(team);
		this.requestDrain(team.id);
	}

	private usedWorkPermits(team: TeamState): number {
		return [...team.members.values()].filter((member) => member.active?.workPermitHeld).length;
	}

	/** Account flow time up to now; every change of running activations or held work permits calls this first. */
	private tickFlow(team: TeamState): void {
		tickFlow(team.flow, this.timestamp(), (team.lifecycle === "active" || team.lifecycle === "closing") && !team.hostPause, team.limits.workPermits);
	}

	private startFlow(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		this.tickFlow(team);
		active.flowRole = member.id === team.lead ? "lead" : "worker";
		if (active.flowRole === "lead") team.flow.leads++;
		else team.flow.workers++;
		if (active.workPermitHeld) team.flow.slots++;
	}

	/** Idempotent: a retained unknown activation can be ended again by the exit confirmation. */
	private endFlow(team: TeamState, active: ActiveActivation): void {
		if (!active.flowRole) return;
		this.tickFlow(team);
		if (active.flowRole === "lead") team.flow.leads--;
		else team.flow.workers--;
		if (active.workPermitHeld) team.flow.slots--;
		delete active.flowRole;
	}

	/** Team active clock excluding this member's explicit/safety pauses, not time spent on another work. */
	private readyClock(team: TeamState, member: RuntimeMember): number {
		return team.flow.activeMs - (member.flowPausedMs ?? 0)
			- (member.flowPauseAt === undefined ? 0 : team.flow.activeMs - member.flowPauseAt);
	}

	private setMemberPause(team: TeamState, member: RuntimeMember, pause: MemberRecord["pause"]): void {
		this.tickFlow(team);
		if (member.pause === "none" && pause !== "none") member.flowPauseAt = team.flow.activeMs;
		else if (member.pause !== "none" && pause === "none" && member.flowPauseAt !== undefined) {
			member.flowPausedMs = (member.flowPausedMs ?? 0) + team.flow.activeMs - member.flowPauseAt;
			delete member.flowPauseAt;
		}
		member.pause = pause;
	}

	/** Queue bookkeeping only: priorities, permits and admission remain the scheduler's decision. */
	private enqueueWork(team: TeamState, ref: WorkRef): void {
		team.ready.push(copy(ref));
		if (team.ledger.get(ref.workId)!.record.kind === "review") return;
		this.tickFlow(team);
		const key = workRefKey(ref);
		// An issue/explicit hold release may requeue the consumer before its dependencies finish.
		if (team.flow.waiting.has(key) && !team.ledger.version(ref)!.waitingFor.every((dependency) => team.ledger.outcomeReady(dependency))) team.flow.waiting.delete(key);
		const ready = team.flow.ready.get(key) ?? { ms: 0 };
		ready.since ??= this.readyClock(team, team.members.get(team.ledger.get(ref.workId)!.record.assignee)!);
		team.flow.ready.set(key, ready);
	}

	private dequeueWork(team: TeamState, ref: WorkRef): void {
		team.ready = team.ready.filter((queued) => !sameWorkRef(queued, ref));
		const key = workRefKey(ref);
		const ready = team.flow.ready.get(key);
		const version = team.ledger.version(ref)!;
		if (isTerminalWorkState(version.state)) {
			team.flow.ready.delete(key);
			team.flow.waiting.delete(key);
			team.flow.committedAt.delete(key);
		} else if (ready?.since !== undefined) {
			this.tickFlow(team);
			ready.ms += Math.max(0, this.readyClock(team, team.members.get(team.ledger.get(ref.workId)!.record.assignee)!) - ready.since);
			delete ready.since;
		}
		if (!version.waitingFor.length) team.flow.waiting.delete(key);
	}

	/** Record ready time separately for first starts and continuations; dependency time never leaks into it. */
	private flowWorkStarted(team: TeamState, ref: WorkRef): number | undefined {
		if (team.ledger.get(ref.workId)!.record.kind === "review") return;
		const flow = team.flow;
		const key = workRefKey(ref);
		const ready = flow.ready.get(key);
		let ms: number | undefined;
		if (ready) {
			const now = this.readyClock(team, team.members.get(team.ledger.get(ref.workId)!.record.assignee)!);
			ms = ready.ms + (ready.since === undefined ? 0 : Math.max(0, now - ready.since));
			pushFlow(flow.started.has(key) ? flow.resumeDelays : flow.startDelays, ms);
		}
		flow.started.add(key);
		flow.ready.delete(key);
		// A child issue can wake a consumer before all dependencies finish. That interrupted wait has no completed sample.
		flow.waiting.delete(key);
		return ms;
	}

	/** Close at outcome readiness, not consumer restart. Never infer completion order from mutable updatedAt. */
	private flowDependenciesReady(team: TeamState): void {
		if (!team.flow.waiting.size) return;
		this.tickFlow(team);
		for (const [key, wait] of team.flow.waiting) {
			if (wait.refs.some((ref) => this.isUnknownOutcome(team, ref))) {
				// A lost outcome requires a policy decision, not a completed dependency-wait sample.
				team.flow.waiting.delete(key);
				continue;
			}
			const ready = wait.refs.filter((ref) => team.ledger.outcomeReady(ref));
			wait.refs = wait.refs.filter((ref) => !team.ledger.outcomeReady(ref));
			if (wait.refs.length) continue;
			team.flow.waiting.delete(key);
			const ms = Math.max(0, team.flow.activeMs - wait.since);
			pushFlow(team.flow.waitDurations, ms);
			team.flow.completedWaits++;
			const members = new Set(ready.map((ref) => team.ledger.get(ref.workId)!.record.assignee));
			// A simultaneous batch has no unique last member; retain the wait sample without fabricating attribution.
			if (members.size !== 1) continue;
			const member = [...members][0]!;
			const total = team.flow.waitsByMember.get(member) ?? { count: 0, ms: 0 };
			team.flow.waitsByMember.set(member, { count: total.count + 1, ms: total.ms + ms });
		}
	}

	/** Flow metrics for the Progress tab, the final text and the review snapshot. */
	flowStats(teamId: string): TeamFlowStats {
		const team = this.team(teamId);
		this.tickFlow(team);
		const records = this.plainRecords(team);
		const finished = records.filter((record) => isTerminalWorkState(currentVersion(record).state)).length;
		const usage = this.teamUsage(team);
		const tokens = usage.input + usage.output + usage.cacheRead;
		let queuedCount = 0;
		let oldest: { ms: number; assignee: string } | undefined;
		if (team.lifecycle === "active") for (const ref of team.ready) {
			const entry = team.ledger.get(ref.workId);
			const version = team.ledger.version(ref);
			if (!entry || !version || version.state !== "queued" || entry.record.kind === "review" || !sameWorkRef(team.ledger.currentRef(ref.workId)!, ref)) continue;
			queuedCount++;
			const ready = team.flow.ready.get(workRefKey(ref));
			const member = team.members.get(entry.record.assignee)!;
			const ms = ready ? ready.ms + (ready.since === undefined ? 0 : Math.max(0, this.readyClock(team, member) - ready.since)) : 0;
			if (!oldest || ms > oldest.ms) oldest = { ms, assignee: entry.record.assignee };
		}
		const slotLimit = team.limits.workPermits;
		const permitLimited = oldest?.assignee !== team.lead && this.usedWorkPermits(team) >= slotLimit;
		const oldestMember = oldest && team.members.get(oldest.assignee);
		const reason = team.hostPause ? "host paused" : oldestMember?.pause !== undefined && oldestMember.pause !== "none" ? "member paused"
			: oldestMember && this.retryWaitMs(oldestMember) ? "retry backoff" : oldestMember?.compaction ? "compacting"
			: oldestMember?.active ? "member busy" : permitLimited ? "slots full" : "starting";
		const members = [...team.members.values()].filter((member) => member.usage.contextTokens > 0);
		const largest = members.reduce<RuntimeMember | undefined>((top, member) => !top || member.usage.contextTokens > top.usage.contextTokens ? member : top, undefined);
		return flowStats(team.flow, this.timestamp(), { slotLimit, pausedMs: team.pausedMs + (team.hostPause ? Math.max(0, (team.endedAt ?? this.timestamp()) - team.hostPause.at) : 0), pendingEvents: this.pendingLeadEvents(team),
			queued: oldest ? { count: queuedCount, oldestMs: oldest.ms, reason } : undefined,
			tokensPerWork: finished ? tokens / finished : undefined,
			context: largest ? { member: largest.id, tokens: largest.usage.contextTokens } : undefined });
	}

	private pendingLeadEvents(team: TeamState): number {
		return team.lifecycle === "active" ? team.events.filter((event) => !event.processed && event.batchId === undefined && !event.passive && (event.recipient ?? team.lead) === team.lead).length : 0;
	}

	/** Parked native gates have priority over new work when a work permit becomes available. */
	private resumeParkedActivations(team: TeamState): void {
		if (team.lifecycle !== "active" || team.members.get(team.lead)?.lifecycle !== "open") return;
		let permits = this.usedWorkPermits(team);
		for (const member of team.members.values()) {
			const active = member.active;
			if (!active?.parked || !active.resumeRequested) continue;
			if (member.lifecycle !== "open" || active.stopReason) continue;
			if (this.needsWorkPermit(team, member)) {
				// Full permits stop only other workers; the lead's parked run needs none.
				if (permits >= team.limits.workPermits) continue;
				permits++;
				this.tickFlow(team);
				active.workPermitHeld = true;
			}
			this.startFlow(team, member, active);
			active.parked = false;
			active.resumeRequested = false;
			this.setMemberPause(team, member, "none");
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

	/** Settle a parked/pending provider gate exactly once; it no longer holds a work permit. */
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

	/** The deadline, the review timer and the retry timers all end with the Team. */
	private clearDeadline(teamId: string): void {
		const timer = this.deadlineTimers.get(teamId);
		if (timer) clearTimeout(timer);
		this.deadlineTimers.delete(teamId);
		const team = this.team(teamId);
		this.clearReview(team);
		for (const memberId of team.members.keys()) {
			clearTimeout(this.retryTimers.get(`${teamId}\0${memberId}`));
			this.retryTimers.delete(`${teamId}\0${memberId}`);
		}
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
		let team: TeamState | undefined;
		try {
			const binding = this.validateBinding(bindingValue);
			memberId = binding.memberId;
			team = this.team(binding.teamId);
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
				team.toolErrors++;
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
			if (team) team.toolErrors++;
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
		if (completion.status === "success") delete member.retry;
		// Usage is folded exactly once, at the first accepted settlement of this activation.
		this.foldActiveTime(team, member, active);
		if (completion.usage) this.foldUsage(team, member, completion.usage, active.scope.work);
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
		this.foldActiveTime(team, member, active);
		if (usage && this.isValidUsage(usage)) this.foldUsage(team, member, usage, active.scope.work);
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
		this.failMessages(team, member, "Recipient transport was lost");
		this.endFlow(team, active);
		delete member.active;
		delete member.currentWork;
		this.resumeParkedActivations(team);
		team.health = "needs_attention";
		if (team.lifecycle === "closing") {
			team.lifecycle = "failed";
			team.reason = "Team member transport failed before native settlement";
		}
		if (member.id === team.lead) {
			this.holdLeadWork(team);
			this.pauseMembersForLeadFault(team);
		} else this.failMemberWork(team, member, ref);
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

	/** Explicit host observation for the fakeable resource-close boundary. */
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
			key: `member-closed:${member.id}:${closeId}`, kind: "MEMBER_CLOSED", message: prompt("team", "event_member_closed", { member: member.id }), memberId: member.id,
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
		if (member.active) this.endFlow(team, member.active);
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

	/** Host-only title change; history records may be renamed after their Team ends. */
	renameTeam(teamId: string, title: string): TeamTeamView {
		const team = this.team(teamId);
		const normalized = normalizeTitle(title, "");
		if (team.lifecycle !== "prepared") this.writeJournal(team, { version: 2, kind: "title", teamId, at: this.timestamp(), title: normalized });
		team.plan.title = normalized;
		this.changed(team);
		return this.view(team);
	}

	/** The driver supplies only the not-yet-settled native usage; no ledger mutation is involved. */
	setLiveUsageSource(source: (teamId: string, memberId: string) => SubagentUsage | undefined): void {
		this.liveUsage = source;
	}

	teamTime(teamId: string): { activeMs: number; wallMs: number; pausedMs: number; startedAt: number; endedAt?: number } {
		const team = this.team(teamId);
		this.tickFlow(team);
		const at = team.endedAt ?? this.timestamp();
		const startedAt = team.startedAt ?? team.createdAt;
		return { activeMs: team.flow.activeMs, wallMs: team.startedAt === undefined ? 0 : Math.max(0, at - startedAt),
			pausedMs: team.pausedMs + (team.hostPause ? Math.max(0, at - team.hostPause.at) : 0), startedAt,
			...(team.endedAt !== undefined ? { endedAt: team.endedAt } : {}) };
	}

	memberStats(teamId: string, memberId: string): { activeMs: number; usage: SubagentUsage } {
		const team = this.team(teamId);
		const member = team.members.get(memberId);
		if (!member) fail("UNKNOWN_MEMBER", `Unknown member ${memberId}`);
		this.tickFlow(team);
		const active = member.active;
		const usage = copy(member.usage);
		const live = active && !active.native && !active.activeTimeFolded ? this.liveUsage?.(teamId, memberId) : undefined;
		if (live) addActivationUsage(usage, live);
		return { activeMs: member.activeMs + (active && !active.activeTimeFolded ? Math.max(0, team.flow.activeMs - active.startedActiveMs) : 0), usage };
	}

	/** Work IDs survive revisions; totals include every native activation of all their versions. */
	workStats(teamId: string, work: WorkRef): { activeMs: number; usage: SubagentUsage } {
		const team = this.team(teamId);
		if (!team.ledger.version(work)) fail("UNKNOWN_WORK", `Unknown work ${workRefKey(work)}`);
		this.tickFlow(team);
		const stats = copy(this.settledWorkStats(team, work.workId));
		for (const member of team.members.values()) {
			const active = member.active;
			if (!active || active.scope.work?.workId !== work.workId || active.activeTimeFolded) continue;
			stats.activeMs += Math.max(0, team.flow.activeMs - active.startedActiveMs);
			const live = this.liveUsage?.(teamId, member.id);
			if (live) addActivationUsage(stats.usage, live);
		}
		return stats;
	}

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

	/** Host diagnostics only. Ready but unobserved outcomes are facts, not stale/deadlocked waits. */
	workWaits(teamId: string, ref: WorkRef): TeamWaitFact[] {
		return this.workWaitFacts(this.team(teamId), ref);
	}

	private workWaitFacts(team: TeamState, ref: WorkRef, creationOrder?: ReadonlyMap<string, number>): TeamWaitFact[] {
		const version = team.ledger.version(ref);
		if (!version || isTerminalWorkState(version.state)) return [];
		if (version.waitingForSignals?.length) {
			// A phase wait is not a wait for producer/owned-child completion. Its outcome has no cleanup gate.
			const observed = new Set(version.observedSignals ?? []);
			const waits = version.waitingForSignals.filter((id) => !observed.has(id)).map((id): TeamWaitFact => {
				const signal = team.ledger.signals.get(id)!;
				const producer = this.waitedWorkFact(team, ref, signal.work, false);
				const pending = signal.state === "pending";
				return { ...producer, signal: { id, name: signal.name }, state: signal.state, blocking: pending,
					reason: pending ? `producer ${producer.state}${producer.reason ? ` · ${producer.reason}` : ""}`
						: `${signal.state === "unavailable" ? "not published; " : ""}phase outcome ready; awaiting delivery; no resource release implied` };
			});
			return this.byCreation(team, waits, (wait) => wait.work, creationOrder);
		}
		const children = team.ledger.ownedChildren(ref);
		const childKeys = new Set(children.map(workRefKey));
		const observed = new Set(version.observedOutcomes.map(workRefKey));
		const targets = new Map([...version.waitingFor, ...children].map((work) => [workRefKey(work), work]));
		return this.byCreation(team, [...targets].filter(([key]) => !observed.has(key))
			.map(([key, work]) => this.waitedWorkFact(team, ref, work, childKeys.has(key))), (wait) => wait.work, creationOrder);
	}

	private waitedWorkFact(team: TeamState, consumer: WorkRef, work: WorkRef, child: boolean): TeamWaitFact {
		const key = workRefKey(work);
		const entry = team.ledger.get(work.workId)!;
		const waited = team.ledger.version(work)!;
		const member = team.members.get(entry.record.assignee)!;
		const cleanup = team.ledger.cleanupPending.has(key);
		const unknown = this.isUnknownOutcome(team, work) && !team.unknownAcknowledged.has(`${workRefKey(consumer)}>${key}`);
		const ready = team.ledger.outcomeReady(work) && !unknown;
		let reason: string | undefined;
		if (cleanup || unknown) reason = [cleanup ? "cleanup pending" : "", unknown ? "outcome unknown; explicit decision required" : ""].filter(Boolean).join(" · ");
		else if (ready) reason = "outcome ready; awaiting delivery";
		else if (waited.hold) {
			const incident = team.incidents.find((item) => item.id === waited.hold!.incidentId && item.state === "open");
			if (incident && (waited.hold.reason === "attention" || waited.hold.reason === "protocol")) {
				const owner = team.events.some((event) => event.incidentId === incident.id) ? team.lead : entry.record.requester;
				reason = `needs ${owner}'s decision`;
			} else reason = waited.hold.reason === "attention" ? "attention" : HELD_REASON[waited.hold.reason];
		} else if (waited.state === "queued") {
			reason = team.hostPause ? "host paused" : member.pause !== "none" ? "member paused"
				: this.retryWaitMs(member) ? "retry backoff"
				: member.active ? member.active.scope.kind === "work" ? `member busy on ${shortWorkRef(member.active.scope.work!)}` : "member handling Team events"
					: member.compaction ? member.compaction.state === "running" ? "compacting" : "compaction scheduled"
						: this.needsWorkPermit(team, member) && this.usedWorkPermits(team) >= team.limits.workPermits ? "slots full" : undefined;
		} else if (waited.state === "running" && member.activity === "settling"
			&& member.currentWork && sameWorkRef(member.currentWork, work)) reason = "settling";
		return { work: { ...work }, assignee: entry.record.assignee, state: waited.hold ? "held" : waited.state,
			child, blocking: !ready, ...(reason ? { reason } : {}),
			...(entry.record.currentRevision !== work.revision ? { latestRevision: entry.record.currentRevision } : {}) };
	}

	getResult(teamId: string, resultRef: string): ResultRecord | undefined {
		const result = this.team(teamId).ledger.results.get(resultRef);
		return result ? copy(result) : undefined;
	}

	/** Host-only process totals; deliveries and all ledger versions survive activation settlement. */
	processStats(teamId: string) {
		const team = this.team(teamId);
		const records = this.plainRecords(team);
		const memberActivations = new Map<string, number>();
		for (const delivery of team.deliveries.values()) {
			memberActivations.set(delivery.memberId, (memberActivations.get(delivery.memberId) ?? 0) + 1);
		}
		return {
			works: records.length, roots: records.filter((record) => !record.parent).length,
			results: team.ledger.resultOrder.filter((id) => !this.isReview(team, team.ledger.results.get(id)!.work)).length,
			activations: team.budget.used.teamActivations + team.budget.used.emergencyLeadActivations,
			modelTurns: team.usage.turns, dependencyWaits: team.dependencyWaits, questions: team.questions,
			revisions: records.reduce((sum, record) => sum + record.versions.length - 1, 0),
			cancelled: records.filter((record) => ["cancelled", "superseded"].includes(currentVersion(record).state)).length,
			toolErrors: team.toolErrors, transientRetries: team.transientRetries, memberActivations,
		};
	}

	/** Host panel facts outside the member-facing view: waiting Team events, each author's results, why work is stalled, the milestone timeline. */
	panelFacts(teamId: string): {
		pendingEvents: number;
		results: Map<string, { count: number; latest: ResultRecord }>;
		/** Per member with blocked or held work: what it waits on, or why it is held. */
		stalled: Map<string, string>;
		/** Current waits/holds, keyed by exact consumer WorkRef; not every running work's child obligations. */
		dependencies: Map<string, TeamWaitFact[]>;
		/** Per member waiting to retry a transient provider error: attempt, time left and error. */
		retrying: Map<string, string>;
		/** While the lead runs an events activation: the event kinds of its batch. */
		leadHandling?: string;
		/** Active Team only: the one reason most worth showing for why it has not finished. */
		waitingFor?: string;
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
		// After close, leftover notices (for example MEMBER_CLOSED) are no longer work for the lead.
		const pendingEvents = this.pendingLeadEvents(team);
		let creationOrder: ReadonlyMap<string, number> | undefined;
		const dependencies = new Map(team.ledger.order.flatMap((id) => {
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			// A running parent may own thousands of children without having yielded. It is not waiting.
			if (version.state !== "blocked" && !version.waitingFor.length && !version.waitingForSignals?.length) return [];
			creationOrder ??= new Map(team.ledger.order.map((workId, index) => [workId, index]));
			const facts = this.workWaitFacts(team, ref, creationOrder);
			return facts.length ? [[workRefKey(ref), facts] as const] : [];
		}));
		const waits = this.memberWaits(team, dependencies, creationOrder);
		const holds = this.listHolds(teamId);
		// A member's oldest hold speaks for it.
		const oldestHolds = new Map<string, HostHoldView>();
		for (const hold of holds) if (!oldestHolds.has(hold.assignee)) oldestHolds.set(hold.assignee, hold);
		const leadBatch = team.members.get(team.lead)!.active?.scope.eventBatchId;
		const stalled = new Map([...waits].map(([member, waited]) => [member, waitingOnText(waited)] as const));
		// A hold outranks a wait.
		for (const hold of oldestHolds.values()) stalled.set(hold.assignee, this.holdText(team, hold, leadBatch));
		// In the batch's own (priority) order, like the activation input.
		const handling = (leadBatch ? team.eventBatches.get(leadBatch)?.eventIds ?? [] : []).map((id) => team.events.find((event) => event.id === id)!);
		const waitingFor = team.lifecycle === "active" ? this.teamWaitingFor(team, holds, oldestHolds, waits) : undefined;
		const retrying = new Map([...team.members.values()].flatMap((member) => {
			const text = this.retryText(team, member);
			return text ? [[member.id, text] as const] : [];
		}));
		return { pendingEvents, results, stalled, dependencies, retrying, ...(handling.length ? { leadHandling: handlingText(handling) } : {}),
			...(waitingFor ? { waitingFor } : {}), timeline: copy(team.timeline), timelineOmitted: team.timelineOmitted };
	}

	/** Per member, unresolved exact Work/signal targets of blocked, un-held versions, once per handle. */
	private memberWaits(team: TeamState, dependencies: ReadonlyMap<string, TeamWaitFact[]>, creationOrder?: ReadonlyMap<string, number>): Map<string, TeamWaitFact[]> {
		const waits = new Map<string, Map<string, TeamWaitFact>>();
		for (const id of team.ledger.order) {
			const assignee = team.ledger.get(id)!.record.assignee;
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if (version.state !== "blocked" || version.hold) continue;
			for (const wait of dependencies.get(workRefKey(ref)) ?? []) {
				if (!wait.blocking) continue;
				const found = waits.get(assignee) ?? new Map<string, TeamWaitFact>();
				found.set(wait.signal?.id ?? workRefKey(wait.work), wait);
				waits.set(assignee, found);
			}
		}
		return new Map([...waits].map(([member, found]) => [member, this.byCreation(team, [...found.values()], (wait) => wait.work, creationOrder)]));
	}

	/** waitingFor is canonicalized by WorkRef; panels and the timeline name waited works in creation order instead. */
	private byCreation<T>(team: TeamState, items: readonly T[], work: (item: T) => WorkRef, creationOrder?: ReadonlyMap<string, number>): T[] {
		if (items.length < 2) return [...items];
		const order = creationOrder ?? new Map(team.ledger.order.map((id, index) => [id, index]));
		const created = (item: T) => order.get(work(item).workId)!;
		return items.toSorted((left, right) => created(left) - created(right));
	}

	/** Panel text for one hold; for a question it also says whether the lead is on it, has it queued, or has already seen it. */
	private holdText(team: TeamState, hold: HostHoldView, leadBatch: string | undefined): string {
		switch (hold.reason) {
			case "attention": {
				const event = team.events.find((item) => item.incidentId === hold.incidentId);
				// A sub-task's question has no lead event: its requester answers it.
				if (!event) return `held · asks: "${previewText(hold.message, 80)}" · for ${team.ledger.get(hold.work.workId)!.record.requester}`;
				const handling = event.batchId !== undefined && event.batchId === leadBatch ? " · lead handling"
					: event.processed ? "" : " · queued for lead";
				return `held · asks: "${previewText(hold.message, 80)}"${handling}`;
			}
			case "budget": {
				const exhausted = team.budget.exhausted(hold.rootId, hold.assignee === team.lead);
				return `held · ${exhausted ? `budget ${exhausted.counter} exhausted` : HELD_REASON.budget}`;
			}
			case "protocol": return `held · ${HELD_REASON.protocol}: ${previewText(hold.message, 80)}`;
			case "lead_unavailable": return `held · ${HELD_REASON.lead_unavailable}`;
		}
	}

	/** Activations of a paused Team that have not reached their provider gate yet. */
	private finishingActivations(team: TeamState): number {
		return [...team.members.values()].filter((member) => member.active && !member.active.parked).length;
	}

	/** The single most relevant reason an active Team has not finished, by priority. */
	private teamWaitingFor(team: TeamState, holds: readonly HostHoldView[], oldestHolds: ReadonlyMap<string, HostHoldView>,
		waits: ReadonlyMap<string, TeamWaitFact[]>): string | undefined {
		if (team.hostPause) {
			const finishing = this.finishingActivations(team);
			return finishing ? `Paused by the host (${finishing} activation${plural(finishing)} finishing)` : `Paused by the host for ${clock(this.timestamp() - team.hostPause.at)}`;
		}
		const lead = team.members.get(team.lead)!;
		if (lead.lifecycle === "faulted") return "Lead failed: revive it (v) or hand the lead over (l) in /rail-team";
		const questions = holds.filter((hold) => hold.reason === "attention" && team.events.some((event) => event.incidentId === hold.incidentId)).map((hold) => hold.assignee);
		if (questions.length) {
			const askers = [...new Set(questions)];
			const who = questions.length <= 2 && askers.length === questions.length ? askers.map((asker) => `${asker}'s`).join(" and ") : questions.length;
			return `Lead decision${plural(questions.length)} on ${who} question${plural(questions.length)}`;
		}
		// A Team without roots has nothing to review or close yet.
		const { roots, blockers } = this.rootObligations(team);
		if (roots.length && !blockers.some((blocker) => blocker.kind === "root_work")) {
			const unreviewed = blockers.filter((blocker) => blocker.kind === "root_review").length;
			return unreviewed ? `Lead review of ${unreviewed} result${plural(unreviewed)}` : "Lead: all roots accepted; decide the next step or close";
		}
		const running = [...team.members.values()].filter((member) => member.activity !== "idle" && !this.isReview(team, member.currentWork)).map((member) => member.id);
		// Members that are not running: what each waits on, or (a hold outranks a wait) why its work is held.
		const stalls = new Map<string, string>([...waits].map(([member, waited]) => [member, `waiting on ${capped([...new Set(waited.map(waitTargetText))], 3)}`]));
		for (const [member, hold] of oldestHolds) if (hold.reason !== "attention") stalls.set(member, `held: ${HELD_REASON[hold.reason]}`);
		const stalled = [...stalls].filter(([member]) => team.members.get(member)!.activity === "idle").map(([member, why]) => `${member} (${why})`);
		return [...(running.length ? [`${capped(running, 4)} (running)`] : []), ...(stalled.length ? [capped(stalled, 4, " · ")] : [])].join(" · ") || undefined;
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
		const roots = this.rootRecords(team);
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
			members: [...team.members.values()].map(({ id, lifecycle, resourceState }) => ({ id, lifecycle, resourceState })),
			usage: this.teamUsage(team), activeMs: this.teamTime(teamId).activeMs,
			memberStats: [...team.members.values()].map(({ id }) => ({ id, ...this.memberStats(teamId, id) })),
			unresolvedIncidents: unresolvedIncidents.slice(-TEAM_MAX_TERMINAL_INCIDENTS).map(({ id, code, message }) => ({ id, ...projectWorkError({ code, message }) })),
			...(unresolvedIncidents.length > TEAM_MAX_TERMINAL_INCIDENTS
				? { unresolvedIncidentsOmitted: unresolvedIncidents.length - TEAM_MAX_TERMINAL_INCIDENTS }
				: {}),
		};
	}

	/** Test-only invariant entry point; production callers may use it for diagnostics as well. */
	assertInvariants(teamId: string): void { this.check(this.team(teamId), true); }

	/** Diagnostic count of Runtime-held effects for one Team; a converged terminal Team holds none. */
	liveEffects(teamId: string): { executor: boolean; scheduledDrain: boolean; closingEffects: number; completionWaiters: number;
		deadlineTimer: boolean; activeActivations: number; stopTimers: number; ready: number; unprocessedEvents: number } {
		const team = this.team(teamId);
		const active = [...team.members.values()].flatMap((member) => member.active ? [member.active] : []);
		return {
			executor: this.executors.has(teamId), scheduledDrain: this.scheduledDrains.has(teamId),
			closingEffects: [...this.closingEffects].filter((key) => key.startsWith(`${teamId}\0`)).length,
			completionWaiters: this.completionWaiters.get(teamId)?.size ?? 0, deadlineTimer: this.deadlineTimers.has(teamId),
			activeActivations: active.length, stopTimers: active.filter((activation) => activation.stopTimer).length, ready: team.ready.length,
			unprocessedEvents: team.events.filter((event) => !event.processed).length,
		};
	}

	private applyAction(team: TeamState, member: RuntimeMember, active: ActiveActivation, action: TeamAction, toolCallId: string): TeamReply {
		if (action.action === "message" || action.action === "signal") {
			if (active.native || active.cleanup || active.stopReason) fail("ACTIVATION_ENDING", "This activation cannot publish new coordination side effects after it has stopped");
			if (active.scope.kind === "work") this.requireWorkScope(team, member, active);
		}
		if (active.scope.kind === "events" && member.id !== team.lead && !["message", "status", "yield"].includes(action.action)) {
			fail("FORBIDDEN_ACTION", "A mailbox activation only communicates: message, status or yield; it does not assign or perform work");
		}
		// Emergency lead activations may only diagnose, cancel, review/waive, close or yield.
		if (active.budget.emergency && action.action !== "status" && action.action !== "yield"
			&& !(action.action === "control" && ["cancel_work", "accept_result", "close_member", "close_team"].includes(action.control.command))) {
			fail("BUDGET_BLOCKED", "Emergency lead activations cannot create or revise work; only status, cancel_work, accept_result, close_member, close_team and yield are allowed");
		}
		if ((action.action === "request" || action.action === "control" || action.action === "message" || action.action === "signal") && active.scope.kind === "work" && this.isReview(team, active.scope.work)) {
			fail("FORBIDDEN_ACTION", "A review only advises");
		}
		this.requireKnownIds(team, forwardedText(action));
		switch (action.action) {
			case "status": return this.status(team, member, action);
			case "request": return this.acceptRequest(team, member, active, action);
			case "message": return this.sendMessage(team, member, active, action);
			case "signal": return this.signalAction(team, member, active, action);
			case "reply": return this.stageReply(team, member, active, action.result, toolCallId);
			case "yield": return this.stageYield(team, member, active, action, toolCallId);
			case "control": return this.control(team, member, active, action.control, toolCallId);
		}
	}

	private sendMessage(team: TeamState, sender: RuntimeMember, active: ActiveActivation, action: Extract<TeamAction, { action: "message" }>): TeamReply {
		if (action.to === sender.id) fail("SELF_REQUEST", "A member cannot message itself");
		const recipient = team.members.get(action.to);
		if (!recipient) fail("UNKNOWN_MEMBER", `Unknown recipient ${action.to}`);
		if (recipient.lifecycle === "closing") fail("RECIPIENT_CLOSING", `Recipient ${action.to} is closing`);
		if (recipient.lifecycle !== "open") fail("RECIPIENT_CLOSED", `Recipient ${action.to} is not open`);
		if (action.replyTo) {
			const original = team.events.find((event) => event.id === action.replyTo && event.kind === "MESSAGE");
			if (!original) fail("UNKNOWN_MESSAGE", `Unknown message ${action.replyTo}`);
			if (original.recipient !== sender.id || original.sender !== action.to) fail("FORBIDDEN_ACTION", "A conversational reply must return to that message's authenticated sender");
		}
		const messages = team.events.filter((event) => event.kind === "MESSAGE");
		if (messages.length >= TEAM_MAX_MESSAGES) fail("TEAM_CAPACITY", "Team message history is full; use work for further obligations");
		if (messages.filter((event) => event.recipient === recipient.id && !event.processed).length >= TEAM_MAX_MEMBER_MESSAGES) fail("REQUEST_QUEUE_FULL", `Recipient ${recipient.id} message queue is full`);
		const event = this.addEvent(team, { key: this.id("message"), kind: "MESSAGE", message: action.text,
			sender: sender.id, recipient: recipient.id, ...(active.scope.work ? { work: copy(active.scope.work) } : {}),
			...(action.replyTo ? { replyTo: action.replyTo } : {}) });
		this.note(team, `${sender.id} sent ${event.id} → ${recipient.id} (queued, not read)`);
		return okReply(sender.id, { receipt: { status: "sent", messageId: event.id, recipient: recipient.id } });
	}

	private failMessages(team: TeamState, member: RuntimeMember, reason: string, batchId?: string): void {
		const messages = team.events.filter((event) => event.kind === "MESSAGE" && event.recipient === member.id
			&& !event.processed && (batchId === undefined || event.batchId === batchId));
		if (!messages.length) return;
		for (const event of messages) {
			event.processed = true;
			event.deliveryFailure = reason;
			delete event.batchId;
		}
		const ids = messages.map((event) => event.id).join(", ");
		const previews = messages.map((event) => `${event.id} from ${event.sender}: ${previewText(event.message, 96)}`).join("; ");
		this.note(team, `${member.id} messages unavailable (${ids}): ${reason}`);
		this.addEvent(team, { key: `message-failure:${messages[0]!.id}`, kind: "MESSAGE_UNAVAILABLE", memberId: member.id,
			message: `Message handling by ${member.id} was not confirmed: ${previews}. ${previewText(reason, 256)}. This is not a read/answer receipt; check already-sent replies before resending.` });
	}

	private signalAction(team: TeamState, member: RuntimeMember, active: ActiveActivation, action: Extract<TeamAction, { action: "signal" }>): TeamReply {
		const work = this.requireWorkScope(team, member, active);
		if (action.operation === "open") {
			if (team.ledger.signals.size >= TEAM_MAX_SIGNALS || [...team.ledger.signals.values()].filter((signal) => sameWorkRef(signal.work, work)).length >= TEAM_MAX_WORK_SIGNALS) {
				fail("TEAM_CAPACITY", "Signal capacity reached for this Team or WorkRef");
			}
			const signal: SignalRecord = { id: this.modelId(team, "signal"), work: copy(work), author: member.id,
				name: action.name, state: "pending", createdAt: this.timestamp() };
			team.ledger.signals.set(signal.id, signal);
			this.note(team, `${member.id} opened ${signal.id} «${signal.name}» for ${shortWorkRef(work)}`);
			this.changed(team);
			return okReply(member.id, { receipt: { status: "opened", signalId: signal.id }, data: copy(signal) });
		}
		const signal = team.ledger.signals.get(action.signalId);
		if (!signal) fail("UNKNOWN_SIGNAL", `Unknown signal ${action.signalId}`);
		if (signal.author !== member.id || !sameWorkRef(signal.work, work)) fail("WRONG_WORK_OWNER", "Only the signal's exact owning WorkRef may publish it");
		if (signal.state === "published" && signal.text === action.text) return okReply(member.id, { receipt: { status: "published", signalId: signal.id }, data: copy(signal) });
		if (signal.state !== "pending") fail("SIGNAL_CLOSED", "This single-use signal is already closed; open a new signal for another phase");
		signal.state = "published";
		signal.text = action.text;
		this.note(team, `${member.id} published ${signal.id} «${signal.name}» (phase fact, not a resource lock)`);
		this.wakeWaiters(team);
		this.changed(team);
		return okReply(member.id, { receipt: { status: "published", signalId: signal.id }, data: copy(signal) });
	}

	/** Pending phases cannot survive their exact Work revision. Published facts are never rewritten. */
	private settleSignals(team: TeamState): void {
		for (const signal of team.ledger.signals.values()) {
			const version = team.ledger.version(signal.work)!;
			if (signal.state !== "pending" || (!isTerminalWorkState(version.state) && team.lifecycle === "active")) continue;
			signal.state = "unavailable";
			signal.text = `Not published: producer ${workRefKey(signal.work)} is ${version.state}; Team is ${team.lifecycle}. No resource release is implied.`;
		}
	}

	private signalsReady(team: TeamState, version: WorkVersion): boolean {
		return !!version.waitingForSignals?.length && version.waitingForSignals.every((id) => {
			const state = team.ledger.signals.get(id)?.state;
			return state === "published" || state === "unavailable";
		});
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
		for (const resultRef of action.inputRefs) this.requireResult(team, resultRef);
		const at = this.timestamp();
		const work = this.makeWork(team, requester.id, recipient.id, action.task, action.inputRefs, parent, at, rootId, depth, action.title);
		this.assertInputFits(team, recipient, work, parent);
		team.ledger.add(work);
		this.enqueueWork(team, { workId: work.id, revision: 1 });
		team.reservedResultBytes += TEAM_MAX_RESULT_BYTES;
		this.note(team, `${requester.id} requested ${shortWorkRef({ workId: work.id, revision: 1 })} «${work.title}» → ${recipient.id}`);
		this.changed(team);
		return okReply(requester.id, { receipt: { status: "accepted", work: { workId: work.id, revision: 1 }, recipient: recipient.id, ...(recipient.pause !== "none" ? { paused: true } : {}) } });
	}

	/**
	 * Text that reaches another party must not carry a dead reference: an ID quoted in it that does not exist
	 * in this Team is rejected while its author can still fix it, with the one existing ID it is a typo of.
	 */
	private requireKnownIds(team: TeamState, text: string | undefined): void {
		// IDs are lowercase, so a quote in another case still names the same ID.
		const kindOf = (token: string) => token.slice(0, token.indexOf(":")) as ModelIdKind;
		const unknown = [...new Set(text?.toLowerCase().match(QUOTED_ID))].filter((token) => !this.modelIds(team, kindOf(token)).includes(token));
		if (!unknown.length) return;
		const quoted = unknown.map((token) => {
			const near = this.modelIds(team, kindOf(token)).filter((id) => isTypo(token, id));
			return near.length === 1 ? `${token} (did you mean ${near[0]}?)` : token;
		});
		fail(unknown.some((token) => token.startsWith("result:")) ? "UNKNOWN_RESULT" : "UNKNOWN_WORK",
			`This action quotes IDs that do not exist in this Team: ${quoted.join(", ")}. `
			+ "Nothing was changed: copy each ID exactly as you received it, then send the action again.");
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
		if (active.scope.kind === "events") {
			if (action.waitingFor.length || action.waitingForSignals?.length || action.attention !== undefined) fail("INVALID_ARGUMENT", "An events activation never waits inside an activation: end it with yield {checkpoint?} and no waitingFor/waitingForSignals/attention. New messages and Team events start the next events activation automatically; do not poll status to wait.");
			active.intent = { kind: "idle", ...(action.checkpoint ? { checkpoint: action.checkpoint } : {}), toolCallId };
			member.activity = "settling";
			this.changed(team);
			return okReply(member.id, { receipt: { status: "staged", intent: "idle" } });
		}
		const ref = this.requireWorkScope(team, member, active);
		if (action.waitingForSignals?.length) {
			if (!action.checkpoint) fail("INVALID_ARGUMENT", "Signal yield requires a checkpoint");
			this.settleSignals(team);
			const version = team.ledger.version(ref)!;
			const ids = action.waitingForSignals.filter((id) => !version.observedSignals?.includes(id));
			if (!ids.length) fail("NO_NEW_DEPENDENCY", "All requested signal outcomes were already delivered to this work version");
			for (const id of ids) if (!team.ledger.signals.has(id)) fail("UNKNOWN_SIGNAL", `Unknown signal ${id}`);
			const cycle = team.ledger.findCycle(ref, [], ids);
			if (cycle) {
				this.note(team, `${member.id} wait rejected: dependency cycle ${capped(cycle, 8, " → ")}`);
				fail("DEPENDENCY_CYCLE", `Dependency cycle: ${cycle.join(" -> ")}`, [{ kind: "cycle", reason: cycle.join(" -> ") }]);
			}
			team.ledger.get(ref.workId)!.stagedWait = { revision: ref.revision, refs: [], signals: [...ids] };
			active.intent = { kind: "yield_signals", work: ref, waitingForSignals: [...action.waitingForSignals], checkpoint: action.checkpoint, toolCallId };
			version.updatedAt = this.timestamp();
			member.activity = "settling";
			this.changed(team);
			return okReply(member.id, { receipt: { status: "staged", intent: "yield_signals", work: ref } });
		}
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
			if (sameWorkRef(target, ref)) {
				this.note(team, `${member.id} wait rejected: dependency cycle ${shortWorkRef(ref)} → itself`);
				fail("DEPENDENCY_CYCLE", "Work cannot wait for itself", [{ kind: "cycle", id: workRefKey(ref), reason: "self dependency" }]);
			}
		}
		const newWaits = action.waitingFor.filter((target) => !version.observedOutcomes.some((observed) => sameWorkRef(observed, target)));
		const cycle = team.ledger.findCycle(ref, newWaits);
		if (cycle) {
			this.note(team, `${member.id} wait rejected: dependency cycle ${capped(cycle, 8, " → ")}`);
			fail("DEPENDENCY_CYCLE", `Dependency cycle: ${cycle.join(" -> ")}`, [{ kind: "cycle", reason: cycle.join(" -> ") }]);
		}
		const entry = team.ledger.get(ref.workId)!;
		entry.stagedWait = { revision: ref.revision, refs: copy(newWaits) };
		active.intent = { kind: "yield_dependencies", work: ref, waitingFor: copy(action.waitingFor), checkpoint: action.checkpoint, toolCallId };
		member.activity = "settling";
		version.updatedAt = this.timestamp();
		this.changed(team);
		return okReply(member.id, { receipt: { status: "staged", intent: "yield_dependencies", work: ref } });
	}

	private control(team: TeamState, member: RuntimeMember, active: ActiveActivation, control: NonNullable<Extract<TeamAction, { action: "control" }>["control"]>, toolCallId: string): TeamReply {
		const workId = "workId" in control ? control.workId : control.command === "accept_result" ? control.work.workId : undefined;
		if (workId !== undefined) this.requireWorkControl(team, member, active, workId);
		else if (member.id !== team.lead) fail("FORBIDDEN_ACTION", "Only the Team lead may pause, resume, revive or close members or close the Team");
		switch (control.command) {
			case "revise_work": return this.reviseWork(team, member, control);
			case "cancel_work": return this.cancelWork(team, member, control);
			case "accept_result": return this.acceptResult(team, member, control);
			case "close_member": return this.closeMember(team, member, control.memberId);
			case "revive_member": return this.reviveMemberControl(team, member, control.memberId);
			case "compact_member": return okReply(member.id, { receipt: { status: "applied", command: "compact_member", memberId: control.memberId,
				compaction: this.requestCompaction(team, control.memberId, { trigger: "lead", ...(control.instructions !== undefined ? { instructions: control.instructions } : {}) }) } });
			case "pause_member": return this.pauseMember(team, member, control.memberId);
			case "resume_member": return this.resumeMember(team, member, control.memberId);
			case "resume_work": return this.resumeWork(team, member, control.workId, control.expectedRevision, control.incidentId, control.instruction);
			case "close_team": return this.closeTeam(team, member, active, control.resultRefs, control.outcome, control.reason, toolCallId);
		}
	}

	/** Work is controlled by whoever requested it, or the lead; never by the member it is currently running for. */
	private requireWorkControl(team: TeamState, member: RuntimeMember, active: ActiveActivation, workId: string): void {
		const entry = team.ledger.get(workId);
		if (!entry) fail("UNKNOWN_WORK", `Unknown work ${workId}`);
		if (active.scope.kind === "work" && active.scope.work!.workId === workId) fail("FORBIDDEN_ACTION", "A member cannot control its own current work");
		if (member.id !== team.lead && entry.record.requester !== member.id) {
			fail("FORBIDDEN_ACTION", `Only ${entry.record.requester} (the requester) or the lead may control work ${workId}`);
		}
	}

	private pauseMember(team: TeamState, lead: RuntimeMember, memberId: string): TeamReply {
		const target = team.members.get(memberId);
		if (!target) fail("UNKNOWN_MEMBER", `Unknown member ${memberId}`);
		if (target.id === lead.id) fail("FORBIDDEN_ACTION", "The lead cannot be paused");
		if (target.lifecycle !== "open" || target.resourceState !== "owned") fail("MEMBER_UNAVAILABLE", `Member ${memberId} is not available to pause`);
		if (target.pause !== "none") {
			// A parked activation still waiting for a permit after resume stays parked when paused again.
			const parked = target.active?.parked && target.active.resumeRequested ? target.active : undefined;
			if (!parked) return okReply(lead.id, { receipt: { status: "unchanged", command: "pause_member", memberId } });
			parked.resumeRequested = false;
			this.setMemberPause(team, target, "confirmed");
			this.changed(team);
			return okReply(lead.id, { receipt: { status: "applied", command: "pause_member", memberId } });
		}
		this.setMemberPause(team, target, target.active ? "requested" : "confirmed");
		this.changed(team);
		this.requestDrain(team.id);
		return okReply(lead.id, { receipt: { status: "applied", command: "pause_member", memberId } });
	}

	private resumeMember(team: TeamState, lead: RuntimeMember, memberId: string): TeamReply {
		const target = team.members.get(memberId);
		if (!target) fail("UNKNOWN_MEMBER", `Unknown member ${memberId}`);
		if (target.id === lead.id) fail("FORBIDDEN_ACTION", "The lead is never paused, so it cannot be resumed");
		if (target.lifecycle !== "open" || target.resourceState !== "owned") fail("MEMBER_UNAVAILABLE", `Member ${memberId} cannot be resumed in its current lifecycle`);
		if (!this.liftPause(team, target)) return okReply(lead.id, { receipt: { status: "unchanged", command: "resume_member", memberId } });
		this.changed(team);
		this.requestDrain(team.id);
		return okReply(lead.id, { receipt: { status: "applied", command: "resume_member", memberId } });
	}

	/** False when the member was not paused (or already resuming). */
	private liftPause(team: TeamState, target: RuntimeMember): boolean {
		const active = target.active;
		// The host's pause is lifted only by continueTeam.
		if (target.pause === "none" || active?.resumeRequested || team.hostPause) return false;
		if (active?.parked) {
			active.resumeRequested = true;
			this.setMemberPause(team, target, "requested");
			this.resumeParkedActivations(team);
		} else {
			this.setMemberPause(team, target, "none");
			if (active?.providerGatePending) this.tryParkAtProviderGate(team, target, active);
		}
		return true;
	}

	private resumeWork(team: TeamState, actor: RuntimeMember, workId: string, expectedRevision: number, incidentId: string, instruction: string): TeamReply {
		const entry = team.ledger.get(workId);
		if (!entry) fail("UNKNOWN_WORK", `Unknown work ${workId}`);
		if (entry.record.currentRevision !== expectedRevision) fail("STALE_REVISION", `Expected revision ${expectedRevision}, current revision is ${entry.record.currentRevision}`);
		const ref = { workId, revision: expectedRevision };
		const version = team.ledger.version(ref)!;
		if (version.hold?.incidentId !== incidentId) {
			const incident = team.incidents.find((item) => item.id === incidentId && item.state === "resolved" && item.work && sameWorkRef(item.work, ref));
			if (incident && version.resumeInstruction === instruction) {
				return okReply(actor.id, { receipt: { status: "unchanged", command: "resume_work", work: ref } });
			}
			fail("INVALID_ARGUMENT", "The current WorkRef is not held by this incident");
		}
		this.applyHoldRelease(team, ref, incidentId, instruction);
		this.note(team, `${actor.id} resumed ${shortWorkRef(ref)}`);
		this.requestDrain(team.id);
		return okReply(actor.id, { receipt: { status: "applied", command: "resume_work", work: ref } });
	}

	private applyHoldRelease(team: TeamState, ref: WorkRef, incidentId: string, instruction: string): void {
		// Every check precedes the mutation below: a rejected release leaves the ledger untouched.
		const entry = team.ledger.get(ref.workId)!;
		const version = team.ledger.version(ref)!;
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		const lead = team.members.get(team.lead)!;
		if (lead.lifecycle !== "open" || lead.resourceState !== "owned") {
			fail("MEMBER_UNAVAILABLE", "The lead is unavailable; a hold release cannot bypass the lead-fault safety pause");
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
		// Releasing a hold never satisfies an AND wait: unmet dependencies keep the work blocked,
		// unless an undelivered child issue needs its owner's answer (as in wakeWaiters).
		if (((version.waitingFor.length && !version.waitingFor.every((dependency) => team.ledger.outcomeReady(dependency)))
			|| (version.waitingForSignals?.length && !this.signalsReady(team, version))) && !this.pendingChildIssues(team, version).length) {
			version.state = "blocked";
		} else {
			version.state = "queued";
			if (!team.ready.some((item) => sameWorkRef(item, ref))) this.enqueueWork(team, ref);
		}
		this.resolveIncident(team, incidentId);
		this.changed(team);
		// Releasing any other hold never acknowledges an unknown dependency: it is held again for that decision.
		this.holdUnknownDependencies(team);
	}

	private reviseWork(team: TeamState, actor: RuntimeMember, control: Extract<NonNullable<Extract<TeamAction, { action: "control" }>["control"]>, { command: "revise_work" }>): TeamReply {
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
		for (const inputRef of control.inputRefs) this.requireResult(team, inputRef);
		if (team.reservedResultBytes + TEAM_MAX_RESULT_BYTES > team.limits.reservedResultBytes) fail("TEAM_CAPACITY", "Reserved result capacity is full");
		const nextRevision = entry.record.currentRevision + 1;
		const candidate = this.makeVersion(nextRevision, control.task, control.inputRefs, this.timestamp());
		this.assertInputFits(team, assignee, { ...entry.record, currentRevision: nextRevision, versions: [...entry.record.versions, candidate] }, entry.record.parent);
		const currentRef = { workId: entry.record.id, revision: entry.record.currentRevision };
		this.writeJournal(team, { version: 2, kind: "decision", teamId: team.id, at: candidate.createdAt, decision: "revise_work", work: currentRef });
		if (control.title !== undefined) entry.record.title = control.title;
		this.note(team, `${actor.id} revised ${shortWorkRef(currentRef)}: "${previewText(control.task, 120)}"`);
		if (!isTerminalWorkState(current.state)) {
			this.cancelDescendants(team, currentRef, "superseded");
			current.state = "superseded";
			current.waitingFor = [];
			delete current.waitingForSignals;
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
		this.dequeueWork(team, currentRef);
		team.review.pending.delete(workRefKey(currentRef));
		team.ledger.addRevision(entry.record.id, candidate);
		this.enqueueWork(team, { workId: entry.record.id, revision: nextRevision });
		team.reservedResultBytes += TEAM_MAX_RESULT_BYTES;
		this.wakeWaiters(team);
		this.changed(team);
		return okReply(actor.id, { receipt: { status: "applied", command: "revise_work", work: { workId: entry.record.id, revision: nextRevision } } });
	}

	private cancelWork(team: TeamState, actor: RuntimeMember, control: Extract<NonNullable<Extract<TeamAction, { action: "control" }>["control"]>, { command: "cancel_work" }>): TeamReply {
		const entry = team.ledger.get(control.workId);
		if (!entry) fail("UNKNOWN_WORK", `Unknown work ${control.workId}`);
		if (entry.record.currentRevision !== control.expectedRevision) fail("STALE_REVISION", `Expected revision ${control.expectedRevision}, current revision is ${entry.record.currentRevision}`);
		const ref = { workId: entry.record.id, revision: entry.record.currentRevision };
		if (isTerminalWorkState(currentVersion(entry.record).state)) {
			return okReply(actor.id, { receipt: { status: "unchanged", command: "cancel_work", work: ref } });
		}
		this.writeJournal(team, { version: 2, kind: "decision", teamId: team.id, at: this.timestamp(), decision: "cancel_work", work: ref, reason: control.reason });
		this.note(team, `${actor.id} cancelled ${shortWorkRef(ref)}`);
		for (const work of [ref, ...team.ledger.openSubtree(ref)]) this.cancelVersion(team, work, control.reason);
		this.wakeWaiters(team);
		this.changed(team);
		return okReply(actor.id, { receipt: { status: "applied", command: "cancel_work", work: ref } });
	}

	/** Cancel one open work version and stop its running activation. */
	private cancelVersion(team: TeamState, work: WorkRef, reason: string): void {
		const version = team.ledger.version(work)!;
		if (isTerminalWorkState(version.state)) return;
		version.state = "cancelled";
		version.error = { code: "CANCELLED", message: reason };
		version.waitingFor = [];
		delete version.waitingForSignals;
		this.dropHold(team, version);
		version.updatedAt = this.timestamp();
		delete team.ledger.get(work.workId)!.stagedWait;
		this.dequeueWork(team, work);
		team.review.pending.delete(workRefKey(work));
		const assignee = team.members.get(team.ledger.get(work.workId)!.record.assignee)!;
		if (assignee.active?.scope.kind === "work" && sameWorkRef(assignee.active.scope.work!, work)) {
			assignee.active.stopReason = "cancelled";
			team.ledger.cleanupPending.add(workRefKey(work));
			this.requestActivationStop(team, assignee, "policy_cancelled");
		}
	}

	private acceptResult(team: TeamState, actor: RuntimeMember, control: Extract<NonNullable<Extract<TeamAction, { action: "control" }>["control"]>, { command: "accept_result" }>): TeamReply {
		const entry = team.ledger.get(control.work.workId);
		const version = team.ledger.version(control.work);
		if (!entry || !version) fail("UNKNOWN_WORK", `Unknown work ${workRefKey(control.work)}`);
		if (entry.record.parent || entry.record.kind || entry.record.currentRevision !== control.work.revision) fail("INVALID_ARGUMENT", "Only a current root work version can be reviewed");
		if (version.review) {
			if (version.review.disposition === control.disposition && version.review.reason === control.reason) {
				return okReply(actor.id, { receipt: { status: "unchanged", command: "accept_result", work: control.work } });
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
		this.note(team, `${actor.id} ${control.disposition} ${shortWorkRef(control.work)}`);
		version.updatedAt = this.timestamp();
		const committedAt = team.flow.committedAt.get(workRefKey(control.work));
		if (committedAt !== undefined) {
			team.flow.committedAt.delete(workRefKey(control.work));
			this.tickFlow(team);
			pushFlow(team.flow.acceptLatencies, Math.max(0, team.flow.activeMs - committedAt));
		}
		this.changed(team);
		return okReply(actor.id, { receipt: { status: "applied", command: "accept_result", work: control.work } });
	}

	private reviveMemberControl(team: TeamState, lead: RuntimeMember, memberId: string): TeamReply {
		const target = team.members.get(memberId);
		if (!target) fail("UNKNOWN_MEMBER", `Unknown member ${memberId}`);
		if (target.id === lead.id) fail("FORBIDDEN_ACTION", "The lead cannot revive itself");
		this.revive(team, target, lead.id);
		return okReply(lead.id, { receipt: { status: "applied", command: "revive_member", memberId } });
	}

	/** Reopen a faulted member whose process is still alive. Its failed works stay failed; whoever revives it requests or revises them again. */
	private revive(team: TeamState, member: RuntimeMember, by: string): void {
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		if (member.lifecycle !== "faulted") fail("MEMBER_UNAVAILABLE", `${member.id} is not faulted`);
		if (member.resourceState !== "owned" || member.active) {
			fail("MEMBER_UNAVAILABLE", `${member.id}'s process has exited or is closing; it cannot be revived — give its work to another member`);
		}
		member.lifecycle = "open";
		// A member that reopens while the host has paused the Team stays paused until the host continues.
		this.setMemberPause(team, member, team.hostPause ? "confirmed" : "none");
		team.hostPause?.members.add(member.id);
		if (member.error?.code === "NATIVE_LENGTH") member.compaction = { trigger: by === "host" ? "host" : "lead", state: "pending" };
		delete member.error;
		delete member.retry;
		this.note(team, `${by} revived ${member.id}`);
		this.refreshHealth(team);
		this.changed(team);
	}

	private closeMember(team: TeamState, lead: RuntimeMember, memberId: string): TeamReply {
		const unread = team.events.filter((event) => event.recipient === memberId && !event.processed);
		if (unread.length) fail("CLOSE_BLOCKED", "Member has undelivered messages; let its mailbox activation finish before closing", unread.map((event) => ({ kind: "message", id: event.id, reason: "message not processed" })));
		if (memberId === lead.id) fail("FORBIDDEN_ACTION", "The lead cannot close itself; use close_team");
		const target = team.members.get(memberId);
		if (!target) fail("UNKNOWN_MEMBER", `Unknown member ${memberId}`);
		if (target.lifecycle === "closing" && target.closeId) return okReply(lead.id, { receipt: { status: "closing", command: "close_member", memberId, closeId: target.closeId } });
		if (target.lifecycle === "closed" || (target.lifecycle === "faulted" && target.resourceState === "released")) {
			return okReply(lead.id, { receipt: { status: "applied", command: "close_member", memberId } });
		}
		if (target.lifecycle === "faulted" && target.resourceState === "owned" && !target.active) {
			// The fault stays on record; only its live process is stopped.
			target.resourceState = "stopping";
			target.closeId = this.id("close");
			this.changed(team);
			this.check(team);
		}
		if (target.lifecycle === "faulted" && target.resourceState === "stopping" && target.closeId) {
			return okReply(lead.id, { receipt: { status: "closing", command: "close_member", memberId, closeId: target.closeId } });
		}
		if (target.lifecycle !== "open") fail("RECIPIENT_CLOSED", `Member ${memberId} is ${target.lifecycle}`);
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
		return okReply(lead.id, { receipt: { status: "closing", command: "close_member", memberId, closeId } });
	}

	/** The roots and what each still owes before close_team: to be terminal, then to be reviewed. */
	private rootObligations(team: TeamState): { roots: WorkRecord[]; blockers: Array<{ kind: string; id?: string; reason: string }> } {
		const blockers: Array<{ kind: string; id?: string; reason: string }> = [];
		const roots = this.rootRecords(team);
		for (const root of roots) {
			const version = currentVersion(root);
			if (!isTerminalWorkState(version.state)) blockers.push({ kind: "root_work", id: workRefKey({ workId: root.id, revision: root.currentRevision }), reason: `root is ${version.state}` });
			if (!version.review) blockers.push({ kind: "root_review", id: workRefKey({ workId: root.id, revision: root.currentRevision }),
				reason: "root has not been reviewed: accept_result it (accepted, or waived with a reason)" });
		}
		return { roots, blockers };
	}

	private closeTeam(team: TeamState, lead: RuntimeMember, active: ActiveActivation, resultRefs: string[], outcome: "succeeded" | "partial" | "failed", reason: string | undefined, toolCallId: string): TeamReply {
		if (lead.id !== team.lead || active.scope.kind !== "events") fail("FORBIDDEN_ACTION", "close_team requires the lead's events activation");
		if (team.hostPause) fail("FORBIDDEN_ACTION", "The host has paused the Team; it can be closed after the host continues it");
		const { roots, blockers } = this.rootObligations(team);
		for (const record of this.plainRecords(team)) {
			const id = record.id;
			const version = currentVersion(record);
			if (!isTerminalWorkState(version.state)) blockers.push({ kind: "work", id: workRefKey({ workId: id, revision: record.currentRevision }), reason: `work is ${version.state}` });
		}
		for (const member of team.members.values()) if (member.id !== lead.id) {
			if (member.active && !this.isReview(team, member.active.scope.work)) blockers.push({ kind: "activation", id: member.id, reason: `${member.id} still has an active activation` });
			// A faulted member's live process is stopped by the close; only an unconfirmed exit (cleanup_failed) blocks.
			if (!((member.lifecycle === "open" && member.resourceState === "owned")
				|| (member.lifecycle === "faulted" && (member.resourceState === "owned" || member.resourceState === "stopping"))
				|| (member.resourceState === "released" && (member.lifecycle === "closed" || member.lifecycle === "faulted")))) {
				blockers.push({ kind: "member_resource", id: member.id, reason: `${member.id} is ${member.lifecycle} with resources ${member.resourceState}` });
			}
		}
		for (const delivery of team.deliveries.values()) if (delivery.state !== "delivered" && delivery.state !== "cancelled" && delivery.activationId !== active.scope.activationId && !this.isReview(team, delivery.work)) {
			blockers.push({ kind: "delivery", id: delivery.memberId, reason: "required input is in flight" });
		}
		for (const event of team.events) if (!event.processed && !ADVISORY_EVENTS.includes(event.kind) && event.batchId !== active.scope.eventBatchId) {
			blockers.push({ kind: "team_event", id: event.id, reason: "an unprocessed Team event is outside the closing activation batch; end this activation with yield to receive it, then close" });
		}
		// An exhausted-budget notice that holds no work is not an unresolved obligation; held work blocks on its own.
		const holdsWork = (incidentId: string) => team.ledger.order.some((id) => team.ledger.current(id)?.hold?.incidentId === incidentId);
		if (outcome === "succeeded" && team.incidents.some((incident) => incident.state === "open" && !this.isReview(team, incident.work)
			&& (incident.code !== "BUDGET_HIT" || holdsWork(incident.id)))) {
			blockers.push({ kind: "incident", reason: "succeeded close cannot leave an unresolved incident" });
		}
		for (const resultRef of resultRefs) this.requireResult(team, resultRef);
		if (outcome === "succeeded") {
			const unsuccessful = roots.filter((root) => currentVersion(root).review?.disposition !== "accepted"
				|| team.ledger.results.get(currentVersion(root).resultRef ?? "")?.result.status !== "succeeded");
			if (unsuccessful.length || resultRefs.length === 0) {
				// Name every root that prevents success so the lead can fix all of them in one step.
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
		if (active.intent) fail("ACTIVATION_ENDING", "Lead activation already staged another intent");
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		this.clearReview(team);
		for (const id of team.ledger.order) {
			if (this.isReview(team, { workId: id, revision: 1 })) this.cancelVersion(team, team.ledger.currentRef(id)!, "The Team is closing");
		}
		const closeId = this.id("close");
		const rootSnapshot: TeamResult["roots"] = roots.map((root) => {
			const version = currentVersion(root);
			return { work: { workId: root.id, revision: root.currentRevision }, state: version.state,
				...(version.resultRef ? { resultRef: version.resultRef } : {}), ...(version.review ? { review: copy(version.review) } : {}) };
		});
		this.writeJournal(team, { version: 2, kind: "close_decision", teamId: team.id, at: this.timestamp(), closeId, outcome,
			resultRefs: copy(resultRefs), roots: copy(rootSnapshot), ...(reason ? { reason } : {}) });
		this.note(team, `${lead.id} close_team ${outcome}`);
		team.closeDecision = { id: closeId, outcome, ...(reason ? { reason } : {}), resultRefs: copy(resultRefs), roots: copy(rootSnapshot) };
		team.lifecycle = "closing";
		team.outcome = outcome;
		if (reason) team.reason = reason;
		for (const target of team.members.values()) {
			if (target.id === lead.id) {
				target.lifecycle = "closing";
				target.resourceState = "stopping";
				target.closeId = closeId;
			} else if (target.lifecycle === "open") {
				target.lifecycle = "closing";
				target.resourceState = "stopping";
				target.closeId = closeId;
			} else if (target.lifecycle === "faulted" && target.resourceState === "owned") {
				target.resourceState = "stopping";
				target.closeId = closeId;
			}
		}
		active.intent = { kind: "close_team", closeId, toolCallId };
		lead.activity = "settling";
		this.consumeBatch(team, active.scope.eventBatchId);
		for (const event of team.events) if (ADVISORY_EVENTS.includes(event.kind) && !event.processed) {
			event.processed = true;
			delete event.batchId;
		}
		this.changed(team);
		this.check(team);
		return okReply(lead.id, { receipt: { status: "closing", command: "close_team", closeId } });
	}

	private status(team: TeamState, member: RuntimeMember, action: Extract<TeamAction, { action: "status" }>): TeamReply {
		if (action.view === "team") return okReply(member.id, { data: this.view(team) });
		if (action.id) {
			if (action.view === "work") {
				const entry = team.ledger.get(action.id);
				if (!entry) fail("UNKNOWN_WORK", `Unknown work ${action.id}`);
				if (member.id !== team.lead && entry.record.assignee !== member.id) {
					const summary = this.workSummaries(team).find((item) => item.work.workId === action.id);
					if (!summary) fail("UNKNOWN_WORK", `Unknown work ${action.id}`);
					return okReply(member.id, { data: { view: "work", items: [summary], hasMore: false } });
				}
				return okReply(member.id, { data: this.getWork(team.id, { workId: action.id, revision: entry.record.currentRevision })! });
			}
			if (action.view === "signal") {
				this.settleSignals(team);
				const record = team.ledger.signals.get(action.id);
				if (!record) fail("UNKNOWN_SIGNAL", `Unknown signal ${action.id}`);
				return okReply(member.id, { data: copy(record) });
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
		this.settleSignals(team);
		const items = action.view === "signal" ? [...team.ledger.signals.values()].map(copy) : action.view === "work" ? this.workSummaries(team)
			: action.view === "result" ? this.resultSummaries(team)
			: team.incidents.map(incidentView);
		const pageItems = items.slice(offset, offset + action.limit);
		const next = offset + pageItems.length;
		return okReply(member.id, { data: { view: action.view, items: pageItems, ...(next < items.length ? { cursor: `page:${next}` } : {}), hasMore: next < items.length } });
	}

	private reserveEvents(team: TeamState, member: RuntimeMember, events: InternalEvent[], emergency: boolean): RuntimeActivation {
		const batchId = this.id("batch");
		const scope: ActivationScope = { activationId: this.id("activation"), kind: "events", eventBatchId: batchId };
		const deliveryId = this.id("delivery");
		let selected = events;
		let input: ActivationInput;
		for (;;) {
			try {
				input = this.activationInput(team, member, deliveryId, { kind: "events", eventBatchId: batchId,
					events: selected.map(({ key: _key, processed: _processed, batchId: _batchId, passive: _passive, deliveryFailure: _failure, ...view }) => view), emergency },
				team.budget.inputSummary(undefined, member.id === team.lead, emergency));
				break;
			} catch (error) {
				if (!(error instanceof TeamProtocolError) || error.code !== "INPUT_BUDGET_EXCEEDED" || selected.length <= 1) throw error;
				// Preserve the brief and event contents; unselected notices stay pending for the next batch.
				selected = selected.slice(0, -1);
			}
		}
		const eventBatch: EventBatch = { eventIds: selected.map((event) => event.id) };
		for (const event of selected) event.batchId = batchId;
		team.eventBatches.set(batchId, eventBatch);
		this.tickFlow(team);
		const activation: ActiveActivation = { startedActiveMs: team.flow.activeMs, scope, deliveryId, inputReady: false, workPermitHeld: this.needsWorkPermit(team, member), parked: false, resumeRequested: false,
			providerGatePending: false, toolCalls: new Map(), completedToolCalls: new Map(), pauseBlockedToolCalls: 0, cache: new Map(), lastSequence: 0,
			budget: team.budget.recordActivation(undefined, member.id === team.lead, emergency), budgetBlockedToolCalls: 0, postIntentContinuations: 0 };
		member.active = activation;
		member.lastActivationKind = "events";
		this.startFlow(team, member, activation);
		member.activity = "running";
		this.note(team, `${member.id} events activation (${eventKinds(selected)})`);
		this.addDelivery(team, member, scope, input);
		this.changed(team);
		return { binding: this.binding(team, member), scope: copy(scope), deliveryId, input };
	}

	private reserveWork(team: TeamState, member: RuntimeMember, ref: WorkRef): RuntimeActivation {
		const version = team.ledger.version(ref)!;
		const review = this.isReview(team, ref) ? this.captureReview(team, team.review.focus.get(ref.workId), team.review.pending.get(workRefKey(ref))?.baseline) : undefined;
		// A lead-authored revision replaces the original instructions. Keep all of it (up to 8 KiB),
		// adding only the compact current snapshot so the delivered task stays below 16 KiB.
		const task = !review ? version.task : ref.revision === 1 ? review.task : `${version.task}\n\n${prompt("team", "review_revised_snapshot", {
			taken: new Date(review.pending.snapshotAt).toISOString(), snapshot: JSON.stringify(review.pending.snapshot),
		})}`;
		const at = this.timestamp();
		const deliveryId = this.id("delivery");
		const scope: ActivationScope = { activationId: this.id("activation"), kind: "work", work: copy(ref) };
		const input = this.activationInput(team, member, deliveryId, {
			kind: "work", work: copy(ref), task, requester: team.ledger.get(ref.workId)!.record.requester,
			rootId: team.ledger.get(ref.workId)!.record.rootId,
			...(team.ledger.get(ref.workId)!.record.parent ? { parent: copy(team.ledger.get(ref.workId)!.record.parent!) } : {}),
			depth: team.ledger.get(ref.workId)!.record.depth, inputRefs: copy(version.inputRefs), waitingFor: copy(version.waitingFor),
			...(version.waitingForSignals?.length ? { waitingForSignals: [...version.waitingForSignals] } : {}),
			...(version.checkpoint ? { checkpoint: version.checkpoint } : {}), ...(version.resumeInstruction ? { resumeInstruction: version.resumeInstruction } : {}),
			...(ref.revision > 1 ? { previous: this.previousVersion(team, ref) } : {}),
		}, team.budget.inputSummary(team.ledger.get(ref.workId)!.record.rootId, member.id === team.lead, false));
		if (review) {
			if (ref.revision === 1) version.task = review.task;
			team.review.pending.set(workRefKey(ref), review.pending);
		}
		version.state = "running";
		version.updatedAt = at;
		this.tickFlow(team);
		member.lastActivationKind = "work";
		member.active = { startedActiveMs: team.flow.activeMs, scope, deliveryId, inputReady: false, workPermitHeld: this.needsWorkPermit(team, member), parked: false, resumeRequested: false,
			providerGatePending: false, toolCalls: new Map(), completedToolCalls: new Map(), pauseBlockedToolCalls: 0, cache: new Map(), lastSequence: 0,
			budget: team.budget.recordActivation(team.ledger.get(ref.workId)!.record.rootId, member.id === team.lead, false),
			budgetBlockedToolCalls: 0, postIntentContinuations: 0 };
		this.startFlow(team, member, member.active);
		const firstStart = !team.flow.started.has(workRefKey(ref));
		const readyMs = this.flowWorkStarted(team, ref);
		member.currentWork = copy(ref);
		member.activity = "running";
		this.note(team, firstStart ? `${member.id} started ${shortWorkRef(ref)}${readyMs === undefined ? "" : ` (ready ${clock(readyMs)})`}` : `${member.id} resumed ${shortWorkRef(ref)}`);
		this.addDelivery(team, member, scope, input);
		this.changed(team);
		return { binding: this.binding(team, member), scope: copy(scope), deliveryId, input };
	}

	private activationInput(team: TeamState, member: RuntimeMember, deliveryId: string, scope: ActivationInput["scope"],
		budget: ActivationInput["budget"]): ActivationInput {
		const outcomes: OutcomeView[] = [];
		let candidates: WorkRef[] = [];
		let ownedChildren: Array<{ work: WorkRef; state: WorkVersion["state"] }> = [];
		let childIssues: ChildIssue[] = [];
		if (scope.kind === "work") {
			const version = team.ledger.version(scope.work)!;
			childIssues = this.pendingChildIssues(team, version);
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
		const signalOutcomes = scope.kind === "work" ? (team.ledger.version(scope.work)!.waitingForSignals ?? [])
			.filter((id) => !team.ledger.version(scope.work)!.observedSignals?.includes(id))
			.map((id) => team.ledger.signals.get(id)!).filter((signal) => signal.state !== "pending") : [];
		const result: ActivationInput = {
			version: TEAM_PROTOCOL_VERSION, teamId: team.id, deliveryId,
			member: { id: member.id, lead: member.id === team.lead, roleDescription: member.roleDescription },
			goal: team.plan.brief.goal,
			roster: this.roster(team, member.id),
			scope: copy(scope), outcomes, ...(signalOutcomes.length ? { signalOutcomes: copy(signalOutcomes), omittedSignalOutcomes: 0 } : {}), omittedOutcomes: 0, ...(childIssues.length ? { childIssues: copy(childIssues) } : {}),
			ownedChildren, budget, notice: (scope.kind === "work" ? workNotice(scope.work) : `${member.id === team.lead ? prompt("team", "events_notice") : prompt("team", "messages_notice")} ${prompt("team", "brief_pointer")}`)
				+ (member.overflowRecoveries?.has(scope.kind === "work" ? workRefKey(scope.work) : "events") ? `\n${prompt("team", "overflow_notice")}` : ""),
		};
		const projected = projectActivationInput(result);
		if (projected.childIssues) projected.notice += ` ${prompt("team", "child_issue_notice")}`;
		// Set from a transient error until the member's next success: exactly the retry activations carry it.
		if (member.retry) projected.notice += ` ${prompt("team", "transient_retry", { error: member.retry.error })}`;
		return projected;
	}

	private addDelivery(team: TeamState, member: RuntimeMember, scope: ActivationScope, input: ActivationInput): void {
		// Only these outcomes survived size projection and the per-consumer unknown-outcome gate.
		const dependencyOutcomes = input.outcomes.map((outcome) => copy(outcome.work));
		team.deliveries.set(input.deliveryId, { id: input.deliveryId, memberId: member.id, activationId: scope.activationId,
			...(scope.kind === "work" ? { work: copy(scope.work!) } : {}),
			state: "in_flight", dependencyOutcomes, ...(input.signalOutcomes?.length ? { signalOutcomes: input.signalOutcomes.map((signal) => signal.id) } : {}), ...(input.childIssues ? { childIssueIds: input.childIssues.map((issue) => issue.incidentId) } : {}) });
	}

	private finishActivation(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		const cleanup = active.cleanup!;
		const scope = active.scope;
		const delivery = team.deliveries.get(active.deliveryId)!;
		this.endFlow(team, active);
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
			if (member.id === team.lead) {
				this.holdLeadWork(team);
				this.pauseMembersForLeadFault(team);
			} else this.failMemberWork(team, member, scope.work);
			delivery.state = "unknown";
			this.createIncident(team, "CLEANUP_FAILED", `${member.id} could not confirm activation cleanup: ${member.error.message}`,
				scope.kind === "work" ? scope.work : undefined, member.id);
			this.note(team, `${member.id} activation cleanup failed`);
			this.failMessages(team, member, "Recipient activation cleanup failed");
			member.activity = "settling";
			this.changed(team);
			this.wakeWaiters(team);
			return;
		}
		if (delivery.state === "in_flight") delivery.state = active.inputReady ? "delivered" : "unknown";
		if (scope.kind === "events") this.finishEvents(team, member, active);
		else this.finishWork(team, member, active);
		// A committed reply already has its own result milestone.
		if (!(active.intent?.kind === "reply" && team.ledger.version(scope.work!)?.resultRef)) {
			const intent = active.intent;
			const ending = intent?.kind === "yield_dependencies"
				? `waiting on ${this.byCreation(team, intent.waitingFor, (ref) => ref).map((ref) => {
					const record = team.ledger.get(ref.workId)!.record;
					return `${record.assignee} · ${shortWorkRef(ref)} «${record.title}»`;
				}).join(", ")}`
				: intent?.kind.replaceAll("_", " ");
			this.note(team, `${member.id} ended ${scope.kind === "work" ? shortWorkRef(scope.work!) : "events activation"}${ending ? ` (${ending})` : ""}`);
		}
		if (member.active === active) delete member.active;
		delete member.currentWork;
		member.activity = "idle";
		this.tickFlow(team);
		member.idleSinceActiveMs = team.flow.activeMs;
		this.resumeParkedActivations(team);
		if (member.lifecycle === "open" && member.pause === "requested") this.setMemberPause(team, member, "confirmed");
		if (member.lifecycle === "closing" && member.id === team.lead) member.resourceState = "stopping";
		this.changed(team);
		this.updateQuiescence(team);
		this.finishTeamCloseIfReady(team);
	}

	/**
	 * A transient provider error (no end intent staged, member open, Team active) keeps the member open for another
	 * activation of the same session after a wait. False when retries are exhausted or not applicable: the caller faults as usual.
	 */
	private scheduleRetry(team: TeamState, member: RuntimeMember, active: ActiveActivation): boolean {
		const error = active.native?.status === "error" ? active.native.error : undefined;
		if (!error?.transient || active.native?.overflow || active.intent || member.lifecycle !== "open" || team.lifecycle !== "active") return false;
		const now = this.timestamp();
		const previous = member.retry;
		const attempts = previous?.attempts ?? 0;
		const firstAt = previous?.firstAt ?? now;
		if (attempts >= RETRY_DELAYS_MS.length && (member.id !== team.lead || now - firstAt >= LEAD_RETRY_WINDOW_MS)) {
			delete member.retry;
			return false;
		}
		const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)]!;
		member.retry = { attempts: attempts + 1, firstAt, nextAt: now + delay, error: previewText(error.message, 120) };
		team.transientRetries++;
		this.note(team, `${member.id} transient error (${member.retry.error}); retry ${member.retry.attempts} in ${delay / 1000}s`);
		this.armRetry(team, member);
		return true;
	}

	/** Wake the scheduler when the member's wait ends. */
	private armRetry(team: TeamState, member: RuntimeMember): void {
		const key = `${team.id}\0${member.id}`;
		clearTimeout(this.retryTimers.get(key));
		const timer = setTimeout(() => {
			this.retryTimers.delete(key);
			// A timer may fire slightly before the Runtime clock reaches nextAt.
			if (this.retryWaitMs(member)) this.armRetry(team, member);
			else this.requestDrain(team.id);
		}, this.retryWaitMs(member));
		// A retry timer alone never keeps the process alive.
		timer.unref();
		this.retryTimers.set(key, timer);
	}

	private retryWaitMs(member: RuntimeMember): number {
		return member.retry ? Math.max(0, member.retry.nextAt - this.timestamp()) : 0;
	}

	/** Panel words while the member waits to retry; the lead's count has no limit after the worker's 5. */
	private retryText(team: TeamState, member: RuntimeMember): string | undefined {
		const wait = this.retryWaitMs(member);
		if (!wait) return undefined;
		const { attempts, error } = member.retry!;
		return `retrying ${attempts}${member.id === team.lead && attempts > RETRY_DELAYS_MS.length ? "" : `/${RETRY_DELAYS_MS.length}`} · next ${Math.ceil(wait / 1000)}s · ${error}`;
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
			&& ["policy_pause", "policy_superseded", "policy_cancelled", "budget_hold", "loop_hold"].includes(completionReason);
		if (active.native?.status !== "success" && !controlledAbort) {
			delete team.ledger.get(ref.workId)!.stagedWait;
			if (!active.stopReason && version.state === "running" && (this.scheduleOverflow(team, member, active) || this.scheduleRetry(team, member, active))) {
				version.state = "queued";
				version.updatedAt = this.timestamp();
				if (!team.ready.some((queued) => sameWorkRef(queued, ref))) this.enqueueWork(team, ref);
				// It already held a permit: after the backoff it must not queue behind fresh work again.
				team.interrupted.add(workRefKey(ref));
				this.wakeWaiters(team);
				return;
			}
			const error = active.native?.error ?? { code: active.native?.status === "length" ? "NATIVE_LENGTH" : "NATIVE_FAILURE",
				message: `Native activation ended with ${active.native?.status ?? "unknown"}` };
			if (!isTerminalWorkState(version.state)) {
				version.state = "failed";
				version.error = copy(error);
				version.updatedAt = this.timestamp();
				this.recordFailedReview(team, member, ref, error.message);
			} else {
				this.createIncident(team, error.code, error.message, ref, member.id);
			}
			member.error = { code: error.code, message: error.message };
			team.health = "needs_attention";
			if (member.lifecycle !== "closing") {
				member.lifecycle = "faulted";
				member.resourceState = "owned";
				this.addEvent(team, { key: `member-fault:${member.id}:${active.scope.activationId}`, kind: "MEMBER_FAULTED", message: prompt("team", "event_member_failed", { member: member.id }), memberId: member.id, work: ref });
				if (member.id === team.lead) {
					this.holdLeadWork(team);
					this.pauseMembersForLeadFault(team);
				} else this.failMemberWork(team, member, ref);
			}
			this.wakeWaiters(team);
			return;
		}
		if ((controlledAbort || active.native?.status === "success") && !active.intent
			&& (completionReason === "policy_pause" || completionReason === "budget_hold" || completionReason === "loop_hold")) {
			delete entry.stagedWait;
			if (current && sameWorkRef(current, ref) && version.state === "running") {
				const progress = active.native?.finalAssistantText?.trim();
				if (progress) version.checkpoint = previewText(progress, TEAM_MAX_NOTE_BYTES);
				version.updatedAt = this.timestamp();
				if (completionReason === "policy_pause") {
					version.state = "queued";
					this.setMemberPause(team, member, "confirmed");
					if (!team.ready.some((queued) => sameWorkRef(queued, ref))) this.enqueueWork(team, ref);
				} else if (completionReason === "loop_hold") {
					this.holdWork(team, member, ref, "TOOL_LOOP",
						`${member.id} repeated the same failing ${active.loopStop!.tool} call ${TEAM_LOOP_REPEATS} times; the work is held`, "protocol");
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
		member.overflowRecoveries?.delete(workRefKey(ref));
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
			team.dependencyWaits++;
			const record = team.ledger.get(ref.workId)!;
			delete record.stagedWait;
			delete version.waitingForSignals;
			version.waitingFor = intent.waitingFor.filter((dependency) => !version.observedOutcomes.some((observed) => sameWorkRef(observed, dependency)));
			version.checkpoint = intent.checkpoint;
			const allReady = version.waitingFor.every((dependency) => team.ledger.outcomeReady(dependency));
			version.state = allReady ? "queued" : "blocked";
			version.updatedAt = this.timestamp();
			if (!allReady && team.ledger.get(ref.workId)!.record.kind !== "review") {
				this.tickFlow(team);
				team.flow.waiting.set(workRefKey(ref), { since: team.flow.activeMs, refs: copy(version.waitingFor.filter((dependency) => !team.ledger.outcomeReady(dependency))) });
			}
			if (allReady && !team.ready.some((item) => sameWorkRef(item, ref))) this.enqueueWork(team, ref);
			this.updateQuiescence(team);
		} else if (intent?.kind === "yield_signals") {
			team.dependencyWaits++;
			delete entry.stagedWait;
			version.waitingFor = [];
			version.waitingForSignals = intent.waitingForSignals.filter((id) => !version.observedSignals?.includes(id));
			version.checkpoint = intent.checkpoint;
			version.state = this.signalsReady(team, version) ? "queued" : "blocked";
			version.updatedAt = this.timestamp();
			if (version.state === "queued") this.enqueueWork(team, ref);
		} else if (intent?.kind === "yield_attention") {
			team.questions++;
			this.holdWork(team, member, ref, "WORK_HELD", intent.attention, "attention");
			version.checkpoint = intent.checkpoint;
			version.waitingFor = [];
			delete version.waitingForSignals;
		} else if (intent?.kind === "idle") {
			version.state = "failed";
			version.error = { code: "PROTOCOL_FAILURE", message: "A work activation cannot use the events-activation idle intent" };
			version.updatedAt = this.timestamp();
		} else if (this.canCommitNaturalFinal(team, ref, active)) {
			const result: WorkResult = { status: "succeeded", summary: active.native!.finalAssistantText!.trim() };
			this.commitResult(team, member, ref, result, "natural_final");
		} else {
			this.holdWork(team, member, ref, "PROTOCOL_FAILURE", "Native work ended without a valid reply or yield", "protocol");
		}
		this.wakeWaiters(team);
	}

	private finishEvents(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		const intent = active.intent;
		const intentApplied = !intent || active.native?.appliedToolCallId === intent.toolCallId;
		const budgetStopped = active.native?.status === "aborted" && active.completion?.reason === "budget_hold";
		if (budgetStopped && !intent) {
			this.failMessages(team, member, "Activation stopped before confirmed handling because its budget was exhausted", active.scope.eventBatchId);
			// The lead's own budget stopped it before any decision. It stays open; the delivered batch
			// is not replayed automatically. The deduplicated budget incident drives any emergency activation.
			this.consumeBatch(team, active.scope.eventBatchId);
			this.budgetIncident(team, active.budgetStop ?? { scope: { kind: "team" }, counter: "teamModelRequests" });
			return;
		}
		if (this.scheduleOverflow(team, member, active) || this.scheduleRetry(team, member, active)) {
			// The batch is not consumed: its events are delivered again after the wait.
			for (const event of team.events) if (event.batchId === active.scope.eventBatchId) delete event.batchId;
			team.eventBatches.delete(active.scope.eventBatchId!);
			return;
		}
		// A legal end intent already confirmed in the transcript survives a later budget stop of a continuation.
		if ((active.native?.status !== "success" && !(budgetStopped && intentApplied)) || !intentApplied) {
			this.failMessages(team, member, "Recipient activation did not confirm message handling");
			const closing = member.lifecycle === "closing";
			if (team.lifecycle === "closing") {
				team.lifecycle = "failed";
				team.reason = `Lead close activation lacked confirmed native evidence (status=${active.native?.status ?? "missing"}, hasIntent=${!!intent}, hasAppliedId=${!!active.native?.appliedToolCallId}, intentApplied=${intentApplied})`;
			}
			if (!closing) member.lifecycle = "faulted";
			member.error = { code: active.native?.error?.code ?? (intentApplied ? (active.native?.status === "length" ? "NATIVE_LENGTH" : "LEAD_FAILURE") : "PROTOCOL_FAILURE"),
				message: active.native?.error?.message ?? (intentApplied ? "Lead activation failed" : "Staged intent was not confirmed in the native transcript") };
			if (!closing) member.resourceState = "owned";
			team.health = "needs_attention";
			this.addEvent(team, { key: `lead-fault:${active.scope.activationId}`, kind: "MEMBER_FAULTED", message: (member.id === team.lead ? prompt("team", "event_lead_failed") : prompt("team", "event_member_failed", { member: member.id })), memberId: member.id });
			if (member.id === team.lead) {
				this.holdLeadWork(team);
				this.pauseMembersForLeadFault(team);
			} else this.failMemberWork(team, member);
			this.wakeWaiters(team);
			return;
		}
		member.overflowRecoveries?.delete("events");
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
		const resultRef = this.modelId(team, "result");
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
		if (!record.parent && record.kind !== "review") {
			this.tickFlow(team);
			team.flow.committedAt.set(workRefKey(ref), team.flow.activeMs);
		}
		if (record.kind === "review") {
			const review = this.recordReview(team, member, ref, resultRef, result);
			// An ON TRACK review is only recorded; anything else (a risk, no verdict, a failed review) reaches the lead.
			if (reviewVerdict(result.summary) !== "on_track" || result.status === "failed") this.addEvent(team, { key: `review:${resultRef}`, kind: "REVIEW_READY", work: ref, resultRef,
				message: prompt("team", "event_review_ready", { work: workRefKey(ref), member: member.id, result_ref: resultRef, times: reviewTiming(review), result: formatWorkResult(result) }) });
		} else if (!record.parent) this.addEvent(team, { key: `root-result:${workRefKey(ref)}:${resultRef}`, kind: "ROOT_RESULT_READY",
			message: prompt("team", "event_root_result_ready", { work: workRefKey(ref), status: result.status, result_ref: resultRef, member: member.id, result: formatWorkResult(result) }), work: ref, resultRef });
		this.wakeWaiters(team);
	}

	/** Host display milestone (wall clock, so the injectable Runtime clock is unaffected); bounded, keeping the start and the newest. */
	private note(team: TeamState, text: string): void {
		team.timeline.push({ at: Date.now(), text });
		if (team.timeline.length > TEAM_MAX_TIMELINE) {
			team.timeline.splice(TEAM_TIMELINE_HEAD, 1);
			team.timelineOmitted++;
		}
	}

	/** Tell the lead which roots already run from initialRequests, so it never requests them again. */
	private bootMessage(team: TeamState): string {
		const initial = team.ledger.order.map((id) => team.ledger.get(id)!.record);
		const outcomeRule = prompt("team", "boot_outcome_rule");
		if (!initial.length) return prompt("team", "boot_no_work", { outcome_rule: outcomeRule });
		const assigned = initial.map((record) => `${record.assignee} ${workRefKey({ workId: record.id, revision: record.currentRevision })} "${previewText(currentVersion(record).task, 160)}"`);
		return prompt("team", "boot_assigned", { count: String(initial.length), assigned: assigned.join("; "), outcome_rule: outcomeRule });
	}

	private canCommitNaturalFinal(team: TeamState, ref: WorkRef, active: ActiveActivation): boolean {
		const text = active.native?.finalAssistantText;
		if (!active.inputReady || active.native?.status !== "success" || active.native.pendingToolCalls || typeof text !== "string" || !text.trim()) return false;
		const candidate: WorkResult = { status: "succeeded", summary: text.trim() };
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > TEAM_MAX_RESULT_BYTES || jsonTextBytes(candidate.summary) > TEAM_MAX_TEXT_ITEM_BYTES) return false;
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
			this.dequeueWork(team, ref);
			this.changed(team);
		}
	}

	private wakeWaiters(team: TeamState): void {
		this.settleSignals(team);
		this.flowDependenciesReady(team);
		this.holdUnknownDependencies(team);
		for (const id of team.ledger.order) {
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if (version.state !== "blocked" || version.hold) continue;
			// A held sub-task also wakes its parent, whose dependencies may still be unresolved.
			const dependenciesReady = version.waitingFor.length > 0 && version.waitingFor.every((waited) => team.ledger.outcomeReady(waited));
			if (!dependenciesReady && !this.signalsReady(team, version) && !this.pendingChildIssues(team, version).length) continue;
			version.state = "queued";
			version.updatedAt = this.timestamp();
			if (!team.ready.some((item) => sameWorkRef(item, ref))) this.enqueueWork(team, ref);
		}
		this.updateQuiescence(team);
	}

	private updateQuiescence(team: TeamState): void {
		if (!team.bootProcessed || team.lifecycle !== "active" || team.hostPause || [...team.members.values()].some((member) => member.active)) return;
		const records = this.plainRecords(team);
		if (records.some((record) => !isTerminalWorkState(currentVersion(record).state) && currentVersion(record).state !== "blocked")) return;
		const signature = records.map((record) => {
			const id = record.id;
			const version = currentVersion(record);
			return `${id}@${record.currentRevision}:${version.state}:${version.hold?.incidentId ?? ""}:${version.resultRef ?? ""}:${version.review?.disposition ?? ""}:${version.review?.reason ?? ""}`;
		}).join("|");
		this.addEvent(team, { key: `quiescent:${createHash("sha1").update(signature).digest("hex")}`, kind: "TEAM_QUIESCENT", message: prompt("team", "event_quiescent") });
	}

	private cancelDescendants(team: TeamState, ref: WorkRef, state: "cancelled" | "superseded", unknownActiveOutcome = false): void {
		for (const child of team.ledger.openSubtree(ref)) {
			const version = team.ledger.version(child)!;
			const member = team.members.get(team.ledger.get(child.workId)!.record.assignee)!;
			const active = member.active?.scope.kind === "work" && sameWorkRef(member.active.scope.work!, child);
			version.state = state;
			version.waitingFor = [];
			delete version.waitingForSignals;
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
			this.dequeueWork(team, child);
		}
	}

	private stopMemberWork(team: TeamState, member: RuntimeMember, reason: string): void {
		this.failMessages(team, member, `Recipient stopped: ${reason}`);
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
			delete version.waitingForSignals;
			delete version.hold;
			version.updatedAt = this.timestamp();
			if (version.state === "failed") this.recordFailedReview(team, member, ref, version.error.message);
			delete entry.stagedWait;
			this.dequeueWork(team, ref);
			if (active) {
				activeMember.active!.stopReason = "cancelled";
				team.ledger.cleanupPending.add(workRefKey(ref));
				this.requestActivationStop(team, activeMember, "policy_cancelled");
			}
			this.cancelDescendants(team, ref, "cancelled", true);
		}
	}

	private failMemberWork(team: TeamState, member: RuntimeMember, failedRef?: WorkRef): void {
		this.failMessages(team, member, "Recipient activation failed");
		if (failedRef) this.cancelDescendants(team, failedRef, "cancelled");
		for (const id of team.ledger.order) {
			const entry = team.ledger.get(id)!;
			if (entry.record.assignee !== member.id) continue;
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if (isTerminalWorkState(version.state)) continue;
			version.state = "failed";
			version.waitingFor = [];
			delete version.waitingForSignals;
			delete version.hold;
			version.error = { code: "MEMBER_UNAVAILABLE", message: `${member.id} faulted before this work could finish` };
			version.updatedAt = this.timestamp();
			this.recordFailedReview(team, member, ref, version.error.message);
			delete entry.stagedWait;
			this.dequeueWork(team, ref);
			this.cancelDescendants(team, ref, "cancelled");
		}
	}

	private pauseMembersForLeadFault(team: TeamState): void {
		for (const member of team.members.values()) {
			if (member.id === team.lead || member.lifecycle !== "open" || member.pause !== "none") continue;
			this.setMemberPause(team, member, member.active ? "requested" : "confirmed");
			this.changed(team);
		}
	}

	private holdLeadWork(team: TeamState): void {
		for (const id of team.ledger.order) {
			const entry = team.ledger.get(id)!;
			if (entry.record.assignee !== team.lead) continue;
			const ref = team.ledger.currentRef(id)!;
			const version = team.ledger.version(ref)!;
			if (isTerminalWorkState(version.state)) continue;
			const incident = this.createIncident(team, "LEAD_UNAVAILABLE", "The lead is unavailable; host cancellation or a new Team is required", ref, team.lead);
			version.state = "blocked";
			version.waitingFor = [];
			delete version.waitingForSignals;
			version.hold = { reason: "lead_unavailable", incidentId: incident.id };
			version.updatedAt = this.timestamp();
			delete entry.stagedWait;
			this.dequeueWork(team, ref);
		}
	}

	private holdForBudget(team: TeamState, ref: WorkRef, exhausted: BudgetExhaustion): void {
		const version = team.ledger.version(ref)!;
		if (version.state !== "queued") return;
		const incident = this.budgetIncident(team, exhausted);
		version.state = "blocked";
		version.hold = { reason: "budget", incidentId: incident.id };
		version.updatedAt = this.timestamp();
		this.dequeueWork(team, ref);
	}

	private requireResult(team: TeamState, ref: string): void {
		if (team.ledger.results.has(ref)) return;
		const work = team.ledger.get(ref);
		const resultRef = work && currentVersion(work.record).resultRef;
		fail("UNKNOWN_RESULT", work ? `${ref} is a work ID, not a result ID; ${resultRef ? `its current result is ${resultRef}` : "it has no committed result yet"}`
			: `Unknown result reference ${ref}`);
	}

	/** Ending held work (cancel, revise) is the lead's answer to its attention/protocol incident. */
	private dropHold(team: TeamState, version: WorkVersion): void {
		if (version.hold?.reason === "attention" || version.hold?.reason === "protocol") this.resolveIncident(team, version.hold.incidentId);
		delete version.hold;
	}

	private resolveIncident(team: TeamState, incidentId: string): void {
		const incident = team.incidents.find((item) => item.id === incidentId);
		if (incident) incident.state = "resolved";
		this.refreshHealth(team);
	}

	/** Faults and stopped members keep the Team flagged; only answered incidents clear it. */
	private refreshHealth(team: TeamState): void {
		if (!team.incidents.some((item) => item.state === "open") && ![...team.members.values()].some((member) => member.error)) team.health = "ok";
	}

	/**
	 * Hold a work version for a decision (resume_work, revise or cancel). A sub-task's decision is its requester's:
	 * the issue goes to the waiting parent. Everything else is announced to the lead as WORK_HELD.
	 */
	private holdWork(team: TeamState, member: RuntimeMember, ref: WorkRef, code: string, message: string, reason: "attention" | "protocol"): void {
		const record = team.ledger.get(ref.workId)!.record;
		const parent = record.parent ? team.ledger.version(record.parent) : undefined;
		// A terminal or held parent cannot answer; a faulted or closed requester always leaves its parent terminal.
		const toParent = parent && !isTerminalWorkState(parent.state) && !parent.hold;
		const incident = this.createIncident(team, code, message, ref, member.id, undefined, toParent ? null : "WORK_HELD");
		const version = team.ledger.version(ref)!;
		version.state = "blocked";
		version.hold = { reason, incidentId: incident.id };
		version.updatedAt = this.timestamp();
		if (toParent) {
			(parent.childIssues ??= []).push({ work: copy(ref), assignee: member.id, incidentId: incident.id, reason,
				message: projectErrorText(message, TEAM_MAX_CHILD_ISSUE_MESSAGE_BYTES) });
			parent.updatedAt = version.updatedAt;
		}
	}

	/** Held sub-tasks of a version that still need its owner's decision. */
	private pendingChildIssues(team: TeamState, version: WorkVersion): ChildIssue[] {
		return (version.childIssues ?? []).filter((issue) => team.incidents.some((incident) => incident.id === issue.incidentId && incident.state === "open"));
	}

	private createIncident(team: TeamState, code: string, message: string, work?: WorkRef, memberId?: string, scopeRootId?: string,
		/** null: the incident is answered elsewhere and raises no Team event. */
		kind: TeamEventView["kind"] | null = code === "BUDGET_HIT" || code === "DEPENDENCY_UNAVAILABLE" ? code : "MEMBER_FAULTED"): TeamIncidentView {
		const rootId = work ? team.ledger.get(work.workId)?.record.rootId : scopeRootId;
		const current = team.incidents.find((incident) => incident.state === "open" && incident.code === code
			&& incident.memberId === memberId && incident.rootId === rootId && (incident.work ? work && sameWorkRef(incident.work, work) : !work));
		if (current) return current;
		const incident: TeamIncidentView = { id: this.modelId(team, "incident"), code, message, state: "open", createdAt: this.timestamp(),
			...(work ? { work: copy(work) } : {}), ...(rootId ? { rootId } : {}), ...(memberId ? { memberId } : {}) };
		team.incidents.push(incident);
		if (kind) this.addEvent(team, { key: `incident:${incident.id}`, kind, message, ...(work ? { work: copy(work) } : {}), ...(memberId ? { memberId } : {}), incidentId: incident.id });
		team.health = "needs_attention";
		return incident;
	}

	private addEvent(team: TeamState, event: Omit<InternalEvent, "id" | "processed">): InternalEvent {
		const duplicate = team.events.find((item) => item.key === event.key);
		if (duplicate) return duplicate;
		const created: InternalEvent = { ...event, id: this.modelId(team, "event"), processed: false };
		team.events.push(created);
		team.eventSeq++;
		this.changed(team);
		return created;
	}

	private requeueOrphanEventBatches(team: TeamState): void {
		const active = new Set([...team.members.values()].flatMap((member) => member.lifecycle === "open" && member.active?.scope.eventBatchId ? [member.active.scope.eventBatchId] : []));
		for (const id of team.eventBatches.keys()) if (!active.has(id)) {
			for (const event of team.events) if (event.batchId === id) delete event.batchId;
			team.eventBatches.delete(id);
		}
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
		if ([...team.members.values()].some((member) => member.id === team.lead
			? member.lifecycle !== "closed" || member.resourceState !== "released"
			: !((member.lifecycle === "closed" || member.lifecycle === "faulted") && member.resourceState === "released"))) return;
		this.tickFlow(team);
		team.endedAt ??= this.timestamp();
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
			for (let count = 0; count < team.limits.workPermits + 1; count++) {
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

		for (const member of team.members.values()) {
			if (member.lifecycle !== "open" || !["active", "closing"].includes(team.lifecycle)) {
				if (member.compaction?.state === "running") executor.abortCompaction?.(this.binding(team, member));
				delete member.compaction;
				delete member.pendingCompaction;
			} else this.startCompaction(team, member);
		}

		// close_team must not stop even an idle member until the lead's own final activation
		// has crossed native settlement and cleanup. Individual close_member remains independent.
		const lead = team.members.get(team.lead)!;
		if (team.lifecycle === "closing" && lead.active) return;
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
		this.settleSignals(team);
		if (!this.completionReady(team)) return;
		if (!team.terminalJournaled) {
			const unread = team.events.filter((event) => event.kind === "MESSAGE" && !event.processed);
			if (unread.length) {
				for (const event of unread) { event.processed = true; event.deliveryFailure = `Team ${team.lifecycle}`; }
				this.note(team, `${unread.length} messages unavailable because Team ${team.lifecycle}: ${unread.map((event) => event.id).join(", ")}`);
			}
			team.endedAt ??= this.timestamp();
			team.terminalJournaled = true;
			this.note(team, `Team ${team.lifecycle}${team.outcome ? ` · outcome ${team.outcome}` : ""}`);
			const terminal = this.getTeamResult(team.id);
			// A closed success is only reported once its terminal history is written.
			if (terminal) {
				const { activeMs, memberStats, ...result } = terminal;
				if (!this.tryJournal(team, { version: 2, kind: "terminal", teamId: team.id, at: this.timestamp(), endedAt: team.endedAt,
					...(team.closeDecision ? { closeId: team.closeDecision.id } : {}), result, activeMs: activeMs!, memberStats: memberStats!, flow: flowSummary(this.flowStats(team.id)) })) {
					this.applyJournalFailure(team);
				}
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
		if (!member || member.epoch !== binding.epoch) fail("PROTOCOL_FAILURE", "Binding does not match a member lifetime");
		return member;
	}

	private validateBinding(value: BindingV2): BindingV2 {
		return parseBinding(value);
	}

	private validateScope(value: ActivationScope): ActivationScope {
		return parseActivationScope(value);
	}

	private binding(team: TeamState, member: RuntimeMember): BindingV2 {
		return { version: TEAM_PROTOCOL_VERSION, teamId: team.id, memberId: member.id, epoch: member.epoch };
	}

	private makeWork(team: TeamState, requester: string, assignee: string, task: string, inputRefs: string[], parent: WorkRef | undefined, at: number, rootId?: string, depth = 0, title?: string): WorkRecord {
		const id = this.modelId(team, "work");
		const version = this.makeVersion(1, task, inputRefs, at);
		return { id, title: normalizeTitle(title, task), requester, assignee, rootId: rootId ?? id, ...(parent ? { parent: copy(parent) } : {}), depth, currentRevision: 1, versions: [version] };
	}

	private makeVersion(revision: number, task: string, inputRefs: string[], at: number): WorkVersion {
		return { revision, task, inputRefs: copy(inputRefs), state: "queued", waitingFor: [], observedOutcomes: [], createdAt: at, updatedAt: at };
	}

	private assertInputFits(team: TeamState, member: RuntimeMember, work: WorkRecord, parent?: WorkRef): void {
		const version = currentVersion(work);
		const scope: WorkScope = {
			kind: "work", work: { workId: work.id, revision: work.currentRevision }, task: version.task,
			requester: work.requester, rootId: work.rootId, ...(parent ? { parent } : {}), depth: work.depth, inputRefs: version.inputRefs, waitingFor: version.waitingFor,
		};
		this.previewInput(team, member, `input-check:${work.id}`, scope);
	}

	/** `self` is the member this input is for: it is about to run. */
	private roster(team: TeamState, self?: string): ActivationInput["roster"] {
		// Load per member, so the lead can see who is free: queued and waiting (blocked or held) current works.
		const load = new Map<string, { queued: number; waiting: number }>();
		for (const id of team.ledger.order) {
			const entry = team.ledger.get(id)!;
			const state = currentVersion(entry.record).state;
			if (state !== "queued" && state !== "blocked") continue;
			const counts = load.get(entry.record.assignee) ?? { queued: 0, waiting: 0 };
			if (state === "queued") counts.queued++;
			else counts.waiting++;
			load.set(entry.record.assignee, counts);
		}
		this.tickFlow(team);
		return [...team.members.values()].map((item) => {
			const counts = load.get(item.id);
			const running = !!item.active || item.id === self;
			const free = item.lifecycle === "open" && !running && !counts?.queued;
			return { id: item.id, ...(item.id === team.lead ? { lead: true as const } : {}),
				lifecycle: item.lifecycle, ...(this.memberContext(item) ? { contextPercent: this.memberContext(item)!.percent } : {}), contextTokens: item.usage.contextTokens,
				...(running ? { running: true as const } : {}), ...(counts?.queued ? { queued: counts.queued } : {}),
				...(counts?.waiting ? { waiting: counts.waiting } : {}),
				...(free ? { idleMinutes: Math.floor(Math.max(0, team.flow.activeMs - (item.idleSinceActiveMs ?? 0)) / 60_000) } : {}) };
		});
	}

	private previewInput(team: TeamState, member: RuntimeMember, deliveryId: string, scope: WorkScope): ActivationInput {
		const input: ActivationInput = {
			version: TEAM_PROTOCOL_VERSION, teamId: team.id, deliveryId,
			member: { id: member.id, lead: member.id === team.lead, roleDescription: member.roleDescription }, goal: team.plan.brief.goal,
			roster: this.roster(team, member.id),
			scope, outcomes: [], omittedOutcomes: 0, ownedChildren: [],
			// Size check only: the largest possible budget summary.
			budget: { emergency: false, modelRequests: Number.MAX_SAFE_INTEGER, toolCalls: Number.MAX_SAFE_INTEGER, activations: Number.MAX_SAFE_INTEGER },
			notice: workNotice(scope.work),
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
			return { work: { workId: id, revision: record.currentRevision }, title: record.title!, requester: record.requester, assignee: record.assignee,
				...(record.parent ? { parent: copy(record.parent) } : {}),
				state: version.state, taskPreview: previewText(version.task, 512), ...(version.hold ? { hold: version.hold.reason } : {}),
				...(version.resultRef ? { resultRef: version.resultRef } : {}), ...(version.review ? { review: version.review.disposition } : {}),
				...(record.kind ? { kind: record.kind } : {}) };
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
			const expected: EndIntent | undefined = active.scope.kind === "events"
				? action.waitingFor.length === 0 && !action.waitingForSignals?.length && action.attention === undefined
					? { kind: "idle", ...(action.checkpoint ? { checkpoint: action.checkpoint } : {}), toolCallId }
					: undefined
				: action.waitingForSignals?.length && action.checkpoint
					? { kind: "yield_signals", work: active.scope.work!, waitingForSignals: action.waitingForSignals, checkpoint: action.checkpoint, toolCallId }
					: action.attention !== undefined && action.checkpoint
					? { kind: "yield_attention", work: active.scope.work!, attention: action.attention, checkpoint: action.checkpoint, toolCallId }
					: action.waitingFor.length && action.checkpoint
						? { kind: "yield_dependencies", work: active.scope.work!, waitingFor: action.waitingFor, checkpoint: action.checkpoint, toolCallId }
						: undefined;
			if (expected && canonicalJson(current) === canonicalJson(expected)) {
				return okReply(member.id, { receipt: { status: "staged", intent: current.kind, ...(current.kind === "yield_attention" || current.kind === "yield_dependencies" || current.kind === "yield_signals" ? { work: current.work } : {}) } });
			}
		}
		if (action.action === "control" && action.control.command === "close_team" && current.kind === "close_team"
			&& team.closeDecision && canonicalJson({ resultRefs: action.control.resultRefs, outcome: action.control.outcome, reason: action.control.reason })
				=== canonicalJson({ resultRefs: team.closeDecision.resultRefs, outcome: team.closeDecision.outcome, reason: team.closeDecision.reason })) {
			return okReply(member.id, { receipt: { status: "closing", command: "close_team", closeId: current.closeId } });
		}
		fail("INTENT_CONFLICT", "The same tool call attempted a conflicting end intent");
	}

	/** Per-read counts: include review work in activity, but not in deliverable roots. */
	private workCounts(team: TeamState) {
		const works: TeamTeamView["works"] = { total: team.ledger.order.length, queued: 0, running: 0, blocked: 0, held: 0,
			resolved: 0, failed: 0, cancelled: 0, roots: 0, rootsReviewed: 0 };
		const memberCounts = new Map([...team.members.keys()].map((id) => [id, { queued: 0, blocked: 0, held: 0 }]));
		const roots: string[] = [];
		const rootChildren = new Map<string, number>();
		for (const id of team.ledger.order) {
			const record = team.ledger.get(id)!.record;
			const version = currentVersion(record);
			works[version.state === "superseded" ? "cancelled" : version.state]++;
			const counts = memberCounts.get(record.assignee)!;
			if (version.state === "queued" || version.state === "blocked") counts[version.state]++;
			if (version.hold) { works.held++; counts.held++; }
			if (record.parent) rootChildren.set(record.rootId, (rootChildren.get(record.rootId) ?? 0) + 1);
			else if (record.kind !== "review") {
				roots.push(id);
				works.roots++;
				if (version.review) works.rootsReviewed++;
			}
		}
		return { works, memberCounts, rootBudgets: roots.map((id) => team.budget.rootView(id, rootChildren.get(id) ?? 0)) };
	}

	private view(team: TeamState): TeamTeamView {
		const { works, memberCounts, rootBudgets } = this.workCounts(team);
		this.tickFlow(team);
		const usage = copy(team.usage);
		const members: TeamMemberView[] = [...team.members.values()].map((member) => {
			const context = this.memberContext(member);
			const memberUsage = copy(member.usage);
			const active = member.active;
			const live = active && !active.native && !active.activeTimeFolded ? this.liveUsage?.(team.id, member.id) : undefined;
			if (live) { addActivationUsage(memberUsage, live); addActivationUsage(usage, live); }
			return {
				id: member.id, roleDescription: member.roleDescription, lifecycle: member.lifecycle,
				activity: member.activity, pause: member.pause, ...(member.currentWork ? { currentWork: copy(member.currentWork) } : {}),
				resourceState: member.resourceState,
				...(member.error ? { error: projectWorkError(member.error) } : {}),
				...memberCounts.get(member.id)!,
				policy: copy(member.policy),
				...(context ? { context } : {}),
				...(member.compaction?.state === "running" ? { compacting: true } : {}),
				...(member.lastCompaction ? { lastCompaction: copy(member.lastCompaction) } : {}),
				usage: memberUsage,
			};
		});
		const used: TeamBudgetView["used"] = { teamWorks: team.ledger.order.length, ...team.budget.used, reservedResultBytes: team.reservedResultBytes };
		// Bounded summaries (one private reply frame): exhausted, then granted, then used roots; untouched
		// roots show the Team-wide default limits. Open incidents first, then the newest resolved ones.
		const budgetRoots = rootBudgets
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
			version: TEAM_PROTOCOL_VERSION, teamId: team.id, title: team.plan.title!, shortId: team.id.slice(0, 8), lifecycle: team.lifecycle, health: team.health, stateVersion: team.stateVersion,
			eventSeq: team.eventSeq, lead: team.lead, timeoutSeconds: team.plan.timeoutSeconds, deadline: team.deadline, brief: copy(team.plan.brief), members,
			works,
			incidents: incidents.map(incidentView), incidentsOmitted: team.incidents.length - incidents.length,
			budget: { limits: copy(team.limits), used,
				exhausted: team.budget.teamExhausted(false) !== undefined || team.ledger.order.length >= team.limits.teamWorks
					|| team.reservedResultBytes >= team.limits.reservedResultBytes,
				roots: shownRoots, rootsOmitted: budgetRoots.length - shownRoots.length,
				grants: copy(team.budget.grants.slice(-TEAM_VIEW_MAX_GRANTS)), grantsOmitted: Math.max(0, team.budget.grants.length - TEAM_VIEW_MAX_GRANTS) },
			usage,
			...(team.hostPause && team.lifecycle === "active" ? { paused: { since: team.hostPause.at, finishing: this.finishingActivations(team) } } : {}),
			...(team.outcome ? { outcome: team.outcome } : {}), ...(team.reason ? { reason: projectErrorText(team.reason) } : {}),
		};
	}

	private newId(): string { return this.createId(); }

	/** Every ID of this kind in the Team, which a new or a quoted ID is checked against. */
	private modelIds(team: TeamState, kind: ModelIdKind): readonly string[] {
		switch (kind) {
			case "work": return team.ledger.order;
			case "result": return team.ledger.resultOrder;
			case "incident": return team.incidents.map((incident) => incident.id);
			case "event": return team.events.map((event) => event.id);
			case "review": return team.review.records.map((record) => record.id);
			case "signal": return [...team.ledger.signals.keys()];
		}
	}

	/**
	 * A new code with a digit that is not one typo away from any ID of its kind in the Team, so a single
	 * slip in a quoted ID never names another real one: it is always caught as unknown.
	 */
	private modelId(team: TeamState, kind: ModelIdKind): string {
		if (!this.shortIds) return this.id(kind);
		const existing = this.modelIds(team, kind);
		for (;;) {
			const id = `${kind}:${Array.from({ length: 4 }, () => ID_ALPHABET.charAt(randomInt(ID_ALPHABET.length))).join("")}`;
			if (/[2-9]/u.test(id.slice(kind.length + 1)) && !existing.some((other) => other === id || isTypo(id, other))) return id;
		}
	}

	private id(kind: string): string {
		// Internal IDs (activation, delivery, close, grant, Team) are never copied by members and may be looked up across Teams.
		const id = `${kind}:${this.createId()}`;
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

	private foldUsage(team: TeamState, member: RuntimeMember, usage: SubagentUsage, work?: WorkRef): void {
		addActivationUsage(team.usage, usage);
		addActivationUsage(member.usage, usage);
		if (work) addActivationUsage(this.settledWorkStats(team, work.workId).usage, usage);
	}

	private settledWorkStats(team: TeamState, workId: string): { activeMs: number; usage: SubagentUsage } {
		let stats = team.workStats.get(workId);
		if (!stats) team.workStats.set(workId, stats = { activeMs: 0, usage: emptySubagentUsage() });
		return stats;
	}

	private foldActiveTime(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		if (active.activeTimeFolded) return;
		this.tickFlow(team);
		const ms = Math.max(0, team.flow.activeMs - active.startedActiveMs);
		member.activeMs += ms;
		if (active.scope.work) this.settledWorkStats(team, active.scope.work.workId).activeMs += ms;
		active.activeTimeFolded = true;
	}

	private teamUsage(team: TeamState): SubagentUsage {
		const usage = copy(team.usage);
		for (const member of team.members.values()) {
			if (member.active && !member.active.native && !member.active.activeTimeFolded) {
				const live = this.liveUsage?.(team.id, member.id);
				if (live) addActivationUsage(usage, live);
			}
		}
		return usage;
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

	private check(team: TeamState, force = false): void {
		if (!this.checkInvariants && !force) return;
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
		let workActivations = 0;
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
				if (member.active.workPermitHeld) workActivations++;
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
					const leadHold = member.id === team.lead && version.state === "blocked" && version.hold?.reason === "lead_unavailable";
					if (!leadHold) throw new Error(`Invariant I17: faulted member ${member.id} still owns runnable work ${id}`);
				}
			}
		}
		if (workActivations > team.limits.workPermits) throw new Error("Invariant: work activation permit limit exceeded");
		const budgetUsed = team.budget.used;
		if (budgetUsed.teamActivations > team.limits.teamActivations || budgetUsed.leadActivations > team.limits.leadActivations
			|| budgetUsed.leadActivations > budgetUsed.teamActivations
			|| budgetUsed.emergencyLeadActivations > team.limits.emergencyLeadActivations || team.ledger.order.length > team.limits.teamWorks
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
				const signalIds = [...(version.waitingForSignals ?? []), ...(version.observedSignals ?? [])];
				if (signalIds.some((id) => !team.ledger.signals.has(id))) throw new Error(`Invariant: unknown signal on ${workRefKey(ref)}`);
				if (version.state === "blocked" && !version.hold && this.signalsReady(team, version)) throw new Error(`Invariant: ready signals not scheduled for ${workRefKey(ref)}`);
				if (version.waitingFor.some((dependency) => !team.ledger.version(dependency))) throw new Error(`Invariant I11: unknown dependency on ${workRefKey(ref)}`);
				if (version.state === "queued" && !ready.has(workRefKey(ref))) throw new Error(`Invariant I14: queued work ${workRefKey(ref)} has no ready item`);
				if (version.revision === record.currentRevision && (version.state === "queued" || (version.state === "blocked" && !version.hold))
					&& this.unknownDependencies(team, ref, version).length) throw new Error(`Invariant 13.5: ${workRefKey(ref)} may run on an unacknowledged outcome-unknown dependency`);
				if (version.state === "blocked" && !version.hold && version.waitingFor.length > 0
					&& version.waitingFor.every((dependency) => team.ledger.outcomeReady(dependency))) throw new Error(`Invariant I13: ready dependency was not scheduled for ${workRefKey(ref)}`);
				// A blocked parent with an undelivered child issue is queued (whatever it still waits on) so its owner can answer.
				if (version.state === "blocked" && !version.hold && this.pendingChildIssues(team, version).length) throw new Error(`Invariant I13: child issue was not scheduled for ${workRefKey(ref)}`);
				if (entry.stagedWait?.revision === version.revision) {
					const assignee = team.members.get(record.assignee)!;
					if (assignee.active?.scope.kind !== "work" || !sameWorkRef(assignee.active.scope.work!, ref)
						|| (assignee.active.intent?.kind !== "yield_dependencies" && assignee.active.intent?.kind !== "yield_signals")) throw new Error(`Invariant I09: staged wait has no matching activation intent for ${workRefKey(ref)}`);
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
			if (!team.closeDecision || [...team.members.values()].some((member) => member.id === team.lead
				? member.lifecycle !== "closed" || member.resourceState !== "released"
				: !((member.lifecycle === "closed" || member.lifecycle === "faulted") && member.resourceState === "released"))) {
				throw new Error("Invariant I28: Team cannot be closed before a committed close and release");
			}
		}
		if (team.lifecycle === "closing" && (!team.closeDecision || [...team.members.values()].some((member) => member.active
			&& (member.id !== team.lead ? !this.isReview(team, member.active.scope.work) : member.active.intent?.kind !== "close_team")))) throw new Error("Invariant I27: close_team has an unrelated active operation");
	}

	private parseWorkRefKey(key: string): WorkRef {
		const split = key.lastIndexOf("@");
		const revision = Number(key.slice(split + 1));
		if (split < 1 || !Number.isSafeInteger(revision) || revision < 1) throw new Error(`Invalid internal WorkRef key ${key}`);
		return { workId: key.slice(0, split), revision };
	}
}
