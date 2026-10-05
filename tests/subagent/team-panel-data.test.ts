import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTeamAction, normalizeTeamPlan, normalizeTitle, normalizeTeamResult, parseTeamReply } from "../../tools/subagents/team-codec";
import { restoreTeamHistory } from "../../tools/subagents/team-history";
import { TEAM_JOURNAL_ENTRY_TYPE, TeamJournalGeneration, type TeamJournalRecord } from "../../tools/subagents/team-journal";
import { TeamRuntime, type RuntimeActivation, type NativeCompletion } from "../../tools/subagents/team-runtime";
import { emptySubagentUsage } from "../../tools/subagents/usage";

const plan = {
	members: [{ alias: "lead", roleDescription: "Coordinate" }, { alias: "worker", roleDescription: "Implement" }, { alias: "qa", roleDescription: "Review" }],
	lead: "lead", brief: { goal: "Implement version 0.6.0. Then release it." },
};
const usage = (input: number, output = 0) => ({ ...emptySubagentUsage(), input, output, cacheRead: input * 2, cacheWrite: input, cost: input / 1000, turns: 1 });
const recordsAsEntries = (records: TeamJournalRecord[]) => records.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data }));

function fixture(initialRequests: Array<{ to: string; task: string; title?: string }> = []) {
	const clock = { at: 1000 };
	let ids = 0;
	const records: TeamJournalRecord[] = [];
	const runtime = new TeamRuntime({ now: () => clock.at, createId: () => `id${++ids}`, journal: new TeamJournalGeneration((record) => records.push(record)) });
	const { teamId } = runtime.prepare({ ...plan, title: "Version 0.6 release", initialRequests });
	runtime.launch(teamId);
	return { runtime, teamId, clock, records };
}

function next(runtime: TeamRuntime, teamId: string): RuntimeActivation {
	const activation = runtime.takeNextActivation(teamId)!;
	assert.ok(activation);
	assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
	return activation;
}
function action(runtime: TeamRuntime, activation: RuntimeActivation, input: unknown, sequence = 1) {
	const reply = runtime.handleAction(activation.binding, activation.scope, sequence, `call${sequence}`, input, `call${sequence}`);
	assert.equal(reply.ok, true, JSON.stringify(reply));
	return reply;
}
function settle(runtime: TeamRuntime, activation: RuntimeActivation, completion: NativeCompletion = { status: "success", appliedToolCallId: "call1" }) {
	assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, completion).ok, true);
	assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
}
function boot(runtime: TeamRuntime, teamId: string) {
	const activation = next(runtime, teamId);
	assert.equal(activation.scope.kind, "events");
	action(runtime, activation, { action: "yield" });
	settle(runtime, activation);
}

test("new Team IDs are unique eight-character lowercase base32 codes, including session-history collisions", () => {
	const runtime = new TeamRuntime();
	const ids = new Set<string>();
	for (let index = 0; index < 24; index++) {
		const view = runtime.prepare(plan);
		assert.match(view.teamId, /^[a-z2-7]{8}$/u);
		assert.equal(view.shortId, view.teamId);
		assert.equal(ids.has(view.teamId), false);
		ids.add(view.teamId);
		runtime.cancelTeam(view.teamId, "Free prepared capacity");
	}
	const generated = ["history1", "abc23456", "leadEpoch", "workerEpoch", "qaEpoch", "abc23456", "def23456", "leadEpoch2", "workerEpoch2", "qaEpoch2"];
	const injected = new TeamRuntime({ createId: () => generated.shift()!, existingTeamIds: () => ["history1"] });
	assert.equal(injected.prepare(plan).teamId, "abc23456", "history collision is retried");
	assert.equal(injected.prepare(plan).teamId, "def23456", "runtime collision is retried");
	const uuid = "3ce7a106-734b-4f49-a270-924fa00a4c61";
	let calls = 0;
	const old = new TeamRuntime({ createId: () => calls++ === 0 ? uuid : `epoch${calls}` });
	assert.equal(old.prepare(plan).shortId, "3ce7a106", "injected old UUIDs retain their full identity and display prefix");
});

test("prepare, request, and revise titles validate one line and 60 Unicode characters; fallback is the first sentence", () => {
	assert.equal(normalizeTeamPlan(plan).title, "Implement version 0.6.0.");
	assert.equal(normalizeTeamPlan({ ...plan, title: "Release candidate" }).title, "Release candidate");
	assert.equal(normalizeTitle(undefined, "One line!\nAnother sentence."), "One line!");
	assert.equal(normalizeTitle(undefined, "界 ".repeat(80)), "界 ".repeat(30).trim(), "truncation cannot leave trailing spaces that private parsing would trim differently");
	assert.equal(normalizeTitle(undefined, "界".repeat(80)), "界".repeat(60));
	assert.equal(normalizeTitle(undefined, "🚂".repeat(80)), "🚂".repeat(60));
	assert.equal(normalizeTitle("🚂".repeat(60), ""), "🚂".repeat(60));
	for (const title of ["", " ", "x".repeat(61), "🚂".repeat(61), "first\nsecond", "first\rsecond", "first\u2028second", 1, {}]) {
		assert.throws(() => normalizeTeamPlan({ ...plan, title }), /title/u);
		assert.throws(() => normalizeTeamAction({ action: "request", to: "worker", task: "Implement.", title }), /title/u);
		assert.throws(() => normalizeTeamAction({ action: "control", command: "revise_work", workId: "work:1", expectedRevision: 1, task: "Revise.", title }), /title/u);
	}
	assert.throws(() => normalizeTeamPlan({ ...plan, title: "\ud800" }), /UTF-8/u);
	assert.throws(() => normalizeTeamAction({ action: "request", to: "worker", task: "Task", title: "\ud800" }), /UTF-8/u);
	assert.throws(() => normalizeTeamAction({ action: "yield", title: "Not a request" }), /not used/u);
	const { runtime, teamId } = fixture([{ to: "worker", task: "First sentence. Second sentence." }]);
	assert.equal(runtime.listWorks(teamId)[0]!.title, "First sentence.");
	const lead = next(runtime, teamId);
	const request = action(runtime, lead, { action: "request", to: "qa", title: "Standalone QA", task: "Inspect all boundaries. Report bugs." });
	assert.ok(request.ok && request.receipt?.status === "accepted");
	const work = runtime.listWorks(teamId).find((work) => work.assignee === "qa")!;
	assert.equal(work.title, "Standalone QA");
	assert.match(runtime.panelFacts(teamId).timeline.at(-1)!.text, /«Standalone QA» → qa/u);
	const status = { ok: true, from: "@hub", to: "lead", data: { view: "work", items: [work], hasMore: false } };
	assert.deepEqual(parseTeamReply(status), status, "titles survive the model-facing codec");
});

test("revision preserves a work title unless explicitly renamed and totals span all revisions", () => {
	const { runtime, teamId, clock } = fixture([{ to: "worker", title: "Agent release", task: "Implement release." }]);
	boot(runtime, teamId);
	const first = next(runtime, teamId);
	clock.at += 1000;
	settle(runtime, first, { status: "success", finalAssistantText: "First version", usage: usage(10) });
	const lead = next(runtime, teamId);
	const work = first.scope.work!;
	action(runtime, lead, { action: "control", command: "revise_work", workId: work.workId, expectedRevision: 1, task: "Use the public structured error field." });
	action(runtime, lead, { action: "yield" }, 2);
	settle(runtime, lead, { status: "success", appliedToolCallId: "call2" });
	assert.equal(runtime.listWorks(teamId)[0]!.title, "Agent release");
	const second = next(runtime, teamId);
	clock.at += 2000;
	settle(runtime, second, { status: "success", finalAssistantText: "Second version", usage: usage(20) });
	assert.equal(runtime.workStats(teamId, work).activeMs, 3000);
	assert.equal(runtime.workStats(teamId, second.scope.work!).usage.input, 30);
	assert.equal(runtime.memberStats(teamId, "worker").activeMs, 3000);
	const revise = next(runtime, teamId);
	action(runtime, revise, { action: "control", command: "revise_work", workId: work.workId, expectedRevision: 2, title: "Final Agent candidate", task: "Recheck the release." });
	assert.equal(runtime.listWorks(teamId)[0]!.title, "Final Agent candidate");
});

test("work and member active time and tokens include resumed in-flight activations exactly once and exclude host pause", async () => {
	const { runtime, teamId, clock, records } = fixture([{ to: "worker", title: "Agent release", task: "Implement the Agent." }]);
	const lead = next(runtime, teamId);
	action(runtime, lead, { action: "yield" });
	settle(runtime, lead, { status: "success", appliedToolCallId: "call1", usage: usage(5) });
	const first = next(runtime, teamId);
	const childReply = action(runtime, first, { action: "request", to: "qa", title: "Standalone QA", task: "Review the Agent." });
	assert.ok(childReply.ok && childReply.receipt?.status === "accepted");
	const child = childReply.receipt.work;
	clock.at += 1000;
	action(runtime, first, { action: "yield", waitingFor: [child], checkpoint: "Waiting for QA" }, 2);
	settle(runtime, first, { status: "success", appliedToolCallId: "call2", usage: usage(10) });
	const qa = next(runtime, teamId);
	clock.at += 2000;
	settle(runtime, qa, { status: "success", finalAssistantText: "QA passed", usage: usage(20) });
	const resumed = next(runtime, teamId);
	assert.deepEqual(resumed.scope.work, first.scope.work);
	runtime.setLiveUsageSource((_id, member) => member === "worker" ? usage(7, 3) : undefined);
	clock.at += 500;
	const work = first.scope.work!;
	assert.equal(runtime.workStats(teamId, work).activeMs, 1500);
	assert.equal(runtime.workStats(teamId, work).usage.input, 17);
	assert.equal(runtime.memberStats(teamId, "worker").usage.input, 17);
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "worker")!.usage.input, 17);
	assert.equal(runtime.getTeam(teamId).usage.input, 42, "Team includes work tokens plus the lead's non-work activation");
	assert.equal(runtime.getTeam(teamId).usage.output, 3);
	runtime.pauseTeam(teamId);
	clock.at += 9000;
	assert.deepEqual(runtime.teamTime(teamId), { activeMs: 3500, wallMs: 12500, pausedMs: 9000, startedAt: 1000 });
	assert.equal(runtime.memberStats(teamId, "worker").activeMs, 1500, "host pause never inflates member busy time");
	runtime.continueTeam(teamId);
	clock.at += 500;
	const completion: NativeCompletion = { status: "success", finalAssistantText: "Agent complete", usage: usage(7, 3) };
	assert.equal(runtime.nativeSettled(resumed.binding, resumed.scope.activationId, completion).ok, true);
	assert.equal(runtime.nativeSettled(resumed.binding, resumed.scope.activationId, completion).ok, true);
	assert.equal(runtime.workStats(teamId, work).activeMs, 2000);
	assert.equal(runtime.workStats(teamId, work).usage.input, 17, "live usage is not added again after settlement");
	assert.equal(runtime.getTeam(teamId).usage.input, 42);
	clock.at += 2000;
	assert.equal(runtime.memberStats(teamId, "worker").activeMs, 2000, "native cleanup is not active member time");
	runtime.cleanupFinished(resumed.binding, resumed.scope.activationId, { ok: true });
	assert.equal(runtime.memberStats(teamId, "worker").activeMs / runtime.teamTime(teamId).activeMs, 1 / 3);
	runtime.cancelTeam(teamId, "Finish accounting test");
	runtime.attachCleanupExecutor(teamId, { runActivation: async () => undefined, closeMember: async () => ({ ok: true }) });
	await runtime.waitForCompletion(teamId);
	const terminal = records.find((record) => record.kind === "terminal")!;
	assert.ok(terminal.kind === "terminal");
	assert.equal(terminal.activeMs, 6000);
	assert.equal(terminal.memberStats!.find((member) => member.id === "worker")!.activeMs, 2000);
	const history = restoreTeamHistory(recordsAsEntries(records));
	assert.equal(history.skipped, 0);
	assert.equal(history.teams[0]!.activeMs, 6000);
	assert.deepEqual(history.teams[0]!.memberStats, terminal.memberStats);
	const frozen = runtime.teamTime(teamId);
	clock.at += 5000;
	assert.deepEqual(runtime.teamTime(teamId), frozen, "terminal wall/active/paused time freezes");
});

test("lost activation accounting freezes native time and usage once even while cleanup is unknown", () => {
	const { runtime, teamId, clock } = fixture([{ to: "worker", task: "Implement." }]);
	boot(runtime, teamId);
	const activation = next(runtime, teamId);
	clock.at += 1000;
	const error = { code: "TRANSPORT_LOST", message: "Connection lost" };
	runtime.activationLost(activation.binding, activation.scope.activationId, error, false, usage(8));
	clock.at += 5000;
	assert.equal(runtime.memberStats(teamId, "worker").activeMs, 1000);
	assert.equal(runtime.workStats(teamId, activation.scope.work!).usage.input, 8);
	assert.equal(runtime.getTeam(teamId).usage.input, 8);
});

test("task lifecycle retains each awaited WorkRef and title after dependencies settle", () => {
	const { runtime, teamId } = fixture([{ to: "worker", title: "Agent release", task: "Implement the Agent." }]);
	boot(runtime, teamId);
	const owner = next(runtime, teamId);
	const child = action(runtime, owner, { action: "request", to: "qa", title: "Standalone QA r5", task: "Review the Agent." });
	assert.ok(child.ok && child.receipt?.status === "accepted");
	action(runtime, owner, { action: "yield", waitingFor: [child.receipt.work], checkpoint: "Await standalone QA" }, 2);
	settle(runtime, owner, { status: "success", appliedToolCallId: "call2" });
	const owningRef = runtime.listWorks(teamId).find((work) => work.assignee === "worker")!.work;
	const waitingRef = child.receipt.work;
	const expected = `worker ended work ${owningRef.workId.slice(5)}@1 (waiting on qa · work ${waitingRef.workId.slice(5)}@1 «Standalone QA r5»)`;
	assert.ok(runtime.panelFacts(teamId).timeline.some((entry) => entry.text === expected));
	const reviewer = next(runtime, teamId);
	settle(runtime, reviewer, { status: "success", finalAssistantText: "QA passed" });
	assert.equal(runtime.panelFacts(teamId).stalled.has("worker"), false);
	assert.ok(runtime.panelFacts(teamId).timeline.some((entry) => entry.text === expected), "completed dependencies do not erase the lifecycle's exact wait evidence");
});

test("terminal accounting retains the final active interval and logical end across delayed cleanup and history reload", async () => {
	const { runtime, teamId, clock, records } = fixture();
	clock.at += 6000;
	runtime.cancelTeam(teamId, "Finish after an idle active interval");
	clock.at += 4000;
	runtime.attachCleanupExecutor(teamId, { runActivation: async () => undefined, closeMember: async () => ({ ok: true }) });
	await runtime.waitForCompletion(teamId);
	assert.equal(runtime.teamTime(teamId).activeMs, 6000);
	assert.equal(runtime.teamTime(teamId).wallMs, 6000);
	const terminal = records.find((record) => record.kind === "terminal")!;
	assert.ok(terminal.kind === "terminal");
	assert.equal(terminal.at, 11000, "the journal timestamp still records when cleanup committed");
	assert.equal(terminal.endedAt, 7000, "logical end freezes when cancellation stops the Team");
	const restored = restoreTeamHistory(recordsAsEntries(records));
	assert.equal(restored.skipped, 0);
	const entry = restored.teams[0]!;
	assert.equal(entry.at - entry.startedAt!, runtime.teamTime(teamId).wallMs);
	assert.equal(entry.at - entry.startedAt! - entry.activeMs!, 0, "cleanup delay is never presented as host pause");
	for (const endedAt of [0, 12000, -1, "7000", null]) {
		const invalid = records.map((record) => record.kind === "terminal" ? { ...record, endedAt } : record);
		assert.equal(restoreTeamHistory(invalid.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data }))).skipped, 1);
	}
});

test("started lifecycle milestone records the first start's queued duration", () => {
	const { runtime, teamId, clock } = fixture([{ to: "worker", title: "Agent release", task: "Implement the Agent." }]);
	boot(runtime, teamId);
	clock.at += 121000;
	const activation = next(runtime, teamId);
	assert.ok(runtime.panelFacts(teamId).timeline.some((entry) => entry.text === `worker started work ${activation.scope.work!.workId.slice(5)}@1 (queued 2:01)`));
});

test("live and terminal Team rename writes strict title records and history takes the latest", async () => {
	const { runtime, teamId, records } = fixture();
	assert.equal(records[0]!.kind, "launched");
	assert.ok(records[0]!.kind === "launched");
	assert.equal(records[0]!.title, "Version 0.6 release");
	runtime.renameTeam(teamId, "QA candidate");
	assert.equal(runtime.getTeam(teamId).title, "QA candidate");
	runtime.cancelTeam(teamId, "Done");
	runtime.attachCleanupExecutor(teamId, { runActivation: async () => undefined, closeMember: async () => ({ ok: true }) });
	await runtime.waitForCompletion(teamId);
	runtime.renameTeam(teamId, "Final release");
	const entries = recordsAsEntries(records);
	assert.equal(restoreTeamHistory(entries).teams[0]!.title, "Final release");
	for (const bad of [
		{ version: 2, kind: "title", teamId, at: 2000, title: "Invalid extra key", extra: true },
		{ version: 2, kind: "title", teamId, at: 2000 },
		{ version: 2, kind: "title", teamId, at: 2000, title: "x".repeat(61) },
	]) {
		const history = restoreTeamHistory([...entries, { type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: bad }]);
		assert.equal(history.skipped, 1);
		assert.equal(history.teams[0]!.title, "Final release");
	}
	const old = records[0]!;
	assert.ok(old.kind === "launched");
	const { title: _title, ...withoutTitle } = old;
	assert.equal(restoreTeamHistory([{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: withoutTitle }]).teams[0]!.title, "Implement version 0.6.0.");
});

test("terminal accounting strictly validates roster, counters and memberStats keys while old records remain valid", () => {
	const result = { version: 2, teamId: "history1", lifecycle: "cancelled", reason: "Finished", finalResultRefs: [], roots: [],
		members: [{ id: "lead", lifecycle: "closed", resourceState: "released" }, { id: "worker", lifecycle: "closed", resourceState: "released" }],
		usage: emptySubagentUsage(), unresolvedIncidents: [] };
	assert.doesNotThrow(() => normalizeTeamResult(result));
	const memberStats = [{ id: "lead", activeMs: 1000, usage: usage(2) }, { id: "worker", activeMs: 2000, usage: usage(3) }];
	assert.deepEqual(normalizeTeamResult({ ...result, activeMs: 3000, memberStats }).memberStats, memberStats);
	assert.throws(() => normalizeTeamResult({ ...result, activeMs: -1 }), /activeMs/u);
	assert.throws(() => normalizeTeamResult({ ...result, memberStats: [memberStats[0], memberStats[0]] }), /roster/u);
	assert.throws(() => normalizeTeamResult({ ...result, memberStats: [{ ...memberStats[0], extra: true }, memberStats[1]] }), /unexpected/u);
	assert.throws(() => normalizeTeamResult({ ...result, memberStats: [{ ...memberStats[0], activeMs: NaN }, memberStats[1]] }), /activeMs/u);
});
