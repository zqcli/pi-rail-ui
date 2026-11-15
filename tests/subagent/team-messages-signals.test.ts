import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";
import { normalizeTeamAction, parseParentCommand, parseTeamReply, projectActivationInput, jsonBytes } from "../../tools/subagents/team-codec";
import { TEAM_MAX_ACTIVATION_INPUT_BYTES, TEAM_MAX_MEMBER_MESSAGES, TEAM_MAX_WORK_SIGNALS, type SignalRecord, type WorkRef, type TeamReply } from "../../tools/subagents/team-protocol";

function fixture(initial = ["a", "b"], options: { workPermits?: number; claim?: string[] } = {}) {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `test${++ids}`, ...(options.workPermits ? { limits: { workPermits: options.workPermits } } : {}) });
	const { teamId } = runtime.prepare({ members: ["lead", "a", "b", "c"].map((alias) => ({ alias, roleDescription: alias })),
		lead: "lead", brief: { goal: "Exercise communication and phase facts" }, initialRequests: initial.map((to) => ({ to, task: `${to} work` })), timeoutSeconds: null });
	for (const member of options.claim ?? []) runtime.claimNativeLifetime(teamId, member);
	runtime.launch(teamId);
	const sequences = new Map<string, number>();
	const act = (a: RuntimeActivation, args: unknown): TeamReply => {
		const seq = (sequences.get(a.scope.activationId) ?? 0) + 1;
		sequences.set(a.scope.activationId, seq);
		return parseTeamReply(runtime.handleAction(a.binding, a.scope, seq, `call${seq}`, args));
	};
	const ready = (a: RuntimeActivation) => {
		parseParentCommand({ version: 2, commandId: "frame", operation: "activate", binding: a.binding, activation: a.scope, deliveryId: a.deliveryId, input: a.input });
		assert.equal(runtime.inputReady(a.binding, a.scope.activationId, a.deliveryId).ok, true);
		return a;
	};
	const settle = (a: RuntimeActivation, hasIntent = true, finalAssistantText?: string) => {
		assert.equal(runtime.nativeSettled(a.binding, a.scope.activationId, { status: "success",
			...(hasIntent ? { appliedToolCallId: `call${sequences.get(a.scope.activationId)}` } : {}), ...(finalAssistantText ? { finalAssistantText } : {}) }).ok, true);
		assert.equal(runtime.cleanupFinished(a.binding, a.scope.activationId, { ok: true }).ok, true);
	};
	const next = () => ready(runtime.takeNextActivation(teamId)!);
	const boot = next(); assert.equal(boot.binding.memberId, "lead"); assert.equal(act(boot, { action: "yield" }).ok, true); settle(boot);
	const open = (a: RuntimeActivation, name = "SDK released") => {
		const reply = act(a, { action: "signal", operation: "open", name });
		assert.equal(reply.ok, true, JSON.stringify(reply));
		return (reply.ok ? reply.data as SignalRecord : undefined)!;
	};
	const status = (a: RuntimeActivation, id: string) => {
		const reply = act(a, { action: "status", view: "signal", id }); assert.equal(reply.ok, true);
		return reply.ok ? reply.data as SignalRecord : undefined;
	};
	const yieldSignals = (a: RuntimeActivation, ids: string[]) => act(a, { action: "yield", waitingForSignals: ids, checkpoint: "continue after these exact phases" });
	return { runtime, teamId, act, ready, settle, next, open, status, yieldSignals };
}
const ref = (a: RuntimeActivation): WorkRef => a.scope.work!;
const error = (reply: TeamReply) => reply.ok ? undefined : reply.error.code;

test("messages: accepted without Work, idle recipient wakes serially and replies conversationally", () => {
	const f = fixture(["a"]); const a = f.next();
	const before = f.runtime.getTeam(f.teamId).works.total;
	const sent = f.act(a, { action: "message", to: "b", text: "Which name?" });
	assert.ok(sent.ok && sent.receipt?.status === "sent");
	assert.equal(f.runtime.getTeam(f.teamId).works.total, before);
	assert.equal(f.runtime.getWork(f.teamId, ref(a))!.current.state, "running");
	const b = f.next(); assert.equal(b.binding.memberId, "b"); assert.equal(b.input.scope.kind, "events");
	if (b.input.scope.kind !== "events" || !sent.ok || sent.receipt?.status !== "sent") return;
	const message = b.input.scope.events[0]!;
	assert.equal(message.id, sent.receipt.messageId); assert.equal(message.sender, "a"); assert.equal(message.recipient, "b"); assert.deepEqual(message.work, ref(a));
	assert.equal(error(f.act(b, { action: "request", to: "c", task: "not a mailbox operation" })), "FORBIDDEN_ACTION");
	assert.equal(f.runtime.gate(b.binding, b.scope, "tool_gate", "base", "bash").allow, false);
	assert.equal(f.act(b, { action: "message", to: "a", text: "Use Widget", replyTo: message.id }).ok, true);
	assert.equal(f.runtime.takeNextActivation(f.teamId), undefined, "sender never gets a concurrent mailbox activation");
	assert.equal(f.act(b, { action: "yield" }).ok, true); f.settle(b);
	assert.equal(f.act(a, { action: "yield", attention: "pause current task", checkpoint: "waiting" }).ok, true); f.settle(a);
	const lead = f.next(); assert.equal(lead.binding.memberId, "lead"); f.act(lead, { action: "yield" }); f.settle(lead);
	const answer = f.next(); assert.equal(answer.binding.memberId, "a");
	assert.ok(answer.input.scope.kind === "events" && answer.input.scope.events[0]!.replyTo === message.id);
	assert.equal(f.runtime.getWork(f.teamId, ref(a))!.current.state, "blocked", "mail does not release a Work hold");
	f.runtime.assertInvariants(f.teamId);
});

test("messages: unknown/mismatched identity, bounds, and pending close are explicit", () => {
	const f = fixture(["a"]); const a = f.next();
	assert.equal(error(f.act(a, { action: "message", to: "missing", text: "x" })), "UNKNOWN_MEMBER");
	assert.equal(error(f.act(a, { action: "message", to: "b", text: "x", replyTo: "event:missing" })), "UNKNOWN_MESSAGE");
	for (let n = 0; n < TEAM_MAX_MEMBER_MESSAGES; n++) assert.equal(f.act(a, { action: "message", to: "b", text: `notice ${n}` }).ok, true);
	assert.equal(error(f.act(a, { action: "message", to: "b", text: "overflow" })), "REQUEST_QUEUE_FULL");
	f.runtime.messageLead(f.teamId, "close?"); const lead = f.next();
	assert.equal(error(f.act(lead, { action: "control", command: "close_member", memberId: "b" })), "CLOSE_BLOCKED");
	const fake = f.act(lead, { action: "message", to: "a", text: "fake answer", replyTo: "event:missing" }); assert.equal(error(fake), "UNKNOWN_MESSAGE");
});

test("signals: publish releases a phase waiter while producer continues; observation is not Work-result consumption", () => {
	const f = fixture(); const a = f.next(), b = f.next();
	const signal = f.open(a);
	assert.equal(f.yieldSignals(b, [signal.id]).ok, true); f.settle(b);
	assert.equal(f.runtime.getWork(f.teamId, ref(b))!.current.state, "blocked");
	assert.equal(f.act(a, { action: "signal", operation: "publish", signalId: signal.id, text: "SDK phase finished; tests continue" }).ok, true);
	assert.equal(f.runtime.getWork(f.teamId, ref(a))!.current.state, "running");
	const resumed = f.next(); assert.deepEqual(ref(resumed), ref(b));
	assert.equal(resumed.input.signalOutcomes?.[0]!.state, "published");
	assert.deepEqual(f.runtime.getWork(f.teamId, ref(b))!.current.observedOutcomes, []);
	assert.deepEqual(f.runtime.getWork(f.teamId, ref(b))!.current.observedSignals, [signal.id]);
	assert.equal(error(f.yieldSignals(resumed, [signal.id])), "NO_NEW_DEPENDENCY");
	assert.equal(f.status(resumed, signal.id)!.state, "published", "status never changes signal consumption");
	f.runtime.assertInvariants(f.teamId);
});

test("signals: publish between staged yield and native cleanup cannot lose a wake", () => {
	const f = fixture(); const a = f.next(), b = f.next(); const signal = f.open(a);
	assert.equal(f.yieldSignals(b, [signal.id]).ok, true);
	assert.equal(f.act(a, { action: "signal", operation: "publish", signalId: signal.id, text: "released" }).ok, true);
	assert.equal(f.runtime.takeNextActivation(f.teamId), undefined, "waiter still owns its settling activation");
	f.settle(b); const again = f.next(); assert.deepEqual(ref(again), ref(b)); assert.equal(again.input.signalOutcomes?.[0]!.id, signal.id);
});

test("signals: exact handles separate repeated phases, independent consumers each observe", () => {
	const f = fixture(["a", "b", "c"]); const a = f.next(), b = f.next(), c = f.next();
	const old = f.open(a); f.act(a, { action: "signal", operation: "publish", signalId: old.id, text: "old phase" });
	const current = f.open(a); assert.notEqual(old.id, current.id);
	assert.equal(f.yieldSignals(b, [current.id]).ok, true); f.settle(b);
	assert.equal(f.yieldSignals(c, [current.id]).ok, true); f.settle(c);
	assert.equal(f.runtime.getWork(f.teamId, ref(b))!.current.state, "blocked", "an old release never satisfies a new handle");
	f.act(a, { action: "signal", operation: "publish", signalId: current.id, text: "new phase" });
	const first = f.next(), second = f.next();
	assert.equal(first.input.signalOutcomes?.[0]!.id, current.id); assert.equal(second.input.signalOutcomes?.[0]!.id, current.id);
	assert.equal(error(f.act(a, { action: "signal", operation: "publish", signalId: current.id, text: "changed historical fact" })), "SIGNAL_CLOSED");
	assert.equal(f.act(a, { action: "signal", operation: "publish", signalId: current.id, text: "new phase" }).ok, true, "identical publication is idempotent");
});

for (const mode of ["finish", "cancel", "revise"] as const) test(`signals: ${mode} ends unpublished phases without pretending release`, () => {
	const f = fixture(); const a = f.next(), b = f.next(); const signal = f.open(a);
	assert.equal(error(f.act(b, { action: "signal", operation: "publish", signalId: signal.id, text: "forged" })), "WRONG_WORK_OWNER");
	f.yieldSignals(b, [signal.id]); f.settle(b);
	if (mode === "finish") { f.act(a, { action: "reply", result: { status: "succeeded", summary: "finished without phase" } }); f.settle(a); }
	else {
		f.runtime.messageLead(f.teamId, "control producer"); const lead = f.next();
		const command = mode === "cancel" ? { command: "cancel_work", reason: "stop" } : { command: "revise_work", task: "new generation" };
		assert.equal(f.act(lead, { action: "control", ...command, workId: ref(a).workId, expectedRevision: ref(a).revision }).ok, true);
		assert.equal(error(f.act(a, { action: "signal", operation: "publish", signalId: signal.id, text: "late" })), "ACTIVATION_ENDING");
	}
	assert.equal(f.runtime.getWork(f.teamId, ref(b))!.current.state, "queued");
	const reader = mode === "finish" ? f.next() : a;
	assert.equal(f.status(reader, signal.id)!.state, "unavailable");
	assert.match(f.status(reader, signal.id)!.text!, /No resource release/);
	f.runtime.assertInvariants(f.teamId);
});

test("signals: permit parent-to-child early phase publication, reject real mixed/staged cycles", () => {
	const f = fixture(["a"]); const a = f.next(); const signal = f.open(a);
	const childReply = f.act(a, { action: "request", to: "b", task: "wait for parent's phase then work" }); assert.equal(childReply.ok, true);
	const b = f.next(); assert.equal(f.yieldSignals(b, [signal.id]).ok, true, "parent completion depends on child, but phase publication does not");
	assert.equal(error(f.act(a, { action: "yield", waitingFor: [ref(b)], checkpoint: "would deadlock before publishing" })), "DEPENDENCY_CYCLE");
	f.act(a, { action: "signal", operation: "publish", signalId: signal.id, text: "ready" });
	assert.equal(f.act(a, { action: "yield", waitingFor: [ref(b)], checkpoint: "now wait for child completion" }).ok, true);
	f.settle(b); f.settle(a); f.runtime.assertInvariants(f.teamId);
});

test("signals: self wait, unknown handle and per-version capacity are bounded", () => {
	const f = fixture(["a"]); const a = f.next(); const own = f.open(a);
	assert.equal(error(f.yieldSignals(a, [own.id])), "DEPENDENCY_CYCLE");
	assert.equal(error(f.yieldSignals(a, ["signal:missing"])), "UNKNOWN_SIGNAL");
	for (let n = 1; n < TEAM_MAX_WORK_SIGNALS; n++) f.open(a, `phase ${n}`);
	assert.equal(error(f.act(a, { action: "signal", operation: "open", name: "overflow" })), "TEAM_CAPACITY");
});

test("codec: new actions remain strict, bounded, and cannot supply sender identity", () => {
	assert.throws(() => normalizeTeamAction({ action: "message", to: "a", text: "x", sender: "lead" }), /unknown field/);
	assert.throws(() => normalizeTeamAction({ action: "message", to: "a", text: "中".repeat(2000) }), /exceeds/);
	assert.throws(() => normalizeTeamAction({ action: "signal", operation: "open", name: "x", text: "no" }), /only name/);
	assert.throws(() => normalizeTeamAction({ action: "yield", waitingFor: [{ workId: "work:1", revision: 1 }], waitingForSignals: ["signal:1"], checkpoint: "no" }), /mutually exclusive/);
	assert.throws(() => normalizeTeamAction({ action: "yield", waitingForSignals: ["signal:1"], attention: "no", checkpoint: "no" }), /mutually exclusive/);
});

test("messages: cancellation between tool gate and business admission cannot send stale work mail", () => {
	const f = fixture(["a"]); const a = f.next();
	assert.equal(f.runtime.gate(a.binding, a.scope, "tool_gate", "sending", "team").allow, true);
	f.runtime.messageLead(f.teamId, "cancel"); const lead = f.next();
	assert.equal(f.act(lead, { action: "control", command: "cancel_work", workId: ref(a).workId, expectedRevision: 1, reason: "stop" }).ok, true);
	assert.equal(error(f.act(a, { action: "message", to: "b", text: "must not arrive" })), "ACTIVATION_ENDING");
	assert.equal(f.runtime.takeNextActivation(f.teamId), undefined);
	// Close the fake native activation so its scoped stop timer is cleared.
	f.runtime.toolResult(a.binding, a.scope, "sending", "team");
	f.settle(a, false);
});

test("mailbox: native failure and transport loss expose unavailable messages and do not strand owned work", () => {
	for (const loss of [false, true]) {
		const f = fixture(["a", "b"]); const a = f.next(), bwork = f.next(); const pending = f.open(bwork);
		f.act(bwork, { action: "yield", attention: "held work", checkpoint: "hold" }); f.settle(bwork);
		const lead = f.next(); f.act(lead, { action: "yield" }); f.settle(lead);
		f.act(a, { action: "message", to: "b", text: "question" }); const mailbox = f.next(); assert.equal(mailbox.binding.memberId, "b");
		if (loss) f.runtime.activationLost(mailbox.binding, mailbox.scope.activationId, { code: "LOST", message: "transport disconnected" }, true);
		else {
			f.runtime.nativeSettled(mailbox.binding, mailbox.scope.activationId, { status: "error", error: { code: "NATIVE", message: "failed" } });
			f.runtime.cleanupFinished(mailbox.binding, mailbox.scope.activationId, { ok: true });
		}
		assert.equal(f.runtime.getWork(f.teamId, ref(bwork))!.current.state, "failed");
		assert.equal(f.status(a, pending.id)!.state, "unavailable");
		assert.ok(f.runtime.panelFacts(f.teamId).timeline.some((row) => /messages unavailable/.test(row.text)));
		const notice = f.next(); assert.equal(notice.binding.memberId, "lead");
		assert.ok(notice.input.scope.kind === "events" && notice.input.scope.events.some((event) => /not a read\/answer receipt/.test(event.message)));
		assert.notEqual(error(f.act(notice, { action: "control", command: "close_member", memberId: "b" })), "CLOSE_BLOCKED");
		f.runtime.assertInvariants(f.teamId);
	}
});

test("mailbox: changing the lead preserves another member's active event batch", () => {
	const f = fixture(["a"]); const a = f.next(); f.act(a, { action: "message", to: "b", text: "question" });
	const b = f.next(); assert.equal(b.binding.memberId, "b");
	f.runtime.handoverLead(f.teamId, "c", "new lead");
	assert.equal(f.runtime.gate(b.binding, b.scope, "provider_gate").allow, true);
	assert.equal(f.act(b, { action: "message", to: "a", text: "still usable" }).ok, true);
	assert.equal(f.act(b, { action: "yield" }).ok, true); f.settle(b); f.runtime.assertInvariants(f.teamId);
});

test("mailbox: exhausted ordinary budget makes queued advisory mail explicitly unavailable, not a close obligation", () => {
	const runtime = new TeamRuntime({ limits: { teamActivations: 1 } });
	const { teamId } = runtime.prepare({ members: [{ alias: "lead", roleDescription: "lead" }, { alias: "b", roleDescription: "worker" }], lead: "lead",
		brief: { goal: "budget" }, initialRequests: [], timeoutSeconds: null }); runtime.launch(teamId);
	const lead = runtime.takeNextActivation(teamId)!; runtime.inputReady(lead.binding, lead.scope.activationId, lead.deliveryId);
	assert.equal(runtime.handleAction(lead.binding, lead.scope, 1, "send", { action: "message", to: "b", text: "advisory" }).ok, true);
	assert.equal(runtime.handleAction(lead.binding, lead.scope, 2, "yield", { action: "yield" }).ok, true);
	runtime.nativeSettled(lead.binding, lead.scope.activationId, { status: "success", appliedToolCallId: "yield" }); runtime.cleanupFinished(lead.binding, lead.scope.activationId, { ok: true });
	const emergency = runtime.takeNextActivation(teamId)!; assert.equal(emergency.binding.memberId, "lead");
	assert.ok(emergency.input.scope.kind === "events" && emergency.input.scope.events.some((event) => event.kind === "MESSAGE_UNAVAILABLE"));
	runtime.inputReady(emergency.binding, emergency.scope.activationId, emergency.deliveryId);
	assert.equal(runtime.handleAction(emergency.binding, emergency.scope, 1, "close", { action: "control", command: "close_team", outcome: "failed", reason: "budget exhausted", resultRefs: [] }).ok, true);
});

test("signals: omitted phase outcomes retain IDs and an explicit count; input projection is idempotent", () => {
	const f = fixture(); f.next(); const b = f.next(); const input = structuredClone(b.input);
	assert.equal(input.scope.kind, "work"); if (input.scope.kind !== "work") return;
	input.scope.task = "t".repeat(16 * 1024); input.goal = "g".repeat(8 * 1024); input.notice = "n".repeat(4 * 1024);
	input.signalOutcomes = Array.from({ length: 32 }, (_, n) => ({ id: `signal:${n}${"s".repeat(240)}`, work: { workId: "w".repeat(256), revision: 1 }, author: "a",
		name: "中".repeat(60), state: "published" as const, text: "x".repeat(1024), createdAt: 1 }));
	input.scope.waitingForSignals = input.signalOutcomes.map((signal) => signal.id); input.omittedSignalOutcomes = 0;
	assert.ok(jsonBytes(input) > TEAM_MAX_ACTIVATION_INPUT_BYTES);
	const projected = projectActivationInput(input);
	assert.ok(projected.omittedSignalOutcomes! > 0); assert.equal(projected.signalOutcomes!.length + projected.omittedSignalOutcomes!, 32);
	assert.deepEqual(projected.scope.kind === "work" && projected.scope.waitingForSignals, input.scope.waitingForSignals);
	assert.deepEqual(projectActivationInput(projected), projected);
});

test("signals: open requires a name and late native publication is refused", () => {
	assert.throws(() => normalizeTeamAction({ action: "signal", operation: "open" }), /name/);
	for (const name of [null, "", "  "]) assert.throws(() => normalizeTeamAction({ action: "signal", operation: "open", name }), /name/);
	const f = fixture(["a"]); const a = f.next(); const signal = f.open(a);
	f.runtime.nativeSettled(a.binding, a.scope.activationId, { status: "success", finalAssistantText: "done" });
	assert.equal(error(f.act(a, { action: "signal", operation: "publish", signalId: signal.id, text: "late" })), "ACTIVATION_ENDING");
	assert.equal(error(f.act(a, { action: "message", to: "b", text: "late" })), "ACTIVATION_ENDING");
	f.runtime.cleanupFinished(a.binding, a.scope.activationId, { ok: true });
});

test("signals: same native intent retry tolerates previously observed plus new phase IDs", () => {
	const f = fixture(); const a = f.next(), b = f.next(); const old = f.open(a);
	f.act(a, { action: "signal", operation: "publish", signalId: old.id, text: "first" }); f.yieldSignals(b, [old.id]); f.settle(b);
	const resumed = f.next(); const next = f.open(a);
	const args = { action: "yield", waitingForSignals: [old.id, next.id], checkpoint: "second" };
	assert.equal(f.runtime.handleAction(resumed.binding, resumed.scope, 100, "rpc1", args, "native-intent").ok, true);
	assert.equal(f.runtime.handleAction(resumed.binding, resumed.scope, 101, "rpc2", args, "native-intent").ok, true);
});

test("mailbox: failed lead cleanup handover requeues Team events without stealing an active worker batch", () => {
	const f = fixture(["a"]); const a = f.next(); f.act(a, { action: "message", to: "b", text: "question" }); const b = f.next();
	f.runtime.messageLead(f.teamId, "must reach successor"); const old = f.next();
	f.runtime.nativeSettled(old.binding, old.scope.activationId, { status: "error", error: { code: "ERR", message: "failed" } });
	f.runtime.cleanupFinished(old.binding, old.scope.activationId, { ok: false, error: { code: "CLEANUP_FAILED", message: "uncertain" } });
	f.runtime.handoverLead(f.teamId, "c", "recover"); f.runtime.memberExitConfirmed(old.binding);
	assert.equal(f.runtime.gate(b.binding, b.scope, "provider_gate").allow, true);
	const successor = f.next(); assert.equal(successor.binding.memberId, "c");
	assert.ok(successor.input.scope.kind === "events" && successor.input.scope.events.some((event) => event.message === "must reach successor"));
});


test("mailbox: global Work turn prevents idle members' conversation from starving another worker", () => {
	const f = fixture(["c"], { workPermits: 1 });
	f.runtime.messageLead(f.teamId, "start conversation"); const lead = f.next();
	f.act(lead, { action: "message", to: "a", text: "question" }); f.act(lead, { action: "yield" }); f.settle(lead);
	const a = f.next(); assert.equal(a.binding.memberId, "a");
	f.act(a, { action: "message", to: "b", text: "another question" }); f.act(a, { action: "yield" }); f.settle(a);
	const c = f.next(); assert.equal(c.binding.memberId, "c"); assert.equal(c.scope.kind, "work");
	assert.equal(f.runtime.takeNextActivation(f.teamId), undefined, "the waiting mailbox still respects the worker permit");
});

test("mailbox: host stopping an idle lead disposes directed messages before handover", () => {
	const f = fixture(["a"], { claim: ["lead"] }); const a = f.next();
	f.act(a, { action: "message", to: "lead", text: "must not strand" });
	f.runtime.hostStopMember(f.teamId, "lead", "host stopped"); f.runtime.handoverLead(f.teamId, "c", "successor");
	const successor = f.next(); assert.equal(successor.binding.memberId, "c");
	assert.ok(successor.input.scope.kind === "events" && successor.input.scope.events.some((event) => event.kind === "MESSAGE_UNAVAILABLE" && event.message.includes("must not strand")));
	f.act(successor, { action: "yield" }); f.settle(successor);
	assert.equal(f.runtime.liveEffects(f.teamId).unprocessedEvents, 0);
});

test("signals: private outcome codec requires the same title contract as open", () => {
	const f = fixture(); const a = f.next(), b = f.next(); const signal = f.open(a, "\u0001".repeat(60));
	f.act(a, { action: "signal", operation: "publish", signalId: signal.id, text: "published" }); f.yieldSignals(b, [signal.id]); f.settle(b);
	const resumed = f.next();
	for (const name of [undefined, null]) {
		const input = structuredClone(resumed.input); if (name === undefined) delete (input.signalOutcomes![0] as Partial<SignalRecord>).name;
		else (input.signalOutcomes![0] as unknown as { name: null }).name = name;
		assert.throws(() => parseParentCommand({ version: 2, commandId: "bad", operation: "activate", binding: resumed.binding, activation: resumed.scope, deliveryId: resumed.deliveryId, input }), /name/);
	}
});

function interruptedParent() {
	const f = fixture(["a"]); const parent = f.next(); const signal = f.open(parent);
	assert.equal(f.act(parent, { action: "request", to: "b", task: "ask before continuing" }).ok, true);
	const child = f.next();
	assert.equal(f.act(parent, { action: "yield", waitingFor: [ref(child)], checkpoint: "wait for child" }).ok, true); f.settle(parent);
	assert.equal(f.act(child, { action: "yield", attention: "need a decision", checkpoint: "paused child" }).ok, true); f.settle(child);
	const incidentId = f.runtime.getWork(f.teamId, ref(child))!.current.hold!.incidentId;
	const resumeChild = (activation: RuntimeActivation) => {
		assert.equal(f.act(activation, { action: "control", command: "resume_work", workId: ref(child).workId,
			expectedRevision: ref(child).revision, incidentId, instruction: "continue after the parent's phase" }).ok, true);
	};
	assert.equal(f.runtime.getWork(f.teamId, ref(parent))!.current.state, "queued");
	assert.deepEqual(f.runtime.getWork(f.teamId, ref(parent))!.current.waitingFor, [ref(child)], "child issue keeps undelivered dependency IDs");
	return { ...f, parent, child, signal, resumeChild };
}

for (const producerState of ["running", "queued"] as const) test(`signals: a ${producerState} producer's interrupted Work wait does not block publication`, () => {
	const f = interruptedParent();
	let parent: RuntimeActivation | undefined;
	let lead: RuntimeActivation | undefined;
	if (producerState === "running") {
		parent = f.next(); assert.deepEqual(ref(parent), ref(f.parent)); f.resumeChild(parent);
	} else {
		f.runtime.messageLead(f.teamId, "resume the child before the queued parent starts"); lead = f.next();
		assert.equal(lead.binding.memberId, "lead");
		assert.equal(f.act(lead, { action: "control", command: "pause_member", memberId: "a" }).ok, true);
		f.resumeChild(lead);
	}
	const child = f.next(); assert.deepEqual(ref(child), ref(f.child));
	assert.equal(f.runtime.getWork(f.teamId, ref(f.parent))!.current.state, producerState);
	assert.equal(error(f.act(child, { action: "yield", waitingFor: [ref(f.parent)], checkpoint: "cannot wait for parent completion" })), "DEPENDENCY_CYCLE", "owned-child completion constraints are unchanged");
	assert.equal(f.yieldSignals(child, [f.signal.id]).ok, true, "an interrupted old wait is not a phase-publication prerequisite"); f.settle(child);
	if (lead) {
		assert.equal(f.act(lead, { action: "control", command: "resume_member", memberId: "a" }).ok, true);
		f.act(lead, { action: "yield" }); f.settle(lead);
	}
	parent ??= f.next(); assert.deepEqual(ref(parent), ref(f.parent));
	assert.equal(f.act(parent, { action: "signal", operation: "publish", signalId: f.signal.id, text: "phase completed before child" }).ok, true);
	const awakened = f.next(); assert.deepEqual(ref(awakened), ref(f.child)); assert.equal(awakened.input.signalOutcomes?.[0]?.id, f.signal.id);
	f.runtime.assertInvariants(f.teamId);
});

for (const wait of ["work", "signal"] as const) test(`signals: a resumed producer's new staged ${wait} wait still rejects a real phase cycle`, () => {
	const f = interruptedParent(); const parent = f.next(); f.resumeChild(parent); const child = f.next();
	if (wait === "work") assert.equal(f.act(parent, { action: "yield", waitingFor: [ref(child)], checkpoint: "wait again" }).ok, true);
	else { const childSignal = f.open(child, "child phase"); assert.equal(f.yieldSignals(parent, [childSignal.id]).ok, true); }
	assert.equal(error(f.yieldSignals(child, [f.signal.id])), "DEPENDENCY_CYCLE", "staged intent participates before cleanup changes running state");
	f.runtime.assertInvariants(f.teamId);
});

test("signals: a resumed producer's staged wait replaces historical publication blockers", () => {
	const f = interruptedParent(); const parent = f.next(); f.resumeChild(parent); const child = f.next();
	assert.equal(f.act(parent, { action: "request", to: "c", task: "independent prerequisite for the phase" }).ok, true);
	const prerequisite = f.next(); assert.equal(prerequisite.binding.memberId, "c");
	assert.equal(f.act(parent, { action: "yield", waitingFor: [ref(prerequisite)], checkpoint: "wait for the new prerequisite" }).ok, true);
	assert.equal(f.yieldSignals(child, [f.signal.id]).ok, true, "the superseded wait on this child must not leak into phase edges");
	f.settle(parent); f.settle(child);
	assert.equal(f.act(prerequisite, { action: "reply", result: { status: "succeeded", summary: "prerequisite finished" } }).ok, true); f.settle(prerequisite);
	const resumed = f.next(); assert.deepEqual(ref(resumed), ref(parent));
	assert.equal(f.act(resumed, { action: "signal", operation: "publish", signalId: f.signal.id, text: "phase now complete" }).ok, true);
	assert.deepEqual(ref(f.next()), ref(child)); f.runtime.assertInvariants(f.teamId);
});

test("signals: publication dependencies do not revive a runnable prerequisite's historical peer wait", () => {
	const f = fixture(); const parent = f.next(), peer = f.next(); const signal = f.open(parent);
	assert.equal(f.act(parent, { action: "request", to: "c", task: "phase prerequisite" }).ok, true); const prerequisite = f.next();
	assert.equal(f.act(prerequisite, { action: "request", to: "lead", task: "ask for a prerequisite decision" }).ok, true); const questioner = f.next();
	assert.equal(questioner.scope.kind, "work");
	assert.equal(f.act(parent, { action: "yield", waitingFor: [ref(prerequisite)], checkpoint: "phase needs this prerequisite" }).ok, true); f.settle(parent);
	assert.equal(f.act(prerequisite, { action: "yield", waitingFor: [ref(peer)], checkpoint: "old peer wait" }).ok, true); f.settle(prerequisite);
	assert.equal(f.act(questioner, { action: "yield", attention: "need a decision", checkpoint: "question" }).ok, true); f.settle(questioner);
	const interrupted = f.next(); assert.deepEqual(ref(interrupted), ref(prerequisite));
	assert.deepEqual(f.runtime.getWork(f.teamId, ref(interrupted))!.current.waitingFor, [ref(peer)]);
	assert.equal(f.yieldSignals(peer, [signal.id]).ok, true, "a runnable prerequisite can finish without its interrupted peer wait"); f.settle(peer);
	const incidentId = f.runtime.getWork(f.teamId, ref(questioner))!.current.hold!.incidentId;
	assert.equal(f.act(interrupted, { action: "control", command: "resume_work", workId: ref(questioner).workId,
		expectedRevision: 1, incidentId, instruction: "continue" }).ok, true);
	assert.equal(f.act(interrupted, { action: "yield", waitingFor: [ref(questioner)], checkpoint: "finish owned child" }).ok, true); f.settle(interrupted);
	const answer = f.next(); assert.deepEqual(ref(answer), ref(questioner));
	assert.equal(f.act(answer, { action: "reply", result: { status: "succeeded", summary: "decision handled" } }).ok, true); f.settle(answer);
	const completedPrerequisite = f.next(); assert.deepEqual(ref(completedPrerequisite), ref(prerequisite));
	assert.equal(f.act(completedPrerequisite, { action: "reply", result: { status: "succeeded", summary: "prerequisite complete" } }).ok, true); f.settle(completedPrerequisite);
	const producer = f.next(); assert.deepEqual(ref(producer), ref(parent));
	assert.equal(f.act(producer, { action: "signal", operation: "publish", signalId: signal.id, text: "phase complete" }).ok, true);
	assert.deepEqual(ref(f.next()), ref(peer)); f.runtime.assertInvariants(f.teamId);
});
