import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";
import { TEAM_MAX_TEXT_ITEM_BYTES, type TeamBudgetLimits, type WorkRef } from "../../tools/subagents/team-protocol";

interface Internals {
	team(teamId: string): { ready: WorkRef[]; events: Array<{ key: string; kind: string }> };
}
const internals = (runtime: TeamRuntime) => runtime as unknown as Internals;

function makeRuntime(initialRequests: Array<{ to: string; task: string }>, options: { limits?: Partial<TeamBudgetLimits>; checkInvariants?: boolean; claimW2?: boolean } = {}) {
	let ids = 0;
	let time = 1_700_000_000_000;
	const runtime = new TeamRuntime({ now: () => time++, createId: () => `id${++ids}`, limits: options.limits ?? {},
		...(options.checkInvariants === undefined ? {} : { checkInvariants: options.checkInvariants }) });
	const { teamId } = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage work, review roots and close the Team." },
		workers: [{ alias: "w1", roleDescription: "Perform work." }, { alias: "w2", roleDescription: "Perform work." }],
		brief: { goal: "Exercise review fixes." }, initialRequests, timeoutSeconds: null,
	});
	if (options.claimW2) runtime.claimNativeLifetime(teamId, "w2");
	runtime.launch(teamId);
	return { runtime, teamId };
}

function ready(runtime: TeamRuntime, activation: RuntimeActivation): void {
	assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
}

function settle(runtime: TeamRuntime, activation: RuntimeActivation, finalAssistantText: string, toolCallId?: string): void {
	assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId,
		{ status: "success", finalAssistantText, ...(toolCallId ? { appliedToolCallId: toolCallId } : {}) }).ok, true);
	assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
}

/** Take activations until the next Work one, letting the Manager end each of its own with a plain yield. */
function nextWork(runtime: TeamRuntime, teamId: string): RuntimeActivation {
	for (let index = 0; index < 20; index++) {
		const activation = runtime.takeNextActivation(teamId)!;
		ready(runtime, activation);
		if (activation.scope.kind === "work") return activation;
		const id = `yield-${index}`;
		assert.equal(runtime.handleAction(activation.binding, activation.scope, 1, id, { action: "yield" }, id).ok, true);
		settle(runtime, activation, "", id);
	}
	throw new Error("no Work activation");
}

test("checkInvariants:false skips the hot-path sweep but assertInvariants still checks", () => {
	for (const checkInvariants of [true, false]) {
		const { runtime, teamId } = makeRuntime([], { checkInvariants });
		const boot = runtime.takeNextActivation(teamId)!;
		internals(runtime).team(teamId).ready.push({ workId: "ghost", revision: 1 });
		if (checkInvariants) assert.throws(() => ready(runtime, boot), /Invariant/u, "the default runtime sweeps on hot paths");
		else {
			ready(runtime, boot);
			assert.throws(() => runtime.assertInvariants(teamId), /Invariant/u, "an explicit assertion always sweeps");
		}
	}
});

test("a repeated host message is a new request once the earlier one was processed, but pending duplicates collapse", () => {
	const { runtime, teamId } = makeRuntime([]);
	const boot = nextWorkless(runtime, teamId);
	const first = runtime.messageManager(teamId, "continue");
	assert.equal(first.status, "applied");
	const pending = runtime.messageManager(teamId, "continue");
	assert.deepEqual([pending.status, "eventId" in pending && pending.eventId], ["unchanged", "eventId" in first && first.eventId]);
	finish(runtime, boot);
	const next = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(next.input.scope.kind === "management" && next.input.scope.events.filter((event) => event.kind === "USER_COMMAND").length, 1);
	ready(runtime, next);
	runtime.handleAction(next.binding, next.scope, 1, "y", { action: "yield" }, "y");
	settle(runtime, next, "", "y");
	const again = runtime.messageManager(teamId, "continue");
	assert.equal(again.status, "applied", "the processed message does not swallow a later identical one");
	assert.notEqual("eventId" in again && again.eventId, "eventId" in first && first.eventId);
	const wake = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(wake.input.scope.kind === "management" && wake.input.scope.events.filter((event) => event.kind === "USER_COMMAND").map((event) => event.message), ["continue"]);
	runtime.assertInvariants(teamId);
});

function nextWorkless(runtime: TeamRuntime, teamId: string): RuntimeActivation {
	const boot = runtime.takeNextActivation(teamId)!;
	ready(runtime, boot);
	return boot;
}

function finish(runtime: TeamRuntime, boot: RuntimeActivation): void {
	runtime.handleAction(boot.binding, boot.scope, 1, "boot", { action: "yield" }, "boot");
	settle(runtime, boot, "", "boot");
}

test("releasing a budget hold keeps the Team flagged while a member is still faulted", () => {
	const { runtime, teamId } = makeRuntime([{ to: "w1", task: "tools" }], { limits: { rootToolCalls: 1 }, claimW2: true });
	const work = nextWork(runtime, teamId);
	assert.deepEqual(runtime.gate(work.binding, work.scope, "provider_gate"), { allow: true });
	assert.deepEqual(runtime.gate(work.binding, work.scope, "tool_gate", "t1", "read"), { allow: true });
	assert.equal(runtime.gate(work.binding, work.scope, "tool_gate", "t2", "read").allow, false);
	settle(runtime, work, "stopped by budget");
	assert.equal(runtime.getWork(teamId, work.scope.work!)!.current.hold?.reason, "budget");
	runtime.hostStopMember(teamId, "w2", "stopped for the test");
	assert.equal(runtime.getTeam(teamId).health, "needs_attention");
	runtime.grantBudget(teamId, { kind: "root", rootId: work.scope.work!.workId }, { rootToolCalls: 1 }, "One more tool call.");
	assert.equal(runtime.getWork(teamId, work.scope.work!)!.current.hold, undefined, "the budget hold was released");
	assert.equal(runtime.getTeam(teamId).health, "needs_attention", "the faulted w2 still needs attention");
	runtime.assertInvariants(teamId);
});

test("quiescence events are keyed by a fixed-size digest, not the O(works) signature", () => {
	const requests = Array.from({ length: 8 }, (_, index) => ({ to: index % 2 ? "w2" : "w1", task: `work ${index}` }));
	const { runtime, teamId } = makeRuntime(requests, { limits: { workerPermits: 1 } });
	for (let index = 0; index < requests.length; index++) settle(runtime, nextWork(runtime, teamId), `done ${index}`);
	for (let index = 0; index < 3; index++) {
		const activation = runtime.takeNextActivation(teamId);
		if (!activation) break;
		ready(runtime, activation);
		runtime.handleAction(activation.binding, activation.scope, 1, `q${index}`, { action: "yield" }, `q${index}`);
		settle(runtime, activation, "", `q${index}`);
	}
	const keys = internals(runtime).team(teamId).events.filter((event) => event.kind === "TEAM_QUIESCENT").map((event) => event.key);
	assert.ok(keys.length > 0, "the Team reached quiescence");
	for (const key of keys) assert.match(key, /^quiescent:[0-9a-f]{40}$/u);
});

test("a natural final whose summary exceeds the codec's text item limit is protocol-held, one at the limit commits", () => {
	for (const [bytes, state] of [[TEAM_MAX_TEXT_ITEM_BYTES + 1, "blocked"], [TEAM_MAX_TEXT_ITEM_BYTES, "resolved"]] as const) {
		const { runtime, teamId } = makeRuntime([{ to: "w1", task: "answer" }]);
		const work = nextWork(runtime, teamId);
		settle(runtime, work, "x".repeat(bytes));
		const current = runtime.getWork(teamId, work.scope.work!)!.current;
		assert.equal(current.state, state);
		if (state === "blocked") assert.equal(current.hold?.reason, "protocol");
		else assert.equal(runtime.getResult(teamId, current.resultRef!)?.result.summary.length, bytes, "a committed result stays decodable");
		runtime.assertInvariants(teamId);
	}
});
