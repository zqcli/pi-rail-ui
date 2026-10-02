import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamRuntime, type NativeCompletion, type RuntimeActivation, type TeamRuntimeOptions } from "../../tools/subagents/team-runtime";
import { TeamJournalGeneration } from "../../tools/subagents/team-journal";
import {
	jsonBytes, jsonTextBytes, normalizeTeamResult, parseParentCommand, parseTeamReply, projectActivationInput,
	projectWorkError, TeamProtocolError,
} from "../../tools/subagents/team-codec";
import {
	TEAM_MAX_ACTIVATION_INPUT_BYTES, TEAM_MAX_BRIEF_BYTES, TEAM_MAX_NOTE_BYTES, TEAM_MAX_ROLE_BYTES, TEAM_MAX_TASK_BYTES,
	type TeamReply, type TeamStatusPage, type TeamWorkSummary, type WorkError, type WorkRef,
} from "../../tools/subagents/team-protocol";

const fill = (bytes: number) => "界\n".repeat(Math.floor(bytes / 5)) + "x".repeat(bytes % 5);
const key = (ref: WorkRef) => `${ref.workId}@${ref.revision}`;
function setup(maximal = false, options: TeamRuntimeOptions = {}) {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `bounds-${++ids}`, ...options });
	const brief = maximal ? { goal: fill(8192), constraints: [fill(8192), fill(8192), "x".repeat(8192)] } : { goal: "Exercise public bounds." };
	if (brief.constraints) brief.constraints[2] = brief.constraints[2]!.slice(0, -(jsonBytes(brief) - TEAM_MAX_BRIEF_BYTES));
	const role = maximal ? fill(TEAM_MAX_ROLE_BYTES) : "Perform assigned work.";
	const task = maximal ? fill(TEAM_MAX_TASK_BYTES) : "Collect every child outcome.";
	const { teamId } = runtime.prepare({
		members: [{ alias: "lead", roleDescription: role }, ...(maximal ? ["owner", "runner", "w3", "w4", "w5", "w6", "w7", "w8"] : ["owner", "runner"]).map((alias) => ({ alias, roleDescription: role }))], lead: "lead",
		brief, initialRequests: [{ to: "owner", task }],
	});
	runtime.launch(teamId);
	const sequences = new Map<string, number>();
	const lastCall = new Map<string, string>();
	function call(activation: RuntimeActivation, args: unknown): TeamReply {
		const seq = (sequences.get(activation.scope.activationId) ?? 0) + 1;
		sequences.set(activation.scope.activationId, seq);
		const id = `${activation.scope.activationId}:call:${seq}`;
		lastCall.set(activation.scope.activationId, id);
		const reply = runtime.handleAction(activation.binding, activation.scope, seq, id, args, id);
		assert.deepEqual(parseTeamReply(reply), reply);
		return reply;
	}
	function ready(activation: RuntimeActivation) {
		assert.deepEqual(parseParentCommand({ version: 2, commandId: "check-activate", operation: "activate", binding: activation.binding,
			activation: activation.scope, deliveryId: activation.deliveryId, input: activation.input }).operation, "activate");
		assert.deepEqual(projectActivationInput(activation.input), activation.input, "Runtime public projection must already be idempotent");
		assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
	}
	function settle(activation: RuntimeActivation, completion: NativeCompletion = { status: "success", appliedToolCallId: lastCall.get(activation.scope.activationId)! }) {
		assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, completion).ok, true);
		assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
	}
	function end(activation: RuntimeActivation, args: unknown) { assert.equal(call(activation, args).ok, true); settle(activation); }
	function nextWork(ack = true): RuntimeActivation | undefined {
		for (let count = 0; count < 40; count++) {
			const next = runtime.takeNextActivation(teamId);
			if (!next) return;
			if (next.scope.kind === "work") { if (ack) ready(next); return next; }
			ready(next);
			end(next, { action: "yield" });
		}
		throw new Error("Management batch did not converge");
	}
	const boot = runtime.takeNextActivation(teamId)!;
	ready(boot);
	end(boot, { action: "yield" });
	const parent = nextWork()!;
	function child() {
		const reply = call(parent, { action: "request", to: "runner", task: "Return an outcome." });
		assert.ok(reply.ok && reply.receipt?.status === "accepted");
		return reply.receipt.work;
	}
	return { runtime, teamId, parent, brief, role, task, call, ready, settle, end, nextWork, child };
}

function assertError(error: WorkError | undefined, code: string, unknown?: boolean) {
	assert.ok(error);
	assert.equal(error.code, code);
	assert.equal(error.outcomeUnknown, unknown);
	assert.ok(error.message.isWellFormed());
	assert.ok(jsonTextBytes(error.message) <= TEAM_MAX_NOTE_BYTES);
	assert.match(error.message, /\[truncated\]$/u);
}

test("Runtime: 6 KiB native failure automatically wakes its parent; all public views remain parseable and evidence stays exact", () => {
	const h = setup();
	const child = h.child();
	h.end(h.parent, { action: "yield", waitingFor: [child], checkpoint: "Need the failed outcome too." });
	const running = h.nextWork()!;
	const raw = { code: "NATIVE_FAILURE", message: "proxy error " + "x".repeat(6000) };
	const completion: NativeCompletion = { status: "error", error: raw };
	assert.equal(h.runtime.nativeSettled(running.binding, running.scope.activationId, completion).ok, true);
	assert.deepEqual(h.runtime.activationCompletion(running.binding, running.scope.activationId)?.native.error, raw);
	assert.throws(() => h.runtime.nativeSettled(running.binding, running.scope.activationId,
		{ ...completion, error: { ...raw, message: raw.message + "different tail" } }), (error: unknown) => error instanceof TeamProtocolError && error.code === "PROTOCOL_FAILURE");
	assert.equal(h.runtime.cleanupFinished(running.binding, running.scope.activationId, { ok: true }).ok, true);
	assert.equal(h.runtime.nativeSettled(running.binding, running.scope.activationId, completion).ok, true, "exact raw evidence remains idempotent after cleanup");
	assertError(h.runtime.getWork(h.teamId, child)?.current.error, "NATIVE_FAILURE");
	const resumed = h.nextWork()!;
	assert.deepEqual(resumed.scope.work, h.parent.scope.work);
	assertError(resumed.input.outcomes[0]?.error, "NATIVE_FAILURE");
	assert.equal(h.runtime.listHolds(h.teamId).length, 0);
	assert.equal(h.call(resumed, { action: "status", view: "team" }).ok, true);
	assert.equal(h.runtime.getTeam(h.teamId).members.find((member) => member.id === "owner")?.lifecycle, "open");
	h.end(resumed, { action: "reply", result: { status: "partial", summary: "The child failed, but the parent remained available." } });
	assert.equal(h.runtime.getWork(h.teamId, h.parent.scope.work!)?.current.state, "resolved");
	h.runtime.assertInvariants(h.teamId);
});

test("Runtime: legal failed business result keeps its full 8 KiB summary, with bounded status/work/outcome diagnostics", () => {
	const h = setup();
	const child = h.child();
	h.end(h.parent, { action: "yield", waitingFor: [child], checkpoint: "Observe business failure." });
	const running = h.nextWork()!;
	const summary = fill(8192);
	h.end(running, { action: "reply", result: { status: "failed", summary } });
	const view = h.runtime.getWork(h.teamId, child)!;
	assertError(view.current.error, "BUSINESS_FAILED");
	assert.equal(h.runtime.getResult(h.teamId, view.current.resultRef!)?.result.summary, summary);
	h.runtime.messageLead(h.teamId, "Inspect the failed child's complete work view.");
	const manager = h.runtime.takeNextActivation(h.teamId)!;
	h.ready(manager);
	const workReply = h.call(manager, { action: "status", view: "work", id: child.workId });
	assert.ok(workReply.ok && workReply.data && "current" in workReply.data);
	assertError(workReply.data.current.error, "BUSINESS_FAILED");
	h.end(manager, { action: "yield" });
	const resumed = h.nextWork()!;
	assertError(resumed.input.outcomes[0]?.error, "BUSINESS_FAILED");
	const resultReply = h.call(resumed, { action: "status", view: "result", id: view.current.resultRef });
	assert.ok(resultReply.ok && resultReply.data && "result" in resultReply.data);
	assert.equal(resultReply.data.result.summary, summary);
	h.end(resumed, { action: "reply", result: { status: "partial", summary: "Business failure observed." } });
});

for (const maximal of [false, true]) test(`Runtime: ${maximal ? "maximal inputs and 40 failure outcomes" : "host grant and 65 children"} paginate and observe every outcome before reply`, () => {
	const h = setup(maximal);
	const parentRef = h.parent.scope.work!;
	const count = maximal ? 40 : 65;
	if (!maximal) h.runtime.grantBudget(h.teamId, { kind: "root", rootId: parentRef.workId }, { rootChildren: 1 }, "Authorize 65 children.");
	const children: WorkRef[] = [];
	for (let index = 0; index < count; index++) {
		children.push(h.child());
		const running = h.nextWork()!;
		assert.deepEqual(running.scope.work, children[index]);
		h.end(running, { action: "reply", result: { status: "failed", summary: fill(8192) } });
	}
	const view = h.runtime.getWork(h.teamId, parentRef)!;
	assert.equal(view.children.length + (view.childrenOmitted ?? 0), count);
	assert.ok(view.children.length <= 64);
	assert.equal(h.call(h.parent, { action: "status", view: "work", id: parentRef.workId }).ok, true);
	const found: WorkRef[] = [];
	let cursor: string | undefined;
	do {
		const reply = h.call(h.parent, { action: "status", view: "work", limit: 20, ...(cursor ? { cursor } : {}) });
		assert.ok(reply.ok && reply.data && "items" in reply.data);
		const page = reply.data as TeamStatusPage;
		for (const item of page.items as TeamWorkSummary[]) if (item.parent && key(item.parent) === key(parentRef)) found.push(item.work);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	assert.deepEqual(found, children, "all refs remain reachable through stable pages and exact parent revisions");
	let active = h.parent;
	const observed = new Set<string>();
	let batches = 0;
	while (observed.size < children.length) {
		assert.ok(batches++ < count + 1);
		const refused = h.call(active, { action: "reply", result: { status: "succeeded", summary: "Too early." } });
		assert.ok(!refused.ok && refused.error.code === "UNOBSERVED_CHILD_RESULTS");
		const unseen = children.filter((ref) => !observed.has(key(ref)));
		h.end(active, { action: "yield", waitingFor: unseen.slice(0, 32), checkpoint: maximal ? fill(4096) : "Read remaining child outcomes." });
		active = h.nextWork(false)!;
		assert.deepEqual(active.scope.work, parentRef);
		assert.ok(jsonBytes(active.input) <= TEAM_MAX_ACTIVATION_INPUT_BYTES);
		assert.deepEqual(active.input.brief, h.brief);
		assert.equal(active.input.member.roleDescription, h.role);
		assert.equal(active.input.scope.kind === "work" && active.input.scope.task, h.task);
		assert.equal(active.input.ownedChildren.length + active.input.ownedChildrenOmitted!, count);
		assert.equal(active.input.outcomes.length + active.input.omittedOutcomes, unseen.length);
		assert.ok(active.input.outcomes.length > 0, "each resumed batch must make actual observation progress");
		if (maximal && batches === 1) {
			assert.ok(active.input.outcomes.length < 32, "combined bytes, not just item count, trim optional outcomes");
			assert.equal(jsonBytes(h.brief), TEAM_MAX_BRIEF_BYTES);
		}
		assert.deepEqual(h.runtime.getWork(h.teamId, parentRef)!.current.observedOutcomes.map(key).sort(), [...observed].sort(), "reservation alone acknowledges nothing");
		for (const outcome of active.input.outcomes) {
			assert.ok(!observed.has(key(outcome.work)));
			observed.add(key(outcome.work));
			assertError(outcome.error, "BUSINESS_FAILED");
		}
		h.ready(active);
		assert.deepEqual(h.runtime.getWork(h.teamId, parentRef)!.current.observedOutcomes.map(key).sort(), [...observed].sort(), "ACK observes exactly input.outcomes, never a separate first-32 projection");
	}
	assert.ok(batches > 1);
	h.end(active, { action: "reply", result: { status: "partial", summary: "Every child failure was observed." } });
	assert.equal(h.runtime.getWork(h.teamId, parentRef)!.current.state, "resolved");
	assert.equal(h.runtime.getTeam(h.teamId).members.find((member) => member.id === "owner")?.lifecycle, "open");
	h.runtime.assertInvariants(h.teamId);
});

test("Runtime: malformed-Unicode transport diagnostics preserve exact evidence; unknown outcomes still require Manager release", () => {
	const h = setup();
	const child = h.child();
	h.end(h.parent, { action: "yield", waitingFor: [child], checkpoint: "Need exact unknown-outcome decision." });
	const running = h.nextWork()!;
	const error = { code: "TRANSPORT_FAILURE", message: "\ud800" + fill(8000), outcomeUnknown: true };
	assert.equal(h.runtime.activationLost(running.binding, running.scope.activationId, error, true).ok, true);
	assert.equal(h.runtime.activationLost(running.binding, running.scope.activationId, error, true).ok, true);
	assert.throws(() => h.runtime.activationLost(running.binding, running.scope.activationId, { ...error, message: error.message + "tail" }, true));
	assertError(h.runtime.getWork(h.teamId, child)?.current.error, "TRANSPORT_FAILURE", true);
	const hold = h.runtime.getWork(h.teamId, h.parent.scope.work!)!.current.hold!;
	assert.equal(hold.reason, "attention");
	assert.deepEqual(h.runtime.getWork(h.teamId, h.parent.scope.work!)!.current.observedOutcomes, []);
	const manager = h.runtime.takeNextActivation(h.teamId)!;
	assert.equal(manager.scope.kind, "events");
	h.ready(manager);
	assert.equal(h.call(manager, { action: "status", view: "work", id: child.workId }).ok, true);
	assert.equal(h.call(manager, { action: "status", view: "incident" }).ok, true);
	assert.equal(h.call(manager, { action: "control", command: "resume_work", workId: h.parent.scope.work!.workId,
		expectedRevision: 1, incidentId: hold.incidentId, instruction: "Inspected uncertain side effects; allow this outcome." }).ok, true);
	h.end(manager, { action: "yield" });
	const resumed = h.nextWork()!;
	assert.deepEqual(resumed.scope.work, h.parent.scope.work);
	assertError(resumed.input.outcomes[0]?.error, "TRANSPORT_FAILURE", true);
	h.end(resumed, { action: "reply", result: { status: "partial", summary: "Unknown outcome explicitly acknowledged." } });
	h.runtime.assertInvariants(h.teamId);
});

test("Runtime: cleanup errors and journal reasons are bounded only at public exits", () => {
	const h = setup();
	const raw = { code: "CLEANUP_FAILED", message: "\ud800" + "\n".repeat(6000), outcomeUnknown: true };
	assert.equal(h.runtime.nativeSettled(h.parent.binding, h.parent.scope.activationId, { status: "success", finalAssistantText: "candidate" }).ok, true);
	assert.equal(h.runtime.cleanupFinished(h.parent.binding, h.parent.scope.activationId, { ok: false, error: raw }).ok, true);
	assertError(h.runtime.getWork(h.teamId, h.parent.scope.work!)?.current.error, "CLEANUP_FAILED", true);
	assert.doesNotThrow(() => parseTeamReply({ ok: true, from: "@hub", to: "lead", data: h.runtime.getTeam(h.teamId) }));
	const manager = h.runtime.takeNextActivation(h.teamId)!;
	h.ready(manager);
	assert.equal(h.call(manager, { action: "status", view: "incident" }).ok, true);
	h.end(manager, { action: "yield" });
	const journal = new TeamJournalGeneration((record) => { if (record.kind === "result") throw new Error(raw.message); });
	const j = setup(false, { journal });
	j.end(j.parent, { action: "reply", result: { status: "succeeded", summary: "candidate" } });
	const terminal = j.runtime.getTeamResult(j.teamId)!;
	assert.equal(terminal.lifecycle, "failed");
	assert.match(terminal.reason!, /\[truncated\]$/u);
	assert.deepEqual(normalizeTeamResult(terminal), terminal);
	assertError(j.runtime.getWork(j.teamId, j.parent.scope.work!)?.current.error, "JOURNAL_FAILURE", true);
	assert.doesNotThrow(() => parseTeamReply({ ok: true, from: "@hub", to: "lead", data: j.runtime.getTeam(j.teamId) }));
	assert.deepEqual(projectWorkError(raw), projectWorkError(projectWorkError(raw)));
});

test("Runtime: revised work projects its prior failure without changing the immutable result", () => {
	const h = setup();
	const summary = fill(8192);
	h.end(h.parent, { action: "reply", result: { status: "failed", summary } });
	const old = h.runtime.getWork(h.teamId, h.parent.scope.work!)!;
	const manager = h.runtime.takeNextActivation(h.teamId)!;
	h.ready(manager);
	assert.equal(h.call(manager, { action: "control", command: "revise_work", workId: old.id, expectedRevision: 1, task: "Retry with a new plan." }).ok, true);
	h.end(manager, { action: "yield" });
	const next = h.nextWork()!;
	assert.equal(next.scope.work?.revision, 2);
	assert.ok(next.input.scope.kind === "work");
	assertError(next.input.scope.previous?.error, "BUSINESS_FAILED");
	assert.equal(h.runtime.getResult(h.teamId, old.current.resultRef!)?.result.summary, summary);
	h.end(next, { action: "reply", result: { status: "succeeded", summary: "New revision completed." } });
});

test("Runtime: long malformed-Unicode driver startup errors still consume the failed attempt and retain first-wins cleanup", () => {
	const runtime = new TeamRuntime();
	const { teamId } = runtime.prepare({ members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w1", roleDescription: "Work." }], lead: "lead", brief: { goal: "Fail before launch." }, initialRequests: [{ to: "w1", task: "Not started." }] });
	const binding = runtime.claimNativeLifetime(teamId, "w1");
	const reason = "Startup cause: \ud800" + fill(8000);
	const receipt = runtime.failStartup(teamId, reason);
	assert.ok("reason" in receipt && receipt.reason);
	assert.match(receipt.reason, /\[truncated\]$/u);
	const team = runtime.getTeam(teamId);
	assert.equal(team.lifecycle, "failed");
	assert.equal(team.members.find((member) => member.id === "w1")?.resourceState, "stopping");
	const ref = runtime.listWorks(teamId)[0]!.work;
	assertError(runtime.getWork(teamId, ref)?.current.error, "STARTUP_FAILURE");
	const again = runtime.failStartup(teamId, "different late cause");
	assert.ok("reason" in again);
	assert.equal(again.reason, receipt.reason, "late failure cannot overwrite the first startup decision");
	assert.deepEqual(runtime.bindingForDriver(teamId, "w1"), binding);
	assert.doesNotThrow(() => parseTeamReply({ ok: true, from: "@hub", to: "lead", data: team }));
	assert.doesNotThrow(() => normalizeTeamResult(runtime.getTeamResult(teamId)));
	runtime.assertInvariants(teamId);
});

test("Runtime: many cleanup-failure notices with maximal brief/roles are sealed into bounded exact Manager batches", () => {
	const h = setup(true, { limits: { workPermits: 8 } });
	const children: WorkRef[] = [];
	for (const to of ["runner", "w3", "w4", "w5", "w6", "w7", "w8"]) {
		const reply = h.call(h.parent, { action: "request", to, task: "Fail independently." });
		assert.ok(reply.ok && reply.receipt?.status === "accepted");
		children.push(reply.receipt.work);
	}
	h.end(h.parent, { action: "yield", waitingFor: children, checkpoint: "Collect known failures." });
	const running = children.map(() => h.runtime.takeNextActivation(h.teamId)!);
	for (const child of running) {
		h.ready(child);
		assert.equal(h.runtime.nativeSettled(child.binding, child.scope.activationId, { status: "success", finalAssistantText: "candidate" }).ok, true);
		assert.equal(h.runtime.cleanupFinished(child.binding, child.scope.activationId,
			{ ok: false, error: { code: "CLEANUP_FAILED", message: "\ud800" + fill(8000), outcomeUnknown: true } }).ok, true);
	}
	const expectedIncidents = h.runtime.getTeam(h.teamId).incidents.map((incident) => incident.id).sort();
	const receivedIncidents: string[] = [];
	const eventIds = new Set<string>();
	let batches = 0;
	let next = h.runtime.takeNextActivation(h.teamId);
	while (next?.scope.kind === "events") {
		assert.ok(batches++ < 10);
		assert.ok(next.input.scope.kind === "events");
		assert.deepEqual(next.input.brief, h.brief);
		for (const event of next.input.scope.events) {
			assert.ok(!eventIds.has(event.id), "a byte-limited batch must not consume or replay other pending events");
			eventIds.add(event.id);
			if (event.incidentId) receivedIncidents.push(event.incidentId);
		}
		h.ready(next);
		h.end(next, { action: "yield" });
		next = h.runtime.takeNextActivation(h.teamId);
	}
	assert.ok(batches > 1, "all failure diagnostics cannot fit beside a maximal brief in one input");
	assert.deepEqual(receivedIncidents.sort(), expectedIncidents);
	assert.equal(next, undefined, "publishing bounded notices does not make unknown cleanup safe");
	assert.equal(h.runtime.getWork(h.teamId, h.parent.scope.work!)?.current.state, "blocked");
	h.runtime.assertInvariants(h.teamId);
});
