/**
 * Team actor protocol v2: public tool actions, private frames, ledger records and limits.
 * Pure contract module: no runtime state, no I/O. Validation lives in team-codec.ts.
 */
import type { SubagentUsage } from "./session-broker";

export const TEAM_PROTOCOL_VERSION = 2 as const;
export const TEAM_COMMAND = "rail-subagent-team-protocol";
export const TEAM_COMMAND_DESCRIPTION = "Rail private team protocol v2";
export const TEAM_ACTIVATION_MESSAGE_TYPE = "rail-team-activation";
export const TEAM_ACTIVATION_TRIGGER = "Process the current Rail Team input.";
export const TEAM_PRIVATE_ENTRY_TYPE = "rail-subagent-team-protocol-v2";

// Size limits (UTF-8 bytes of the JSON serialization unless noted).
export const TEAM_MAX_WORKERS = 8;
export const TEAM_MAX_MEMBERS = TEAM_MAX_WORKERS + 1;
export const TEAM_MAX_ALIAS_LENGTH = 64;
export const TEAM_MAX_ID_LENGTH = 256;
export const TEAM_MAX_TASK_BYTES = 8 * 1024;
export const TEAM_MAX_ROLE_BYTES = 4 * 1024;
export const TEAM_MAX_BRIEF_BYTES = 32 * 1024;
export const TEAM_MAX_NOTE_BYTES = 4 * 1024; // checkpoint, attention, resume instruction, reasons
export const TEAM_MAX_TEXT_ITEM_BYTES = 8 * 1024;
export const TEAM_MAX_RESULT_BYTES = 12 * 1024;
/** A Manager event may carry one complete root result plus its heading. */
export const TEAM_MAX_EVENT_MESSAGE_BYTES = TEAM_MAX_RESULT_BYTES + TEAM_MAX_NOTE_BYTES;
export const TEAM_MAX_RESULT_ITEMS = 32;
export const TEAM_MAX_INPUT_REFS = 32;
export const TEAM_MAX_WAITING_FOR = 32;
export const TEAM_MAX_ACTIVATION_INPUT_BYTES = 64 * 1024;
export const TEAM_MAX_FRAME_BYTES = 1024 * 1024;
/** Complete raw model arguments, before normalization or private framing. */
export const TEAM_MAX_ACTION_BYTES = 64 * 1024;
/** Public previews are independent of host-grantable ledger capacity. */
export const TEAM_MAX_PUBLIC_CHILDREN = 64;
export const TEAM_MAX_OWNED_CHILD_PREVIEWS = 8;
export const TEAM_MAX_DEPENDENCY_PREVIEW_BYTES = 4 * 1024;
export const TEAM_MAX_DEPENDENCY_PREVIEWS = 8;
export const TEAM_MAX_DELIVERED_OUTCOMES = 32;
export const TEAM_MAX_MANAGER_EVENT_BATCH = 16;
export const TEAM_STATUS_DEFAULT_LIMIT = 20;
export const TEAM_STATUS_MAX_LIMIT = 50;
/**
 * The team view is a bounded summary inside one private reply frame; complete lists are read
 * through paginated status(work|result|incident) pages.
 */
export const TEAM_VIEW_MAX_INCIDENTS = 32;
/** Terminal journal records retain only the newest open incidents; live status remains fully paginated. */
export const TEAM_MAX_TERMINAL_INCIDENTS = 512;
export const TEAM_VIEW_MAX_BUDGET_ROOTS = 32;
export const TEAM_VIEW_MAX_GRANTS = 16;
export const TEAM_MAX_INITIAL_REQUESTS = 8;
export const TEAM_MAX_LIVE_TEAMS = 32;
export const TEAM_MAX_RESERVED_RESULT_BYTES = 16 * 1024 * 1024;
export const TEAM_MAX_TIMEOUT_SECONDS = 86400;
/** Completed idempotency entries kept per active member; pending entries are never evicted. */
export const TEAM_COMMAND_CACHE = 128;
export const TEAM_MAX_PENDING_OPERATIONS = 32;

export const TEAM_ERROR_CODES = [
	"INVALID_ARGUMENT", "UNSUPPORTED_PROTOCOL", "UNKNOWN_MEMBER", "FORBIDDEN_ACTION", "SELF_REQUEST", "RECIPIENT_CLOSING",
	"RECIPIENT_CLOSED", "MEMBER_UNAVAILABLE", "TEAM_OWNED", "STALE_REVISION", "UNKNOWN_WORK", "UNKNOWN_RESULT",
	"WRONG_WORK_OWNER", "REQUEST_QUEUE_FULL", "TEAM_CAPACITY", "INPUT_BUDGET_EXCEEDED", "BUDGET_BLOCKED", "DEPENDENCY_CYCLE",
	"NO_NEW_DEPENDENCY", "UNRESOLVED_CHILDREN", "UNOBSERVED_CHILD_RESULTS", "INTENT_CONFLICT", "ACTIVATION_ENDING",
	"WORK_NOT_RUNNING", "CLOSE_BLOCKED", "INVALID_TEAM_OUTCOME", "CLEANUP_FAILED", "DELIVERY_UNKNOWN", "PROTOCOL_FAILURE",
] as const;
export type TeamErrorCode = typeof TEAM_ERROR_CODES[number];

export type MemberRole = "manager" | "worker";
export type MemberLifecycle = "starting" | "open" | "closing" | "closed" | "faulted";
export type MemberActivity = "idle" | "running" | "settling";
export type PauseState = "none" | "requested" | "confirmed";
export type ResourceState = "starting" | "owned" | "stopping" | "released" | "cleanup_failed";
export const WORK_STATES = ["queued", "running", "blocked", "resolved", "failed", "cancelled", "superseded"] as const;
export type WorkState = typeof WORK_STATES[number];
export const TERMINAL_WORK_STATES: readonly WorkState[] = ["resolved", "failed", "cancelled", "superseded"];
export type TeamLifecycle = "prepared" | "active" | "closing" | "closed" | "failed" | "cancelled" | "interrupted";
export type Health = "ok" | "needs_attention";
export type HoldReason = "attention" | "budget" | "protocol" | "manager_unavailable";
export type TeamOutcome = "succeeded" | "partial" | "failed";

export interface WorkRef { workId: string; revision: number }
export interface TeamEvidence {
	source: string;
	locator?: string;
	basis: "observed" | "verified" | "inferred" | "unverified";
}
export interface WorkResult {
	status: "succeeded" | "partial" | "failed";
	summary: string;
	findings?: string[];
	evidence?: TeamEvidence[];
	limitations?: string[];
	artifacts?: string[];
}
export interface ResultRecord {
	id: string;
	work: WorkRef;
	author: string;
	result: WorkResult;
	committedAt: number;
	source: "explicit_reply" | "natural_final";
}
export interface WorkError { code: string; message: string; outcomeUnknown?: boolean }
export interface DependencyOutcome {
	work: WorkRef;
	state: "resolved" | "failed" | "cancelled" | "superseded";
	resultRef?: string;
	error?: WorkError;
}
export interface WorkVersion {
	revision: number;
	task: string;
	inputRefs: string[];
	state: WorkState;
	waitingFor: WorkRef[];
	observedOutcomes: WorkRef[];
	checkpoint?: string;
	resumeInstruction?: string;
	hold?: { reason: HoldReason; incidentId: string };
	resultRef?: string;
	review?: { disposition: "accepted" | "waived"; reason?: string };
	error?: WorkError;
	createdAt: number;
	updatedAt: number;
}
export interface WorkRecord {
	id: string;
	requester: string;
	assignee: string;
	rootId: string;
	parent?: WorkRef;
	depth: number;
	currentRevision: number;
	versions: WorkVersion[];
}
export interface MemberRecord {
	id: string;
	role: MemberRole;
	roleDescription: string;
	lifecycle: MemberLifecycle;
	activity: MemberActivity;
	pause: PauseState;
	currentWork?: WorkRef;
	resourceState: ResourceState;
	error?: { code: string; message: string };
}

/** Parent-supplied scope, not a grant of additional operating-system privileges. */
export interface TeamBrief {
	goal: string;
	target?: string;
	acceptanceCriteria?: string[];
	constraints?: string[];
	authorizations?: { member: string; allowed: string[]; forbidden?: string[] }[];
}

/** Model/cwd policy resolved and pinned by the launcher at prepare; opaque to the runtime. */
export interface TeamMemberPolicy {
	model?: string;
	cwd?: string;
	fastMode?: boolean;
	searchMode?: string;
	contextWindow?: number;
}
export interface TeamMemberPlan {
	alias: string;
	roleDescription: string;
	policy: TeamMemberPolicy;
}
export interface TeamInitialRequest { to: string; task: string; inputRefs: string[] }
export interface TeamPlan {
	manager: TeamMemberPlan;
	workers: TeamMemberPlan[];
	brief: TeamBrief;
	initialRequests: TeamInitialRequest[];
	/** null = no team-wide deadline. */
	timeoutSeconds: number | null;
}

// ---------------------------------------------------------------------------------------------
// Budgets. Host configuration only; the model-facing schema never exposes a way to raise them.

export interface TeamBudgetLimits {
	workerPermits: number;
	memberUnresolvedWork: number;
	teamWorks: number;
	rootChildren: number;
	depth: number;
	workRevisions: number;
	rootActivations: number;
	teamActivations: number;
	managerActivations: number;
	activationModelRequests: number;
	rootModelRequests: number;
	teamModelRequests: number;
	activationToolCalls: number;
	rootToolCalls: number;
	teamToolCalls: number;
	emergencyManagerActivations: number;
	reservedResultBytes: number;
}
export const DEFAULT_TEAM_BUDGET: Readonly<TeamBudgetLimits> = Object.freeze({
	workerPermits: 4,
	memberUnresolvedWork: 64,
	teamWorks: 512,
	rootChildren: 64,
	depth: 8,
	workRevisions: 32,
	rootActivations: 128,
	teamActivations: 512,
	managerActivations: 128,
	activationModelRequests: 64,
	rootModelRequests: 256,
	teamModelRequests: 1024,
	activationToolCalls: 256,
	rootToolCalls: 1024,
	teamToolCalls: 4096,
	emergencyManagerActivations: 3,
	reservedResultBytes: TEAM_MAX_RESERVED_RESULT_BYTES,
});
/** Counters a host grant may raise for the whole team. */
export const TEAM_GRANTABLE_COUNTERS = ["teamActivations", "managerActivations", "teamModelRequests", "teamToolCalls", "emergencyManagerActivations"] as const;
/** Counters a host grant may raise for one root. */
export const ROOT_GRANTABLE_COUNTERS = ["rootChildren", "rootActivations", "rootModelRequests", "rootToolCalls"] as const;
export type TeamGrantCounter = typeof TEAM_GRANTABLE_COUNTERS[number];
export type RootGrantCounter = typeof ROOT_GRANTABLE_COUNTERS[number];

// ---------------------------------------------------------------------------------------------
// Public member tool actions (`team` tool). Normalized by team-codec.

export type TeamAction =
	| { action: "request"; to: string; task: string; inputRefs: string[] }
	| { action: "reply"; result: WorkResult }
	| { action: "yield"; waitingFor: WorkRef[]; checkpoint?: string; attention?: string }
	| { action: "status"; view: "team" | "work" | "result" | "incident"; id?: string; cursor?: string; limit: number }
	| { action: "control"; control: TeamControl };

export type TeamControl =
	| { command: "pause_member"; memberId: string }
	| { command: "resume_member"; memberId: string }
	| { command: "revise_work"; workId: string; expectedRevision: number; task: string; inputRefs: string[] }
	| { command: "cancel_work"; workId: string; expectedRevision: number; reason: string }
	| { command: "resume_work"; workId: string; expectedRevision: number; incidentId: string; instruction: string }
	| { command: "accept_result"; work: WorkRef; disposition: "accepted" | "waived"; reason?: string }
	| { command: "close_member"; memberId: string }
	| { command: "close_team"; resultRefs: string[]; outcome: TeamOutcome; reason?: string };
export type TeamControlCommand = TeamControl["command"];

export interface TeamError {
	code: TeamErrorCode;
	message: string;
	blockers?: Array<{ kind: string; id?: string; reason: string }>;
}

export type TeamReceipt =
	| { status: "accepted"; work: WorkRef; recipient: string; paused?: true }
	| { status: "staged"; intent: EndIntent["kind"]; work?: WorkRef }
	| { status: "applied"; command: TeamControlCommand; work?: WorkRef; memberId?: string }
	| { status: "unchanged"; command: TeamControlCommand; work?: WorkRef; memberId?: string }
	| { status: "closing"; command: "close_member" | "close_team"; memberId?: string; closeId: string };

export type TeamReplyData = TeamStatusPage | TeamTeamView | TeamWorkView | ResultRecord | TeamIncidentView;

export type TeamReply =
	| { ok: true; from: "@hub"; to: string; receipt?: TeamReceipt; data?: TeamReplyData }
	| { ok: false; from: "@hub"; to: string; error: TeamError };

// ---------------------------------------------------------------------------------------------
// Private frames (parent <-> child extension). Never shown to the model.

export interface BindingV2 {
	version: 2;
	teamId: string;
	memberId: string;
	role: MemberRole;
	epoch: string;
}
export interface ActivationScope {
	activationId: string;
	kind: "work" | "management";
	/** Required for kind=work, forbidden for management. */
	work?: WorkRef;
	/** Required for kind=management. */
	eventBatchId?: string;
}

export type PrivateAction =
	/** Raw public arguments, codec-validated before child framing and independently revalidated by Runtime. */
	| { action: "business"; args: Record<string, unknown> }
	| { action: "input_ready"; deliveryId: string }
	| { action: "provider_gate" }
	| { action: "tool_gate"; toolCallId: string; toolName: string; endIntent: boolean }
	| { action: "tool_result"; toolCallId: string; toolName: string }
	| { action: "boundary"; kind: "turn_end" | "agent_end" };

export interface ChildRequestFrame {
	version: 2;
	kind: "request";
	binding: BindingV2;
	activation: ActivationScope;
	sequence: number;
	rpcRequestId: string;
	request: PrivateAction;
}
export interface ChildAckFrame {
	version: 2;
	kind: "ack";
	commandId: string;
	binding: BindingV2;
	activation?: ActivationScope;
	ok: boolean;
	error?: string;
}
export type ChildFrame = ChildRequestFrame | ChildAckFrame;

export type ParentCommand =
	| { version: 2; commandId: string; operation: "bind"; binding: BindingV2; loadout: MemberLoadout }
	| { version: 2; commandId: string; operation: "activate"; binding: BindingV2; activation: ActivationScope; deliveryId: string; input: ActivationInput }
	| { version: 2; commandId: string; operation: "reply"; binding: BindingV2; activation: ActivationScope; rpcRequestId: string; reply: PrivateReply }
	| { version: 2; commandId: string; operation: "deactivate"; binding: BindingV2; activation: ActivationScope }
	| { version: 2; commandId: string; operation: "unbind"; binding: BindingV2 };

export interface MemberLoadout { role: MemberRole; teamTool: true }

export type GateDecision =
	| { allow: true }
	| { allow: false; reason: "paused" | "stale_scope" | "budget" | "activation_ending" | "delivery_pending" | "team_stopping" | "policy_stop"; message: string };

export type PrivateReply =
	| { kind: "business"; reply: TeamReply }
	| { kind: "gate"; decision: GateDecision }
	| { kind: "ack" };

// ---------------------------------------------------------------------------------------------
// Activation input and end intents.

export interface ManagerEventView {
	id: string;
	kind: ManagerEventKind;
	message: string;
	actor?: "@host";
	work?: WorkRef;
	memberId?: string;
	incidentId?: string;
	resultRef?: string;
}
export const MANAGER_EVENT_KINDS = ["BOOT", "USER_COMMAND", "ROOT_RESULT_READY", "DECISION_REQUEST", "WORK_HELD", "MEMBER_FAULTED",
	"MEMBER_CLOSED", "DEPENDENCY_UNAVAILABLE", "BUDGET_HIT", "TEAM_QUIESCENT"] as const;
export type ManagerEventKind = typeof MANAGER_EVENT_KINDS[number];

export interface OutcomeView {
	work: WorkRef;
	state: DependencyOutcome["state"];
	resultRef?: string;
	error?: WorkError;
	preview?: { status: WorkResult["status"]; summary: string };
}

/**
 * Steps this activation may take and what its scope has left after it (spec 9.4). Values are the
 * tightest applicable limit; emergency Manager activations are bounded by activation and emergency counts only.
 */
export interface ActivationBudgetSummary {
	emergency: boolean;
	modelRequests: number;
	toolCalls: number;
	/** Further activations this scope may reserve after this one. */
	activations: number;
}

export interface ActivationInput {
	version: 2;
	teamId: string;
	deliveryId: string;
	member: { id: string; role: MemberRole; roleDescription: string };
	brief: TeamBrief;
	roster: Array<{ id: string; role: MemberRole; lifecycle: MemberLifecycle; rolePreview: string }>;
	scope:
		| {
			kind: "work";
			work: WorkRef;
			task: string;
			requester: string;
			rootId: string;
			parent?: WorkRef;
			depth: number;
			inputRefs: string[];
			waitingFor: WorkRef[];
			checkpoint?: string;
			resumeInstruction?: string;
			previous?: { revision: number; state: WorkState; checkpoint?: string; resultRef?: string; error?: WorkError };
		}
		| { kind: "management"; eventBatchId: string; events: ManagerEventView[]; checkpoint?: string; emergency: boolean };
	outcomes: OutcomeView[];
	/** Outcomes that did not fit this input; they stay undelivered for a later activation. */
	omittedOutcomes: number;
	/** Bounded preview, not the authoritative set of completion obligations. */
	ownedChildren: Array<{ work: WorkRef; state: WorkState }>;
	/** Remaining children are discoverable via status(work) pages and their exact parent WorkRef. */
	ownedChildrenOmitted?: number;
	budget: ActivationBudgetSummary;
	notice: string;
}

export type EndIntent =
	| { kind: "reply"; work: WorkRef; result: WorkResult; toolCallId: string }
	| { kind: "yield_dependencies"; work: WorkRef; waitingFor: WorkRef[]; checkpoint: string; toolCallId: string }
	| { kind: "yield_attention"; work: WorkRef; attention: string; checkpoint: string; toolCallId: string }
	| { kind: "manager_idle"; checkpoint?: string; toolCallId: string }
	| { kind: "close_team"; closeId: string; toolCallId: string };

export interface DeliveryRecord {
	id: string;
	memberId: string;
	/** Internal only. */
	activationId: string;
	work?: WorkRef;
	eventIds?: string[];
	state: "in_flight" | "delivered" | "cancelled" | "unknown";
	dependencyOutcomes: WorkRef[];
}

// ---------------------------------------------------------------------------------------------
// Public views.

export interface TeamIncidentView {
	id: string;
	code: string;
	message: string;
	state: "open" | "resolved";
	work?: WorkRef;
	rootId?: string;
	memberId?: string;
	createdAt: number;
}
export interface TeamWorkView {
	id: string;
	requester: string;
	assignee: string;
	rootId: string;
	parent?: WorkRef;
	depth: number;
	currentRevision: number;
	current: WorkVersion;
	/** Bounded preview; enumerate status(work) pages matching parent for the complete set. */
	children: WorkRef[];
	childrenOmitted?: number;
	revisions: Array<{ revision: number; state: WorkState; resultRef?: string }>;
	/** Results that arrived for a version that could no longer accept them; evidence only. */
	rejectedCandidates?: Array<{ revision: number; reason: string; summary: string }>;
}
export interface TeamWorkSummary {
	work: WorkRef;
	/** Exact owning version; lets paginated work summaries enumerate all children after host grants. */
	parent?: WorkRef;
	requester: string;
	assignee: string;
	state: WorkState;
	taskPreview: string;
	hold?: HoldReason;
	resultRef?: string;
	review?: "accepted" | "waived";
}
export interface TeamMemberView extends MemberRecord {
	queued: number;
	blocked: number;
	held: number;
	policy: TeamMemberPolicy;
	/** Native usage of this member's settled activations, each counted once. */
	usage: SubagentUsage;
}
export interface TeamBudgetGrantView {
	id: string;
	actor: "@host";
	scope: { kind: "team" } | { kind: "root"; rootId: string };
	increments: Partial<Record<TeamGrantCounter | RootGrantCounter, number>>;
	reason: string;
	at: number;
}
export interface TeamRootBudgetView {
	rootId: string;
	used: { rootActivations: number; rootModelRequests: number; rootToolCalls: number; rootChildren: number };
	limits: Record<RootGrantCounter, number>;
}
export interface TeamBudgetView {
	limits: TeamBudgetLimits;
	used: {
		teamWorks: number;
		teamActivations: number;
		managerActivations: number;
		teamModelRequests: number;
		teamToolCalls: number;
		emergencyManagerActivations: number;
		reservedResultBytes: number;
	};
	exhausted: boolean;
	/** Exhausted roots first, then granted or used roots; at most TEAM_VIEW_MAX_BUDGET_ROOTS. */
	roots: TeamRootBudgetView[];
	rootsOmitted: number;
	/** The most recent grants; at most TEAM_VIEW_MAX_GRANTS. */
	grants: TeamBudgetGrantView[];
	grantsOmitted: number;
}
export interface TeamTeamView {
	version: 2;
	teamId: string;
	lifecycle: TeamLifecycle;
	health: Health;
	stateVersion: number;
	eventSeq: number;
	manager: string;
	timeoutSeconds: number | null;
	deadline: number | null;
	brief: TeamBrief;
	members: TeamMemberView[];
	works: { total: number; queued: number; running: number; blocked: number; held: number; resolved: number; failed: number; cancelled: number; roots: number; rootsReviewed: number };
	/** Open incidents first, then the most recent resolved ones; at most TEAM_VIEW_MAX_INCIDENTS. */
	incidents: TeamIncidentView[];
	incidentsOmitted: number;
	budget: TeamBudgetView;
	/** Team total of settled native usage (Manager plus workers). */
	usage: SubagentUsage;
	outcome?: TeamOutcome;
	reason?: string;
}
export interface TeamStatusPage {
	view: "work" | "result" | "incident";
	items: Array<TeamWorkSummary | { id: string; work: WorkRef; author: string; status: WorkResult["status"]; summaryPreview: string } | TeamIncidentView>;
	cursor?: string;
	hasMore: boolean;
}

export interface TeamResult {
	version: 2;
	teamId: string;
	lifecycle: "closed" | "failed" | "cancelled" | "interrupted";
	outcome?: TeamOutcome;
	reason?: string;
	finalResultRefs: string[];
	roots: Array<{
		work: WorkRef;
		state: WorkState;
		resultRef?: string;
		review?: { disposition: "accepted" | "waived"; reason?: string };
	}>;
	members: Array<{ id: string; role: MemberRole; lifecycle: MemberLifecycle; resourceState: ResourceState }>;
	usage: SubagentUsage;
	unresolvedIncidents: Array<{ id: string; code: string; message: string }>;
	unresolvedIncidentsOmitted?: number;
}

export const sameWorkRef = (left: WorkRef, right: WorkRef): boolean => left.workId === right.workId && left.revision === right.revision;
export const workRefKey = (ref: WorkRef): string => `${ref.workId}@${ref.revision}`;
/** Display form of a WorkRef (work UUID prefix and revision); protocol and status text keep the full ref. */
export const shortWorkRef = (ref: WorkRef): string => `work ${ref.workId.slice(ref.workId.lastIndexOf(":") + 1).slice(0, 8)}@${ref.revision}`;
export const isTerminalWorkState = (state: WorkState): boolean => TERMINAL_WORK_STATES.includes(state);
