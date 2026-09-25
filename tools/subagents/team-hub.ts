import { randomUUID } from "node:crypto";
import { assertValidAgentAlias } from "./identity";
import {
	isTeamAssignment, isTeamBrief, isTeamMessageReference, isTeamRequest, isTeamTaskResult, sameTeamBinding,
	TEAM_CONTROL_COMMANDS, TEAM_EVENT_KINDS, TEAM_MAX_ERROR_BYTES, TEAM_MAX_EVENTS, TEAM_MAX_MESSAGE_BYTES, TEAM_MAX_OUTPUT_BYTES,
	TEAM_MAX_WORKERS, TEAM_MEMBER_STATES, TEAM_PHASES, TEAM_PROTOCOL_VERSION,
	type TeamAssignment, type TeamBinding, type TeamBrief, type TeamEvent, type TeamMemberSnapshot, type TeamOutcome,
	type TeamReply, type TeamRequest, type TeamSnapshot, type TeamWait,
} from "./team-protocol";

const WORKER_PERMITS = 4;
const REQUEST_CACHE = 128;
const MAX_TEAMS = 32;
const OUTPUT_BYTES = TEAM_MAX_OUTPUT_BYTES;
const ERROR_BYTES = TEAM_MAX_ERROR_BYTES;
const EVENT_BATCH_BYTES = 256 * 1024;
const RESERVED_DIRECTION_EVENT_BYTES = 56 * 1024;
const DEFAULT_STALL_GRACE_MS = 2000;
// Wait/control replies enter a model context; keep their status projection small.
const PREVIEW_BYTES = 512;
// The durable journal only needs recent routes and the terminal reason for history display.
const JOURNAL_EVENTS = 16;
const TRUNCATED = "\n[truncated]";

/** The team cannot progress without the coordinator changing something. */
export class TeamStalledError extends Error {
	override readonly name = "TeamStalledError";
}

// Bound both UTF-8 text and JSON escaping overhead, without splitting Unicode characters.
function boundedText(text: string, limit: number): string {
	if (text.length <= limit && Buffer.byteLength(text) <= limit && Buffer.byteLength(JSON.stringify(text)) - 2 <= limit) return text;
	let result = "";
	let bytes = 0;
	let jsonBytes = 0;
	for (const character of text) {
		bytes += Buffer.byteLength(character);
		jsonBytes += Buffer.byteLength(JSON.stringify(character)) - 2;
		if (bytes > limit - Buffer.byteLength(TRUNCATED) || jsonBytes > limit - Buffer.byteLength(JSON.stringify(TRUNCATED)) + 2) break;
		result += character;
	}
	return result + TRUNCATED;
}
const terminal = (state: string): boolean => ["completed", "failed", "cancelled", "interrupted"].includes(state);
const matchesMessageStream = (event: TeamEvent, from: string): boolean =>
	(event.kind === "message" || event.kind === "report") && event.from === from;
const copy = <T>(value: T): T => structuredClone(value);

interface Pending {
	kind: "checkpoint" | "wait";
	receive: boolean;
	revision?: number;
	receipt?: TeamReply["receipt"];
	redirectWake?: boolean;
	wait?: TeamWait;
	resolve: (reply: TeamReply) => void;
	cleanup: () => void;
}
interface Member {
	view: TeamMemberSnapshot;
	binding?: TeamBinding;
	/** Aborted when the coordinator cancels this member; the host stops its native run. */
	controller: AbortController;
	paused: boolean;
	permit: boolean;
	announced: boolean;
	inbox: TeamEvent[];
	latestDirection?: { event: GeneratedTeamEvent; revision: number };
	// Reserved, coalesced worker status notifications never consume message/result capacity.
	states: Map<string, TeamEvent>;
	sequence: number;
	requests: Map<string, { fingerprint: string; promise: Promise<TeamReply>; settled: boolean }>;
	pending?: Pending;
}
interface Team {
	view: TeamSnapshot;
	members: Map<string, Member>;
	controller: AbortController;
	startupDeadline?: number;
	timers: ReturnType<typeof setTimeout>[];
	/** Counts state changes that can unblock a parked member; coordinator re-parking is not progress. */
	progress: number;
	stallTimer?: ReturnType<typeof setTimeout>;
	stallArmedAt?: number;
	stallNoticeAt?: number;
	history: boolean;
	published?: string;
	journaled?: string;
	publishing: boolean;
	publicationRevision: number;
	journalError?: string;
	replies: { resolve: (reply: TeamReply) => void; reply: TeamReply }[];
}

type EventFields = Omit<TeamEvent, "version" | "messageId" | "timestamp" | "seq" | "from" | "to">;
type GeneratedTeamEvent = TeamEvent & { version: 2; messageId: string; timestamp: number; from: string; to: string };
interface EventDraft {
	fields: EventFields;
	author?: Member;
	to?: string;
}

/** In-process state machine. Only the parent's dispatch binding grants identity. */
export class TeamHub {
	private readonly teams = new Map<string, Team>();
	private readonly listeners = new Set<(snapshot: TeamSnapshot) => void>();
	private readonly now: () => number;
	private readonly startupTimeoutMs: number;
	private readonly stallGraceMs: number;
	private disposed = false;

	constructor(private readonly options: {
		onSnapshot?: (snapshot: TeamSnapshot) => void;
		startupTimeoutMs?: number;
		/** Delay before a fully parked team is treated as stalled. */
		stallGraceMs?: number;
		now?: () => number;
	} = {}) {
		this.now = options.now ?? Date.now;
		this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
		if (!Number.isFinite(this.startupTimeoutMs) || this.startupTimeoutMs <= 0) throw new Error("Invalid startup timeout");
		this.stallGraceMs = options.stallGraceMs ?? DEFAULT_STALL_GRACE_MS;
		if (!Number.isFinite(this.stallGraceMs) || this.stallGraceMs < 0) throw new Error("Invalid stall grace");
	}

	prepare(input: { coordinator: string; workers: string[]; timeoutSeconds?: number; brief?: TeamBrief }): TeamSnapshot {
		if (this.disposed) throw new Error("TeamHub disposed");
		if (!input || !Array.isArray(input.workers)) throw new Error("Expected one coordinator and 1–8 unique workers");
		const ids = [input.coordinator, ...input.workers];
		const seconds = input.timeoutSeconds ?? 3600;
		if (input.workers.length < 1 || input.workers.length > TEAM_MAX_WORKERS
			|| ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 64)
			|| new Set(ids).size !== ids.length) throw new Error("Expected one coordinator and 1–8 unique workers");
		for (const id of ids) assertValidAgentAlias(id);
		if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error("Invalid team timeout");
		if (input.brief !== undefined) {
			if (!isTeamBrief(input.brief)) throw new Error("Invalid team brief");
			const authorized = new Set<string>();
			for (const authorization of input.brief.authorizations ?? []) {
				assertValidAgentAlias(authorization.member);
				if (!ids.includes(authorization.member) || authorized.has(authorization.member)) throw new Error("Brief authorization must name one unique team member");
				authorized.add(authorization.member);
			}
		}
		const createdAt = this.now();
		if (!Number.isFinite(createdAt) || createdAt < 0) throw new Error("Invalid team clock");
		// Finished history is display-only: make room by dropping the oldest terminal team.
		if (this.teams.size >= MAX_TEAMS) {
			const oldest = [...this.teams.values()].filter((team) => terminal(team.view.phase))
				.sort((left, right) => left.view.createdAt - right.view.createdAt)[0];
			if (oldest) this.teams.delete(oldest.view.id);
		}
		if (this.teams.size >= MAX_TEAMS) throw new Error("Team session capacity exceeded (32 active teams)");
		const view: TeamSnapshot = {
			id: randomUUID(), coordinator: input.coordinator, workers: [...input.workers], phase: "prepared",
			seq: 0, createdAt, deadline: createdAt + Math.ceil(seconds * 1000), members: [], events: [],
			...(input.brief ? { brief: copy(input.brief) } : {}),
		};
		const members = new Map<string, Member>();
		for (const id of ids) {
			const member: Member = {
				view: { id, role: id === input.coordinator ? "coordinator" : "worker", state: "registered", instructionRevision: 0, observedRevision: 0 },
				controller: new AbortController(), paused: false, permit: false, announced: false, inbox: [], states: new Map(), sequence: 0, requests: new Map(),
			};
			members.set(id, member);
			view.members.push(member.view);
		}
		const team: Team = { view, members, controller: new AbortController(),
			timers: [], progress: 0, history: false, publishing: false, publicationRevision: 0, replies: [] };
		this.teams.set(view.id, team);
		team.timers.push(setTimeout(() => this.cancel(view.id, "Team deadline exceeded"), seconds * 1000));
		for (const timer of team.timers) timer.unref?.();
		this.publish(team);
		this.assertJournal(team);
		return copy(view);
	}

	join(teamId: string, memberIds: string[], assignments?: TeamAssignment[]): TeamBinding[] {
		const team = this.live(teamId);
		if (!Array.isArray(memberIds)) throw new Error("Join must claim coordinator or exact worker roster atomically");
		const coordinator = memberIds.length === 1 && memberIds[0] === team.view.coordinator;
		const workers = memberIds.length === team.view.workers.length && team.view.workers.every((id) => memberIds.includes(id));
		if ((!coordinator && !workers) || new Set(memberIds).size !== memberIds.length) throw new Error("Join must claim coordinator or exact worker roster atomically");
		if (memberIds.some((id) => team.members.get(id)?.binding)) throw new Error("Member already joined");
		let assignmentCopies: Map<string, TeamAssignment> | undefined;
		if (assignments !== undefined) {
			if (!Array.isArray(assignments) || assignments.length !== memberIds.length || assignments.some((item) => !isTeamAssignment(item))) {
				throw new Error("Assignments must provide one valid assignment per joining member");
			}
			assignmentCopies = new Map();
			for (const assignment of assignments) {
				assertValidAgentAlias(assignment.memberId);
				if (!memberIds.includes(assignment.memberId) || assignmentCopies.has(assignment.memberId)) {
					throw new Error("Assignments must match the joining member roster exactly");
				}
				assignmentCopies.set(assignment.memberId, copy(assignment));
			}
			if (assignmentCopies.size !== memberIds.length) throw new Error("Assignments must match the joining member roster exactly");
		}
		// Parent planning time after prepare is bounded only by the overall team deadline.
		if (team.startupDeadline === undefined) {
			team.startupDeadline = this.now() + this.startupTimeoutMs;
			const timer = setTimeout(() => {
				if (!this.admitted(team)) this.cancel(teamId, "Startup admission deadline exceeded: launch both sibling dispatches");
			}, this.startupTimeoutMs);
			timer.unref?.();
			team.timers.push(timer);
		}
		const bindings = memberIds.map((id): TeamBinding => ({ version: TEAM_PROTOCOL_VERSION,
			teamId, memberId: id, role: team.members.get(id)!.view.role, epoch: randomUUID() }));
		for (const binding of bindings) {
			const member = team.members.get(binding.memberId)!;
			if (assignmentCopies) member.view.assignment = assignmentCopies.get(binding.memberId)!;
			member.binding = binding;
			this.state(team, member, "starting");
		}
		if (this.admitted(team)) team.view.phase = "running";
		this.pump(team);
		this.publish(team);
		this.assertJournal(team);
		return copy(bindings);
	}

	request(binding: TeamBinding, request: TeamRequest, signal?: AbortSignal): Promise<TeamReply> {
		const routed = (reply: TeamReply): TeamReply => ({
			...reply, from: "@hub", to: typeof binding?.memberId === "string" ? binding.memberId : "",
			requestId: typeof request?.requestId === "string" ? request.requestId : "",
		});
		try {
			const [team, member] = this.bound(binding);
			if (!isTeamRequest(request)) throw new Error("Invalid team request");
			// Explicit fields exclude untrusted sender/binding properties from both identity and dedup.
			const fingerprint = JSON.stringify([request.sequence, request.action, request.to, request.message,
				request.replyTo, request.supersedes, request.result, request.command, request.wait?.kind,
				request.wait?.member, request.wait?.from, request.wait?.afterSeq, request.receive, request.revision]);
			const cached = member.requests.get(request.requestId);
			if (cached) {
				if (cached.fingerprint !== fingerprint) throw new Error("Conflicting duplicate request id");
				return cached.promise.then((reply) => copy(reply));
			}
			if (request.sequence <= member.sequence) throw new Error("Stale request sequence");
			if (signal?.aborted) throw new Error("Request aborted");
			if (member.pending && (request.action === "checkpoint" || request.action === "wait" || request.action === "finish"
				|| (request.action === "report" && request.wait))) throw new Error("Member already has a pending checkpoint/wait");
			while (member.requests.size >= REQUEST_CACHE) {
				const oldest = [...member.requests].find(([, entry]) => entry.settled);
				if (!oldest) throw new Error("Request cache overflow");
				member.requests.delete(oldest[0]);
			}
			member.sequence = request.sequence;
			// Install the cache before publishing: journal callbacks may synchronously reenter.
			let resolve!: (reply: TeamReply) => void;
			const promise = new Promise<TeamReply>((done) => { resolve = done; });
			const entry = { fingerprint, promise, settled: false };
			member.requests.set(request.requestId, entry);
			const done = (reply: TeamReply): void => {
				team.replies.push({ reply: routed(reply), resolve: (result) => { entry.settled = true; resolve(copy(result)); } });
			};
			try { this.apply(team, member, copy(request), done, signal); }
			catch (error) { done({ ok: false, error: this.error(error) }); }
			this.pump(team);
			this.publish(team);
			return promise.then((reply) => copy(reply));
		} catch (error) { return Promise.resolve(routed({ ok: false, error: this.error(error) })); }
	}

	complete(binding: TeamBinding, outcome: TeamOutcome): void {
		const team = this.team(binding.teamId);
		const member = team.members.get(binding.memberId);
		if (team.history || !member?.binding || !sameTeamBinding(member.binding, binding)) throw new Error("Invalid or stale team binding");
		if (terminal(member.view.state) || terminal(team.view.phase)) return;
		this.expire(team);
		if (terminal(team.view.phase)) return;
		if (member.view.role === "coordinator" && outcome.status === "completed" && team.view.phase !== "finalizing") {
			throw new Error("Coordinator completion requires the all-worker finalizing barrier");
		}
		if (outcome.status === "completed" && (member.view.observedRevision ?? 0) < (member.view.instructionRevision ?? 0)) {
			throw new Error("Member cannot complete before observing the latest redirected instruction");
		}
		this.finalize(team, member, outcome);
		if (member.view.role === "coordinator") {
			if (outcome.status !== "completed") {
				this.stop(team, outcome.status, outcome.error ?? "Coordinator failed");
				this.assertJournal(team);
				return;
			}
			team.view.phase = "completed";
			this.clearTimers(team);
			// This signal means cancellation, not successful settlement. Aborting it here
			// would cancel the host's still-unwinding coordinator dispatch and lose its answer.
		}
		this.pump(team);
		this.publish(team);
		this.assertJournal(team);
	}

	async waitForWorkers(binding: TeamBinding, signal?: AbortSignal): Promise<TeamSnapshot> {
		const [team, member] = this.bound(binding);
		if (member.view.role !== "coordinator") throw new Error("Only coordinator may await finalization");
		if (signal?.aborted) throw new Error("Request aborted");
		if (member.pending) throw new Error("Member already has a pending checkpoint/wait");
		const reply = await new Promise<TeamReply>((resolve) => {
			this.park(team, member, "wait", (reply) => team.replies.push({ resolve, reply }), { kind: "workers" }, signal);
			this.pump(team);
			this.publish(team);
		});
		if (reply.code === "team_stalled") throw new TeamStalledError(reply.error ?? "Team stalled");
		if (!reply.ok || !reply.snapshot) throw new Error(reply.error ?? "Worker barrier failed");
		return reply.snapshot;
	}

	get(teamId: string): TeamSnapshot { const team = this.team(teamId); this.expire(team); return copy(team.view); }
	list(): TeamSnapshot[] { return [...this.teams.keys()].map((id) => this.get(id)); }
	signal(teamId: string): AbortSignal { const team = this.team(teamId); this.expire(team); return team.controller.signal; }
	/** Aborted when the coordinator cancels this member (team cancellation uses signal()). */
	memberSignal(teamId: string, memberId: string): AbortSignal {
		const member = this.team(teamId).members.get(memberId);
		if (!member) throw new Error("Unknown team member");
		return member.controller.signal;
	}
	subscribe(listener: (snapshot: TeamSnapshot) => void): () => void {
		if (this.disposed) throw new Error("TeamHub disposed");
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	cancel(teamId: string, reason = "Team cancelled"): void {
		const team = this.team(teamId);
		if (!terminal(team.view.phase)) this.stop(team, "cancelled", reason);
	}
	/**
	 * Adopt display-only history. Invalid entries are skipped and only the newest teams that fit
	 * are kept, so damaged or excessive history can never disable the runtime.
	 */
	restore(snapshots: readonly TeamSnapshot[]): { restored: number; skipped: number } {
		if (this.disposed) throw new Error("TeamHub disposed");
		if (!Array.isArray(snapshots)) throw new Error("Team history must be an array");
		// Reconstruct each entry from known fields only; the last entry for an id wins.
		const latest = new Map<string, TeamSnapshot>();
		let skipped = 0;
		for (const snapshot of snapshots as readonly unknown[]) {
			try {
				const view = this.validateSnapshot(snapshot);
				latest.delete(view.id);
				latest.set(view.id, view);
			} catch { skipped++; }
		}
		const candidates = [...latest.values()].filter((view) => !this.teams.has(view.id))
			.sort((left, right) => right.createdAt - left.createdAt);
		const room = Math.max(0, MAX_TEAMS - this.teams.size);
		skipped += Math.max(0, candidates.length - room);
		for (const view of candidates.slice(0, room)) {
			let changed = false;
			if (!terminal(view.phase)) {
				changed = true;
				view.phase = "interrupted";
				for (const member of view.members) if (!terminal(member.state)) {
					member.state = "cancelled";
					member.error = "Interrupted by parent restart; historical team cannot resume";
					delete member.waitingFor;
				}
			}
			const team: Team = { view, members: new Map(), controller: new AbortController(),
				startupDeadline: 0, timers: [], progress: 0, history: true, publishing: false, publicationRevision: 0, replies: [] };
			team.controller.abort("Historical team");
			this.teams.set(view.id, team);
			// Only a newly interrupted team is new information; terminal history is not re-journaled.
			if (changed) {
				try {
					const result: unknown = this.options.onSnapshot?.(this.journalView(team));
					if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(() => {});
				} catch { /* History is display-only; a failed write must not block startup. */ }
			}
			team.published = this.publicationKey(team);
		}
		return { restored: Math.min(candidates.length, room), skipped };
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const team of this.teams.values()) if (!terminal(team.view.phase)) this.stop(team, "cancelled", "TeamHub disposed");
		this.listeners.clear();
	}

	private validateSnapshot(value: unknown): TeamSnapshot {
		const invalid = (): never => { throw new Error("Invalid historical team snapshot"); };
		const record = (item: unknown): Record<string, unknown> => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return invalid();
			return item as Record<string, unknown>;
		};
		const text = (item: unknown): string => typeof item === "string" ? item : invalid();
		const alias = (item: unknown): string => { const id = text(item); assertValidAgentAlias(id); return id; };
		const memberState = (item: unknown): TeamMemberSnapshot["state"] => {
			if (!(TEAM_MEMBER_STATES as readonly string[]).includes(text(item))) return invalid();
			return item as TeamMemberSnapshot["state"];
		};
		const source = record(value);
		const id = text(source["id"]);
		if (!/^[A-Za-z0-9._-]{1,128}$/u.test(id)) return invalid();
		const coordinator = alias(source["coordinator"]);
		const rawWorkers = source["workers"];
		if (!Array.isArray(rawWorkers) || rawWorkers.length < 1 || rawWorkers.length > TEAM_MAX_WORKERS) return invalid();
		const workers = rawWorkers.map(alias);
		const roster = new Set([coordinator, ...workers]);
		if (roster.size !== workers.length + 1) return invalid();
		const phase = text(source["phase"]) as TeamSnapshot["phase"];
		if (!(TEAM_PHASES as readonly string[]).includes(phase)) return invalid();
		const seq = source["seq"];
		const createdAt = source["createdAt"];
		const deadline = source["deadline"];
		if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0
			|| typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < 0
			|| typeof deadline !== "number" || !Number.isFinite(deadline) || deadline < createdAt) return invalid();
		let brief: TeamBrief | undefined;
		if (source["brief"] !== undefined) {
			if (!isTeamBrief(source["brief"])) return invalid();
			const authorized = new Set<string>();
			for (const authorization of source["brief"].authorizations ?? []) {
				if (!roster.has(authorization.member) || authorized.has(authorization.member)) return invalid();
				authorized.add(authorization.member);
			}
			brief = copy(source["brief"]);
		}
		const rawMembers = source["members"];
		if (!Array.isArray(rawMembers) || rawMembers.length !== roster.size) return invalid();
		const seen = new Set<string>();
		const members = rawMembers.map((item): TeamMemberSnapshot => {
			const raw = record(item);
			const id = alias(raw["id"]);
			if (!roster.has(id) || seen.has(id)) return invalid();
			seen.add(id);
			const role = id === coordinator ? "coordinator" : "worker";
			if (raw["role"] !== role) return invalid();
			const member: TeamMemberSnapshot = { id, role, state: memberState(raw["state"]) };
			if (raw["waitingFor"] !== undefined) {
				const waitingFor = text(raw["waitingFor"]);
				if (!["message", "workers"].includes(waitingFor) && !roster.has(waitingFor)) return invalid();
				member.waitingFor = waitingFor;
			}
			if (raw["output"] !== undefined) member.output = boundedText(text(raw["output"]), OUTPUT_BYTES);
			if (raw["error"] !== undefined) member.error = boundedText(text(raw["error"]), ERROR_BYTES);
			if (raw["assignment"] !== undefined) {
				if (!isTeamAssignment(raw["assignment"]) || raw["assignment"].memberId !== id) return invalid();
				member.assignment = copy(raw["assignment"]);
			}
			if (raw["result"] !== undefined) {
				if (!isTeamTaskResult(raw["result"])) return invalid();
				member.result = copy(raw["result"]);
			}
			const instructionRevision = raw["instructionRevision"];
			const observedRevision = raw["observedRevision"];
			if ((instructionRevision === undefined) !== (observedRevision === undefined)) return invalid();
			if (instructionRevision !== undefined) {
				if (typeof instructionRevision !== "number" || !Number.isSafeInteger(instructionRevision) || instructionRevision < 0
					|| typeof observedRevision !== "number" || !Number.isSafeInteger(observedRevision) || observedRevision < 0 || observedRevision > instructionRevision) return invalid();
				member.instructionRevision = instructionRevision;
				member.observedRevision = observedRevision;
			}
			return member;
		});
		if (terminal(phase) && members.some((member) => !terminal(member.state))) return invalid();
		if (["finalizing", "completed"].includes(phase) && members.some((member) => member.role === "worker" && !terminal(member.state))) return invalid();
		if (phase === "completed" && members.find((member) => member.id === coordinator)!.state !== "completed") return invalid();
		const rawEvents = source["events"];
		if (!Array.isArray(rawEvents) || rawEvents.length > TEAM_MAX_EVENTS) return invalid();
		let previous = 0;
		const knownMessageEvents = new Map<string, TeamEvent>();
		const events = rawEvents.map((item): TeamEvent => {
			const raw = record(item);
			const eventSeq = raw["seq"];
			if (typeof eventSeq !== "number" || !Number.isSafeInteger(eventSeq) || eventSeq <= previous || eventSeq > seq) return invalid();
			previous = eventSeq;
			const kind = text(raw["kind"]) as TeamEvent["kind"];
			if (!(TEAM_EVENT_KINDS as readonly string[]).includes(kind)) return invalid();
			const event: TeamEvent = { seq: eventSeq, kind };
			const metadataKeys = ["version", "messageId", "timestamp", "replyTo", "supersedes"] as const;
			const hasMetadata = metadataKeys.some((key) => raw[key] !== undefined);
			if (raw["member"] !== undefined) {
				const memberId = alias(raw["member"]);
				if (!roster.has(memberId)) return invalid();
				event.member = memberId;
			}
			for (const key of ["from", "to"] as const) if (raw[key] !== undefined) {
				const route = text(raw[key]);
				if (!hasMetadata || !["@hub", "@parent"].includes(route)) {
					const memberId = alias(route);
					if (!roster.has(memberId)) return invalid();
					event[key] = memberId;
				} else event[key] = route;
			}
			if (raw["message"] !== undefined) event.message = boundedText(text(raw["message"]), ERROR_BYTES);
			if (raw["state"] !== undefined) event.state = memberState(raw["state"]);
			if (hasMetadata) {
				if (raw["version"] !== 2 || raw["messageId"] !== `${id}:${eventSeq}`
					|| typeof raw["timestamp"] !== "number" || !Number.isFinite(raw["timestamp"]) || raw["timestamp"] < 0
					|| typeof event.from !== "string" || typeof event.to !== "string") return invalid();
				event.version = 2;
				event.messageId = raw["messageId"] as string;
				event.timestamp = raw["timestamp"];
				if (raw["replyTo"] !== undefined) {
					if (!isTeamMessageReference(raw["replyTo"])) return invalid();
					event.replyTo = raw["replyTo"];
				}
				if (raw["supersedes"] !== undefined) {
					if (!isTeamMessageReference(raw["supersedes"])) return invalid();
					event.supersedes = raw["supersedes"];
				}
				if (kind !== "message" && kind !== "report" && (event.replyTo !== undefined || event.supersedes !== undefined)) return invalid();
				if (kind === "message" || kind === "report") {
					if (!roster.has(event.from) || !roster.has(event.to) || event.from === event.to || typeof event.message !== "string"
						|| event.member !== undefined || event.state !== undefined) return invalid();
					if (kind === "report" && event.to !== coordinator) return invalid();
				} else if (kind === "control") {
					if (!roster.has(event.from) || members.find((member) => member.id === event.from)?.role !== "coordinator"
						|| !roster.has(event.to) || members.find((member) => member.id === event.to)?.role !== "worker"
						|| !(TEAM_CONTROL_COMMANDS as readonly string[]).includes(event.message ?? "") || event.member !== undefined || event.state !== undefined) return invalid();
				} else {
					if (event.from !== "@hub") return invalid();
					if (kind === "result") {
						if (!event.member || !roster.has(event.member) || !["completed", "failed", "cancelled"].includes(event.state ?? "")
							|| event.message !== undefined) return invalid();
						const expectedTo = event.member === coordinator ? "@parent" : coordinator;
						if (event.to !== expectedTo) return invalid();
					} else if (kind === "state") {
						if (event.to !== coordinator || !event.member || !roster.has(event.member) || !event.state) return invalid();
					} else if (kind === "undelivered") {
						if (!roster.has(event.to) || !event.member || !roster.has(event.member) || typeof event.message !== "string"
							|| event.state !== undefined) return invalid();
					} else if (event.to !== coordinator || typeof event.message !== "string" || event.member !== undefined || event.state !== undefined) return invalid();
				}
				for (const reference of [event.replyTo, event.supersedes]) if (reference && !reference.startsWith(`${id}:`)) return invalid();
				for (const [reference, sameAuthor] of [[event.replyTo, false], [event.supersedes, true]] as const) if (reference) {
					const prior = knownMessageEvents.get(reference);
					if (prior && sameAuthor && prior.from !== event.from) return invalid();
					if (!prior && rawEvents.some((candidate) => record(candidate) && candidate["messageId"] === reference)) return invalid();
				}
				if (kind === "message" || kind === "report") knownMessageEvents.set(event.messageId, event);
			}
			return event;
		});
		while (Buffer.byteLength(JSON.stringify(events)) > EVENT_BATCH_BYTES) events.shift();
		return { id, coordinator, workers, phase, seq, createdAt, deadline, members, events, ...(brief ? { brief } : {}) };
	}

	private apply(team: Team, member: Member, request: TeamRequest, done: (reply: TeamReply) => void, signal?: AbortSignal): void {
		switch (request.action) {
			case "checkpoint":
				if (request.revision !== undefined && request.revision !== (member.view.instructionRevision ?? 0)) {
					done({ ok: false, code: "stale_instruction", revision: member.view.instructionRevision ?? 0,
						error: "Checkpoint was generated for a stale team instruction" });
					return;
				}
				if (member.permit && !member.paused && this.admitted(team)) {
					done(this.checkpointReply(team, member, request.receive === true));
				} else this.park(team, member, "checkpoint", done, undefined, signal, request.receive === true, request.revision);
				return;
			case "wait":
				if (!request.wait) throw new Error("Missing wait condition");
				this.validateWait(team, member, request.wait);
				this.park(team, member, "wait", done, request.wait, signal); return;
			case "finish":
				if (member.view.role === "coordinator") {
					if (request.message !== undefined || request.result !== undefined) throw new Error("Coordinator finish cannot include a worker result");
					this.assertNoPausedWorkers(team);
					this.park(team, member, "wait", done, { kind: "workers" }, signal);
				}
				else {
					const result = request.result ?? (request.message !== undefined ? { status: "succeeded", summary: request.message } : undefined);
					if (result !== undefined) {
						// Message shorthand must satisfy the same aggregate JSON budget as an explicit result.
						if (!isTeamTaskResult(result)) throw new Error("Invalid team result: structured result exceeds its serialized limit");
						member.view.result = copy(result);
						team.publicationRevision++;
					}
					member.permit = false;
					team.progress++;
					this.state(team, member, member.paused ? "paused" : "waiting");
					this.notifyState(team, member);
					done({ ok: true });
				}
				return;
			case "send": {
				const event = this.deliver(team, member, request.to, request.message, "message", request.replyTo, request.supersedes);
				team.progress++;
				done({ ok: true, receipt: { status: "queued", messageId: event.messageId, recipient: event.to, seq: event.seq } });
				return;
			}
			case "report":
				if (request.to !== undefined && request.to !== team.view.coordinator) {
					throw new Error(`report can only be sent to this team's coordinator "${team.view.coordinator}"; use send for other recipients`);
				}
				if (member.view.id === team.view.coordinator) throw new Error("Coordinator cannot report to itself");
				if (request.wait) this.validateWait(team, member, request.wait);
				{
					const event = this.deliver(team, member, team.view.coordinator, request.message, "report", request.replyTo, request.supersedes);
					team.progress++;
					const receipt: NonNullable<TeamReply["receipt"]> = { status: "queued", messageId: event.messageId, recipient: event.to, seq: event.seq };
					if (request.wait) { this.park(team, member, "wait", done, request.wait, signal, false, undefined, receipt); return; }
					done({ ok: true, receipt });
					return;
				}
			case "control": {
				if (member.view.role !== "coordinator") throw new Error("Only coordinator may control workers");
				const target = request.to && team.members.get(request.to);
				if (!target || target.view.role !== "worker") throw new Error("Unknown worker control target");
				if (terminal(target.view.state)) throw new Error("Cannot control terminal member");
				if (!request.command) throw new Error("Missing control command");
				team.progress++;
				let redirectedMessage: GeneratedTeamEvent | undefined;
				if (request.command === "cancel") {
					const reason = `Cancelled by coordinator ${member.view.id}${request.message?.trim() ? `: ${request.message.trim()}` : ""}`;
					const controlEvent = this.event(team, { kind: "control", message: request.command }, member, target.view.id);
					// Logical cancellation is immediate; the host observes the member signal and
					// stops the native run. Late child requests are rejected as terminal.
					this.finalize(team, target, { status: "cancelled", output: "", error: reason });
					target.controller.abort(reason);
					this.pump(team);
					done({ ok: true, receipt: { status: "applied", recipient: target.view.id, seq: controlEvent.seq }, snapshot: this.statusView(team) });
					return;
				} else if (request.command === "pause") {
					target.paused = true;
					this.state(team, target, target.permit ? "pause_requested" : "paused");
					this.notifyState(team, target);
				} else if (request.command === "resume") {
					target.paused = false;
					team.members.get(team.view.coordinator)!.states.delete(target.view.id);
					this.state(team, target, target.permit ? "running" : "waiting");
					this.notifyState(team, target);
				} else if (request.command === "redirect") {
					this.validateDelivery(team, member, request.to, request.message, "message", undefined, undefined, true);
					const revision = target.view.instructionRevision ?? 0;
					if (revision >= Number.MAX_SAFE_INTEGER) throw new Error("Instruction revision exhausted");
					const events = this.eventBatch(team, [
						{ fields: { kind: "message", message: request.message! }, author: member, to: target.view.id },
						{ fields: { kind: "control", message: request.command }, author: member, to: target.view.id },
					]);
					redirectedMessage = events[0]!;
					target.view.instructionRevision = revision + 1;
					delete target.view.result; // A deliverable for the superseded instruction is no longer current.
					target.latestDirection = { event: redirectedMessage, revision: revision + 1 };
					// Redirect replaces a dependency, but never clears a manual pause.
					if (target.pending?.kind === "wait") {
						target.pending.wait = { kind: "message", afterSeq: redirectedMessage.seq - 1 };
						target.pending.redirectWake = true;
						target.view.waitingFor = "message";
					}
					const controlEvent = events[1]!;
					this.pump(team);
					done({ ok: true, receipt: { status: "applied", recipient: target.view.id, seq: controlEvent.seq }, snapshot: this.statusView(team) });
					return;
				}
				const controlEvent = this.event(team, { kind: "control", message: request.command }, member, target.view.id);
				// Include immediate safe-point admission/wakeups, not a transient pre-pump state.
				this.pump(team);
				done({ ok: true, receipt: { status: "applied", recipient: target.view.id, seq: controlEvent.seq }, snapshot: this.statusView(team) });
				return;
			}
		}
	}

	private validateDelivery(team: Team, from: Member, to: string | undefined, message: string | undefined,
		kind: "message" | "report", replyTo?: string, supersedes?: string, reserveDirection = false): Member {
		const target = to && team.members.get(to);
		if (!target) throw new Error("Unknown message recipient");
		if (target.view.id === from.view.id) throw new Error(kind === "report" ? "Cannot report to self" : "Cannot send a message to self");
		if (terminal(target.view.state)) throw new Error("Recipient is terminal");
		if (!message) throw new Error("Missing message");
		if (Buffer.byteLength(message, "utf8") > TEAM_MAX_MESSAGE_BYTES) throw new Error("Invalid team request: message exceeds limit");
		if (!reserveDirection && target.inbox.length >= TEAM_MAX_EVENTS) throw new Error("Inbox overflow");
		const knownMessages = [...team.view.events, ...[...team.members.values()].flatMap((item) => [
			...item.inbox, ...item.states.values(), ...(item.latestDirection ? [item.latestDirection.event] : []),
		])];
		const findReference = (reference: string): TeamEvent | undefined => knownMessages.find((event) => event.messageId === reference
			&& (event.kind === "message" || event.kind === "report"));
		if (replyTo !== undefined && (!replyTo.startsWith(`${team.view.id}:`) || !findReference(replyTo))) throw new Error("replyTo must reference a known message in this team");
		if (supersedes !== undefined) {
			const prior = supersedes.startsWith(`${team.view.id}:`) ? findReference(supersedes) : undefined;
			if (!prior || prior.from !== from.view.id) throw new Error("supersedes must reference your own prior message in this team");
		}
		return target;
	}

	private deliver(team: Team, from: Member, to: string | undefined, message: string | undefined,
		kind: "message" | "report", replyTo?: string, supersedes?: string): GeneratedTeamEvent {
		const target = this.validateDelivery(team, from, to, message, kind, replyTo, supersedes);
		const event = this.event(team, { kind, message: message!, ...(replyTo ? { replyTo } : {}), ...(supersedes ? { supersedes } : {}) }, from, target.view.id);
		target.inbox.push(event);
		return event;
	}

	private validateWait(team: Team, member: Member, wait: TeamWait): void {
		if (wait.kind === "member" && (!wait.member || !team.members.has(wait.member))) throw new Error("Unknown wait member");
		if (wait.kind === "workers" && member.view.role !== "coordinator") throw new Error("Worker cannot wait for all workers (self-wait)");
		if (wait.kind === "workers") this.assertNoPausedWorkers(team);
		if (wait.from !== undefined) {
			if (wait.kind !== "message") throw new Error("wait.from is only valid for message waits");
			if (!team.members.has(wait.from)) throw new Error("Unknown message sender");
			if (wait.from === member.view.id) throw new Error("Cannot wait for your own messages");
		}
		const dependencies = (condition?: TeamWait): string[] => condition?.kind === "workers" ? team.view.workers
			: condition?.kind === "member" ? [condition.member!] : [];
		const visit = (id: string, seen: Set<string>): boolean => {
			if (id === member.view.id) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			const target = team.members.get(id)!;
			if (terminal(target.view.state)) return false;
			// Coordinator finalization always depends on all workers, even before its explicit wait.
			const next = target.view.role === "coordinator" ? team.view.workers : dependencies(target.pending?.wait);
			return next.some((dependency) => visit(dependency, seen));
		};
		if (dependencies(wait).some((id) => visit(id, new Set()))) throw new Error("Self-wait or dependency cycle");
	}

	private park(team: Team, member: Member, kind: Pending["kind"], resolve: Pending["resolve"], wait?: TeamWait,
		signal?: AbortSignal, receive = false, revision?: number, receipt?: TeamReply["receipt"]): void {
		member.permit = false;
		if (wait?.kind === "message" && wait.afterSeq !== undefined) {
			// Acknowledged messages must free capacity even when no newer message exists yet.
			this.acknowledge(member, wait.afterSeq, wait.from);
		}
		const abort = (): void => {
			// A cancelled native operation cannot safely continue the same team execution.
			this.stop(team, "cancelled", "Team request aborted");
		};
		member.pending = { kind, receive, resolve, cleanup: () => signal?.removeEventListener("abort", abort),
			...(revision !== undefined ? { revision } : {}), ...(receipt ? { receipt } : {}), ...(wait ? { wait } : {}) };
		if (wait) member.view.waitingFor = wait.kind === "member" ? wait.member! : wait.kind;
		this.state(team, member, member.paused ? "paused" : "waiting");
		this.notifyState(team, member);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	}

	private pump(team: Team): void {
		if (terminal(team.view.phase)) return;
		let permits = [...team.members.values()].filter((m) => m.view.role === "worker" && m.permit).length;
		for (const member of team.members.values()) {
			const pending = member.pending;
			if (!pending || member.paused || terminal(member.view.state)) continue;
			if (pending.kind === "checkpoint") {
				if (pending.revision !== undefined && pending.revision !== (member.view.instructionRevision ?? 0)) {
					this.settle(member, { ok: false, code: "stale_instruction", revision: member.view.instructionRevision ?? 0,
						error: "Checkpoint was generated for a stale team instruction" });
					continue;
				}
				if (!this.admitted(team) || (member.view.role === "worker" && permits >= WORKER_PERMITS)) continue;
				member.permit = true;
				team.members.get(team.view.coordinator)!.states.delete(member.view.id);
				if (member.view.role === "worker") { permits++; team.progress++; }
				this.state(team, member, member.view.role === "coordinator" && team.view.phase === "finalizing" ? "finalizing" : "running");
				this.settle(member, this.checkpointReply(team, member, pending.receive));
				continue;
			}
			const wait = pending.wait!;
			let events: TeamEvent[] = [];
			if (wait.kind === "message") {
				this.acknowledge(member, wait.afterSeq ?? 0, wait.from);
				const matches = pending.redirectWake || (wait.from
					? member.inbox.some((event) => matchesMessageStream(event, wait.from!))
					: member.inbox.length > 0 || member.states.size > 0);
				if (!matches) continue;
				events = this.consume(member, wait.from);
			} else if (wait.kind === "member") {
				if (!terminal(team.members.get(wait.member!)!.view.state)) continue;
			} else {
				if (!team.view.workers.every((id) => terminal(team.members.get(id)!.view.state))) continue;
				team.view.phase = "finalizing";
			}
			team.members.get(team.view.coordinator)!.states.delete(member.view.id);
			if (member.view.role === "worker") team.progress++;
			this.state(team, member, wait.kind === "workers" ? "finalizing" : "waiting");
			delete member.view.waitingFor;
			// Wait replies carry consumed events separately. Complete outcomes are included only
			// where the wait is about them: the awaited member, or every worker at the barrier.
			const complete = wait.kind === "workers" ? team.view.workers : wait.kind === "member" ? [wait.member!] : [];
			this.settle(member, { ok: true, events: copy(events), snapshot: this.statusView(team, complete) });
		}
		this.watchStall(team);
	}

	private checkpointReply(team: Team, member: Member, receive: boolean): TeamReply {
		// Tool/provider gates grant work only: consuming here can steal a message from
		// an already-generated wait tool before the next model context is assembled.
		if (!receive) return { ok: true };
		const observedRevision = member.view.observedRevision ?? 0;
		const instructionRevision = member.view.instructionRevision ?? 0;
		const direction = member.latestDirection && member.latestDirection.revision > observedRevision
			&& member.latestDirection.revision === instructionRevision ? member.latestDirection : undefined;
		if (direction && Buffer.byteLength(JSON.stringify(direction.event)) > RESERVED_DIRECTION_EVENT_BYTES) {
			throw new Error("Redirected team direction exceeds its reserved context slot");
		}
		const events = this.consume(member, undefined, !!direction);
		let revision = observedRevision;
		if (direction) {
			events.push(direction.event);
			events.sort((left, right) => left.seq - right.seq);
			revision = direction.revision;
			member.view.observedRevision = revision;
			delete member.latestDirection;
			team.publicationRevision++;
		}
		const reply: TeamReply = { ok: true, revision, events };
		if (!member.announced) {
			member.announced = true;
			// Announce only shared brief and roster data; events/results already have
			// their own delivery path and must not be duplicated in this frame.
			reply.snapshot = {
				...copy(team.view),
				members: team.view.members.map(({ id, role, state, assignment, instructionRevision, observedRevision }) => ({
					id, role, state,
					...(assignment ? { assignment: copy(assignment) } : {}),
					...(instructionRevision !== undefined ? { instructionRevision } : {}),
					...(observedRevision !== undefined ? { observedRevision } : {}),
				})),
				events: [],
			};
		}
		return reply;
	}

	private acknowledge(member: Member, afterSeq: number, from?: string): void {
		member.inbox = member.inbox.filter((event) => event.seq > afterSeq
			|| (from !== undefined && !matchesMessageStream(event, from)));
		if (from === undefined) for (const [id, event] of member.states) if (event.seq <= afterSeq) member.states.delete(id);
	}

	private consume(member: Member, from?: string, reserveDirection = false): TeamEvent[] {
		let bytes = 2;
		const events: TeamEvent[] = [];
		const available = (from === undefined ? [...member.inbox, ...member.states.values()]
			: member.inbox.filter((event) => matchesMessageStream(event, from))).sort((left, right) => left.seq - right.seq);
		for (const event of available) {
			bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
			if (events.length === TEAM_MAX_EVENTS - (reserveDirection ? 1 : 0) || bytes > EVENT_BATCH_BYTES) break;
			events.push(event);
		}
		const consumed = new Set(events);
		member.inbox = member.inbox.filter((event) => !consumed.has(event));
		for (const [id, event] of member.states) if (consumed.has(event)) member.states.delete(id);
		return events;
	}

	private notifyState(team: Team, member: Member): void {
		if (member.view.role !== "worker" || terminal(team.view.phase)) return;
		const wait = member.pending?.wait;
		const blocked = wait?.kind === "message" ? !member.inbox.some((event) => wait.from === undefined
			? true : matchesMessageStream(event, wait.from))
			: wait?.kind === "member" && !terminal(team.members.get(wait.member!)!.view.state);
		if (!member.paused && !blocked) return; // Never advertise ordinary permit queue churn.
		const message = wait ? `waiting for ${wait.kind}${wait.member ? ` ${wait.member}` : ""}` : member.view.state;
		const coordinator = team.members.get(team.view.coordinator)!;
		const previous = coordinator.states.get(member.view.id);
		if (previous?.state === member.view.state && previous.message === message) return;
		// Latest unconsumed actionable status wins per worker: at most eight reserved slots.
		coordinator.states.set(member.view.id, this.event(team, {
			kind: "state", member: member.view.id, state: member.view.state, message,
		}));
	}

	private settle(member: Member, reply: TeamReply): void {
		const pending = member.pending;
		delete member.pending;
		delete member.view.waitingFor;
		if (pending) {
			pending.cleanup();
			pending.resolve(pending.receipt ? { ...reply, receipt: pending.receipt } : reply);
		}
	}

	/** Make a member terminal: shared by native completion and coordinator cancellation. */
	private finalize(team: Team, member: Member, outcome: TeamOutcome): void {
		member.permit = false;
		member.view.output = boundedText(outcome.output, OUTPUT_BYTES);
		if (outcome.error !== undefined) member.view.error = boundedText(outcome.error, ERROR_BYTES);
		this.settle(member, { ok: false, error: outcome.status === "cancelled" && outcome.error ? outcome.error : "Member completed" });
		member.requests.clear();
		this.notifyUndelivered(team, member, outcome.status);
		member.inbox = [];
		member.states.clear();
		delete member.latestDirection;
		team.members.get(team.view.coordinator)!.states.delete(member.view.id);
		this.state(team, member, outcome.status);
		const result = this.event(team, { kind: "result", member: member.view.id, state: outcome.status });
		if (member.view.role === "worker") {
			// Reserve at most one native result per fixed worker beyond the ordinary inbox limit.
			// Native settlement must remain authoritative even when reports filled the mailbox.
			team.members.get(team.view.coordinator)!.inbox.push(result);
		}
		team.progress++;
	}

	/** A queued receipt promised nothing; tell senders (and the coordinator) what was never read. */
	private notifyUndelivered(team: Team, member: Member, status: TeamOutcome["status"]): void {
		const unread = member.inbox.filter((event) => (event.kind === "message" || event.kind === "report")
			&& event.from !== undefined && team.members.has(event.from));
		if (!unread.length) return;
		const describe = (events: TeamEvent[]) => `${member.view.id} became ${status} before reading ${events.length} queued message(s): `
			+ events.map((event) => event.messageId ?? `seq ${event.seq}`).join(", ");
		const recipients = new Map<string, TeamEvent[]>();
		for (const event of unread) recipients.set(event.from!, [...recipients.get(event.from!) ?? [], event]);
		if (member.view.id !== team.view.coordinator && !recipients.has(team.view.coordinator)) recipients.set(team.view.coordinator, unread);
		for (const [id, events] of recipients) {
			const recipient = team.members.get(id)!;
			if (terminal(recipient.view.state)) continue;
			// Reserved like native results: at most one notice per ending member and recipient.
			recipient.inbox.push(this.event(team, { kind: "undelivered", member: member.view.id, message: describe(events) }, undefined, id));
		}
	}

	private assertNoPausedWorkers(team: Team): void {
		const paused = team.view.workers.filter((id) => {
			const worker = team.members.get(id)!;
			return worker.paused && !terminal(worker.view.state);
		});
		if (paused.length === 1) throw new Error(`Cannot wait for all workers while ${paused[0]} is paused; resume or cancel it first`);
		if (paused.length > 1) throw new Error(`Cannot wait for all workers while ${paused.join(", ")} are paused; resume or cancel them first`);
	}

	/** Describe a team whose every live member is parked on a condition nobody can satisfy. */
	private stallReason(team: Team): string | undefined {
		if (!["running", "finalizing"].includes(team.view.phase) || !this.admitted(team)) return undefined;
		const parts: string[] = [];
		for (const member of team.members.values()) {
			if (terminal(member.view.state)) continue;
			const pending = member.pending;
			// A member without a pending gate is still generating or executing tools.
			if (!pending || member.permit) return undefined;
			if (member.paused) { parts.push(`${member.view.id} is paused`); continue; }
			// pump() grants every satisfiable gate, so an unpaused checkpoint waits for a busy permit holder.
			if (pending.kind === "checkpoint") return undefined;
			const wait = pending.wait!;
			parts.push(wait.kind === "workers" ? `${member.view.id} waits for all workers`
				: wait.kind === "member" ? `${member.view.id} waits for ${wait.member} to finish`
				: `${member.view.id} waits for a message${wait.from ? ` from ${wait.from}` : ""}`);
		}
		return parts.length ? parts.join("; ") : undefined;
	}

	private watchStall(team: Team): void {
		if (terminal(team.view.phase) || team.history) return;
		if (!this.stallReason(team)) {
			if (team.stallTimer) clearTimeout(team.stallTimer);
			delete team.stallTimer;
			return;
		}
		if (team.stallTimer && team.stallArmedAt === team.progress) return;
		if (team.stallTimer) clearTimeout(team.stallTimer);
		team.stallArmedAt = team.progress;
		team.stallTimer = setTimeout(() => this.resolveStall(team), this.stallGraceMs);
		team.stallTimer.unref?.();
	}

	private resolveStall(team: Team): void {
		delete team.stallTimer;
		if (terminal(team.view.phase)) return;
		const reason = this.stallReason(team);
		if (!reason) return;
		if (team.stallArmedAt !== team.progress) { this.watchStall(team); return; }
		const coordinator = team.members.get(team.view.coordinator)!;
		if (team.stallNoticeAt === team.progress || coordinator.pending?.kind !== "wait") {
			this.stop(team, "failed", `Team stalled: ${reason}. No member changed anything after the coordinator was notified.`);
			return;
		}
		team.stallNoticeAt = team.progress;
		// Deliver directly to the coordinator's pending wait, bypassing any sender filter.
		this.settle(coordinator, { ok: false, code: "team_stalled", error: `Team stalled: ${reason}. `
			+ "Nobody can proceed until you act: send the awaited message, control resume/redirect/cancel a worker, "
			+ "or finish once every worker is terminal. Waiting again without a change fails the team." });
		this.state(team, coordinator, "running");
		this.publish(team);
	}
	private state(team: Team, member: Member, state: TeamMemberSnapshot["state"]): void {
		if (member.view.state === state) return;
		member.view.state = state;
		this.event(team, { kind: "state", member: member.view.id, state });
	}
	private event(team: Team, fields: EventFields, author?: Member, to?: string): GeneratedTeamEvent {
		return this.eventBatch(team, [{ fields, ...(author ? { author } : {}), ...(to ? { to } : {}) }])[0]!;
	}
	private eventBatch(team: Team, drafts: EventDraft[]): GeneratedTeamEvent[] {
		const timestamps = drafts.map(() => this.now());
		if (timestamps.some((timestamp) => !Number.isFinite(timestamp) || timestamp < 0)
			|| !Number.isSafeInteger(team.view.seq + drafts.length)) throw new Error("Invalid Team event clock or sequence");
		const events = drafts.map((draft, index): GeneratedTeamEvent => {
			const { fields } = draft;
			let from: string;
			let to: string;
			if (["message", "report", "control"].includes(fields.kind)) {
				if (!draft.author || !draft.to) throw new Error("Member event requires authenticated routing");
				from = draft.author.view.id;
				to = draft.to;
			} else {
				from = "@hub";
				to = draft.to ?? (fields.kind === "result" && fields.member === team.view.coordinator ? "@parent" : team.view.coordinator);
			}
			const seq = team.view.seq + index + 1;
			return { ...fields, version: 2, messageId: `${team.view.id}:${seq}`, timestamp: timestamps[index]!, seq, from, to };
		});
		team.view.seq += events.length;
		team.view.events.push(...events);
		while (team.view.events.length > TEAM_MAX_EVENTS || Buffer.byteLength(JSON.stringify(team.view.events)) > EVENT_BATCH_BYTES) team.view.events.shift();
		return events;
	}
	private stop(team: Team, phase: "failed" | "cancelled", reason: string, journalFailure = false): void {
		if (terminal(team.view.phase) && !journalFailure) return;
		reason = boundedText(reason, ERROR_BYTES);
		// Logical cancellation closes admission now; host still owns native process cleanup.
		// Set phase before settling dependencies, so cancelled workers never open A's barrier.
		team.view.phase = phase;
		this.clearTimers(team);
		for (const member of team.members.values()) {
			member.permit = false;
			if (!terminal(member.view.state)) {
				member.view.error = reason;
				member.view.output = "";
				this.state(team, member, "cancelled");
			}
			this.settle(member, { ok: false, error: reason });
			member.requests.clear();
			member.inbox = [];
			member.states.clear();
			delete member.latestDirection;
		}
		this.event(team, { kind: "cancelled", message: reason });
		team.controller.abort(reason);
		if (!journalFailure) this.publish(team);
	}
	private clearTimers(team: Team): void {
		for (const timer of team.timers) clearTimeout(timer);
		team.timers = [];
		if (team.stallTimer) clearTimeout(team.stallTimer);
		delete team.stallTimer;
	}
	private admitted(team: Team): boolean { return [...team.members.values()].every((member) => member.binding); }
	private expire(team: Team): void {
		if (terminal(team.view.phase)) return;
		if (this.now() >= team.view.deadline) this.stop(team, "cancelled", "Team deadline exceeded");
		else if (team.startupDeadline !== undefined && !this.admitted(team) && this.now() >= team.startupDeadline) this.stop(team, "cancelled", "Startup admission deadline exceeded: launch both sibling dispatches");
	}
	private team(id: string): Team { const team = this.teams.get(id); if (!team) throw new Error("Unknown team"); return team; }
	private live(id: string): Team {
		const team = this.team(id);
		this.expire(team);
		if (this.disposed || team.history || terminal(team.view.phase)) throw new Error("Team is terminal or interrupted");
		return team;
	}
	private bound(binding: TeamBinding): [Team, Member] {
		const team = this.live(binding.teamId);
		const member = team.members.get(binding.memberId);
		if (!member?.binding || !sameTeamBinding(member.binding, binding)) throw new Error("Invalid or stale team binding");
		if (terminal(member.view.state)) throw new Error("Member is terminal");
		return [team, member];
	}
	private assertJournal(team: Team): void { if (team.journalError) throw new Error(team.journalError); }
	private publish(team: Team): void {
		if (team.publishing) return;
		team.publishing = true;
		try {
			while (team.published !== this.publicationKey(team)) {
				team.published = this.publicationKey(team);
				// Teams never resume after a parent restart, so the durable journal records only
				// milestones (roster admission, member outcomes, phases). Live observers see everything.
				const journalKey = this.journalKey(team);
				if (!team.journalError && team.journaled !== journalKey) {
					team.journaled = journalKey;
					try {
						const result: unknown = this.options.onSnapshot?.(this.journalView(team));
						// The frozen callback is synchronous. Fail closed on accidental async writers,
						// and observe their rejection rather than letting it become unhandled.
						if (result && typeof (result as PromiseLike<unknown>).then === "function") {
							void Promise.resolve(result).catch(() => {});
							throw new Error("onSnapshot must persist synchronously");
						}
					} catch (error) {
						team.journalError = boundedText(`Team journal failed: ${this.error(error)}`, ERROR_BYTES);
						this.stop(team, "failed", team.journalError, true);
						team.published = this.publicationKey(team);
					}
				}
				for (const listener of this.listeners) {
					try {
						const result: unknown = listener(copy(team.view));
						if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(() => {});
					} catch { /* Non-durable observers are isolated. */ }
				}
			}
		} finally {
			team.publishing = false;
			// No successful grant/result escapes before its journal callback has succeeded.
			for (const { resolve, reply } of team.replies.splice(0)) {
				const failure = team.journalError ?? (["failed", "cancelled", "interrupted"].includes(team.view.phase)
					? String(team.controller.signal.reason ?? "Team terminated") : undefined);
				resolve(failure ? {
					ok: false,
					...(reply.from !== undefined ? { from: reply.from } : {}),
					...(reply.to !== undefined ? { to: reply.to } : {}),
					...(reply.requestId !== undefined ? { requestId: reply.requestId } : {}),
					error: boundedText(failure, ERROR_BYTES),
				} : reply);
			}
		}
	}
	private publicationKey(team: Team): string {
		return `${team.view.seq}:${team.view.phase}:${team.publicationRevision}`;
	}
	private journalKey(team: Team): string {
		return `${team.view.phase}|${team.view.members.map((member) => terminal(member.state) ? member.state
			: team.members.get(member.id)?.binding ? "joined" : "registered").join(",")}`;
	}
	private journalView(team: Team): TeamSnapshot {
		const view = copy(team.view);
		view.events = view.events.slice(-JOURNAL_EVENTS);
		return view;
	}
	/**
	 * Current status for a member's model context: no event history, brief or assignments
	 * (the first context already announced them). Outputs are included only for `complete` members.
	 */
	private statusView(team: Team, complete: readonly string[] = []): TeamSnapshot {
		const { brief: _brief, ...view } = copy(team.view);
		return {
			...view,
			events: [],
			members: view.members.map(({ id, role, state, waitingFor, output, error, result, instructionRevision, observedRevision }) => ({
				id, role, state,
				...(waitingFor !== undefined ? { waitingFor } : {}),
				...(complete.includes(id)
					? { ...(output !== undefined ? { output } : {}), ...(error !== undefined ? { error } : {}), ...(result ? { result } : {}) }
					: {
						...(error !== undefined ? { error: boundedText(error, PREVIEW_BYTES) } : {}),
						...(result ? { result: { status: result.status, summary: boundedText(result.summary, PREVIEW_BYTES) } } : {}),
					}),
				...(instructionRevision !== undefined ? { instructionRevision, observedRevision: observedRevision ?? 0 } : {}),
			})),
		};
	}
	private error(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
