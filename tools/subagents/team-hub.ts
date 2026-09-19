import { randomUUID } from "node:crypto";
import { assertValidAgentAlias } from "./identity";
import {
	isTeamRequest, sameTeamBinding, TEAM_MAX_EVENTS, TEAM_MAX_WORKERS, TEAM_PROTOCOL_VERSION,
	type TeamBinding, type TeamEvent, type TeamMemberSnapshot, type TeamOutcome,
	type TeamReply, type TeamRequest, type TeamSnapshot, type TeamWait,
} from "./team-protocol";

const WORKER_PERMITS = 4;
const REQUEST_CACHE = 128;
const MAX_TEAMS = 32;
const OUTPUT_BYTES = 16 * 1024;
const ERROR_BYTES = 8 * 1024;
const EVENT_BATCH_BYTES = 256 * 1024;
const TRUNCATED = "\n[truncated]";

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
const copy = <T>(value: T): T => structuredClone(value);

interface Pending {
	kind: "checkpoint" | "wait";
	receive: boolean;
	wait?: TeamWait;
	resolve: (reply: TeamReply) => void;
	cleanup: () => void;
}
interface Member {
	view: TeamMemberSnapshot;
	binding?: TeamBinding;
	paused: boolean;
	permit: boolean;
	announced: boolean;
	inbox: TeamEvent[];
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
	history: boolean;
	published?: string;
	publishing: boolean;
	journalError?: string;
	replies: { resolve: (reply: TeamReply) => void; reply: TeamReply }[];
}

/** In-process state machine. Only the parent's dispatch binding grants identity. */
export class TeamHub {
	private readonly teams = new Map<string, Team>();
	private readonly listeners = new Set<(snapshot: TeamSnapshot) => void>();
	private readonly now: () => number;
	private readonly startupTimeoutMs: number;
	private disposed = false;

	constructor(private readonly options: {
		onSnapshot?: (snapshot: TeamSnapshot) => void;
		startupTimeoutMs?: number;
		now?: () => number;
	} = {}) {
		this.now = options.now ?? Date.now;
		this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
		if (!Number.isFinite(this.startupTimeoutMs) || this.startupTimeoutMs <= 0) throw new Error("Invalid startup timeout");
	}

	prepare(input: { coordinator: string; workers: string[]; timeoutSeconds?: number }): TeamSnapshot {
		if (this.disposed) throw new Error("TeamHub disposed");
		if (this.teams.size >= MAX_TEAMS) throw new Error("Team session capacity exceeded (32, including history)");
		const ids = [input.coordinator, ...input.workers];
		const seconds = input.timeoutSeconds ?? 3600;
		if (input.workers.length < 1 || input.workers.length > TEAM_MAX_WORKERS
			|| ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 64)
			|| new Set(ids).size !== ids.length) throw new Error("Expected one coordinator and 1–8 unique workers");
		for (const id of ids) assertValidAgentAlias(id);
		if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error("Invalid team timeout");
		const createdAt = this.now();
		const view: TeamSnapshot = {
			id: randomUUID(), coordinator: input.coordinator, workers: [...input.workers], phase: "prepared",
			seq: 0, createdAt, deadline: createdAt + Math.ceil(seconds * 1000), members: [], events: [],
		};
		const members = new Map<string, Member>();
		for (const id of ids) {
			const member: Member = {
				view: { id, role: id === input.coordinator ? "coordinator" : "worker", state: "registered" },
				paused: false, permit: false, announced: false, inbox: [], states: new Map(), sequence: 0, requests: new Map(),
			};
			members.set(id, member);
			view.members.push(member.view);
		}
		const team: Team = { view, members, controller: new AbortController(),
			timers: [], history: false, publishing: false, replies: [] };
		this.teams.set(view.id, team);
		team.timers.push(setTimeout(() => this.cancel(view.id, "Team deadline exceeded"), seconds * 1000));
		for (const timer of team.timers) timer.unref?.();
		this.publish(team);
		this.assertJournal(team);
		return copy(view);
	}

	join(teamId: string, memberIds: string[]): TeamBinding[] {
		const team = this.live(teamId);
		const coordinator = memberIds.length === 1 && memberIds[0] === team.view.coordinator;
		const workers = memberIds.length === team.view.workers.length && team.view.workers.every((id) => memberIds.includes(id));
		if ((!coordinator && !workers) || new Set(memberIds).size !== memberIds.length) throw new Error("Join must claim coordinator or exact worker roster atomically");
		if (memberIds.some((id) => team.members.get(id)?.binding)) throw new Error("Member already joined");
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
		try {
			const [team, member] = this.bound(binding);
			if (!isTeamRequest(request)) throw new Error("Invalid team request");
			// Explicit fields exclude untrusted sender/binding properties from both identity and dedup.
			const fingerprint = JSON.stringify([request.sequence, request.action, request.to, request.message,
				request.command, request.wait?.kind, request.wait?.member, request.wait?.afterSeq, request.receive]);
			const cached = member.requests.get(request.requestId);
			if (cached) {
				if (cached.fingerprint !== fingerprint) throw new Error("Conflicting duplicate request id");
				return cached.promise.then(copy);
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
				team.replies.push({ reply, resolve: (result) => { entry.settled = true; resolve(copy(result)); } });
			};
			try { this.apply(team, member, copy(request), done, signal); }
			catch (error) { done({ ok: false, error: this.error(error) }); }
			this.pump(team);
			this.publish(team);
			return promise.then(copy);
		} catch (error) { return Promise.resolve({ ok: false, error: this.error(error) }); }
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
		member.permit = false;
		member.view.output = boundedText(outcome.output, OUTPUT_BYTES);
		if (outcome.error !== undefined) member.view.error = boundedText(outcome.error, ERROR_BYTES);
		this.settle(member, { ok: false, error: "Member completed" });
		member.requests.clear();
		member.inbox = [];
		member.states.clear();
		team.members.get(team.view.coordinator)!.states.delete(member.view.id);
		this.state(team, member, outcome.status);
		const result = this.event(team, { kind: "result", member: member.view.id, state: outcome.status });
		if (member.view.role === "worker") {
			// Reserve at most one native result per fixed worker beyond the ordinary inbox limit.
			// Native settlement must remain authoritative even when reports filled the mailbox.
			team.members.get(team.view.coordinator)!.inbox.push(result);
		}
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
		if (!reply.ok || !reply.snapshot) throw new Error(reply.error ?? "Worker barrier failed");
		return reply.snapshot;
	}

	get(teamId: string): TeamSnapshot { const team = this.team(teamId); this.expire(team); return copy(team.view); }
	list(): TeamSnapshot[] { return [...this.teams.keys()].map((id) => this.get(id)); }
	signal(teamId: string): AbortSignal { const team = this.team(teamId); this.expire(team); return team.controller.signal; }
	subscribe(listener: (snapshot: TeamSnapshot) => void): () => void {
		if (this.disposed) throw new Error("TeamHub disposed");
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	cancel(teamId: string, reason = "Team cancelled"): void {
		const team = this.team(teamId);
		if (!terminal(team.view.phase)) this.stop(team, "cancelled", reason);
	}
	restore(snapshots: readonly TeamSnapshot[]): void {
		if (this.disposed) throw new Error("TeamHub disposed");
		if (!Array.isArray(snapshots) || snapshots.length > MAX_TEAMS) throw new Error("Invalid history or team session capacity exceeded (32)");
		// Validate/reconstruct the entire batch before adopting anything; never clone unknown fields.
		const views = snapshots.map((snapshot: unknown) => this.validateSnapshot(snapshot));
		const ids = new Set(views.map((view) => view.id));
		if (ids.size !== views.length) throw new Error("Duplicate historical team id");
		if (this.teams.size + views.filter((view) => !this.teams.has(view.id)).length > MAX_TEAMS) throw new Error("Team session capacity exceeded (32, including history)");
		for (const view of views) {
			if (this.teams.has(view.id)) continue;
			if (!terminal(view.phase)) {
				view.phase = "interrupted";
				for (const member of view.members) if (!terminal(member.state)) {
					member.state = "cancelled";
					member.error = "Interrupted by parent restart; historical team cannot resume";
					delete member.waitingFor;
				}
			}
			const team: Team = { view, members: new Map(), controller: new AbortController(),
				startupDeadline: 0, timers: [], history: true, publishing: false, replies: [] };
			team.controller.abort("Historical team");
			this.teams.set(view.id, team);
			this.publish(team);
			this.assertJournal(team);
		}
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
		const states = ["registered", "starting", "running", "waiting", "pause_requested", "paused", "finalizing", "completed", "failed", "cancelled"];
		const memberState = (item: unknown): TeamMemberSnapshot["state"] => {
			if (!states.includes(text(item))) return invalid();
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
		if (!["prepared", "running", "finalizing", "completed", "failed", "cancelled", "interrupted"].includes(phase)) return invalid();
		const seq = source["seq"];
		const createdAt = source["createdAt"];
		const deadline = source["deadline"];
		if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0
			|| typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < 0
			|| typeof deadline !== "number" || !Number.isFinite(deadline) || deadline < createdAt) return invalid();
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
			return member;
		});
		if (terminal(phase) && members.some((member) => !terminal(member.state))) return invalid();
		if (["finalizing", "completed"].includes(phase) && members.some((member) => member.role === "worker" && !terminal(member.state))) return invalid();
		if (phase === "completed" && members.find((member) => member.id === coordinator)!.state !== "completed") return invalid();
		const rawEvents = source["events"];
		if (!Array.isArray(rawEvents) || rawEvents.length > TEAM_MAX_EVENTS) return invalid();
		let previous = 0;
		const events = rawEvents.map((item): TeamEvent => {
			const raw = record(item);
			const eventSeq = raw["seq"];
			if (typeof eventSeq !== "number" || !Number.isSafeInteger(eventSeq) || eventSeq <= previous || eventSeq > seq) return invalid();
			previous = eventSeq;
			const kind = text(raw["kind"]) as TeamEvent["kind"];
			if (!["message", "report", "state", "result", "control", "cancelled"].includes(kind)) return invalid();
			const event: TeamEvent = { seq: eventSeq, kind };
			for (const key of ["from", "to", "member"] as const) if (raw[key] !== undefined) {
				const id = alias(raw[key]);
				if (!roster.has(id)) return invalid();
				event[key] = id;
			}
			if (raw["message"] !== undefined) event.message = boundedText(text(raw["message"]), ERROR_BYTES);
			if (raw["state"] !== undefined) event.state = memberState(raw["state"]);
			return event;
		});
		while (Buffer.byteLength(JSON.stringify(events)) > EVENT_BATCH_BYTES) events.shift();
		return { id, coordinator, workers, phase, seq, createdAt, deadline, members, events };
	}

	private apply(team: Team, member: Member, request: TeamRequest, done: (reply: TeamReply) => void, signal?: AbortSignal): void {
		switch (request.action) {
			case "checkpoint":
				if (member.permit && !member.paused && this.admitted(team)) {
					done(this.checkpointReply(team, member, request.receive === true));
				} else this.park(team, member, "checkpoint", done, undefined, signal, request.receive === true);
				return;
			case "wait":
				if (!request.wait) throw new Error("Missing wait condition");
				this.validateWait(team, member, request.wait);
				this.park(team, member, "wait", done, request.wait, signal); return;
			case "finish":
				if (member.view.role === "coordinator") this.park(team, member, "wait", done, { kind: "workers" }, signal);
				else {
					member.permit = false;
					this.state(team, member, member.paused ? "paused" : "waiting");
					this.notifyState(team, member);
					done({ ok: true });
				}
				return;
			case "send": this.deliver(team, member, request.to, request.message, "message"); break;
			case "report":
				if (request.to !== undefined && request.to !== team.view.coordinator) {
					throw new Error(`report can only be sent to this team's coordinator "${team.view.coordinator}"; use send for other recipients`);
				}
				if (request.wait) this.validateWait(team, member, request.wait);
				this.deliver(team, member, team.view.coordinator, request.message, "report");
				if (request.wait) { this.park(team, member, "wait", done, request.wait, signal); return; }
				break;
			case "control": {
				if (member.view.role !== "coordinator") throw new Error("Only coordinator may control workers");
				const target = request.to && team.members.get(request.to);
				if (!target || target.view.role !== "worker") throw new Error("Unknown worker control target");
				if (terminal(target.view.state)) throw new Error("Cannot control terminal member");
				if (request.command === "pause") {
					target.paused = true;
					this.state(team, target, target.permit ? "pause_requested" : "paused");
					this.notifyState(team, target);
				} else if (request.command === "resume") {
					target.paused = false;
					team.members.get(team.view.coordinator)!.states.delete(target.view.id);
					this.state(team, target, target.permit ? "running" : "waiting");
					this.notifyState(team, target);
				} else if (request.command === "redirect") {
					this.deliver(team, member, request.to, request.message, "message");
					// Redirect replaces a dependency, but never clears a manual pause.
					if (target.pending?.kind === "wait") {
						target.pending.wait = { kind: "message", afterSeq: team.view.seq - 1 };
						target.view.waitingFor = "message";
					}
				} else throw new Error("Missing control command");
				this.event(team, { kind: "control", from: member.view.id, to: target.view.id, message: request.command });
				// Include immediate safe-point admission/wakeups, not a transient pre-pump state.
				this.pump(team);
				done({ ok: true, snapshot: copy(team.view) });
				return;
			}
		}
		done({ ok: true });
	}

	private deliver(team: Team, from: Member, to: string | undefined, message: string | undefined, kind: "message" | "report"): void {
		const target = to && team.members.get(to);
		if (!target) throw new Error("Unknown message recipient");
		if (terminal(target.view.state)) throw new Error("Recipient is terminal");
		if (!message) throw new Error("Missing message");
		if (target.inbox.length >= TEAM_MAX_EVENTS) throw new Error("Inbox overflow");
		const event = this.event(team, { kind, from: from.view.id, to: target.view.id, message });
		target.inbox.push(event);
	}

	private validateWait(team: Team, member: Member, wait: TeamWait): void {
		if (wait.kind === "member" && (!wait.member || !team.members.has(wait.member))) throw new Error("Unknown wait member");
		if (wait.kind === "workers" && member.view.role !== "coordinator") throw new Error("Worker cannot wait for all workers (self-wait)");
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

	private park(team: Team, member: Member, kind: Pending["kind"], resolve: Pending["resolve"], wait?: TeamWait, signal?: AbortSignal, receive = false): void {
		member.permit = false;
		if (wait?.kind === "message" && wait.afterSeq !== undefined) {
			// Acknowledged messages must free capacity even when no newer message exists yet.
			this.acknowledge(member, wait.afterSeq);
		}
		const abort = (): void => {
			// A cancelled native operation cannot safely continue the same team execution.
			this.stop(team, "cancelled", "Team request aborted");
		};
		member.pending = { kind, receive, resolve, cleanup: () => signal?.removeEventListener("abort", abort), ...(wait ? { wait } : {}) };
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
				if (!this.admitted(team) || (member.view.role === "worker" && permits >= WORKER_PERMITS)) continue;
				member.permit = true;
				team.members.get(team.view.coordinator)!.states.delete(member.view.id);
				if (member.view.role === "worker") permits++;
				this.state(team, member, member.view.role === "coordinator" && team.view.phase === "finalizing" ? "finalizing" : "running");
				this.settle(member, this.checkpointReply(team, member, pending.receive));
				continue;
			}
			const wait = pending.wait!;
			let events: TeamEvent[] = [];
			if (wait.kind === "message") {
				this.acknowledge(member, wait.afterSeq ?? 0);
				if (!member.inbox.length && !member.states.size) continue;
				events = this.consume(member);
			} else if (wait.kind === "member") {
				if (!terminal(team.members.get(wait.member!)!.view.state)) continue;
			} else {
				if (!team.view.workers.every((id) => terminal(team.members.get(id)!.view.state))) continue;
				team.view.phase = "finalizing";
			}
			team.members.get(team.view.coordinator)!.states.delete(member.view.id);
			this.state(team, member, wait.kind === "workers" ? "finalizing" : "waiting");
			delete member.view.waitingFor;
			this.settle(member, { ok: true, events: copy(events), snapshot: copy(team.view) });
		}
	}

	private checkpointReply(team: Team, member: Member, receive: boolean): TeamReply {
		// Tool/provider gates grant work only: consuming here can steal a message from
		// an already-generated wait tool before the next model context is assembled.
		if (!receive) return { ok: true };
		const reply: TeamReply = { ok: true, events: this.consume(member) };
		if (!member.announced) {
			member.announced = true;
			reply.snapshot = copy(team.view); // Public roster/roles only; never dispatch capabilities.
		}
		return reply;
	}

	private acknowledge(member: Member, afterSeq: number): void {
		member.inbox = member.inbox.filter((event) => event.seq > afterSeq);
		for (const [id, event] of member.states) if (event.seq <= afterSeq) member.states.delete(id);
	}

	private consume(member: Member): TeamEvent[] {
		let bytes = 2;
		const events: TeamEvent[] = [];
		const available = [...member.inbox, ...member.states.values()].sort((left, right) => left.seq - right.seq);
		for (const event of available) {
			bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
			if (events.length === TEAM_MAX_EVENTS || bytes > EVENT_BATCH_BYTES) break;
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
		const blocked = wait?.kind === "message" ? member.inbox.length === 0
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
		if (pending) { pending.cleanup(); pending.resolve(reply); }
	}
	private state(team: Team, member: Member, state: TeamMemberSnapshot["state"]): void {
		if (member.view.state === state) return;
		member.view.state = state;
		this.event(team, { kind: "state", member: member.view.id, state });
	}
	private event(team: Team, fields: Omit<TeamEvent, "seq">): TeamEvent {
		const event = { ...fields, seq: ++team.view.seq };
		team.view.events.push(event);
		while (team.view.events.length > TEAM_MAX_EVENTS || Buffer.byteLength(JSON.stringify(team.view.events)) > EVENT_BATCH_BYTES) team.view.events.shift();
		return event;
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
		}
		this.event(team, { kind: "cancelled", message: reason });
		team.controller.abort(reason);
		if (!journalFailure) this.publish(team);
	}
	private clearTimers(team: Team): void { for (const timer of team.timers) clearTimeout(timer); team.timers = []; }
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
			while (team.published !== `${team.view.seq}:${team.view.phase}`) {
				team.published = `${team.view.seq}:${team.view.phase}`;
				if (!team.journalError) {
					try {
						const result: unknown = this.options.onSnapshot?.(copy(team.view));
						// The frozen callback is synchronous. Fail closed on accidental async writers,
						// and observe their rejection rather than letting it become unhandled.
						if (result && typeof (result as PromiseLike<unknown>).then === "function") {
							void Promise.resolve(result).catch(() => {});
							throw new Error("onSnapshot must persist synchronously");
						}
					} catch (error) {
						team.journalError = boundedText(`Team journal failed: ${this.error(error)}`, ERROR_BYTES);
						this.stop(team, "failed", team.journalError, true);
						team.published = `${team.view.seq}:${team.view.phase}`;
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
				resolve(failure ? { ok: false, error: boundedText(failure, ERROR_BYTES) } : reply);
			}
		}
	}
	private error(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
