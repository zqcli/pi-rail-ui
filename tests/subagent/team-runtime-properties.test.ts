import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, encodeActivationInput, jsonBytes, parseChildFrame, parseTeamReply } from "../../tools/subagents/team-codec";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";
import {
	TEAM_MAX_ACTIVATION_INPUT_BYTES, TEAM_MAX_BRIEF_BYTES, TEAM_MAX_NOTE_BYTES, TEAM_MAX_DEPENDENCY_PREVIEWS,
	TEAM_MAX_DELIVERED_OUTCOMES, TEAM_MAX_FRAME_BYTES, TEAM_MAX_RESULT_BYTES, TEAM_MAX_ROLE_BYTES, TEAM_MAX_TASK_BYTES,
	TEAM_MAX_WORKERS, type TeamReply, type WorkRef,
} from "../../tools/subagents/team-protocol";

/** Small deterministic PRNG (mulberry32) so every failing trace replays from its seed. */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function runtimeFor(workers: string[], initialRequests: Array<{ to: string; task: string }>, limits = {}) {
	let ids = 0;
	let time = 1_700_000_000_000;
	const runtime = new TeamRuntime({ now: () => time++, createId: () => `id${++ids}`, limits });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage, review and close." },
		workers: workers.map((alias) => ({ alias, roleDescription: `Worker ${alias}.` })),
		brief: { goal: "Property-test the Team Runtime." }, initialRequests, timeoutSeconds: null,
	});
	runtime.launch(prepared.teamId);
	return { runtime, teamId: prepared.teamId };
}

interface Flight {
	activation: RuntimeActivation;
	phase: "reserved" | "ready" | "ended" | "settled";
	sequence: number;
	intentCallId?: string;
	label: string;
}

const refKey = (ref: WorkRef) => `${ref.workId}@${ref.revision}`;
/** Coverage of the outcome-unknown paths across all X10 seeds; the test asserts they were exercised. */
const unknownCoverage = { dependencyHolds: 0, acknowledgedDeliveries: 0 };

/**
 * X10/X01/X02/X03/X06/X07: a seeded random walk over every Runtime transition that a native driver,
 * the Manager, workers and the host can trigger, with arbitrary interleaving of the activation latches
 * (reserve, input_ready, intent, agent_settled, cleanup) across members. Every step asserts the full
 * invariant set plus trace-level properties that the in-Runtime checker cannot see alone.
 */
function runSeed(seed: number, steps: number): string[] {
	const random = prng(seed);
	const pick = <T>(items: readonly T[]): T | undefined => items.length ? items[Math.floor(random() * items.length)] : undefined;
	const workers = ["w1", "w2", "w3"];
	const { runtime, teamId } = runtimeFor(workers, [{ to: "w1", task: "root one" }, { to: "w2", task: "root two" }]);
	const trace: string[] = [];
	const flights: Flight[] = [];
	const closed: Flight[] = [];
	const pendingCloses: Array<{ memberId: string; closeId: string }> = [];
	const unconfirmedExits: string[] = [];
	const results = new Map<string, string>();
	const terminal = new Map<string, string>();
	let lastStateVersion = runtime.getTeam(teamId).stateVersion;
	let calls = 0;

	// 13.5: an outcome-unknown dependency reaches a consumer only after an explicit resume/release on that version.
	const assertUnknownAcknowledged = (activation: RuntimeActivation) => {
		if (activation.input.scope.kind !== "work" || !activation.input.outcomes.some((outcome) => outcome.error?.outcomeUnknown)) return;
		unknownCoverage.acknowledgedDeliveries++;
		assert.ok(activation.input.scope.resumeInstruction, `seed ${seed}: unknown outcome auto-delivered to ${refKey(activation.input.scope.work)}`);
	};
	const knownRefs = () => runtime.listWorks(teamId).map((work) => work.work);
	const act = (flight: Flight, args: Record<string, unknown>): TeamReply => {
		const callId = `c${++calls}`;
		const before = canonicalJson({ team: runtime.getTeam(teamId), works: runtime.listWorks(teamId) });
		trace.push(`${flight.label} attempts ${canonicalJson(args)}`);
		const reply = runtime.handleAction(flight.activation.binding, flight.activation.scope, ++flight.sequence, callId, args, callId);
		trace.push(`${flight.label} ${canonicalJson(args)} -> ${reply.ok ? reply.receipt?.status ?? "ok" : reply.error.code}`);
		parseTeamReply(reply);
		if (!reply.ok) {
			// I23: a rejected business action has no partial side effect.
			assert.equal(canonicalJson({ team: runtime.getTeam(teamId), works: runtime.listWorks(teamId) }), before, `rejected ${canonicalJson(args)} changed state`);
		} else if (reply.receipt?.status === "staged" || (reply.receipt?.status === "closing" && reply.receipt.command === "close_team")) {
			flight.intentCallId = callId;
			flight.phase = "ended";
		} else if (reply.receipt?.status === "closing" && reply.receipt.command === "close_member") {
			pendingCloses.push({ memberId: reply.receipt.memberId!, closeId: reply.receipt.closeId });
		}
		return reply;
	};

	const check = (label: string) => {
		try {
			runtime.assertInvariants(teamId);
			const team = runtime.getTeam(teamId);
			assert.ok(team.stateVersion >= lastStateVersion, "stateVersion never moves backwards");
			lastStateVersion = team.stateVersion;
			for (const summary of runtime.listWorks(teamId)) {
				const work = runtime.getWork(teamId, summary.work)!;
				for (const revision of work.revisions) {
					const key = `${work.id}@${revision.revision}`;
					const previous = terminal.get(key);
					if (previous && previous !== revision.state) assert.fail(`terminal ${key} changed from ${previous} to ${revision.state}`);
					if (["resolved", "failed", "cancelled", "superseded"].includes(revision.state)) terminal.set(key, revision.state);
					if (revision.resultRef) {
						const record = canonicalJson(runtime.getResult(teamId, revision.resultRef));
						const seen = results.get(revision.resultRef);
						if (seen && seen !== record) assert.fail(`ResultRecord ${revision.resultRef} changed after commit`);
						results.set(revision.resultRef, record);
					}
				}
				const assignee = team.members.find((member) => member.id === summary.assignee)!;
				if ((assignee.lifecycle === "closing" || assignee.lifecycle === "closed") && !["resolved", "failed", "cancelled", "superseded"].includes(summary.state)) {
					assert.fail(`closed/closing ${assignee.id} still owns unresolved ${refKey(summary.work)}`);
				}
			}
			const activeMembers = flights.map((flight) => flight.activation.binding.memberId);
			assert.equal(new Set(activeMembers).size, activeMembers.length, "I01: one activation per member");
		} catch (error) {
			throw new Error(`seed ${seed} failed after ${label}:\n${trace.slice(-40).join("\n")}\n${(error as Error).message}`, { cause: error });
		}
	};

	const businessStep = (flight: Flight) => {
		const scope = flight.activation.scope;
		const input = flight.activation.input;
		const roll = random();
		if (scope.kind === "management") {
			const works = runtime.listWorks(teamId);
			const target = pick(works);
			if (roll < 0.25) act(flight, { action: "request", to: pick(workers)!, task: `root ${calls}` });
			else if (roll < 0.35 && target) act(flight, { action: "control", command: "cancel_work", workId: target.work.workId, expectedRevision: target.work.revision, reason: "property cancel" });
			else if (roll < 0.45 && target) act(flight, { action: "control", command: "revise_work", workId: target.work.workId, expectedRevision: target.work.revision, task: `revised ${calls}` });
			else if (roll < 0.52) act(flight, { action: "control", command: "pause_member", memberId: pick(workers)! });
			else if (roll < 0.60) act(flight, { action: "control", command: "resume_member", memberId: pick(workers)! });
			else if (roll < 0.68 && target) act(flight, { action: "control", command: "accept_result", work: target.work, disposition: random() < 0.5 ? "accepted" : "waived", reason: "property review" });
			else if (roll < 0.72) act(flight, { action: "control", command: "close_member", memberId: pick(workers)! });
			else if (roll < 0.78 && target?.hold) {
				const hold = runtime.getWork(teamId, target.work)!.current.hold;
				if (hold) act(flight, { action: "control", command: "resume_work", workId: target.work.workId, expectedRevision: target.work.revision, incidentId: hold.incidentId, instruction: "continue" });
			} else if (roll < 0.83) act(flight, { action: "status", view: pick(["team", "work", "result", "incident"] as const)! });
			else act(flight, { action: "yield", checkpoint: `management ${calls}` });
			return;
		}
		const children = input.ownedChildren.map((child) => child.work);
		if (roll < 0.25) act(flight, { action: "request", to: pick([...workers, "lead"].filter((id) => id !== flight.activation.binding.memberId))!, task: `child ${calls}` });
		else if (roll < 0.55) act(flight, { action: "reply", result: { status: pick(["succeeded", "partial", "failed"] as const)!, summary: `result ${calls}` } });
		else if (roll < 0.72) {
			const waitingFor = random() < 0.8 && children.length ? children : [pick(knownRefs())!];
			act(flight, { action: "yield", waitingFor, checkpoint: `checkpoint ${calls}` });
		} else if (roll < 0.78) act(flight, { action: "yield", attention: "needs a Manager decision", checkpoint: `attention ${calls}` });
		else if (roll < 0.84) act(flight, { action: "status", view: "work" });
		else flight.phase = "ended";
	};

	const settle = (flight: Flight) => {
		const { binding, scope } = flight.activation;
		if (random() < 0.06 && binding.role === "worker") {
			// Transport loss before agent_settled: outcome unknown, only this member is isolated.
			const exitConfirmed = random() < 0.5;
			const lost = runtime.activationLost(binding, scope.activationId, { code: "PROTOCOL_FAILURE", message: "injected transport loss", outcomeUnknown: true }, exitConfirmed);
			if (!exitConfirmed) unconfirmedExits.push(binding.memberId);
			trace.push(`${flight.label} lost (exit ${exitConfirmed ? "confirmed" : "unknown"}) -> ${lost.ok}`);
			flights.splice(flights.indexOf(flight), 1);
			closed.push(flight);
			return;
		}
		const failure = random() < 0.03 && binding.role === "worker";
		const completion = failure ? { status: "error" as const, error: { code: "PROVIDER_ERROR", message: "injected native failure" } }
			: { status: "success" as const, ...(flight.intentCallId ? { appliedToolCallId: flight.intentCallId } : {}), finalAssistantText: random() < 0.5 ? `natural ${calls}` : "" };
		trace.push(`${flight.label} settling ${completion.status}`);
		const settled = runtime.nativeSettled(binding, scope.activationId, completion);
		trace.push(`${flight.label} settled ${completion.status} -> ${settled.ok}`);
		flight.phase = "settled";
	};

	const cleanup = (flight: Flight) => {
		const { binding, scope } = flight.activation;
		const reply = runtime.cleanupFinished(binding, scope.activationId, { ok: true });
		trace.push(`${flight.label} cleanup -> ${reply.ok}`);
		flights.splice(flights.indexOf(flight), 1);
		closed.push(flight);
	};

	const advance = (flight: Flight) => {
		if (flight.phase === "reserved") {
			const ready = runtime.inputReady(flight.activation.binding, flight.activation.scope.activationId, flight.activation.deliveryId);
			trace.push(`${flight.label} input_ready -> ${ready.ok}`);
			flight.phase = "ready";
		} else if (flight.phase === "ready") {
			if (random() < 0.8) businessStep(flight);
			else flight.phase = "ended";
		} else if (flight.phase === "ended") settle(flight);
		else cleanup(flight);
	};

	const withTrace = (label: string, run: () => void) => {
		try { run(); }
		catch (error) {
			if ((error as Error).message.startsWith(`seed ${seed} `)) throw error;
			throw new Error(`seed ${seed} failed during ${label}:\n${trace.slice(-40).join("\n")}\n${(error as Error).message}`, { cause: error });
		}
	};
	for (let step = 0; step < steps; step++) withTrace(`step ${step}`, () => {
		const roll = random();
		if (roll < 0.25) {
			const activation = runtime.takeNextActivation(teamId);
			if (activation) {
				assertUnknownAcknowledged(activation);
				const label = `${activation.binding.memberId}:${activation.scope.kind === "work" ? refKey(activation.scope.work!) : "mgmt"}`;
				flights.push({ activation, phase: "reserved", sequence: 0, label });
				trace.push(`${label} reserved`);
			}
		} else if (roll < 0.85 && flights.length) advance(pick(flights)!);
		else if (roll < 0.9 && closed.length) {
			// X06: duplicated or late native evidence for an already-closed activation is idempotent or refused.
			const old = pick(closed)!;
			const before = canonicalJson(runtime.getTeam(teamId));
			// Only the last closed activation keeps a tombstone; older evidence is refused, never re-applied.
			const refused = (evidence: () => TeamReply) => { try { evidence(); } catch (error) { assert.equal((error as { code?: string }).code, "WORK_NOT_RUNNING"); } };
			refused(() => runtime.cleanupFinished(old.activation.binding, old.activation.scope.activationId, { ok: true }));
			refused(() => runtime.inputReady(old.activation.binding, old.activation.scope.activationId, old.activation.deliveryId));
			const late = runtime.handleAction(old.activation.binding, old.activation.scope, old.sequence + 1, `late-${calls}`, { action: "request", to: "w3", task: "late" }, `late-${calls}`);
			assert.equal(late.ok, false, "a retired activation cannot create work");
			assert.equal(canonicalJson(runtime.getTeam(teamId)), before, "late evidence for a retired scope changes nothing");
			trace.push(`${old.label} late evidence ignored`);
		} else if (roll < 0.94 && pendingCloses.length) {
			const close = pendingCloses.shift()!;
			const released = runtime.memberReleased(runtime.bindingForDriver(teamId, close.memberId), close.closeId, { ok: true });
			trace.push(`release ${close.memberId} -> ${released.ok}`);
		} else if (roll < 0.955) {
			const held = runtime.listHolds(teamId)[0];
			if (held && (held.reason === "attention" || held.reason === "protocol")) {
				const before = canonicalJson({ team: runtime.getTeam(teamId), works: runtime.listWorks(teamId) });
				try {
					const reply = runtime.releaseHold(teamId, held.work, held.incidentId, "host continue");
					trace.push(`host release ${refKey(held.work)} -> ${reply.status}`);
				} catch (error) {
					// An outcome-unknown dependency without a confirmed exit (or a busy/unavailable owner) refuses release atomically.
					assert.equal(canonicalJson({ team: runtime.getTeam(teamId), works: runtime.listWorks(teamId) }), before);
					trace.push(`host release ${refKey(held.work)} refused ${(error as { code?: string }).code}`);
				}
			}
		} else if (roll < 0.97 && unconfirmedExits.length) {
			const memberId = unconfirmedExits.shift()!;
			trace.push(`exit confirmed ${memberId} -> ${runtime.memberExitConfirmed(runtime.bindingForDriver(teamId, memberId)).ok}`);
		} else {
			runtime.messageManager(teamId, `host note ${step % 3}`);
			trace.push(`host message ${step % 3}`);
		}
		check(`step ${step}`);
		unknownCoverage.dependencyHolds += runtime.getTeam(teamId).incidents.filter((incident) => incident.code === "DEPENDENCY_UNAVAILABLE" && incident.state === "open").length ? 1 : 0;
	});

	// Drain: finish every flight, then answer every remaining activation deterministically.
	for (let guard = 0; guard < 2000; guard++) {
		if (flights.length) { withTrace("drain flight", () => { advance(flights[0]!); check("drain flight"); }); continue; }
		const activation = runtime.takeNextActivation(teamId);
		if (!activation) break;
		assertUnknownAcknowledged(activation);
		const flight: Flight = { activation, phase: "reserved", sequence: 0, label: `${activation.binding.memberId}:drain` };
		flights.push(flight);
		trace.push(`${flight.label} reserved`);
		withTrace("drain input", () => advance(flight));
		if (activation.scope.kind === "management") act(flight, { action: "yield" });
		else {
			const reply = act(flight, { action: "reply", result: { status: "succeeded", summary: "drain" } });
			if (!reply.ok) {
				const waitingFor = activation.input.ownedChildren.map((child) => child.work);
				if (waitingFor.length) act(flight, { action: "yield", waitingFor, checkpoint: "drain wait" });
			}
		}
		flight.phase = "ended";
		check("drain activation");
	}
	assert.equal(flights.length, 0);
	for (const close of pendingCloses) runtime.memberReleased(runtime.bindingForDriver(teamId, close.memberId), close.closeId, { ok: true });
	check("final");
	// Liveness: nothing runnable is stranded. Queued work waits only on a paused or unavailable member.
	const team = runtime.getTeam(teamId);
	for (const summary of runtime.listWorks(teamId)) {
		if (summary.state !== "queued") continue;
		const member = team.members.find((item) => item.id === summary.assignee)!;
		assert.ok(member.pause !== "none" || member.lifecycle !== "open", `seed ${seed}: runnable ${refKey(summary.work)} was stranded`);
	}
	return trace;
}

test("X10: fixed-seed random Runtime traces keep every invariant and replay identically", () => {
	for (let seed = 1; seed <= 60; seed++) runSeed(seed, 160);
	for (let seed = 61; seed <= 75; seed++) runSeed(seed, 400);
	assert.deepEqual(runSeed(7, 160), runSeed(7, 160), "a seed reproduces the exact same trace");
	assert.ok(unknownCoverage.dependencyHolds > 0 && unknownCoverage.acknowledgedDeliveries > 0,
		`the random walk exercised outcome-unknown holds and acknowledged deliveries: ${JSON.stringify(unknownCoverage)}`);
});

function settleClean(runtime: TeamRuntime, activation: RuntimeActivation, callId?: string) {
	assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", ...(callId ? { appliedToolCallId: callId } : {}) }).ok, true);
	assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
}

function start(runtime: TeamRuntime, teamId: string): RuntimeActivation {
	const activation = runtime.takeNextActivation(teamId)!;
	assert.ok(activation);
	assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
	return activation;
}

function call(runtime: TeamRuntime, activation: RuntimeActivation, sequence: number, id: string, args: unknown): TeamReply {
	return runtime.handleAction(activation.binding, activation.scope, sequence, id, args, id);
}

function bootIdle(runtime: TeamRuntime, teamId: string) {
	const boot = start(runtime, teamId);
	assert.equal(call(runtime, boot, 1, "boot", { action: "yield" }).ok, true);
	settleClean(runtime, boot, "boot");
}

test("D08: more outcomes than previews or one input can carry stay referenced, unselected ones stay undelivered, and previews are never full results", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = start(runtime, teamId);
	const children: WorkRef[] = [];
	const count = TEAM_MAX_DELIVERED_OUTCOMES + 2;
	for (let index = 0; index < count; index++) {
		const accepted = call(runtime, parent, index + 1, `child-${index}`, { action: "request", to: "w2", task: `child ${index}` });
		assert.ok(accepted.ok && accepted.receipt?.status === "accepted");
		children.push(accepted.receipt.work);
	}
	assert.equal(call(runtime, parent, count + 1, "wait-first", { action: "yield", waitingFor: children.slice(0, 32), checkpoint: "collect children" }).ok, true);
	settleClean(runtime, parent, "wait-first");
	const longSummary = `${"界".repeat(300)} full-result-tail`;
	for (let index = 0; index < count; index++) {
		const child = start(runtime, teamId);
		assert.equal(call(runtime, child, 1, `reply-${index}`, { action: "reply", result: { status: "succeeded", summary: `${index}:${longSummary}` } }).ok, true);
		settleClean(runtime, child, `reply-${index}`);
	}
	const resumed = start(runtime, teamId);
	assert.equal(resumed.scope.kind, "work");
	assert.equal(resumed.input.outcomes.length, TEAM_MAX_DELIVERED_OUTCOMES);
	assert.equal(resumed.input.omittedOutcomes, 2);
	const previews = resumed.input.outcomes.filter((outcome) => outcome.preview);
	assert.equal(previews.length, TEAM_MAX_DEPENDENCY_PREVIEWS);
	for (const outcome of resumed.input.outcomes) {
		assert.ok(outcome.resultRef, "every delivered outcome carries its immutable resultRef");
		const full = runtime.getResult(teamId, outcome.resultRef)!;
		assert.ok(full.result.summary.endsWith("full-result-tail"), "the full result is intact in the ledger");
		if (outcome.preview) assert.ok(outcome.preview.summary.length < full.result.summary.length && !outcome.preview.summary.endsWith("full-result-tail"), "a preview is visibly truncated");
	}
	assert.ok(jsonBytes(resumed.input) <= TEAM_MAX_ACTIVATION_INPUT_BYTES);
	const delivered = new Set(resumed.input.outcomes.map((outcome) => refKey(outcome.work)));
	const omitted = children.filter((child) => !delivered.has(refKey(child)));
	assert.equal(omitted.length, 2);
	const early = call(runtime, resumed, 1, "early-reply", { action: "reply", result: { status: "succeeded", summary: "too early" } });
	assert.equal(early.ok, false);
	assert.equal(!early.ok && early.error.code, "UNOBSERVED_CHILD_RESULTS");
	assert.deepEqual(!early.ok && early.error.blockers?.map((blocker) => blocker.id).sort(), omitted.map(refKey).sort());
	assert.equal(call(runtime, resumed, 2, "wait-omitted", { action: "yield", waitingFor: omitted, checkpoint: "collect the rest" }).ok, true,
		"undelivered outcomes are new dependencies, not NO_NEW_DEPENDENCY");
	settleClean(runtime, resumed, "wait-omitted");
	const last = start(runtime, teamId);
	assert.deepEqual(last.input.outcomes.map((outcome) => refKey(outcome.work)).sort(), omitted.map(refKey).sort());
	assert.equal(last.input.omittedOutcomes, 0);
	assert.equal(call(runtime, last, 1, "final", { action: "reply", result: { status: "succeeded", summary: "all children observed" } }).ok, true);
	settleClean(runtime, last, "final");
	assert.equal(runtime.getWork(teamId, last.scope.work!)!.current.state, "resolved");
	runtime.assertInvariants(teamId);
});

test("W02: an unresolved request far behind many newer events remains addressable in the ledger and replies normally", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2", "w3"], []);
	const boot = start(runtime, teamId);
	const early = call(runtime, boot, 1, "early", { action: "request", to: "w1", task: "early obligation" });
	assert.ok(early.ok && early.receipt?.status === "accepted");
	assert.equal(call(runtime, boot, 2, "pause-w1", { action: "control", command: "pause_member", memberId: "w1" }).ok, true);
	for (let index = 0; index < 70; index++) {
		assert.equal(call(runtime, boot, index + 3, `noise-${index}`, { action: "request", to: index % 2 ? "w3" : "w2", task: `noise ${index}` }).ok, true);
	}
	assert.equal(call(runtime, boot, 80, "boot-yield", { action: "yield" }).ok, true);
	settleClean(runtime, boot, "boot-yield");
	for (let index = 0; index < 70; index++) {
		const noise = start(runtime, teamId);
		if (noise.scope.kind === "management") {
			assert.equal(call(runtime, noise, 1, `m-${index}`, { action: "yield" }).ok, true);
			settleClean(runtime, noise, `m-${index}`);
			index--;
			continue;
		}
		assert.notEqual(noise.binding.memberId, "w1", "the paused member is not scheduled");
		assert.equal(call(runtime, noise, 1, `n-${index}`, { action: "reply", result: { status: "succeeded", summary: `noise ${index}` } }).ok, true);
		settleClean(runtime, noise, `n-${index}`);
	}
	assert.ok(runtime.getTeam(teamId).eventSeq > 64, "far more than a 64-item recent-event window has been produced");
	const work = runtime.getWork(teamId, early.receipt.work)!;
	assert.equal(work.current.state, "queued");
	assert.equal(runtime.listWorks(teamId)[0]?.taskPreview, "early obligation", "the ledger, not an event tail, keeps the obligation");
	const manager = start(runtime, teamId);
	let page: TeamReply = call(runtime, manager, 1, "page-1", { action: "status", view: "work", limit: 50 });
	const found: string[] = [];
	for (let sequence = 2; page.ok; sequence++) {
		const data = page.data as { items: Array<{ taskPreview: string }>; cursor?: string; hasMore: boolean };
		found.push(...data.items.map((item) => item.taskPreview));
		if (!data.hasMore) break;
		page = call(runtime, manager, sequence, `page-${sequence}`, { action: "status", view: "work", limit: 50, cursor: data.cursor });
	}
	assert.ok(found.includes("early obligation"));
	assert.equal(new Set(found).size, found.length, "cursor pages are stable and non-overlapping");
	assert.equal(call(runtime, manager, 10, "resume-w1", { action: "control", command: "resume_member", memberId: "w1" }).ok, true);
	assert.equal(call(runtime, manager, 11, "m-yield", { action: "yield" }).ok, true);
	settleClean(runtime, manager, "m-yield");
	const obligation = start(runtime, teamId);
	assert.deepEqual(obligation.scope.work, early.receipt.work);
	assert.equal(call(runtime, obligation, 1, "early-reply", { action: "reply", result: { status: "succeeded", summary: "early obligation served" } }).ok, true);
	settleClean(runtime, obligation, "early-reply");
	assert.equal(runtime.getWork(teamId, early.receipt.work)!.current.state, "resolved");
	runtime.assertInvariants(teamId);
});

/** An oversized public action is refused either as a structured error reply or a codec exception. */
function refusedAction(run: () => TeamReply): string {
	try {
		const reply = run();
		assert.equal(reply.ok, false, JSON.stringify(reply));
		return reply.ok ? "" : reply.error.code;
	} catch (error) {
		return (error as { code?: string }).code ?? "THROWN";
	}
}

test("D07/X04: a maximal roster with maximal multi-byte, escape-heavy inputs fits every frame; one byte more is refused before admission", () => {
	// Each "界" is 3 UTF-8 bytes; each quote costs an escape byte inside JSON.
	const fill = (bytes: number) => {
		const unit = "界\"";
		let text = "";
		while (jsonBytes(text + unit) - 2 <= bytes) text += unit;
		while (jsonBytes(`${text}a`) - 2 <= bytes) text += "a";
		return text;
	};
	const workers = Array.from({ length: TEAM_MAX_WORKERS }, (_value, index) => `w${index + 1}`);
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `max${++ids}` });
	const briefGoal = fill(TEAM_MAX_BRIEF_BYTES - 64);
	const plan = {
		manager: { alias: "lead", roleDescription: fill(TEAM_MAX_ROLE_BYTES) },
		workers: workers.map((alias) => ({ alias, roleDescription: fill(TEAM_MAX_ROLE_BYTES) })),
		brief: { goal: briefGoal },
		initialRequests: workers.map((to) => ({ to, task: fill(TEAM_MAX_TASK_BYTES) })),
		timeoutSeconds: null,
	};
	for (;;) {
		try { runtime.prepare(plan); break; }
		catch (error) {
			// Shrink only the brief until the complete plan fits; every other field stays maximal.
			if (!(error instanceof Error) || !/brief/u.test(error.message)) throw error;
			plan.brief.goal = plan.brief.goal.slice(0, -64);
		}
	}
	const teamId = runtime.listTeams()[0]!.teamId;
	runtime.launch(teamId);
	const boot = start(runtime, teamId);
	assert.ok(jsonBytes(boot.input) <= TEAM_MAX_ACTIVATION_INPUT_BYTES);
	encodeActivationInput(boot.input);
	const tooLong = `${fill(TEAM_MAX_TASK_BYTES)}界`;
	const before = canonicalJson({ team: runtime.getTeam(teamId), works: runtime.listWorks(teamId) });
	assert.ok(refusedAction(() => runtime.handleAction(boot.binding, boot.scope, 1, "over", { action: "request", to: "w1", task: tooLong }, "over")));
	assert.equal(canonicalJson({ team: runtime.getTeam(teamId), works: runtime.listWorks(teamId) }), before, "the oversized task is refused without admission");
	assert.equal(call(runtime, boot, 2, "boot", { action: "yield" }).ok, true);
	settleClean(runtime, boot, "boot");
	const worker = start(runtime, teamId);
	assert.ok(jsonBytes(worker.input) <= TEAM_MAX_ACTIVATION_INPUT_BYTES, "maximal accepted work always fits one activation input");
	const maxResult = { status: "partial", summary: fill(4096), findings: [fill(2048)], limitations: [fill(2048)], evidence: [{ source: fill(1024), basis: "observed" }] };
	while (jsonBytes(maxResult) > TEAM_MAX_RESULT_BYTES) maxResult.findings[0] = maxResult.findings[0]!.slice(0, -8);
	const staged = call(runtime, worker, 1, "max-reply", { action: "reply", result: maxResult });
	assert.equal(staged.ok, true, JSON.stringify(staged));
	const frame = { version: 2, kind: "request", binding: worker.binding, activation: worker.scope, sequence: 2, rpcRequestId: "frame",
		request: { action: "business", args: { action: "reply", result: maxResult } } };
	assert.ok(jsonBytes(frame) <= TEAM_MAX_FRAME_BYTES);
	parseChildFrame(frame);
	const oversizeResult = { ...maxResult, summary: `${maxResult.summary}${fill(TEAM_MAX_RESULT_BYTES)}` };
	assert.ok(refusedAction(() => runtime.handleAction(worker.binding, worker.scope, 3, "over-result", { action: "reply", result: oversizeResult }, "over-result")));
	const overCheckpoint = call(runtime, worker, 4, "over-checkpoint", { action: "yield", attention: "x", checkpoint: `${fill(TEAM_MAX_NOTE_BYTES)}界` });
	assert.equal(overCheckpoint.ok, false);
	settleClean(runtime, worker, "max-reply");
	// Maximal checkpoint + attention now, then a maximal host instruction: the combined next input still fits.
	const second = takeWork(runtime, teamId)!;
	assert.equal(runtime.inputReady(second.binding, second.scope.activationId, second.deliveryId).ok, true);
	const checkpoint = fill(TEAM_MAX_NOTE_BYTES);
	const attention = fill(TEAM_MAX_NOTE_BYTES);
	const stagedHold = call(runtime, second, 1, "max-attention", { action: "yield", attention, checkpoint });
	assert.equal(stagedHold.ok, true, JSON.stringify(stagedHold));
	settleClean(runtime, second, "max-attention");
	const hold = runtime.getWork(teamId, second.scope.work!)!.current.hold!;
	assert.equal(hold.reason, "attention");
	const instruction = fill(TEAM_MAX_NOTE_BYTES);
	assert.equal(runtime.releaseHold(teamId, second.scope.work!, hold.incidentId, instruction).status, "applied");
	let resumed = takeWork(runtime, teamId)!;
	while (resumed.scope.work!.workId !== second.scope.work!.workId) {
		// Other maximal roots may run first; each still fits one input.
		assert.ok(jsonBytes(resumed.input) <= TEAM_MAX_ACTIVATION_INPUT_BYTES);
		assert.equal(runtime.inputReady(resumed.binding, resumed.scope.activationId, resumed.deliveryId).ok, true);
		assert.equal(call(runtime, resumed, 1, `r-${resumed.scope.activationId}`, { action: "reply", result: { status: "succeeded", summary: "done" } }).ok, true);
		settleClean(runtime, resumed, `r-${resumed.scope.activationId}`);
		resumed = takeWork(runtime, teamId)!;
	}
	assert.equal(resumed.input.scope.kind === "work" && resumed.input.scope.checkpoint, checkpoint);
	assert.equal(resumed.input.scope.kind === "work" && resumed.input.scope.resumeInstruction, instruction);
	assert.ok(jsonBytes(resumed.input) <= TEAM_MAX_ACTIVATION_INPUT_BYTES, "maximal task + checkpoint + instruction + roster fit one input");
	encodeActivationInput(resumed.input);
	const committed = runtime.getWork(teamId, worker.scope.work!)!;
	assert.equal(runtime.getResult(teamId, committed.current.resultRef!)!.result.summary, maxResult.summary, "the maximal legal result commits unchanged");
	runtime.assertInvariants(teamId);
});

test("X10 regression: cancelling or superseding held work clears its scheduling hold, so no host hold points at a terminal version", () => {
	for (const command of ["cancel_work", "revise_parent"] as const) {
		const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "parent" }]);
		bootIdle(runtime, teamId);
		const parent = start(runtime, teamId);
		const child = call(runtime, parent, 1, "child", { action: "request", to: "w2", task: "child" });
		assert.ok(child.ok && child.receipt?.status === "accepted");
		assert.equal(call(runtime, parent, 2, "wait", { action: "yield", waitingFor: [child.receipt.work], checkpoint: "wait" }).ok, true);
		settleClean(runtime, parent, "wait");
		const worker = start(runtime, teamId);
		assert.equal(runtime.nativeSettled(worker.binding, worker.scope.activationId, { status: "success", finalAssistantText: "" }).ok, true);
		assert.equal(runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true }).ok, true);
		assert.equal(runtime.getWork(teamId, child.receipt.work)!.current.hold?.reason, "protocol");
		const manager = start(runtime, teamId);
		const control = command === "cancel_work"
			? { action: "control", command, workId: child.receipt.work.workId, expectedRevision: 1, reason: "drop the held child" }
			: { action: "control", command: "revise_work", workId: parent.scope.work!.workId, expectedRevision: 1, task: "parent, revised" };
		assert.equal(call(runtime, manager, 1, command, control).ok, true);
		const held = runtime.getWork(teamId, child.receipt.work)!.current;
		assert.equal(held.state, command === "cancel_work" ? "cancelled" : "superseded");
		assert.equal(held.hold, undefined);
		assert.deepEqual(runtime.listHolds(teamId), [], "the host sees no releasable hold on terminal work");
		assert.equal(runtime.getTeam(teamId).works.held, 0);
		const team = runtime.getTeam(teamId);
		assert.deepEqual(team.incidents.map((incident) => incident.state), ["resolved"], "ending held work answers its incident");
		assert.equal(team.health, "ok", "and no longer blocks a succeeded close, which checks open incidents");
		runtime.assertInvariants(teamId);
	}
});

test("X10 regression: a worker transport loss after a staged yield removes the lost intent's wait edge", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = start(runtime, teamId);
	const child = call(runtime, parent, 1, "child", { action: "request", to: "w2", task: "child" });
	assert.ok(child.ok && child.receipt?.status === "accepted");
	assert.equal(call(runtime, parent, 2, "wait", { action: "yield", waitingFor: [child.receipt.work], checkpoint: "wait" }).ok, true);
	assert.equal(runtime.activationLost(parent.binding, parent.scope.activationId,
		{ code: "PROTOCOL_FAILURE", message: "transport lost after the staged yield", outcomeUnknown: true }, true).ok, true);
	const lost = runtime.getWork(teamId, parent.scope.work!)!.current;
	assert.equal(lost.state, "failed");
	assert.equal(lost.error?.outcomeUnknown, true);
	assert.deepEqual(lost.waitingFor, [], "the staged wait never becomes a committed wait");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")!.lifecycle, "faulted");
	runtime.assertInvariants(teamId);
});

/** Parent on w1 waits for [child A on w2, child B on w3]; returns the parent/child refs with the parent blocked. */
function parentWaitingForTwo() {
	const { runtime, teamId } = runtimeFor(["w1", "w2", "w3"], [{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = start(runtime, teamId);
	const a = call(runtime, parent, 1, "child-a", { action: "request", to: "w2", task: "child A" });
	const b = call(runtime, parent, 2, "child-b", { action: "request", to: "w3", task: "child B" });
	assert.ok(a.ok && a.receipt?.status === "accepted" && b.ok && b.receipt?.status === "accepted");
	assert.equal(call(runtime, parent, 3, "wait", { action: "yield", waitingFor: [a.receipt.work, b.receipt.work], checkpoint: "wait for A and B" }).ok, true);
	settleClean(runtime, parent, "wait");
	const childA = runtime.takeNextActivation(teamId)!;
	const childB = runtime.takeNextActivation(teamId)!;
	assert.deepEqual([childA.binding.memberId, childB.binding.memberId], ["w2", "w3"]);
	return { runtime, teamId, parent: parent.scope.work!, a: a.receipt.work, b: b.receipt.work, childA, childB };
}

function managerStep(runtime: TeamRuntime, teamId: string, actions: Array<Record<string, unknown>>): TeamReply[] {
	const manager = start(runtime, teamId);
	assert.equal(manager.scope.kind, "management");
	const replies = actions.map((args, index) => call(runtime, manager, index + 1, `m-${manager.scope.activationId}-${index}`, args));
	assert.equal(call(runtime, manager, actions.length + 1, `m-${manager.scope.activationId}-yield`, { action: "yield" }).ok, true);
	settleClean(runtime, manager, `m-${manager.scope.activationId}-yield`);
	return replies;
}

function takeWork(runtime: TeamRuntime, teamId: string): RuntimeActivation | undefined {
	for (;;) {
		const next = runtime.takeNextActivation(teamId);
		if (!next || next.scope.kind === "work") return next;
		assert.equal(runtime.inputReady(next.binding, next.scope.activationId, next.deliveryId).ok, true);
		assert.equal(call(runtime, next, 1, `drain-${next.scope.activationId}`, { action: "yield" }).ok, true);
		settleClean(runtime, next, `drain-${next.scope.activationId}`);
	}
}

test("13.3/13.5 known failures wake waiters automatically: a settled native error and a successful failed-status reply", () => {
	const { runtime, teamId, parent, a, b, childA, childB } = parentWaitingForTwo();
	assert.equal(runtime.inputReady(childA.binding, childA.scope.activationId, childA.deliveryId).ok, true);
	assert.equal(runtime.nativeSettled(childA.binding, childA.scope.activationId, { status: "error", error: { code: "PROVIDER_ERROR", message: "settled provider error" } }).ok, true);
	assert.equal(runtime.cleanupFinished(childA.binding, childA.scope.activationId, { ok: true }).ok, true);
	assert.equal(runtime.inputReady(childB.binding, childB.scope.activationId, childB.deliveryId).ok, true);
	assert.equal(call(runtime, childB, 1, "b-failed", { action: "reply", result: { status: "failed", summary: "B found a business failure" } }).ok, true);
	settleClean(runtime, childB, "b-failed");
	assert.equal(runtime.getWork(teamId, a)!.current.error?.outcomeUnknown, undefined, "a settled, cleaned native error is a known outcome");
	assert.equal(runtime.listHolds(teamId).length, 0);
	const resumed = takeWork(runtime, teamId)!;
	assert.deepEqual(resumed.scope.work, parent, "known failed outcomes are deliverable without a Manager decision");
	assert.deepEqual(resumed.input.outcomes.map((outcome) => [outcome.state, outcome.error?.outcomeUnknown ?? false]).sort(), [["failed", false], ["resolved", false]]);
	void b;
	runtime.assertInvariants(teamId);
});

test("13.5: a transport loss with confirmed exit holds the waiting parent once; explicit release keeps AND waits blocked and delivers the unknown outcome with results intact", () => {
	const { runtime, teamId, parent, a, b, childA, childB } = parentWaitingForTwo();
	assert.equal(runtime.inputReady(childB.binding, childB.scope.activationId, childB.deliveryId).ok, true);
	assert.equal(runtime.activationLost(childB.binding, childB.scope.activationId,
		{ code: "PROTOCOL_FAILURE", message: "w3 transport lost; tools may have run", outcomeUnknown: true }, true).ok, true);
	const held = runtime.getWork(teamId, parent)!.current;
	assert.equal(held.state, "blocked");
	assert.equal(held.hold?.reason, "attention");
	const incident = runtime.getTeam(teamId).incidents.find((item) => item.id === held.hold!.incidentId)!;
	assert.equal(incident.code, "DEPENDENCY_UNAVAILABLE");
	assert.deepEqual(incident.work, parent);
	const incidentsBefore = runtime.getTeam(teamId).incidents.length;

	// Unrelated transitions, a status read and further scheduling never duplicate the incident or run the parent.
	managerStep(runtime, teamId, [{ action: "status", view: "incident" }]);
	assert.equal(runtime.getTeam(teamId).incidents.filter((item) => item.code === "DEPENDENCY_UNAVAILABLE").length, 1);
	assert.equal(runtime.getTeam(teamId).incidents.length, incidentsBefore);
	assert.equal(runtime.getWork(teamId, parent)!.current.hold?.incidentId, incident.id);

	// Release while A is still running: the hold clears but the AND wait stays blocked (no automatic queueing).
	const release = runtime.releaseHold(teamId, parent, incident.id, "B's side effects were inspected; continue with A");
	assert.equal(release.status, "applied");
	const released = runtime.getWork(teamId, parent)!.current;
	assert.deepEqual([released.state, released.hold], ["blocked", undefined]);
	assert.equal(runtime.getWork(teamId, b)!.current.error?.outcomeUnknown, true, "the dependency's outcomeUnknown evidence is never cleared");
	assert.equal(runtime.getWork(teamId, b)!.current.state, "failed", "the unknown dependency is never promoted to success");

	assert.equal(runtime.inputReady(childA.binding, childA.scope.activationId, childA.deliveryId).ok, true);
	assert.equal(call(runtime, childA, 1, "a-reply", { action: "reply", result: { status: "succeeded", summary: "A result" } }).ok, true);
	settleClean(runtime, childA, "a-reply");
	const resumed = takeWork(runtime, teamId)!;
	assert.deepEqual(resumed.scope.work, parent);
	assert.equal(runtime.inputReady(resumed.binding, resumed.scope.activationId, resumed.deliveryId).ok, true);
	assert.equal(resumed.input.scope.kind === "work" && resumed.input.scope.resumeInstruction, "B's side effects were inspected; continue with A");
	const outcomes = new Map(resumed.input.outcomes.map((outcome) => [`${outcome.work.workId}@${outcome.work.revision}`, outcome]));
	assert.equal(outcomes.get(refKey(b))?.error?.outcomeUnknown, true, "the acknowledged unknown outcome is delivered as unknown");
	const aResult = outcomes.get(refKey(a))?.resultRef;
	assert.ok(aResult && runtime.getResult(teamId, aResult)?.result.summary === "A result", "the other dependency's resultRef is preserved");
	assert.equal(call(runtime, resumed, 1, "parent-reply", { action: "reply", result: { status: "partial", summary: "A used; B outcome unknown", limitations: ["B side effects unverified"] } }).ok, true);
	settleClean(runtime, resumed, "parent-reply");
	assert.equal(runtime.getWork(teamId, parent)!.current.state, "resolved");
	assert.equal(runtime.getTeam(teamId).incidents.find((item) => item.id === incident.id)?.state, "resolved");
	runtime.assertInvariants(teamId);
});

test("13.5: an unknown exit keeps cleanup pending, so the dependency hold cannot be released until the exit is confirmed", () => {
	const { runtime, teamId, parent, b, childB } = parentWaitingForTwo();
	assert.equal(runtime.activationLost(childB.binding, childB.scope.activationId,
		{ code: "PROTOCOL_FAILURE", message: "w3 exit unknown", outcomeUnknown: true }, false).ok, true);
	const held = runtime.getWork(teamId, parent)!.current;
	assert.equal(held.hold?.reason, "attention");
	const before = canonicalJson({ team: runtime.getTeam(teamId), works: runtime.listWorks(teamId) });
	assert.throws(() => runtime.releaseHold(teamId, parent, held.hold!.incidentId, "continue"), (error: { code?: string }) => error.code === "CLEANUP_FAILED");
	assert.equal(canonicalJson({ team: runtime.getTeam(teamId), works: runtime.listWorks(teamId) }), before, "the refused release changes nothing");
	const manager = start(runtime, teamId);
	const resume = call(runtime, manager, 1, "resume", { action: "control", command: "resume_work", workId: parent.workId, expectedRevision: 1, incidentId: held.hold!.incidentId, instruction: "continue" });
	assert.equal(!resume.ok && resume.error.code, "CLEANUP_FAILED");
	assert.equal(call(runtime, manager, 2, "m-yield", { action: "yield" }).ok, true);
	settleClean(runtime, manager, "m-yield");
	const after = runtime.getWork(teamId, parent)!.current;
	assert.deepEqual([after.state, after.hold?.incidentId], ["blocked", held.hold!.incidentId]);
	assert.equal(takeWork(runtime, teamId), undefined, "the held parent is never scheduled; only child A (already running) remains active");

	assert.equal(runtime.memberExitConfirmed(runtime.bindingForDriver(teamId, "w3")).ok, true);
	assert.equal(runtime.getWork(teamId, b)!.current.error?.outcomeUnknown, true, "a confirmed exit does not make the business outcome known");
	assert.equal(runtime.getWork(teamId, parent)!.current.hold?.incidentId, held.hold!.incidentId, "a confirmed exit alone never resumes the consumer");
	assert.equal(runtime.releaseHold(teamId, parent, held.hold!.incidentId, "exit confirmed; continue").status, "applied");
	runtime.assertInvariants(teamId);
});

test("13.5: releasing an unrelated protocol hold does not acknowledge an unknown child; the parent is held again for that decision", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = start(runtime, teamId);
	const child = call(runtime, parent, 1, "child", { action: "request", to: "w2", task: "child" });
	assert.ok(child.ok && child.receipt?.status === "accepted");
	const running = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(running.scope.work, child.receipt.work);
	assert.equal(runtime.activationLost(running.binding, running.scope.activationId, { code: "PROTOCOL_FAILURE", message: "child lost", outcomeUnknown: true }, true).ok, true);
	// The still-running parent ends naturally without a reply: an ordinary protocol hold.
	assert.equal(runtime.nativeSettled(parent.binding, parent.scope.activationId, { status: "success", finalAssistantText: "I think the child is done." }).ok, true);
	assert.equal(runtime.cleanupFinished(parent.binding, parent.scope.activationId, { ok: true }).ok, true);
	const protocolHold = runtime.getWork(teamId, parent.scope.work!)!.current.hold!;
	assert.equal(runtime.getTeam(teamId).incidents.find((item) => item.id === protocolHold.incidentId)?.code, "PROTOCOL_FAILURE");
	assert.equal(runtime.releaseHold(teamId, parent.scope.work!, protocolHold.incidentId, "reply properly").status, "applied");
	const dependencyHold = runtime.getWork(teamId, parent.scope.work!)!.current.hold!;
	assert.equal(dependencyHold.reason, "attention");
	assert.equal(runtime.getTeam(teamId).incidents.find((item) => item.id === dependencyHold.incidentId)?.code, "DEPENDENCY_UNAVAILABLE");
	assert.equal(takeWork(runtime, teamId), undefined, "the parent is not scheduled on the unacknowledged unknown child");
	assert.equal(runtime.releaseHold(teamId, parent.scope.work!, dependencyHold.incidentId, "child side effects checked").status, "applied");
	const resumed = takeWork(runtime, teamId)!;
	assert.deepEqual(resumed.scope.work, parent.scope.work);
	assert.equal(resumed.input.outcomes[0]?.error?.outcomeUnknown, true);
	runtime.assertInvariants(teamId);
});

test("13.3: a normal cancel_work whose native cleanup is confirmed stays a known, automatically deliverable outcome", () => {
	const { runtime, teamId, parent, b, childA, childB } = parentWaitingForTwo();
	for (const child of [childA, childB]) assert.equal(runtime.inputReady(child.binding, child.scope.activationId, child.deliveryId).ok, true);
	assert.equal(runtime.messageManager(teamId, "Cancel child B").status, "applied");
	const [cancel] = managerStep(runtime, teamId, [{ action: "control", command: "cancel_work", workId: b.workId, expectedRevision: 1, reason: "no longer needed" }]);
	assert.equal(cancel?.ok, true);
	assert.equal(runtime.nativeSettled(childB.binding, childB.scope.activationId, { status: "aborted" }).ok, true);
	assert.equal(runtime.cleanupFinished(childB.binding, childB.scope.activationId, { ok: true }).ok, true);
	assert.equal(runtime.getWork(teamId, b)!.current.error?.outcomeUnknown, undefined);
	assert.equal(call(runtime, childA, 1, "a-reply", { action: "reply", result: { status: "succeeded", summary: "A" } }).ok, true);
	settleClean(runtime, childA, "a-reply");
	assert.equal(runtime.listHolds(teamId).length, 0, "a cleaned cancellation is not escalated to a permanent hold");
	assert.deepEqual(takeWork(runtime, teamId)?.scope.work, parent);
	runtime.assertInvariants(teamId);
});

type Latch = "reserved" | "input_ready" | "staged" | "settled";
const LATCHES: readonly Latch[] = ["reserved", "input_ready", "staged", "settled"];

/** Drive one activation to a latch; the returned function finishes it from there. */
function toLatch(runtime: TeamRuntime, activation: RuntimeActivation, latch: Latch, intent: Record<string, unknown>, callId: string): () => void {
	const steps = [
		() => assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true),
		() => assert.equal(call(runtime, activation, 1, callId, intent).ok, true),
		() => assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: callId }).ok, true),
		() => assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true),
	];
	const reached = LATCHES.indexOf(latch);
	for (const step of steps.slice(0, reached)) step();
	return () => { for (const step of steps.slice(reached)) step(); };
}

test("X01/L03: close_member at every activation latch of its target is blocked until cleanup; after closing, a request is refused without work", () => {
	for (const latch of LATCHES) {
		const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "only work" }]);
		const manager = start(runtime, teamId);
		const worker = runtime.takeNextActivation(teamId)!;
		assert.equal(worker.binding.memberId, "w1");
		const finish = toLatch(runtime, worker, latch, { action: "reply", result: { status: "succeeded", summary: `done at ${latch}` } }, `reply-${latch}`);
		const blocked = call(runtime, manager, 1, `close-${latch}`, { action: "control", command: "close_member", memberId: "w1" });
		assert.equal(blocked.ok, false, `close must be blocked at ${latch}`);
		assert.equal(!blocked.ok && blocked.error.code, "CLOSE_BLOCKED");
		assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")!.lifecycle, "open");
		runtime.assertInvariants(teamId);
		finish();
		const work = runtime.getWork(teamId, worker.scope.work!)!;
		assert.equal(work.current.state, "resolved", `the reply staged at ${latch} commits after cleanup`);
		const closing = call(runtime, manager, 2, `close-after-${latch}`, { action: "control", command: "close_member", memberId: "w1" });
		assert.ok(closing.ok && closing.receipt?.status === "closing", JSON.stringify(closing));
		const worksBefore = runtime.listWorks(teamId).length;
		const refused = call(runtime, manager, 3, `late-request-${latch}`, { action: "request", to: "w1", task: "after close" });
		assert.equal(!refused.ok && refused.error.code, "RECIPIENT_CLOSING");
		assert.equal(runtime.listWorks(teamId).length, worksBefore, "a refused request allocates no work");
		assert.equal(runtime.getResult(teamId, work.current.resultRef!)?.author, "w1", "the closing author's result stays readable");
		runtime.assertInvariants(teamId);
	}
});

test("X07: a Manager event arriving at any latch of a management activation joins the next sealed batch exactly once", () => {
	for (const latch of LATCHES) {
		const { runtime, teamId } = runtimeFor(["w1"], []);
		const boot = runtime.takeNextActivation(teamId)!;
		assert.equal(boot.scope.kind, "management");
		const sealed = boot.input.scope.kind === "management" ? boot.input.scope.events.map((event) => event.id) : [];
		const finish = toLatch(runtime, boot, latch, { action: "yield" }, `boot-${latch}`);
		const receipt = runtime.messageManager(teamId, `arrived at ${latch}`);
		assert.equal(receipt.status, "applied");
		assert.equal(runtime.takeNextActivation(teamId), undefined, "no second Manager activation while one is in flight");
		finish();
		const next = runtime.takeNextActivation(teamId)!;
		assert.equal(next.scope.kind, "management");
		const events = next.input.scope.kind === "management" ? next.input.scope.events : [];
		assert.deepEqual(events.filter((event) => event.kind !== "TEAM_QUIESCENT").map((event) => event.kind), ["USER_COMMAND"],
			`the new event, not the sealed BOOT batch, forms the next batch (${latch})`);
		assert.equal(events.some((event) => sealed.includes(event.id)), false, "the sealed batch is never redelivered");
		assert.equal(events[0]?.actor, "@host");
		toLatch(runtime, next, "reserved", { action: "yield" }, `next-${latch}`)();
		assert.equal(runtime.messageManager(teamId, `arrived at ${latch}`).status, "unchanged", "a repeated host message is deduplicated");
		assert.equal(runtime.takeNextActivation(teamId), undefined, "a processed event never wakes the Manager again");
		runtime.assertInvariants(teamId);
	}
});

// ---- Acceptance-matrix gaps (spec 24) that need explicit deterministic assertions ----

const snapshot = (runtime: TeamRuntime, teamId: string) => canonicalJson({ team: runtime.getTeam(teamId), works: runtime.listWorks(teamId) });
const errorCode = (run: () => TeamReply): string => refusedAction(run);
let calls = 100;

test("P02/P07: forged identity fields and illegal combinations are refused before state changes; declared optionals accept null", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "root" }]);
	bootIdle(runtime, teamId);
	const worker = start(runtime, teamId);
	const before = snapshot(runtime, teamId);
	for (const forged of [
		{ action: "request", to: "w2", task: "t", from: "lead" },
		{ action: "request", to: "w2", task: "t", requester: "lead" },
		{ action: "request", to: "w2", task: "t", rootId: "other-root" },
		{ action: "request", to: "w2", task: "t", role: "manager" },
		{ action: "reply", result: { status: "succeeded", summary: "x" }, work: worker.scope.work },
		{ action: "yield", waitingFor: [worker.scope.work], attention: "both", checkpoint: "c" },
		{ action: "yield", waitingFor: [worker.scope.work] },
		{ action: "status", view: "team", limit: 51 },
		{ action: "request", to: "w2", task: "t", surprise: "real value" },
	]) {
		const code = errorCode(() => call(runtime, worker, 1, `forged-${JSON.stringify(forged)}`, forged));
		assert.ok(["INVALID_ARGUMENT", "PROTOCOL_FAILURE", "THROWN"].includes(code), `${JSON.stringify(forged)} -> ${code}`);
		assert.equal(snapshot(runtime, teamId), before, `${JSON.stringify(forged)} changed state`);
	}
	assert.equal(errorCode(() => call(runtime, worker, 2, "worker-control", { action: "control", command: "pause_member", memberId: "w2" })), "FORBIDDEN_ACTION");
	assert.equal(errorCode(() => call(runtime, worker, 3, "self", { action: "request", to: "w1", task: "self" })), "SELF_REQUEST");
	assert.equal(errorCode(() => call(runtime, worker, 4, "unknown", { action: "request", to: "nobody", task: "x" })), "UNKNOWN_MEMBER");
	const forgedRole = { ...worker.binding, role: "manager" as const };
	assert.ok(errorCode(() => runtime.handleAction(forgedRole, worker.scope, 5, "forged-role", { action: "control", command: "pause_member", memberId: "w2" }, "forged-role")));
	const staleEpoch = { ...worker.binding, epoch: "not-the-lifetime-epoch" };
	assert.ok(errorCode(() => runtime.handleAction(staleEpoch, worker.scope, 5, "stale-epoch", { action: "request", to: "w2", task: "t" }, "stale-epoch")));
	assert.equal(snapshot(runtime, teamId), before, "forged role/epoch frames never mutate the Team");
	const nullable = call(runtime, worker, 6, "null-optional", { action: "request", to: "w2", task: "declared optional null", inputRefs: null });
	assert.ok(nullable.ok && nullable.receipt?.status === "accepted", JSON.stringify(nullable));
	const child = runtime.getWork(teamId, nullable.receipt.work)!;
	assert.deepEqual([child.requester, child.parent, child.rootId, child.depth], ["w1", worker.scope.work, runtime.getWork(teamId, worker.scope.work!)!.rootId, 1],
		"requester, parent, root and depth come from the binding, never from model fields");
	runtime.assertInvariants(teamId);
});

test("P09: two Teams with the same aliases cannot reference each other's work or results; the other Team is unchanged", () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `x${++ids}` });
	const plan = (goal: string) => ({ manager: { alias: "lead", roleDescription: "Manage." }, workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal }, initialRequests: [{ to: "w1", task: goal }], timeoutSeconds: null });
	const a = runtime.prepare(plan("Team A")).teamId;
	const b = runtime.prepare(plan("Team B")).teamId;
	runtime.launch(a);
	runtime.launch(b);
	bootIdle(runtime, a);
	const aWork = start(runtime, a);
	assert.equal(call(runtime, aWork, 1, "a-reply", { action: "reply", result: { status: "succeeded", summary: "A result" } }).ok, true);
	settleClean(runtime, aWork, "a-reply");
	const aResult = runtime.getWork(a, aWork.scope.work!)!.current.resultRef!;
	const aBefore = snapshot(runtime, a);
	bootIdle(runtime, b);
	const bWork = start(runtime, b);
	const bBefore = snapshot(runtime, b);
	assert.equal(errorCode(() => call(runtime, bWork, 1, "cross-wait", { action: "yield", waitingFor: [aWork.scope.work], checkpoint: "cross" })), "UNKNOWN_WORK");
	assert.equal(errorCode(() => call(runtime, bWork, 2, "cross-input", { action: "request", to: "lead", task: "use A", inputRefs: [aResult] })), "UNKNOWN_RESULT");
	assert.equal(errorCode(() => call(runtime, bWork, 3, "cross-read", { action: "status", view: "result", id: aResult })), "UNKNOWN_RESULT");
	const crossBinding = { ...bWork.binding, teamId: a };
	assert.ok(errorCode(() => runtime.handleAction(crossBinding, bWork.scope, 4, "cross-binding", { action: "request", to: "lead", task: "x" }, "cross-binding")));
	assert.equal(snapshot(runtime, b), bBefore);
	assert.equal(snapshot(runtime, a), aBefore, "Team A is completely unchanged by Team B's attempts");
	runtime.assertInvariants(a);
	runtime.assertInvariants(b);
});

test("W08/W09: failed, cancelled and superseded children are each delivered to the parent; unresolved children block reply with exact blockers", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2", "w3"], [{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = start(runtime, teamId);
	const refs = ["fail", "cancel", "supersede"].map((name, index) => {
		const accepted = call(runtime, parent, index + 1, `child-${name}`, { action: "request", to: name === "fail" ? "w2" : "w3", task: `child ${name}` });
		assert.ok(accepted.ok && accepted.receipt?.status === "accepted");
		return accepted.receipt.work;
	});
	const early = call(runtime, parent, 4, "early", { action: "reply", result: { status: "succeeded", summary: "too early" } });
	assert.equal(!early.ok && early.error.code, "UNRESOLVED_CHILDREN");
	assert.deepEqual(!early.ok && early.error.blockers?.map((blocker) => blocker.id).sort(), refs.map(refKey).sort());
	assert.equal(call(runtime, parent, 5, "wait", { action: "yield", waitingFor: refs, checkpoint: "collect" }).ok, true);
	settleClean(runtime, parent, "wait");
	const failing = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(failing.scope.work, refs[0]);
	assert.equal(runtime.inputReady(failing.binding, failing.scope.activationId, failing.deliveryId).ok, true);
	assert.equal(runtime.nativeSettled(failing.binding, failing.scope.activationId, { status: "error", error: { code: "PROVIDER_ERROR", message: "provider failed" } }).ok, true);
	assert.equal(runtime.cleanupFinished(failing.binding, failing.scope.activationId, { ok: true }).ok, true);
	const [cancelled, revised] = managerStep(runtime, teamId, [
		{ action: "control", command: "cancel_work", workId: refs[1]!.workId, expectedRevision: 1, reason: "not needed" },
		{ action: "control", command: "revise_work", workId: refs[2]!.workId, expectedRevision: 1, task: "child supersede, revised" },
	]);
	assert.equal(cancelled?.ok, true);
	assert.equal(revised?.ok, true);
	// The revised child now has a queued revision 2 on w3; the parent is woken by the three terminal outcomes of the refs it waited for.
	let resumed = takeWork(runtime, teamId)!;
	while (resumed.binding.memberId !== "w1") {
		assert.equal(runtime.inputReady(resumed.binding, resumed.scope.activationId, resumed.deliveryId).ok, true);
		assert.equal(call(runtime, resumed, 1, `other-${resumed.scope.activationId}`, { action: "reply", result: { status: "succeeded", summary: "revision 2" } }).ok, true);
		settleClean(runtime, resumed, `other-${resumed.scope.activationId}`);
		resumed = takeWork(runtime, teamId)!;
	}
	const states = new Map(resumed.input.outcomes.map((outcome) => [refKey(outcome.work), outcome.state]));
	assert.equal(states.get(refKey(refs[0]!)), "failed");
	assert.equal(states.get(refKey(refs[1]!)), "cancelled");
	assert.equal(states.get(refKey(refs[2]!)), "superseded", "the parent's fixed WorkRef gets superseded, never the new revision's result");
	runtime.assertInvariants(teamId);
});

test("W10: a child of a terminal parent cannot be revised into a new obligation; state is unchanged", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = start(runtime, teamId);
	const child = call(runtime, parent, 1, "child", { action: "request", to: "w2", task: "child" });
	assert.ok(child.ok && child.receipt?.status === "accepted");
	assert.equal(call(runtime, parent, 2, "wait", { action: "yield", waitingFor: [child.receipt.work], checkpoint: "c" }).ok, true);
	settleClean(runtime, parent, "wait");
	const running = takeWork(runtime, teamId)!;
	assert.equal(runtime.inputReady(running.binding, running.scope.activationId, running.deliveryId).ok, true);
	assert.equal(call(runtime, running, 1, "child-reply", { action: "reply", result: { status: "succeeded", summary: "child" } }).ok, true);
	settleClean(runtime, running, "child-reply");
	const again = takeWork(runtime, teamId)!;
	assert.equal(runtime.inputReady(again.binding, again.scope.activationId, again.deliveryId).ok, true);
	assert.equal(call(runtime, again, 1, "parent-reply", { action: "reply", result: { status: "succeeded", summary: "parent" } }).ok, true);
	settleClean(runtime, again, "parent-reply");
	const before = snapshot(runtime, teamId);
	const [revise] = managerStep(runtime, teamId, [{ action: "control", command: "revise_work", workId: child.receipt.work.workId, expectedRevision: 1, task: "resurrect" }]);
	assert.equal(!revise!.ok && revise!.error.code, "INVALID_ARGUMENT");
	assert.match(!revise!.ok ? revise!.error.message : "", /independent work/u);
	assert.deepEqual(JSON.parse(snapshot(runtime, teamId)).works, JSON.parse(before).works, "no work or revision was created");
	runtime.assertInvariants(teamId);
});

test("A04/A07: after a staged intent new business is ACTIVATION_ENDING; an empty last answer never falls back to earlier text", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "a" }, { to: "w2", task: "b" }]);
	bootIdle(runtime, teamId);
	const first = start(runtime, teamId);
	assert.equal(call(runtime, first, 1, "staged", { action: "reply", result: { status: "succeeded", summary: "staged" } }).ok, true);
	const before = snapshot(runtime, teamId);
	for (const [id, args] of [["after", { action: "request", to: "w2", task: "late side effect" }],
		["second-intent", { action: "reply", result: { status: "failed", summary: "conflict" } }]] as const) {
		assert.ok(["ACTIVATION_ENDING", "INTENT_CONFLICT"].includes(errorCode(() => call(runtime, first, calls++, id, args))), id);
	}
	assert.equal(snapshot(runtime, teamId), before);
	settleClean(runtime, first, "staged");
	const second = takeWork(runtime, teamId)!;
	assert.equal(runtime.inputReady(second.binding, second.scope.activationId, second.deliveryId).ok, true);
	// The last native assistant message is empty (an earlier turn had text): no natural_final result.
	assert.equal(runtime.nativeSettled(second.binding, second.scope.activationId, { status: "success", finalAssistantText: "" }).ok, true);
	assert.equal(runtime.cleanupFinished(second.binding, second.scope.activationId, { ok: true }).ok, true);
	const work = runtime.getWork(teamId, second.scope.work!)!.current;
	assert.deepEqual([work.state, work.hold?.reason, work.resultRef], ["blocked", "protocol", undefined]);
	runtime.assertInvariants(teamId);
});

test("D04/D05/D06: requests arriving during settling or after idle wake once; a full recipient queue refuses new work but a staged reply still settles", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "r1" }], { memberUnresolvedWork: 2 });
	const manager = start(runtime, teamId);
	const r1 = runtime.takeNextActivation(teamId)!;
	assert.equal(runtime.inputReady(r1.binding, r1.scope.activationId, r1.deliveryId).ok, true);
	assert.equal(call(runtime, r1, 1, "r1-reply", { action: "reply", result: { status: "succeeded", summary: "r1" } }).ok, true);
	assert.equal(runtime.nativeSettled(r1.binding, r1.scope.activationId, { status: "success", appliedToolCallId: "r1-reply" }).ok, true);
	// R2 arrives while R1 is settling; the queue for w1 is now full (R1 unresolved + R2).
	const r2 = call(runtime, manager, 1, "r2", { action: "request", to: "w1", task: "r2" });
	assert.ok(r2.ok && r2.receipt?.status === "accepted");
	const full = snapshot(runtime, teamId);
	assert.equal(errorCode(() => call(runtime, manager, 2, "r3", { action: "request", to: "w1", task: "r3" })), "REQUEST_QUEUE_FULL");
	assert.equal(snapshot(runtime, teamId), full, "the refused request allocates nothing");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "R2 never starts beside the settling R1");
	assert.deepEqual(r1.scope.work, runtime.getTeam(teamId).members.find((member) => member.id === "w1")!.currentWork, "R1 stays the current work");
	assert.equal(runtime.cleanupFinished(r1.binding, r1.scope.activationId, { ok: true }).ok, true);
	assert.equal(runtime.getWork(teamId, r1.scope.work!)!.current.state, "resolved", "the staged reply settles despite the full queue");
	const next = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(next.scope.work, r2.receipt.work);
	assert.equal(runtime.takeNextActivation(teamId), undefined, "exactly one activation for R2");
	assert.equal(runtime.inputReady(next.binding, next.scope.activationId, next.deliveryId).ok, true);
	assert.equal(call(runtime, next, 1, "r2-reply", { action: "reply", result: { status: "succeeded", summary: "r2" } }).ok, true);
	settleClean(runtime, next, "r2-reply");
	// After idle, a new arrival wakes w1 once.
	const r4 = call(runtime, manager, 3, "r4", { action: "request", to: "w1", task: "r4" });
	assert.ok(r4.ok && r4.receipt?.status === "accepted");
	const woken = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(woken.scope.work, r4.receipt.work);
	assert.equal(runtime.takeNextActivation(teamId), undefined);
	runtime.assertInvariants(teamId);
});

test("U04/U05: waiting and hold changes advance stateVersion while activity stays idle; reads do not; status pages are bounded with stable cursors", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = start(runtime, teamId);
	const children = Array.from({ length: 7 }, (_value, index) => {
		const accepted = call(runtime, parent, index + 1, `c${index}`, { action: "request", to: "w2", task: `child ${index}` });
		assert.ok(accepted.ok && accepted.receipt?.status === "accepted");
		return accepted.receipt.work;
	});
	assert.equal(call(runtime, parent, 8, "wait", { action: "yield", waitingFor: children, checkpoint: "wait" }).ok, true);
	settleClean(runtime, parent, "wait");
	const idleVersion = runtime.getTeam(teamId).stateVersion;
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")!.activity, "idle");
	assert.equal(runtime.getWork(teamId, parent.scope.work!)!.current.waitingFor.length, 7, "the public view exposes the wait");
	const big = `${"界".repeat(1500)}TAIL`;
	for (let index = 0; index < 7; index++) {
		const child = takeWork(runtime, teamId)!;
		assert.equal(runtime.inputReady(child.binding, child.scope.activationId, child.deliveryId).ok, true);
		assert.equal(call(runtime, child, 1, `r${index}`, { action: "reply", result: { status: "succeeded", summary: `${index}${big}`, artifacts: [`artifact-${index}`] } }).ok, true);
		settleClean(runtime, child, `r${index}`);
	}
	assert.ok(runtime.getTeam(teamId).stateVersion > idleVersion, "the waiter's state change is visible while w1 stayed idle");
	const manager = start(runtime, teamId);
	const readVersion = runtime.getTeam(teamId).stateVersion;
	const pages: string[] = [];
	let cursor: string | undefined;
	for (let sequence = 1; ; sequence++) {
		const page = call(runtime, manager, sequence, `page-${sequence}`, { action: "status", view: "result", limit: 3, ...(cursor ? { cursor } : {}) });
		assert.ok(page.ok, JSON.stringify(page));
		const data = page.data as { items: Array<{ id: string; summaryPreview: string }>; cursor?: string; hasMore: boolean };
		assert.ok(data.items.length <= 3);
		for (const item of data.items) {
			assert.ok(!item.summaryPreview.endsWith("TAIL"), "list items carry a bounded preview, never the full result");
			pages.push(item.id);
		}
		if (!data.hasMore) break;
		cursor = data.cursor;
	}
	assert.equal(pages.length, 7);
	assert.equal(new Set(pages).size, 7, "cursor pages are stable and non-overlapping");
	const full = call(runtime, manager, 20, "full", { action: "status", view: "result", id: pages[0] });
	assert.ok(full.ok && (full.data as { result: { summary: string } }).result.summary.endsWith("TAIL"), "the full result is readable by resultRef");
	assert.equal(runtime.getTeam(teamId).stateVersion, readVersion, "status reads never advance stateVersion");
	runtime.assertInvariants(teamId);
});

test("L04/L06/L07/L08: outgoing obligations block close_member, the Manager cannot close itself, close_team linearizes against requests, and succeeded needs accepted succeeded roots", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "root" }]);
	bootIdle(runtime, teamId);
	const root = start(runtime, teamId);
	const child = call(runtime, root, 1, "outgoing", { action: "request", to: "w2", task: "outgoing child" });
	assert.ok(child.ok && child.receipt?.status === "accepted");
	assert.equal(call(runtime, root, 2, "wait", { action: "yield", waitingFor: [child.receipt.work], checkpoint: "c" }).ok, true);
	settleClean(runtime, root, "wait");
	assert.equal(runtime.messageManager(teamId, "try closing").status, "applied");
	const manager = start(runtime, teamId);
	const w1Close = call(runtime, manager, 1, "close-w1", { action: "control", command: "close_member", memberId: "w1" });
	assert.equal(!w1Close.ok && w1Close.error.code, "CLOSE_BLOCKED", "w1 still owns work and awaits its outgoing child");
	assert.equal(errorCode(() => call(runtime, manager, 2, "close-self", { action: "control", command: "close_member", memberId: "lead" })), "FORBIDDEN_ACTION");
	const blockedTeam = call(runtime, manager, 3, "close-team-early", { action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "early" });
	assert.equal(!blockedTeam.ok && blockedTeam.error.code, "CLOSE_BLOCKED", "accepted unresolved requests block close_team");
	assert.equal(runtime.getTeam(teamId).lifecycle, "active");
	assert.equal(call(runtime, manager, 4, "m-yield", { action: "yield" }).ok, true);
	settleClean(runtime, manager, "m-yield");
	for (let index = 0; index < 2; index++) {
		const next = takeWork(runtime, teamId)!;
		assert.equal(runtime.inputReady(next.binding, next.scope.activationId, next.deliveryId).ok, true);
		const status = next.binding.memberId === "w1" ? "partial" : "succeeded";
		assert.equal(call(runtime, next, 1, `done-${index}`, { action: "reply", result: { status, summary: `${status} work` } }).ok, true);
		settleClean(runtime, next, `done-${index}`);
	}
	const rootWork = runtime.getWork(teamId, root.scope.work!)!.current;
	const final = start(runtime, teamId);
	assert.equal(errorCode(() => call(runtime, final, 1, "accept-partial", { action: "control", command: "accept_result", work: root.scope.work, disposition: "accepted" })), "INVALID_TEAM_OUTCOME");
	const unaccepted = call(runtime, final, 2, "close-succeeded", { action: "control", command: "close_team", resultRefs: [rootWork.resultRef], outcome: "succeeded" });
	assert.equal(unaccepted.ok, false, "succeeded close is refused while the root is unreviewed/partial");
	assert.equal(call(runtime, final, 3, "waive", { action: "control", command: "accept_result", work: root.scope.work, disposition: "waived", reason: "partial is acceptable" }).ok, true);
	assert.equal(errorCode(() => call(runtime, final, 4, "close-succeeded-2", { action: "control", command: "close_team", resultRefs: [rootWork.resultRef], outcome: "succeeded" })), "INVALID_TEAM_OUTCOME");
	const closing = call(runtime, final, 5, "close-partial", { action: "control", command: "close_team", resultRefs: [rootWork.resultRef], outcome: "partial", reason: "root waived as partial" });
	assert.ok(closing.ok && closing.receipt?.status === "closing");
	const worksBefore = runtime.listWorks(teamId).length;
	assert.ok(["ACTIVATION_ENDING", "INTENT_CONFLICT"].includes(errorCode(() => call(runtime, final, 6, "after-close", { action: "request", to: "w2", task: "after close" }))));
	assert.throws(() => runtime.messageManager(teamId, "after close"), /current lifecycle/u, "no new Manager work after the close decision");
	assert.equal(runtime.listWorks(teamId).length, worksBefore, "no work is accepted after the linearized close_team");
	runtime.assertInvariants(teamId);
});

test("G02/G03/G04: duplicate result/incident facts raise one Manager event; status, no-op controls and an inactive Manager yield create no new activation", () => {
	const { runtime, teamId } = runtimeFor(["w1"], [{ to: "w1", task: "root" }]);
	bootIdle(runtime, teamId);
	const worker = start(runtime, teamId);
	assert.equal(call(runtime, worker, 1, "reply", { action: "reply", result: { status: "succeeded", summary: "r" } }).ok, true);
	settleClean(runtime, worker, "reply");
	// Late duplicate evidence of the same commit is idempotent and cannot produce a second ROOT_RESULT_READY.
	assert.equal(runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true }).ok, true);
	const manager = start(runtime, teamId);
	const events = manager.input.scope.kind === "management" ? manager.input.scope.events : [];
	assert.equal(events.filter((event) => event.kind === "ROOT_RESULT_READY").length, 1);
	const noops = [
		{ action: "status", view: "team" },
		{ action: "status", view: "work" },
		{ action: "control", command: "resume_member", memberId: "w1" },
	];
	noops.forEach((args, index) => {
		const reply = call(runtime, manager, index + 1, `noop-${index}`, args);
		assert.equal(reply.ok, true, JSON.stringify(reply));
	});
	assert.equal(call(runtime, manager, 9, "idle", { action: "yield" }).ok, true);
	settleClean(runtime, manager, "idle");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "the handled batch is not requeued and no-op actions made no new event");
	assert.equal(runtime.liveEffects(teamId).unprocessedManagerEvents, 0);
	assert.equal(runtime.getTeam(teamId).lifecycle, "active", "an idle, unclosed Team stays active without polling or failure");
	runtime.assertInvariants(teamId);
});

test("A05: a staged worker reply followed by a native error is never published as a clean result and isolates only that member", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "root" }, { to: "w2", task: "unrelated" }]);
	bootIdle(runtime, teamId);
	const worker = start(runtime, teamId);
	assert.equal(call(runtime, worker, 1, "staged", { action: "reply", result: { status: "succeeded", summary: "looks done" } }).ok, true);
	assert.equal(runtime.nativeSettled(worker.binding, worker.scope.activationId, { status: "error", appliedToolCallId: "staged",
		error: { code: "PROVIDER_ERROR", message: "stream failed after the tool result" } }).ok, true);
	assert.equal(runtime.cleanupFinished(worker.binding, worker.scope.activationId, { ok: true }).ok, true);
	const work = runtime.getWork(teamId, worker.scope.work!)!;
	assert.equal(work.current.state, "failed");
	assert.equal(work.current.resultRef, undefined, "no ResultRecord was committed");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")!.lifecycle, "faulted");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w2")!.lifecycle, "open", "only the failing member is isolated");
	runtime.assertInvariants(teamId);
});

test("19.1: the Team status text shows lifecycle, health, member activity/pause, current WorkRef and task, queue/hold counts, policy, incidents and budget", async () => {
	const { formatTeamView } = await import("../../tools/subagents/team-tool");
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "Review the protocol codec" }, { to: "w2", task: "second" }]);
	bootIdle(runtime, teamId);
	const running = start(runtime, teamId);
	const other = takeWork(runtime, teamId)!;
	assert.equal(runtime.inputReady(other.binding, other.scope.activationId, other.deliveryId).ok, true);
	assert.equal(call(runtime, other, 1, "attention", { action: "yield", attention: "need a decision", checkpoint: "c" }).ok, true);
	settleClean(runtime, other, "attention");
	const text = formatTeamView(runtime.getTeam(teamId), runtime.listWorks(teamId)).join("\n");
	assert.match(text, /ACTIVE · needs attention 1/u);
	assert.match(text, new RegExp(`w1 +worker +· OPEN · RUNNING ${running.scope.work!.workId}@1 "Review the protocol codec" · queued 0 · blocked 0 · held 0`, "u"));
	assert.match(text, /w2 +worker +· OPEN · IDLE · queued 0 · blocked 1 · held 1/u);
	assert.match(text, /lead +manager +· OPEN/u);
	assert.match(text, /FAST off · SEARCH off/u);
	assert.match(text, /Holds: .*attention \(w2\)/u);
	assert.match(text, /Incident .*\[WORK_HELD\]|Incident .*\[ATTENTION/u);
	assert.match(text, /Budget: activations \d+\/512/u);
	assert.doesNotMatch(text, /completed|workers completed/iu, "idle is never presented as a finished Team");
});

test("W07: re-yielding on an already delivered, unchanged outcome is NO_NEW_DEPENDENCY and schedules nothing", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "parent" }]);
	bootIdle(runtime, teamId);
	const parent = start(runtime, teamId);
	const child = call(runtime, parent, 1, "child", { action: "request", to: "w2", task: "child" });
	assert.ok(child.ok && child.receipt?.status === "accepted");
	const childRef = child.receipt.work;
	assert.equal(call(runtime, parent, 2, "wait", { action: "yield", waitingFor: [childRef], checkpoint: "c" }).ok, true);
	settleClean(runtime, parent, "wait");
	const running = takeWork(runtime, teamId)!;
	assert.equal(runtime.inputReady(running.binding, running.scope.activationId, running.deliveryId).ok, true);
	assert.equal(call(runtime, running, 1, "child-reply", { action: "reply", result: { status: "succeeded", summary: "child" } }).ok, true);
	settleClean(runtime, running, "child-reply");
	const resumed = takeWork(runtime, teamId)!;
	assert.equal(runtime.inputReady(resumed.binding, resumed.scope.activationId, resumed.deliveryId).ok, true);
	assert.equal(resumed.input.outcomes.length, 1);
	const before = snapshot(runtime, teamId);
	assert.equal(errorCode(() => call(runtime, resumed, 1, "again", { action: "yield", waitingFor: [childRef], checkpoint: "again" })), "NO_NEW_DEPENDENCY");
	assert.equal(snapshot(runtime, teamId), before);
	assert.equal(call(runtime, resumed, 2, "done", { action: "reply", result: { status: "succeeded", summary: "parent" } }).ok, true);
	settleClean(runtime, resumed, "done");
	assert.equal(takeWork(runtime, teamId), undefined, "no extra activation was created by the refused yield");
	runtime.assertInvariants(teamId);
});

test("W01/W03/D01: identities come from the binding; a legal R1→R2→R3 chain back to the first member is accepted; an outcome is not delivered before input_ready", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2", "w3"], [{ to: "w1", task: "R1" }]);
	bootIdle(runtime, teamId);
	const r1 = start(runtime, teamId);
	const r1Ref = r1.scope.work!;
	assert.deepEqual((({ requester, assignee, rootId, parent, depth }) => ({ requester, assignee, rootId, parent, depth }))(runtime.getWork(teamId, r1Ref)!),
		{ requester: "lead", assignee: "w1", rootId: r1Ref.workId, parent: undefined, depth: 0 });
	const r2 = call(runtime, r1, 1, "r2", { action: "request", to: "w2", task: "R2" });
	assert.ok(r2.ok && r2.receipt?.status === "accepted");
	assert.equal(call(runtime, r1, 2, "r1-wait", { action: "yield", waitingFor: [r2.receipt.work], checkpoint: "wait R2" }).ok, true);
	settleClean(runtime, r1, "r1-wait");
	const r2Run = start(runtime, teamId);
	const r3 = call(runtime, r2Run, 1, "r3", { action: "request", to: "w3", task: "R3" });
	assert.ok(r3.ok && r3.receipt?.status === "accepted");
	assert.equal(call(runtime, r2Run, 2, "r2-wait", { action: "yield", waitingFor: [r3.receipt.work], checkpoint: "wait R3" }).ok, true);
	settleClean(runtime, r2Run, "r2-wait");
	const r3Run = start(runtime, teamId);
	// A member-level loop (w1 → w2 → w3 → w1) is legal: only work-graph cycles are refused.
	const r4 = call(runtime, r3Run, 1, "r4", { action: "request", to: "w1", task: "R4 back to w1" });
	assert.ok(r4.ok && r4.receipt?.status === "accepted", JSON.stringify(r4));
	for (const [ref, requester, assignee, parent, depth] of [
		[r2.receipt.work, "w1", "w2", r1Ref, 1], [r3.receipt.work, "w2", "w3", r2.receipt.work, 2], [r4.receipt.work, "w3", "w1", r3.receipt.work, 3],
	] as const) {
		const work = runtime.getWork(teamId, ref)!;
		assert.deepEqual({ requester: work.requester, assignee: work.assignee, rootId: work.rootId, parent: work.parent, depth: work.depth },
			{ requester, assignee, rootId: r1Ref.workId, parent, depth }, "requester/root/parent/depth are derived by the Runtime");
	}
	assert.equal(runtime.getTeam(teamId).works.total, 4);
	assert.equal(runtime.getTeam(teamId).works.roots, 1);
	assert.equal(call(runtime, r3Run, 2, "r3-wait", { action: "yield", waitingFor: [r4.receipt.work], checkpoint: "wait R4" }).ok, true);
	settleClean(runtime, r3Run, "r3-wait");
	const r4Run = start(runtime, teamId);
	assert.equal(r4Run.binding.memberId, "w1", "the parked R1 owner runs R4 in its own lifetime");
	assert.equal(call(runtime, r4Run, 1, "r4-reply", { action: "reply", result: { status: "succeeded", summary: "R4" } }).ok, true);
	settleClean(runtime, r4Run, "r4-reply");
	// D01: the outcome is reserved into R3's next input but is not delivered until input_ready.
	const resumed = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(resumed.scope.work, r3.receipt.work);
	assert.deepEqual(resumed.input.outcomes.map((outcome) => outcome.work), [r4.receipt.work]);
	const r3Before = runtime.getWork(teamId, r3.receipt.work)!.current;
	assert.deepEqual(r3Before.observedOutcomes, [], "reserved is not delivered");
	assert.deepEqual(r3Before.waitingFor, [r4.receipt.work]);
	assert.equal(runtime.gate(resumed.binding, resumed.scope, "provider_gate").allow, false);
	assert.equal(runtime.inputReady(resumed.binding, resumed.scope.activationId, resumed.deliveryId).ok, true);
	assert.deepEqual(runtime.getWork(teamId, r3.receipt.work)!.current.observedOutcomes, [r4.receipt.work]);
	assert.deepEqual(runtime.getWork(teamId, r3.receipt.work)!.current.waitingFor, []);
	runtime.assertInvariants(teamId);
});

test("P05/P06: late frames from a finished activation never touch the current work; duplicate input_ready/settle/cleanup settle once", () => {
	const { runtime, teamId } = runtimeFor(["w1"], [{ to: "w1", task: "first" }, { to: "w1", task: "second" }]);
	bootIdle(runtime, teamId);
	const first = start(runtime, teamId);
	assert.equal(call(runtime, first, 1, "first-reply", { action: "reply", result: { status: "succeeded", summary: "first" } }).ok, true);
	settleClean(runtime, first, "first-reply");
	const second = takeWork(runtime, teamId)!;
	assert.equal(second.binding.memberId, "w1");
	assert.equal(runtime.inputReady(second.binding, second.scope.activationId, second.deliveryId).ok, true);
	const once = snapshot(runtime, teamId);
	assert.equal(runtime.inputReady(second.binding, second.scope.activationId, second.deliveryId).ok, true, "a duplicate input_ready is acknowledged");
	assert.equal(snapshot(runtime, teamId), once, "a duplicate input_ready changes nothing");
	assert.equal(second.input.outcomes.length, 0);
	// Late reply/yield frames of the finished first activation, including its old scope and sequence.
	assert.equal(call(runtime, first, 2, "late-first-reply", { action: "reply", result: { status: "succeeded", summary: "late" } }).ok, false);
	// A duplicate input_ready of the just-closed, already delivered activation is re-acknowledged from its tombstone only.
	assert.equal(runtime.inputReady(first.binding, first.scope.activationId, first.deliveryId).ok, true);
	assert.throws(() => runtime.inputReady(first.binding, first.scope.activationId, second.deliveryId), (error: unknown) => (error as { code?: string }).code === "WORK_NOT_RUNNING");
	assert.equal(snapshot(runtime, teamId), once, "late frames from the old activation change nothing");
	assert.equal(runtime.getWork(teamId, second.scope.work!)!.current.state, "running");
	assert.equal(runtime.getWork(teamId, second.scope.work!)!.current.resultRef, undefined);
	assert.equal(call(runtime, second, 1, "second-reply", { action: "reply", result: { status: "succeeded", summary: "second" } }).ok, true);
	assert.equal(runtime.nativeSettled(second.binding, second.scope.activationId, { status: "success", appliedToolCallId: "second-reply" }).ok, true);
	const settledOnce = snapshot(runtime, teamId);
	runtime.nativeSettled(second.binding, second.scope.activationId, { status: "success", appliedToolCallId: "second-reply" });
	assert.equal(snapshot(runtime, teamId), settledOnce, "a duplicate agent_settled does not settle twice");
	assert.equal(runtime.cleanupFinished(second.binding, second.scope.activationId, { ok: true }).ok, true);
	const committed = snapshot(runtime, teamId);
	runtime.cleanupFinished(second.binding, second.scope.activationId, { ok: true });
	assert.equal(snapshot(runtime, teamId), committed, "a duplicate deactivate/cleanup commits nothing twice");
	assert.equal(runtime.listResultRefsPage(teamId).total, 2, "exactly one result per work");
	runtime.assertInvariants(teamId);
});

test("A08/G01: a Manager natural answer leaves the Team active with an idle Manager, no summary, no close and no polling activation", () => {
	const { runtime, teamId } = runtimeFor(["w1"], []);
	const boot = start(runtime, teamId);
	assert.equal(boot.scope.kind, "management");
	assert.equal(runtime.nativeSettled(boot.binding, boot.scope.activationId, { status: "success", finalAssistantText: "Everything looks done; here is my summary." }).ok, true);
	assert.equal(runtime.cleanupFinished(boot.binding, boot.scope.activationId, { ok: true }).ok, true);
	// At most one semantic TEAM_QUIESCENT batch for this state version; then nothing, however often the drain runs.
	const quiescent = runtime.takeNextActivation(teamId);
	if (quiescent) {
		assert.deepEqual(quiescent.input.scope.kind === "management" && quiescent.input.scope.events.map((event) => event.kind), ["TEAM_QUIESCENT"]);
		assert.equal(runtime.inputReady(quiescent.binding, quiescent.scope.activationId, quiescent.deliveryId).ok, true);
		assert.equal(runtime.nativeSettled(quiescent.binding, quiescent.scope.activationId, { status: "success", finalAssistantText: "Still nothing to do." }).ok, true);
		assert.equal(runtime.cleanupFinished(quiescent.binding, quiescent.scope.activationId, { ok: true }).ok, true);
	}
	const settled = snapshot(runtime, teamId);
	for (let index = 0; index < 3; index++) assert.equal(runtime.takeNextActivation(teamId), undefined, "no polling or self-wakeup activation");
	const team = runtime.getTeam(teamId);
	assert.equal(team.lifecycle, "active");
	assert.equal(team.outcome, undefined);
	for (const member of team.members) assert.deepEqual([member.lifecycle, member.activity], ["open", "idle"]);
	assert.equal(runtime.listResultRefsPage(teamId).total, 0, "a Manager natural answer is not a Team result or summary");
	assert.equal(runtime.getTeamResult(teamId), undefined);
	assert.equal(snapshot(runtime, teamId), settled, "reads and empty drains change nothing");
	runtime.assertInvariants(teamId);
});

test("D10/L05: after its author is closed and released, a resultRef stays readable and acceptable without waking the author", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "authored" }]);
	bootIdle(runtime, teamId);
	const worker = start(runtime, teamId);
	assert.equal(call(runtime, worker, 1, "authored", { action: "reply", result: { status: "succeeded", summary: "historical result" } }).ok, true);
	settleClean(runtime, worker, "authored");
	const manager = start(runtime, teamId);
	const closing = call(runtime, manager, 1, "close-author", { action: "control", command: "close_member", memberId: "w1" });
	assert.ok(closing.ok && closing.receipt?.status === "closing", "an author with only committed results can close");
	assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, "w1"), closing.receipt.closeId, { ok: true }).ok, true);
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")!.lifecycle, "closed");
	const work = runtime.getWork(teamId, worker.scope.work!)!;
	const record = runtime.getResult(teamId, work.current.resultRef!)!;
	assert.equal(record.author, "w1");
	assert.equal(record.result.summary, "historical result");
	const read = call(runtime, manager, 2, "read-result", { action: "status", view: "result", id: record.id });
	assert.ok(read.ok, JSON.stringify(read));
	assert.equal(call(runtime, manager, 3, "accept", { action: "control", command: "accept_result", work: worker.scope.work, disposition: "accepted" }).ok, true);
	assert.equal(call(runtime, manager, 4, "yield", { action: "yield" }).ok, true);
	settleClean(runtime, manager, "yield");
	for (let next = runtime.takeNextActivation(teamId); next; next = runtime.takeNextActivation(teamId)) {
		assert.notEqual(next.binding.memberId, "w1", "reading or accepting a closed author's result never wakes it");
		assert.equal(runtime.inputReady(next.binding, next.scope.activationId, next.deliveryId).ok, true);
		assert.equal(call(runtime, next, 1, `drain-${next.scope.activationId}`, { action: "yield" }).ok, true);
		settleClean(runtime, next, `drain-${next.scope.activationId}`);
	}
	assert.equal(runtime.getWork(teamId, worker.scope.work!)!.current.review?.disposition, "accepted");
	runtime.assertInvariants(teamId);
});

test("P08: every retired v1 action and field returns its migration error from the Runtime and changes nothing", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "work" }]);
	bootIdle(runtime, teamId);
	const worker = start(runtime, teamId);
	const before = snapshot(runtime, teamId);
	const cases: Array<[Record<string, unknown>, RegExp]> = [
		[{ action: "send", to: "w2", message: "hi" }, /message was removed|send was replaced by request/u],
		[{ action: "send", to: "w2" }, /send was replaced by request \{to, task\}/u],
		[{ action: "report", result: { status: "succeeded", summary: "x" } }, /report was replaced by reply/u],
		[{ action: "wait" }, /wait was replaced by yield \{waitingFor/u],
		[{ action: "finish" }, /finish was replaced by reply \{result\} \(worker\) or control close_team/u],
		[{ action: "request", to: "w2", task: "t", afterSeq: 3 }, /afterSeq was removed/u],
		[{ action: "control", command: "revise_work", workId: "x", expectedRevision: 1, task: "t", supersedes: "old" }, /supersedes was removed/u],
		[{ action: "reply", result: { status: "succeeded", summary: "x" }, replyTo: "m1" }, /replyTo was removed/u],
	];
	let sequence = 1;
	for (const [args, message] of cases) {
		const reply = call(runtime, worker, sequence++, `legacy-${sequence}`, args);
		assert.equal(reply.ok, false, JSON.stringify(args));
		assert.equal(!reply.ok && reply.error.code, "INVALID_ARGUMENT");
		assert.match(!reply.ok ? reply.error.message : "", message);
	}
	assert.equal(snapshot(runtime, teamId), before, "no legacy bypass reaches the ledger");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")!.lifecycle, "open", "a business error does not fault the member");
	runtime.assertInvariants(teamId);
});

test("A06: a last real answer without an intent becomes natural_final only for the current version with no unresolved children", () => {
	const { runtime, teamId } = runtimeFor(["w1", "w2"], [{ to: "w1", task: "plain" }, { to: "w2", task: "with child" }]);
	bootIdle(runtime, teamId);
	const plain = start(runtime, teamId);
	const parent = start(runtime, teamId);
	assert.deepEqual([plain.binding.memberId, parent.binding.memberId], ["w1", "w2"]);
	assert.equal(runtime.nativeSettled(plain.binding, plain.scope.activationId, { status: "success", finalAssistantText: "Plain final answer." }).ok, true);
	assert.equal(runtime.cleanupFinished(plain.binding, plain.scope.activationId, { ok: true }).ok, true);
	const plainWork = runtime.getWork(teamId, plain.scope.work!)!;
	assert.equal(plainWork.current.state, "resolved");
	const record = runtime.getResult(teamId, plainWork.current.resultRef!)!;
	assert.deepEqual([record.source, record.result.summary, record.author], ["natural_final", "Plain final answer.", "w1"]);
	const child = call(runtime, parent, 1, "child", { action: "request", to: "w1", task: "unresolved child" });
	assert.ok(child.ok && child.receipt?.status === "accepted");
	assert.equal(runtime.nativeSettled(parent.binding, parent.scope.activationId, { status: "success", finalAssistantText: "I am done anyway." }).ok, true);
	assert.equal(runtime.cleanupFinished(parent.binding, parent.scope.activationId, { ok: true }).ok, true);
	const parentWork = runtime.getWork(teamId, parent.scope.work!)!;
	assert.equal(parentWork.current.resultRef, undefined, "no natural_final while an owned child is unresolved");
	assert.equal(parentWork.current.state, "blocked");
	assert.equal(parentWork.current.hold?.reason, "protocol");
	assert.equal(runtime.getWork(teamId, child.receipt.work)!.current.state, "queued", "the child obligation is kept");
	runtime.assertInvariants(teamId);
});
