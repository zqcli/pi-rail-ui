import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamRuntime, type NativeCompletion, type RuntimeActivation } from "../../tools/subagents/team-runtime";
import { WorkLedger } from "../../tools/subagents/team-work-ledger";
import { TEAM_VIEW_MAX_BUDGET_ROOTS, type TeamBudgetLimits, type WorkRef } from "../../tools/subagents/team-protocol";
import { emptySubagentUsage } from "../../tools/subagents/usage";

function world(limits?: Partial<TeamBudgetLimits>) {
	let id = 0;
	// Keep production invariant checks and the default long budget enabled, including in the load test.
	const runtime = new TeamRuntime({ now: () => 1_700_000_000_000, createId: () => `view-${++id}`, ...(limits ? { limits } : {}) });
	const { teamId } = runtime.prepare({
		members: ["lead", "parent", "worker", "other", "faulted", "reviewer"].map((alias) => ({ alias, roleDescription: "Work." })),
		lead: "lead", brief: { goal: "Inspect current Team counts." }, initialRequests: [], timeoutSeconds: null,
		review: { by: "reviewer", everyMinutes: 60 },
	});
	runtime.launch(teamId);
	const sequences = new Map<string, number>();
	const call = (activation: RuntimeActivation, args: unknown) => {
		const sequence = (sequences.get(activation.scope.activationId) ?? 0) + 1;
		sequences.set(activation.scope.activationId, sequence);
		const callId = `call-${sequence}`;
		const reply = runtime.handleAction(activation.binding, activation.scope, sequence, callId, args, callId);
		assert.equal(reply.ok, true, JSON.stringify(reply));
		return reply;
	};
	const settle = (activation: RuntimeActivation, completion: NativeCompletion = {
		status: "success", appliedToolCallId: `call-${sequences.get(activation.scope.activationId)}`,
	}) => {
		assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, completion).ok, true);
		assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
	};
	const end = (activation: RuntimeActivation, args: unknown) => { call(activation, args); settle(activation); };
	const take = (member: string) => {
		const activation = runtime.takeNextActivation(teamId)!;
		assert.equal(activation?.binding.memberId, member);
		assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
		return activation;
	};
	const request = (activation: RuntimeActivation, to: string): WorkRef => {
		const reply = call(activation, { action: "request", to, task: `Task for ${to}.` });
		assert.ok(reply.ok && reply.receipt?.status === "accepted");
		return reply.receipt.work;
	};
	const reply = (activation: RuntimeActivation) => end(activation, { action: "reply", result: { status: "succeeded", summary: "Done." } });
	const lead = take("lead");
	return { runtime, teamId, lead, call, settle, end, take, request, reply };
}

/** Independent public-record calculation keeps the original counting semantics explicit. */
function assertCounts({ runtime, teamId }: ReturnType<typeof world>) {
	const summaries = runtime.listWorks(teamId);
	const records = summaries.map((summary) => runtime.getWork(teamId, summary.work)!);
	const roots = summaries.filter((work) => !work.parent && work.kind !== "review");
	const current = records.map((record) => record.current);
	const count = (state: string) => current.filter((version) => version.state === state).length;
	const view = runtime.getTeam(teamId);
	assert.deepEqual(view.works, {
		total: current.length, queued: count("queued"), running: count("running"), blocked: count("blocked"),
		held: current.filter((version) => !!version.hold).length, resolved: count("resolved"), failed: count("failed"),
		cancelled: count("cancelled") + count("superseded"), roots: roots.length, rootsReviewed: roots.filter((root) => !!root.review).length,
	});
	for (const member of view.members) {
		const owned = records.filter((record) => record.assignee === member.id).map((record) => record.current);
		assert.deepEqual([member.queued, member.blocked, member.held], [
			owned.filter((version) => version.state === "queued").length,
			owned.filter((version) => version.state === "blocked").length,
			owned.filter((version) => !!version.hold).length,
		]);
	}
	const budget = runtime.inspectBudget(teamId);
	assert.deepEqual(budget.roots.map((root) => [root.rootId, root.used.rootChildren]), roots.map((root) => [root.work.workId,
		records.filter((record) => record.rootId === root.work.workId && record.parent !== undefined).length]));
	for (const root of view.budget.roots) assert.deepEqual(root, budget.roots.find((item) => item.rootId === root.rootId));
	runtime.assertInvariants(teamId);
	return view;
}

test("Team views count current states and holds, retain descendants across revisions, and exclude reviews only from roots", () => {
	const w = world();
	const a = w.request(w.lead, "parent");
	const b = w.request(w.lead, "worker");
	w.request(w.lead, "worker");
	w.request(w.lead, "faulted");
	const cancelled = w.request(w.lead, "other");
	assertCounts(w);
	const parent = w.take("parent");
	const worker = w.take("worker");
	const failed = w.take("faulted");
	const child = w.request(parent, "other");
	w.end(parent, { action: "yield", waitingFor: [child], checkpoint: "Wait for child." });
	w.settle(failed, { status: "error", error: { code: "NATIVE_FAILURE", message: "Stopped." } });
	const childRun = w.take("other");
	const grandchild = w.request(childRun, "worker");
	w.end(childRun, { action: "yield", waitingFor: [grandchild], checkpoint: "Wait for grandchild." });
	w.reply(worker);
	w.call(w.lead, { action: "control", command: "accept_result", work: b, disposition: "accepted" });
	assertCounts(w);
	w.reply(w.take("worker"));
	w.reply(w.take("other"));
	w.reply(w.take("parent"));
	w.call(w.lead, { action: "control", command: "revise_work", workId: a.workId, expectedRevision: 1, task: "Second pass.", inputRefs: [] });
	const revised = w.take("parent");
	const nextChild = w.request(revised, "other");
	w.end(revised, { action: "yield", waitingFor: [nextChild], checkpoint: "Wait for second-pass child." });
	w.call(w.lead, { action: "control", command: "cancel_work", workId: cancelled.workId, expectedRevision: 1, reason: "No longer needed." });
	w.take("other");
	w.end(w.take("worker"), { action: "yield", attention: "Need a decision.", checkpoint: "Waiting." });
	const review = w.runtime.reviewNow(w.teamId).work;
	const view = assertCounts(w);
	assert.deepEqual(view.works, { total: 9, queued: 1, running: 1, blocked: 2, held: 1, resolved: 3, failed: 1, cancelled: 1, roots: 5, rootsReviewed: 1 });
	assert.equal(w.runtime.inspectBudget(w.teamId).roots[0]!.used.rootChildren, 3, "both generations and the grandchild count once");
	assert.equal(view.members.find((member) => member.id === "reviewer")!.queued, 1);
	assert.equal(view.budget.roots.some((root) => root.rootId === review.workId), false);
	assert.equal(w.runtime.getWork(w.teamId, { ...a, revision: 2 })!.currentRevision, 2);
});

test("bounded root budgets keep exhausted, granted and used creation order, omit untouched roots and stay fresh after grants", () => {
	const w = world({ rootActivations: 2 });
	const roots = Array.from({ length: 40 }, () => w.request(w.lead, "parent"));
	for (const root of roots) {
		const activation = w.take("parent");
		assert.deepEqual(activation.scope.work, root);
		w.reply(activation);
	}
	for (const index of [5, 33]) {
		w.call(w.lead, { action: "control", command: "revise_work", workId: roots[index]!.workId, expectedRevision: 1, task: "Revise.", inputRefs: [] });
		w.reply(w.take("parent"));
	}
	// Reverse grant order must not change the root creation order within the granted group.
	for (const index of [39, 34, 0]) w.runtime.hostControl(w.teamId).grant({ kind: "root", rootId: roots[index]!.workId }, { rootChildren: 1 }, "More children.");
	const untouched = w.request(w.lead, "parent");
	const view = assertCounts(w);
	const ranked = [5, 33, 0, 34, 39, ...roots.map((_, index) => index).filter((index) => ![5, 33, 0, 34, 39].includes(index))];
	assert.deepEqual(view.budget.roots.map((root) => root.rootId), ranked.slice(0, TEAM_VIEW_MAX_BUDGET_ROOTS).map((index) => roots[index]!.workId));
	assert.equal(view.budget.rootsOmitted, roots.length - TEAM_VIEW_MAX_BUDGET_ROOTS);
	assert.equal(w.runtime.inspectBudget(w.teamId).roots.at(-1)!.rootId, untouched.workId);
	w.runtime.hostControl(w.teamId).grant({ kind: "root", rootId: untouched.workId }, { rootChildren: 1 }, "Make untouched root visible.");
	const after = assertCounts(w);
	assert.equal(after.budget.roots[5]!.rootId, untouched.workId);
	assert.equal(after.budget.rootsOmitted, roots.length + 1 - TEAM_VIEW_MAX_BUDGET_ROOTS);
});

test("Team view samples live usage once per active member and freezes native usage before cleanup", () => {
	const w = world();
	w.request(w.lead, "parent");
	const parent = w.take("parent");
	w.runtime.setMemberContextWindow(w.teamId, "parent", 1000);
	const calls: string[] = [];
	w.runtime.setLiveUsageSource((_teamId, member) => {
		calls.push(member);
		return { ...emptySubagentUsage(), input: member === "lead" ? 10 : 20, output: 5, contextTokens: 100, turns: 1, searches: 1 };
	});
	const view = w.runtime.getTeam(w.teamId);
	assert.deepEqual(calls, ["lead", "parent"]);
	assert.deepEqual([view.usage.input, view.usage.output, view.usage.turns, view.usage.searches, view.usage.contextTokens], [30, 10, 2, 2, 100]);
	assert.deepEqual(view.members.slice(0, 2).map((member) => member.usage.input), [10, 20]);
	assert.deepEqual(view.members[1]!.context, { used: 0, window: 1000, percent: 0 }, "context remains the settled member observation");
	w.call(parent, { action: "reply", result: { status: "succeeded", summary: "Done." } });
	assert.equal(w.runtime.nativeSettled(parent.binding, parent.scope.activationId, {
		status: "success", appliedToolCallId: "call-1", usage: { ...emptySubagentUsage(), input: 20, contextTokens: 100, turns: 1 },
	}).ok, true);
	calls.length = 0;
	const settled = w.runtime.getTeam(w.teamId);
	assert.deepEqual(calls, ["lead"], "settled native usage must not be sampled or added twice while cleanup is pending");
	assert.equal(settled.members[1]!.activity, "settling");
	assert.equal(settled.usage.input, 30);
	assert.equal(settled.members[1]!.usage.input, 20);
	assert.equal(w.runtime.cleanupFinished(parent.binding, parent.scope.activationId, { ok: true }).ok, true);
	calls.length = 0;
	const cleaned = w.runtime.getTeam(w.teamId);
	assert.deepEqual(calls, ["lead"]);
	assert.deepEqual(cleaned.usage, settled.usage);
	assert.deepEqual(cleaned.members[1]!.usage, settled.members[1]!.usage);
});

test("perf: Team view and full budget inspection read the ledger linearly across 128 roots and 1152 works", (t) => {
	const w = world();
	for (let index = 0; index < 128; index++) {
		w.request(w.lead, "parent");
		const root = w.take("parent");
		const children = Array.from({ length: 8 }, () => w.request(root, "worker"));
		w.end(root, { action: "yield", waitingFor: children, checkpoint: "Wait for all children." });
		for (const _child of children) w.reply(w.take("worker"));
		w.reply(w.take("parent"));
	}
	w.runtime.assertInvariants(w.teamId);
	const total = 1152;
	const get = WorkLedger.prototype.get;
	let reads = 0;
	const spy = t.mock.method(WorkLedger.prototype, "get", function (this: WorkLedger, id: string) { reads++; return get.call(this, id); });
	const view = w.runtime.getTeam(w.teamId);
	const viewReads = reads;
	reads = 0;
	const budget = w.runtime.inspectBudget(w.teamId);
	const budgetReads = reads;
	spy.mock.restore();
	assert.deepEqual([view.works.total, view.works.resolved, view.works.roots], [total, total, 128]);
	assert.equal(budget.roots.length, 128);
	assert.ok(budget.roots.every((root) => root.used.rootChildren === 8));
	const measure = (run: () => unknown) => {
		for (let index = 0; index < 5; index++) run();
		const start = performance.now();
		for (let index = 0; index < 20; index++) run();
		return (performance.now() - start) / 20;
	};
	const viewMs = measure(() => w.runtime.getTeam(w.teamId));
	const budgetMs = measure(() => w.runtime.inspectBudget(w.teamId));
	t.diagnostic(`128 roots / ${total} works: view ${viewMs.toFixed(2)} ms (${viewReads} ledger reads), budget ${budgetMs.toFixed(2)} ms (${budgetReads} reads)`);
	// Counts, rather than a wall-clock threshold, catch the roots × works regression on any host.
	assert.ok(viewReads <= 2 * total, `view scanned the ledger ${viewReads / total} times`);
	assert.ok(budgetReads <= 2 * total, `budget scanned the ledger ${budgetReads / total} times`);
});
