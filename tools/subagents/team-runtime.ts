import { randomUUID } from "node:crypto";
import {
	TEAM_MAX_DEPENDENCY_PREVIEWS, TEAM_MAX_DELIVERED_OUTCOMES, TEAM_MAX_LIVE_TEAMS, TEAM_MAX_MANAGER_EVENT_BATCH,
	TEAM_MAX_DEPENDENCY_PREVIEW_BYTES, TEAM_MAX_RESULT_BYTES, TEAM_PROTOCOL_VERSION, DEFAULT_TEAM_BUDGET, isTerminalWorkState, sameWorkRef,
	workRefKey,
	type ActivationInput, type ActivationScope, type BindingV2, type DeliveryRecord, type EndIntent,
	type ManagerEventView, type MemberRecord, type OutcomeView, type ResultRecord,
	type TeamAction, type TeamBudgetLimits, type TeamBudgetView, type TeamErrorCode, type TeamIncidentView, type TeamLifecycle,
	type TeamMemberPolicy, type TeamMemberView, type TeamPlan, type TeamReply, type TeamResult, type TeamTeamView,
	type TeamWorkSummary, type TeamWorkView, type WorkError, type WorkRecord, type WorkRef, type WorkResult, type WorkVersion,
} from "./team-protocol";
import {
	TeamProtocolError, canonicalJson, encodeActivationInput, errorReply, normalizeTeamAction, normalizeTeamPlan, parseActivationScope, parseBinding, sameScope,
	okReply, previewText,
} from "./team-codec";
import { WorkLedger } from "./team-work-ledger";
import { emptySubagentUsage } from "./usage";

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
}

export interface CleanupCompletion {
	ok: boolean;
	error?: WorkError;
}

export interface TeamRuntimeOptions {
	now?: () => number;
	createId?: () => string;
	limits?: Partial<TeamBudgetLimits>;
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
	cleanup?: CleanupCompletion;
	stopReason?: "cancelled" | "superseded";
	cache: Map<string, CachedAction>;
	lastSequence: number;
}

interface CompletedActivationTombstone {
	activationId: string;
	deliveryId: string;
	native: NativeCompletion;
	cleanup: CleanupCompletion;
}

interface RuntimeMember extends MemberRecord {
	policy: TeamMemberPolicy;
	epoch: string;
	active?: ActiveActivation;
	lastActivation?: CompletedActivationTombstone;
	closeId?: string;
}

interface CloseDecision {
	id: string;
	outcome: "succeeded" | "partial" | "failed";
	reason?: string;
	resultRefs: string[];
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
	members: Map<string, RuntimeMember>;
	ledger: WorkLedger;
	ready: WorkRef[];
	deliveries: Map<string, DeliveryRecord>;
	events: InternalEvent[];
	eventBatches: Map<string, EventBatch>;
	incidents: TeamIncidentView[];
	limits: TeamBudgetLimits;
	teamActivations: number;
	managerActivations: number;
	reservedResultBytes: number;
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
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly limits: TeamBudgetLimits;

	constructor(options: TeamRuntimeOptions = {}) {
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
		this.limits = { ...DEFAULT_TEAM_BUDGET, ...options.limits };
		for (const [key, value] of Object.entries(this.limits)) {
			if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid Team budget ${key}`);
		}
	}

	/** Validate and reserve the complete plan/initial ledger without starting any member. */
	prepare(rawPlan: unknown): TeamTeamView {
		const plan = normalizeTeamPlan(rawPlan);
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
			});
		}
		const team: TeamState = {
			id, lifecycle: "prepared", health: "ok", stateVersion: 1, eventSeq: 0, createdAt,
			deadline: null,
			plan: copy(plan), manager: plan.manager.alias, members, ledger: new WorkLedger(), ready: [], deliveries: new Map(),
			events: [], eventBatches: new Map(), incidents: [], limits: { ...this.limits },
			teamActivations: 0, managerActivations: 0, reservedResultBytes: reserved, usage: emptySubagentUsage(),
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
		const launchAt = this.timestamp();
		team.deadline = team.plan.timeoutSeconds === null ? null : launchAt + Math.ceil(team.plan.timeoutSeconds * 1000);
		team.lifecycle = "active";
		for (const member of team.members.values()) {
			member.lifecycle = "open";
			member.resourceState = "owned";
		}
		this.addEvent(team, { key: "BOOT", kind: "BOOT", message: "Team is active. Review the brief, manage work and close explicitly." });
		this.changed(team);
		this.check(team);
		return this.view(team);
	}

	/**
	 * Reserve one FIFO work item or one finite Manager event batch. Reservation is synchronous and
	 * exclusive; callers perform native work only after this method returns.
	 */
	takeNextActivation(teamId: string): RuntimeActivation | undefined {
		const team = this.team(teamId);
		if (team.lifecycle !== "active") return undefined;
		const manager = team.members.get(team.manager)!;
		if (manager.lifecycle !== "open") return undefined;
		if (!manager.active && manager.pause === "none") {
			const pending = team.events.filter((event) => !event.processed && event.batchId === undefined)
				.slice(0, TEAM_MAX_MANAGER_EVENT_BATCH);
			if (pending.length) {
				if (team.teamActivations >= team.limits.teamActivations || team.managerActivations >= team.limits.managerActivations) {
					this.createIncident(team, "BUDGET_HIT", "Manager activation budget is exhausted");
					this.check(team);
					return undefined;
				}
				const activation = this.reserveManagement(team, manager, pending);
				this.check(team);
				return activation;
			}
		}
		const workerPermits = [...team.members.values()].filter((member) => member.role === "worker" && member.active).length;
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
			if (team.teamActivations >= team.limits.teamActivations
				|| (member.role === "manager" && team.managerActivations >= team.limits.managerActivations)) {
				this.holdForBudget(team, ref);
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
			if (reply.ok) this.check(team);
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
				&& canonicalJson(member.lastActivation.native) === canonicalJson(completion)) return okReply(member.id);
			fail("WORK_NOT_RUNNING", "No matching active activation");
		}
		if (active.native) {
			if (canonicalJson(active.native) !== canonicalJson(completion)) fail("PROTOCOL_FAILURE", "Conflicting native settlement evidence");
			return okReply(member.id);
		}
		if (completion.status === "success" && completion.pendingToolCalls) fail("PROTOCOL_FAILURE", "Native success cannot retain pending tool calls");
		if (completion.finalAssistantText !== undefined && typeof completion.finalAssistantText !== "string") {
			fail("PROTOCOL_FAILURE", "finalAssistantText must be a string");
		}
		active.native = copy(completion);
		member.activity = "settling";
		this.changed(team);
		this.check(team);
		return okReply(member.id);
	}

	/** Cleanup is separate evidence: no result commit or next activation can pass this boundary early. */
	cleanupFinished(bindingValue: BindingV2, activationId: string, cleanup: CleanupCompletion): TeamReply {
		const binding = this.validateBinding(bindingValue);
		const team = this.team(binding.teamId);
		const member = this.authenticatedMember(binding);
		const active = member.active?.scope.activationId === activationId ? member.active : undefined;
		if (!active) {
			if (member.lastActivation?.activationId === activationId
				&& canonicalJson(member.lastActivation.cleanup) === canonicalJson(cleanup)) return okReply(member.id);
			fail("WORK_NOT_RUNNING", "No matching active activation");
		}
		if (!active.native) fail("PROTOCOL_FAILURE", "Cleanup cannot complete before native settlement");
		if (active.cleanup) {
			if (canonicalJson(active.cleanup) !== canonicalJson(cleanup)) fail("PROTOCOL_FAILURE", "Conflicting cleanup evidence");
			return okReply(member.id);
		}
		active.cleanup = copy(cleanup);
		if (cleanup.ok) member.lastActivation = { activationId, deliveryId: active.deliveryId, native: copy(active.native), cleanup: copy(cleanup) };
		this.finishActivation(team, member, active);
		this.check(team);
		return okReply(member.id);
	}

	/** Explicit Manager-only host observation for the fakeable resource-close boundary. */
	memberReleased(bindingValue: BindingV2, closeId: string, result: CleanupCompletion): TeamReply {
		const binding = this.validateBinding(bindingValue);
		const team = this.team(binding.teamId);
		const member = this.authenticatedMember(binding);
		if (member.lifecycle === "closed" && member.closeId === closeId && result.ok && member.resourceState === "released") return okReply(member.id);
		if (member.lifecycle === "faulted" && member.closeId === closeId && !result.ok && member.resourceState === "cleanup_failed") {
			return errorReply(member.id, new TeamProtocolError("CLEANUP_FAILED", member.error?.message ?? "Member exit was not confirmed"));
		}
		if (member.lifecycle !== "closing" || member.closeId !== closeId) fail("CLEANUP_FAILED", "Member close operation does not match");
		if (member.active) fail("CLOSE_BLOCKED", "Member still has an activation or cleanup in flight");
		if (result.ok) {
			member.lifecycle = "closed";
			member.resourceState = "released";
			delete member.error;
		} else {
			member.lifecycle = "faulted";
			member.resourceState = "cleanup_failed";
			member.error = { code: result.error?.code ?? "CLEANUP_FAILED", message: result.error?.message ?? "Member exit was not confirmed" };
			team.health = "needs_attention";
			if (team.lifecycle === "closing") {
				team.lifecycle = "failed";
				team.reason = "Team close cleanup failed";
			}
		}
		if (result.ok) this.addEvent(team, {
			key: `member-closed:${member.id}:${closeId}`, kind: "MEMBER_CLOSED", message: `${member.id} closed after confirmed resource release`, memberId: member.id,
		});
		this.changed(team);
		this.finishTeamCloseIfReady(team);
		this.check(team);
		return result.ok
			? okReply(member.id, { receipt: { status: "applied", command: "close_member", memberId: member.id } })
			: errorReply(member.id, new TeamProtocolError("CLEANUP_FAILED", member.error?.message ?? "Member exit was not confirmed"));
	}

	getTeam(teamId: string): TeamTeamView { return this.view(this.team(teamId)); }

	/** Host/driver-only lifetime capability; never include this in a Team view or model input. */
	bindingForDriver(teamId: string, memberId: string): BindingV2 {
		const team = this.team(teamId);
		const member = team.members.get(memberId);
		if (!member) fail("UNKNOWN_MEMBER", `Unknown member ${memberId}`);
		return this.binding(team, member);
	}

	getWork(teamId: string, ref: WorkRef): TeamWorkView | undefined {
		const entry = this.team(teamId).ledger.get(ref.workId);
		const current = this.team(teamId).ledger.version(ref);
		if (!entry || !current) return undefined;
		return {
			id: entry.record.id, requester: entry.record.requester, assignee: entry.record.assignee, rootId: entry.record.rootId,
			...(entry.record.parent ? { parent: copy(entry.record.parent) } : {}), depth: entry.record.depth,
			currentRevision: entry.record.currentRevision, current: copy(current), children: this.team(teamId).ledger.ownedChildren(ref),
			revisions: entry.record.versions.map((version) => ({ revision: version.revision, state: version.state, ...(version.resultRef ? { resultRef: version.resultRef } : {}) })),
			...(entry.rejectedCandidates.length ? { rejectedCandidates: copy(entry.rejectedCandidates) } : {}),
		};
	}

	getResult(teamId: string, resultRef: string): ResultRecord | undefined {
		const result = this.team(teamId).ledger.results.get(resultRef);
		return result ? copy(result) : undefined;
	}

	getTeamResult(teamId: string): TeamResult | undefined {
		const team = this.team(teamId);
		if (["prepared", "active", "closing"].includes(team.lifecycle)) return undefined;
		const roots = team.ledger.order.map((id) => team.ledger.get(id)!.record).filter((record) => !record.parent);
		return {
			version: TEAM_PROTOCOL_VERSION,
			teamId: team.id,
			lifecycle: team.lifecycle as TeamResult["lifecycle"],
			...(team.outcome ? { outcome: team.outcome } : {}),
			...(team.reason ? { reason: team.reason } : {}),
			finalResultRefs: copy(team.closeDecision?.resultRefs ?? []),
			roots: roots.map((record) => {
				const version = currentVersion(record);
				return { work: { workId: record.id, revision: record.currentRevision }, state: version.state,
					...(version.resultRef ? { resultRef: version.resultRef } : {}), ...(version.review ? { review: copy(version.review) } : {}) };
			}),
			members: [...team.members.values()].map(({ id, role, lifecycle, resourceState }) => ({ id, role, lifecycle, resourceState })),
			usage: copy(team.usage),
			unresolvedIncidents: team.incidents.filter((incident) => incident.state === "open").map(({ id, code, message }) => ({ id, code, message })),
		};
	}

	/** Test-only invariant entry point; production callers may use it for diagnostics as well. */
	assertInvariants(teamId: string): void { this.check(this.team(teamId)); }

	private applyAction(team: TeamState, member: RuntimeMember, active: ActiveActivation, action: TeamAction, toolCallId: string): TeamReply {
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
			if (rootChildren >= team.limits.rootChildren) fail("TEAM_CAPACITY", `Root ${rootId} exceeded its child-work limit`);
			if (isTerminalWorkState(parentVersion.state)) fail("WORK_NOT_RUNNING", "Cannot create children from terminal work");
		}
		for (const resultRef of action.inputRefs) if (!team.ledger.results.has(resultRef)) fail("UNKNOWN_RESULT", `Unknown result reference ${resultRef}`);
		const at = this.timestamp();
		const work = this.makeWork(requester.id, recipient.id, action.task, action.inputRefs, parent, at, rootId, depth);
		this.assertInputFits(team, recipient, work, parent);
		team.ledger.add(work);
		team.ready.push({ workId: work.id, revision: 1 });
		team.reservedResultBytes += TEAM_MAX_RESULT_BYTES;
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
			if (action.waitingFor.length || action.attention !== undefined) fail("INVALID_ARGUMENT", "Management yield cannot wait for work or request attention");
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
			case "close_team": return this.closeTeam(team, member, active, control.resultRefs, control.outcome, control.reason, toolCallId);
			case "pause_member": case "resume_member": case "resume_work":
				fail("FORBIDDEN_ACTION", `${control.command} is not enabled in the pure-runtime phase`);
		}
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
		if (!isTerminalWorkState(current.state)) {
			this.cancelDescendants(team, currentRef, "superseded");
			current.state = "superseded";
			current.waitingFor = [];
			current.updatedAt = this.timestamp();
		}
		delete entry.stagedWait;
		const active = assignee.active;
		if (active?.scope.kind === "work" && sameWorkRef(active.scope.work!, currentRef)) {
			active.stopReason = "superseded";
			team.ledger.cleanupPending.add(workRefKey(currentRef));
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
		const affected = [ref, ...team.ledger.openSubtree(ref)];
		for (const work of affected) {
			const version = team.ledger.version(work)!;
			if (isTerminalWorkState(version.state)) continue;
			version.state = "cancelled";
			version.error = { code: "CANCELLED", message: control.reason };
			version.waitingFor = [];
			version.updatedAt = this.timestamp();
			delete team.ledger.get(work.workId)!.stagedWait;
			const assignee = team.members.get(team.ledger.get(work.workId)!.record.assignee)!;
			if (assignee.active?.scope.kind === "work" && sameWorkRef(assignee.active.scope.work!, work)) {
				assignee.active.stopReason = "cancelled";
				team.ledger.cleanupPending.add(workRefKey(work));
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
			if (!version.review) blockers.push({ kind: "root_review", id: workRefKey({ workId: root.id, revision: root.currentRevision }), reason: "root has not been accepted or waived" });
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
			blockers.push({ kind: "manager_event", id: event.id, reason: "an unprocessed Manager event is outside the closing activation batch" });
		}
		if (team.incidents.some((incident) => incident.state === "open") && outcome === "succeeded") {
			blockers.push({ kind: "incident", reason: "succeeded close cannot leave an unresolved incident" });
		}
		for (const resultRef of resultRefs) if (!team.ledger.results.has(resultRef)) fail("UNKNOWN_RESULT", `Unknown result reference ${resultRef}`);
		if (outcome === "succeeded") {
			if (roots.some((root) => currentVersion(root).review?.disposition !== "accepted"
				|| team.ledger.results.get(currentVersion(root).resultRef ?? "")?.result.status !== "succeeded") || resultRefs.length === 0) {
				fail("INVALID_TEAM_OUTCOME", "succeeded requires every current root accepted with a succeeded result and at least one final resultRef");
			}
		} else if (outcome === "partial") {
			if (!reason || resultRefs.length === 0) fail("INVALID_TEAM_OUTCOME", "partial requires a reason and at least one resultRef");
		} else if (!reason) fail("INVALID_TEAM_OUTCOME", "failed requires a reason");
		if (blockers.length) fail("CLOSE_BLOCKED", "Team close is blocked by unresolved obligations", blockers);
		if (active.intent) fail("ACTIVATION_ENDING", "Manager activation already staged another intent");
		if (team.lifecycle !== "active") fail("RECIPIENT_CLOSING", `Team is ${team.lifecycle}`);
		const closeId = this.id("close");
		team.closeDecision = { id: closeId, outcome, ...(reason ? { reason } : {}), resultRefs: copy(resultRefs) };
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
			return okReply(member.id, { data: copy(incident) });
		}
		const offset = action.cursor ? this.cursorOffset(action.cursor) : 0;
		const items = action.view === "work" ? this.workSummaries(team)
			: action.view === "result" ? this.resultSummaries(team)
			: team.incidents.map((incident) => copy(incident));
		const pageItems = items.slice(offset, offset + action.limit);
		const next = offset + pageItems.length;
		return okReply(member.id, { data: { view: action.view, items: pageItems, ...(next < items.length ? { cursor: `page:${next}` } : {}), hasMore: next < items.length } });
	}

	private reserveManagement(team: TeamState, member: RuntimeMember, events: InternalEvent[]): RuntimeActivation {
		const batchId = this.id("batch");
		const scope: ActivationScope = { activationId: this.id("activation"), kind: "management", eventBatchId: batchId };
		const deliveryId = this.id("delivery");
		const input = this.activationInput(team, member, deliveryId, { kind: "management", eventBatchId: batchId,
			events: events.map(({ key: _key, processed: _processed, batchId: _batchId, ...view }) => view), emergency: false });
		const eventBatch: EventBatch = { id: batchId, eventIds: events.map((event) => event.id) };
		for (const event of events) event.batchId = batchId;
		team.eventBatches.set(batchId, eventBatch);
		const activation: ActiveActivation = { scope, deliveryId, inputReady: false, cache: new Map(), lastSequence: 0 };
		member.active = activation;
		member.activity = "running";
		team.teamActivations++;
		team.managerActivations++;
		this.addDelivery(team, member, scope, deliveryId, eventBatch.eventIds);
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
		});
		version.state = "running";
		version.updatedAt = at;
		member.active = { scope, deliveryId, inputReady: false, cache: new Map(), lastSequence: 0 };
		member.currentWork = copy(ref);
		member.activity = "running";
		team.teamActivations++;
		if (member.role === "manager") team.managerActivations++;
		this.addDelivery(team, member, scope, deliveryId);
		this.changed(team);
		return { binding: this.binding(team, member), scope: copy(scope), deliveryId, input };
	}

	private activationInput(team: TeamState, member: RuntimeMember, deliveryId: string, scope: ActivationInput["scope"]): ActivationInput {
		const outcomes: OutcomeView[] = [];
		let candidates: WorkRef[] = [];
		let ownedChildren: Array<{ work: WorkRef; state: WorkVersion["state"] }> = [];
		if (scope.kind === "work") {
			const version = team.ledger.version(scope.work)!;
			const entry = team.ledger.get(scope.work.workId)!;
			candidates = [...version.waitingFor, ...team.ledger.ownedChildren(scope.work)];
			ownedChildren = team.ledger.ownedChildren(scope.work).map((work) => ({ work, state: team.ledger.version(work)!.state }));
			const seen = new Set<string>();
			for (const ref of candidates) {
				const key = workRefKey(ref);
				if (seen.has(key) || version.observedOutcomes.some((old) => workRefKey(old) === key) || !team.ledger.outcomeReady(ref)) continue;
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
			void entry;
		}
		const selected = outcomes.slice(0, TEAM_MAX_DELIVERED_OUTCOMES);
		const result: ActivationInput = {
			version: TEAM_PROTOCOL_VERSION, teamId: team.id, deliveryId,
			member: { id: member.id, role: member.role, roleDescription: member.roleDescription },
			brief: copy(team.plan.brief),
			roster: [...team.members.values()].map((item) => ({ id: item.id, role: item.role, lifecycle: item.lifecycle,
				rolePreview: previewText(item.roleDescription, 512) })),
			scope: copy(scope), outcomes: selected, omittedOutcomes: Math.max(0, outcomes.length - selected.length),
			ownedChildren, notice: "Other queued work is not part of this activation. Only the current WorkRef is authorized for this work.",
		};
		encodeActivationInput(result);
		return result;
	}

	private addDelivery(team: TeamState, member: RuntimeMember, scope: ActivationScope, deliveryId: string, eventIds?: string[]): void {
		const dependencyOutcomes = scope.kind === "work" ? this.previewOutcomeRefs(team, scope.work!) : [];
		team.deliveries.set(deliveryId, { id: deliveryId, memberId: member.id, activationId: scope.activationId,
			...(scope.kind === "work" ? { work: copy(scope.work!) } : {}), ...(eventIds ? { eventIds: copy(eventIds) } : {}),
			state: "in_flight", dependencyOutcomes });
	}

	private previewOutcomeRefs(team: TeamState, ref: WorkRef): WorkRef[] {
		const version = team.ledger.version(ref)!;
		const seen = new Set<string>();
		const refs: WorkRef[] = [];
		for (const candidate of [...version.waitingFor, ...team.ledger.ownedChildren(ref)]) {
			const key = workRefKey(candidate);
			if (seen.has(key) || version.observedOutcomes.some((old) => workRefKey(old) === key) || !team.ledger.outcomeReady(candidate)) continue;
			seen.add(key);
			refs.push(copy(candidate));
			if (refs.length >= TEAM_MAX_DELIVERED_OUTCOMES) break;
		}
		return refs;
	}

	private finishActivation(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		const cleanup = active.cleanup!;
		const scope = active.scope;
		const delivery = team.deliveries.get(active.deliveryId)!;
		if (!cleanup.ok) {
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
			}
			if (member.role === "manager") this.holdManagerWork(team);
			else if (scope.kind === "work") this.failWorkerWork(team, member, scope.work!);
			delivery.state = "unknown";
			this.createIncident(team, "CLEANUP_FAILED", member.error.message, scope.kind === "work" ? scope.work : undefined, member.id);
			this.addEvent(team, { key: `member-fault:${member.id}:${scope.activationId}`, kind: "MEMBER_FAULTED", message: `${member.id} could not confirm activation cleanup`, memberId: member.id });
			member.activity = "settling";
			this.changed(team);
			return;
		}
		if (delivery.state === "in_flight") delivery.state = active.inputReady ? "delivered" : "unknown";
		if (scope.kind === "management") this.finishManagement(team, member, active);
		else this.finishWork(team, member, active);
		if (member.active === active) delete member.active;
		delete member.currentWork;
		member.activity = "idle";
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
		if (active.stopReason || !current || !sameWorkRef(current, ref) || isTerminalWorkState(version.state)) {
			delete team.ledger.get(ref.workId)!.stagedWait;
			this.wakeWaiters(team);
			return;
		}
		if (active.native?.status !== "success") {
			delete team.ledger.get(ref.workId)!.stagedWait;
			version.state = "failed";
			version.error = active.native?.error ?? { code: active.native?.status === "length" ? "NATIVE_LENGTH" : "NATIVE_FAILURE",
				message: `Native activation ended with ${active.native?.status ?? "unknown"}` };
			version.updatedAt = this.timestamp();
			member.lifecycle = "faulted";
			member.error = { code: version.error.code, message: version.error.message };
			member.resourceState = "owned";
			team.health = "needs_attention";
			this.addEvent(team, { key: `member-fault:${member.id}:${active.scope.activationId}`, kind: "MEMBER_FAULTED", message: `${member.id} failed during native activation`, memberId: member.id, work: ref });
			if (member.role === "manager") this.holdManagerWork(team);
			else this.failWorkerWork(team, member, ref);
			this.wakeWaiters(team);
			return;
		}
		const intent = active.intent;
		if (intent && active.native?.appliedToolCallId !== intent.toolCallId) {
			delete team.ledger.get(ref.workId)!.stagedWait;
			const incident = this.createIncident(team, "PROTOCOL_FAILURE", "The staged end-intent result was not confirmed in the native transcript", ref, member.id);
			version.state = "blocked";
			version.hold = { reason: "protocol", incidentId: incident.id };
			version.updatedAt = this.timestamp();
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
			const incident = this.createIncident(team, "WORK_HELD", intent.attention, ref, member.id);
			version.checkpoint = intent.checkpoint;
			version.hold = { reason: "attention", incidentId: incident.id };
			version.state = "blocked";
			version.waitingFor = [];
			version.updatedAt = this.timestamp();
		} else if (intent?.kind === "manager_idle") {
			version.state = "failed";
			version.error = { code: "PROTOCOL_FAILURE", message: "A work activation cannot use a management-idle intent" };
			version.updatedAt = this.timestamp();
		} else if (this.canCommitNaturalFinal(team, ref, active)) {
			const result: WorkResult = { status: "succeeded", summary: active.native!.finalAssistantText!.trim() };
			this.commitResult(team, member, ref, result, "natural_final");
		} else {
			const incident = this.createIncident(team, "PROTOCOL_FAILURE", "Native work ended without a valid reply or yield", ref, member.id);
			version.state = "blocked";
			version.hold = { reason: "protocol", incidentId: incident.id };
			version.updatedAt = this.timestamp();
		}
		this.wakeWaiters(team);
	}

	private finishManagement(team: TeamState, member: RuntimeMember, active: ActiveActivation): void {
		const intent = active.intent;
		const intentApplied = !intent || active.native?.appliedToolCallId === intent.toolCallId;
		if (active.native?.status !== "success" || !intentApplied) {
			const closing = member.lifecycle === "closing";
			if (team.lifecycle === "closing") {
				team.lifecycle = "failed";
				team.reason = "Manager close activation did not settle with confirmed native evidence";
			}
			if (!closing) member.lifecycle = "faulted";
			member.error = { code: active.native?.error?.code ?? (intentApplied ? "MANAGER_FAILURE" : "PROTOCOL_FAILURE"),
				message: active.native?.error?.message ?? (intentApplied ? "Manager activation failed" : "Staged intent was not confirmed in the native transcript") };
			if (!closing) member.resourceState = "owned";
			team.health = "needs_attention";
			this.addEvent(team, { key: `manager-fault:${active.scope.activationId}`, kind: "MEMBER_FAULTED", message: "Manager activation failed; no automatic successor is available", memberId: member.id });
			this.holdManagerWork(team);
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
			const incident = this.createIncident(team, "RESULT_TOO_LARGE", "Candidate result exceeds its reserved result slot", ref, member.id);
			version.state = "blocked";
			version.hold = { reason: "protocol", incidentId: incident.id };
			version.updatedAt = this.timestamp();
			return;
		}
		const record = team.ledger.get(ref.workId)!.record;
		const children = team.ledger.ownedChildren(ref);
		if (children.some((child) => !team.ledger.outcomeReady(child)
			|| !version.observedOutcomes.some((observed) => sameWorkRef(observed, child)))) {
			const incident = this.createIncident(team, "UNOBSERVED_CHILD_RESULTS", "Result commit was blocked by an unobserved child outcome", ref, member.id);
			version.state = "blocked";
			version.hold = { reason: "protocol", incidentId: incident.id };
			version.updatedAt = this.timestamp();
			return;
		}
		const resultRef = this.id("result");
		const committed: ResultRecord = { id: resultRef, work: copy(ref), author: member.id, result: copy(result), committedAt: this.timestamp(), source };
		team.ledger.commitResult(committed);
		version.resultRef = resultRef;
		version.state = "resolved";
		if (result.status === "failed") version.error = { code: "BUSINESS_FAILED", message: result.summary };
		else delete version.error;
		version.updatedAt = committed.committedAt;
		if (!record.parent) this.addEvent(team, { key: `root-result:${workRefKey(ref)}:${resultRef}`, kind: "ROOT_RESULT_READY", message: `Root work ${workRefKey(ref)} has a committed result`, work: ref, resultRef });
		this.wakeWaiters(team);
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

	private wakeWaiters(team: TeamState): void {
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
		if (team.lifecycle !== "active" || [...team.members.values()].some((member) => member.active)) return;
		if (team.ledger.order.some((id) => !isTerminalWorkState(team.ledger.current(id)!.state)
			&& team.ledger.current(id)!.state !== "blocked")) return;
		const signature = team.ledger.order.map((id) => {
			const record = team.ledger.get(id)!.record;
			const version = currentVersion(record);
			return `${id}@${record.currentRevision}:${version.state}:${version.hold?.incidentId ?? ""}:${version.resultRef ?? ""}`;
		}).join("|");
		this.addEvent(team, { key: `quiescent:${signature}`, kind: "TEAM_QUIESCENT", message: "No work is runnable; review blocked work or decide whether to close", });
	}

	private cancelDescendants(team: TeamState, ref: WorkRef, state: "cancelled" | "superseded"): void {
		for (const child of team.ledger.openSubtree(ref)) {
			const version = team.ledger.version(child)!;
			version.state = state;
			version.waitingFor = [];
			version.updatedAt = this.timestamp();
			version.error = { code: state.toUpperCase(), message: `Parent work ${workRefKey(ref)} was ${state}` };
			delete team.ledger.get(child.workId)!.stagedWait;
			const member = team.members.get(team.ledger.get(child.workId)!.record.assignee)!;
			if (member.active?.scope.kind === "work" && sameWorkRef(member.active.scope.work!, child)) {
				member.active.stopReason = state;
				team.ledger.cleanupPending.add(workRefKey(child));
			}
			team.ready = team.ready.filter((queued) => !sameWorkRef(queued, child));
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
			version.error = { code: "MEMBER_UNAVAILABLE", message: `${member.id} faulted before this work could finish` };
			version.updatedAt = this.timestamp();
			delete entry.stagedWait;
			team.ready = team.ready.filter((queued) => !sameWorkRef(queued, ref));
			this.cancelDescendants(team, ref, "cancelled");
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

	private holdForBudget(team: TeamState, ref: WorkRef): void {
		const version = team.ledger.version(ref)!;
		if (version.state !== "queued") return;
		const incident = this.createIncident(team, "BUDGET_HIT", "Activation budget is exhausted", ref, team.ledger.get(ref.workId)!.record.assignee);
		version.state = "blocked";
		version.hold = { reason: "budget", incidentId: incident.id };
		version.updatedAt = this.timestamp();
		team.ready = team.ready.filter((item) => !sameWorkRef(item, ref));
	}

	private createIncident(team: TeamState, code: string, message: string, work?: WorkRef, memberId?: string): TeamIncidentView {
		const current = team.incidents.find((incident) => incident.state === "open" && incident.code === code
			&& incident.memberId === memberId && (incident.work ? work && sameWorkRef(incident.work, work) : !work));
		if (current) return current;
		const rootId = work ? team.ledger.get(work.workId)?.record.rootId : undefined;
		const incident: TeamIncidentView = { id: this.id("incident"), code, message, state: "open", createdAt: this.timestamp(),
			...(work ? { work: copy(work) } : {}), ...(rootId ? { rootId } : {}), ...(memberId ? { memberId } : {}) };
		team.incidents.push(incident);
		this.addEvent(team, { key: `incident:${incident.id}`, kind: code === "BUDGET_HIT" ? "BUDGET_HIT" : code === "WORK_HELD" ? "WORK_HELD" : "DEPENDENCY_UNAVAILABLE",
			message, ...(work ? { work: copy(work) } : {}), ...(memberId ? { memberId } : {}), incidentId: incident.id });
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
			if (event) { event.processed = true; delete event.batchId; }
		}
		team.eventBatches.delete(batchId);
	}

	private finishTeamCloseIfReady(team: TeamState): void {
		if (team.lifecycle !== "closing" || !team.closeDecision) return;
		if ([...team.members.values()].some((member) => member.id === team.manager
			? member.lifecycle !== "closed" || member.resourceState !== "released"
			: !((member.lifecycle === "closed" || member.lifecycle === "faulted") && member.resourceState === "released"))) return;
		team.lifecycle = "closed";
		team.outcome = team.closeDecision.outcome;
		if (team.closeDecision.reason) team.reason = team.closeDecision.reason;
		else delete team.reason;
		this.changed(team);
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
			notice: "Other queued work is not part of this activation. Only the current WorkRef is authorized for this work.",
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
			...(previous.resultRef ? { resultRef: previous.resultRef } : {}), ...(previous.error ? { error: copy(previous.error) } : {}) };
	}

	private workSummaries(team: TeamState): TeamWorkSummary[] {
		return team.ledger.order.map((id) => {
			const record = team.ledger.get(id)!.record;
			const version = currentVersion(record);
			return { work: { workId: id, revision: record.currentRevision }, requester: record.requester, assignee: record.assignee,
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
			resourceState: member.resourceState, ...(member.error ? { error: copy(member.error) } : {}),
			queued: current.filter((version, index) => version.state === "queued" && team.ledger.get(team.ledger.order[index]!)!.record.assignee === member.id).length,
			blocked: current.filter((version, index) => version.state === "blocked" && team.ledger.get(team.ledger.order[index]!)!.record.assignee === member.id).length,
			held: current.filter((version, index) => !!version.hold && team.ledger.get(team.ledger.order[index]!)!.record.assignee === member.id).length,
			policy: copy(member.policy),
		}));
		const roots = team.ledger.order.map((id) => team.ledger.get(id)!.record).filter((record) => !record.parent);
		const used: TeamBudgetView["used"] = {
			teamWorks: team.ledger.order.length, teamActivations: team.teamActivations, managerActivations: team.managerActivations,
			teamModelRequests: 0, teamToolCalls: 0, emergencyManagerActivations: 0, reservedResultBytes: team.reservedResultBytes,
		};
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
			incidents: copy(team.incidents), budget: { limits: copy(team.limits), used,
				exhausted: team.teamActivations >= team.limits.teamActivations || team.ledger.order.length >= team.limits.teamWorks
					|| team.reservedResultBytes >= team.limits.reservedResultBytes },
			...(team.outcome ? { outcome: team.outcome } : {}), ...(team.reason ? { reason: team.reason } : {}),
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
	private changed(team: TeamState): void { team.stateVersion++; }

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
					if (member.active.inputReady !== (delivery.state === "delivered")) throw new Error("Invariant D01: input_ready and delivery state disagree");
					if (member.active.intent && version.state !== "running" && !isTerminalWorkState(version.state)) throw new Error("Invariant I09: staged intent changed work state before settlement");
				}
				if (member.active.native && member.activity !== "settling") throw new Error(`Invariant I01: settled activation ${member.id} is not settling`);
				if (member.active.cleanup && !member.active.native) throw new Error(`Invariant I09: cleanup preceded native settlement for ${member.id}`);
				if (member.role === "worker") workerActivations++;
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
		if (team.teamActivations > team.limits.teamActivations || team.managerActivations > team.limits.managerActivations
			|| team.managerActivations > team.teamActivations || team.ledger.order.length > team.limits.teamWorks
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
				if (new Set(version.waitingFor.map(workRefKey)).size !== version.waitingFor.length
					|| new Set(version.observedOutcomes.map(workRefKey)).size !== version.observedOutcomes.length) throw new Error(`Invariant I14: duplicate dependency observation on ${workRefKey(ref)}`);
				if (version.waitingFor.some((dependency) => !team.ledger.version(dependency))) throw new Error(`Invariant I11: unknown dependency on ${workRefKey(ref)}`);
				if (version.state === "queued" && !ready.has(workRefKey(ref))) throw new Error(`Invariant I14: queued work ${workRefKey(ref)} has no ready item`);
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
