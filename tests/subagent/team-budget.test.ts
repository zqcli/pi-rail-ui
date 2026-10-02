import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamProtocolError, normalizeTeamAction, parseParentCommand } from "../../tools/subagents/team-codec";
import { TEAM_MAX_BUDGET_GRANTS } from "../../tools/subagents/team-budget";
import { TEAM_JOURNAL_ENTRY_TYPE, TeamJournalGeneration, type TeamJournalRecord } from "../../tools/subagents/team-journal";
import { restoreTeamHistory } from "../../tools/subagents/team-history";
import { TeamRuntime, type NativeCompletion, type RuntimeActivation } from "../../tools/subagents/team-runtime";
import {
	TEAM_MAX_FRAME_BYTES, TEAM_MAX_NOTE_BYTES, TEAM_MAX_ROLE_BYTES, TEAM_MAX_TEXT_ITEM_BYTES, TEAM_MAX_MEMBERS, TEAM_STATUS_MAX_LIMIT,
	TEAM_VIEW_MAX_BUDGET_ROOTS, TEAM_VIEW_MAX_GRANTS, TEAM_VIEW_MAX_INCIDENTS,
	type GateDecision, type TeamBudgetLimits, type TeamTeamView, type WorkRef,
} from "../../tools/subagents/team-protocol";
import type { SubagentUsage } from "../../tools/subagents/session-broker";
import * as protocol from "../../tools/subagents/team-protocol";
import { normalizeTeamPlan, parseTeamReply } from "../../tools/subagents/team-codec";

interface Setup {
	budget?: "standard" | "long" | "unlimited";
	limits?: Partial<TeamBudgetLimits>;
	initialRequests?: Array<{ to: string; task: string }>;
	journal?: TeamJournalGeneration;
	launch?: boolean;
}

function makeRuntime({ limits = {}, initialRequests = [], journal, launch = true, budget }: Setup = {}) {
	let ids = 0;
	let time = 1_700_000_000_000;
	const runtime = new TeamRuntime({ now: () => time++, createId: () => `budget-${++ids}`, limits, ...(journal ? { journal } : {}) });
	const { teamId } = runtime.prepare({
		members: [{ alias: "lead", roleDescription: "Manage work, review roots and close the Team." }, { alias: "w1", roleDescription: "Perform work." }, { alias: "w2", roleDescription: "Perform work." }], lead: "lead",
		brief: { goal: "Exercise cumulative budgets." },
		...(budget ? { budget } : {}),
		initialRequests,
		timeoutSeconds: null,
	});
	if (launch) runtime.launch(teamId);
	return { runtime, teamId };
}

test("presets preserve standard safeguards, default to long, and apply runtime overrides per Team", () => {
	const { standard, long, unlimited } = protocol.TEAM_BUDGET_PRESETS;
	assert.equal(protocol.DEFAULT_TEAM_BUDGET, long);
	assert.equal(protocol.TEAM_BUDGET_UNLIMITED, 1_000_000_000);
	assert.deepEqual(standard, {
		workPermits: 4, memberUnresolvedWork: 64, teamWorks: 512, rootChildren: 64, depth: 8, workRevisions: 32,
		rootActivations: 128, teamActivations: 512, leadActivations: 128, activationModelRequests: 64,
		rootModelRequests: 256, teamModelRequests: 1024, activationToolCalls: 256, rootToolCalls: 1024,
		teamToolCalls: 4096, emergencyLeadActivations: 3, reservedResultBytes: 16 * 1024 * 1024,
	});
	assert.deepEqual(long, { ...standard, teamActivations: 4096, leadActivations: 1024, teamModelRequests: 8192,
		teamToolCalls: 32768, teamWorks: 4096, rootChildren: 512, rootActivations: 1024, rootModelRequests: 2048,
		rootToolCalls: 8192, workRevisions: 128, reservedResultBytes: 64 * 1024 * 1024 });
	assert.deepEqual(unlimited, { ...standard, teamActivations: 1_000_000_000, leadActivations: 1_000_000_000,
		teamModelRequests: 1_000_000_000, teamToolCalls: 1_000_000_000, rootActivations: 1_000_000_000,
		rootModelRequests: 1_000_000_000, rootToolCalls: 1_000_000_000, teamWorks: 20000, rootChildren: 2048,
		workRevisions: 512, reservedResultBytes: 256 * 1024 * 1024 });
	const runtime = new TeamRuntime({ limits: { workPermits: 2, teamActivations: 42 } });
	const oldPlan = { members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w1", roleDescription: "Work." }], lead: "lead", brief: { goal: "Presets." } };
	assert.equal(normalizeTeamPlan(oldPlan).budget, undefined, "old plans need no budget field");
	for (const preset of [undefined, "standard", "unlimited"] as const) {
		const view = runtime.prepare({ ...oldPlan, ...(preset ? { budget: preset } : {}) });
		assert.deepEqual(view.budget.limits, { ...protocol.TEAM_BUDGET_PRESETS[preset ?? "long"], workPermits: 2, teamActivations: 42 });
		assert.deepEqual(parseTeamReply({ ok: true, from: "@hub", to: "lead", data: view }), { ok: true, from: "@hub", to: "lead", data: view });
	}
});

test("preset raises preview and journal all limits, release only satisfied budget holds, and never lower grants", () => {
	const records: TeamJournalRecord[] = [];
	const journal = new TeamJournalGeneration((record) => records.push(record));
	const { runtime, teamId } = makeRuntime({ budget: "standard", limits: { teamActivations: 1 }, initialRequests: [{ to: "w1", task: "held root" }], journal });
	const manager = takeManager(runtime, teamId);
	end(runtime, manager, yieldNow);
	nextWork(runtime, teamId);
	assert.equal(runtime.listHolds(teamId)[0]?.reason, "budget");
	const before = runtime.inspectBudget(teamId);
	const journalLength = records.length;
	const preview = runtime.previewRaiseBudget(teamId, "long");
	assert.deepEqual(runtime.inspectBudget(teamId), before);
	assert.equal(records.length, journalLength, "preview does not journal");
	assert.equal(preview.released.length, 1);
	for (const counter of ["teamWorks", "rootChildren", "workRevisions", "reservedResultBytes", "rootActivations", "rootModelRequests", "rootToolCalls"]) {
		assert.ok(preview.changes.some((change) => change.counter === counter), counter);
	}
	const receipt = runtime.raiseBudget(teamId, "long");
	assert.ok("released" in receipt);
	assert.deepEqual(receipt.released, preview.released);
	const after = runtime.inspectBudget(teamId);
	assert.deepEqual(after.limits, protocol.TEAM_BUDGET_PRESETS.long);
	assert.deepEqual(after.used, before.used);
	assert.equal(after.roots[0]!.limits.rootActivations, 1024);
	assert.equal(runtime.listHolds(teamId).length, 0);
	const grant = records.findLast((record) => record.kind === "grant");
	assert.equal(grant?.grant.preset, "long");
	assert.equal(grant?.grant.increments.teamWorks, 4096 - 512);
	assert.equal(restoreTeamHistory(records.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data }))).skipped, 0);
	const eventBatch = takeManager(runtime, teamId);
	assert.ok(eventBatch.input.scope.kind === "events" && eventBatch.input.scope.events.some((event) => event.kind === "USER_COMMAND" && event.message?.includes("Raise to long")));
	const count = records.length;
	assert.equal(runtime.raiseBudget(teamId, "standard").status, "unchanged");
	assert.deepEqual(runtime.previewRaiseBudget(teamId, "long").changes, []);
	assert.equal(records.length, count);
	runtime.grantBudget(teamId, { kind: "team" }, { teamActivations: 1_000_000_000 }, "extra");
	runtime.raiseBudget(teamId, "unlimited");
	assert.equal(runtime.inspectBudget(teamId).limits.teamActivations, 1_000_004_096);
	assert.equal(runtime.inspectBudget(teamId).roots[0]!.limits.rootModelRequests, 1_000_000_000);
	assert.deepEqual(parseTeamReply({ ok: true, from: "@hub", to: "lead", data: runtime.getTeam(teamId) }), { ok: true, from: "@hub", to: "lead", data: runtime.getTeam(teamId) });
});

test("a preset raise fails closed before mutating limits when its grant journal fails", () => {
	const { runtime, teamId } = makeRuntime({ budget: "standard", journal: new TeamJournalGeneration((record) => {
		if (record.kind === "grant") throw new Error("fake disk failure");
	}) });
	const limits = runtime.inspectBudget(teamId).limits;
	assert.throws(() => runtime.raiseBudget(teamId, "long"), /journal/u);
	assert.deepEqual(runtime.inspectBudget(teamId).limits, limits);
	assert.equal(runtime.inspectBudget(teamId).grants.length, 0);
});

test("a preset raise rejects effective-root overflow before applying or journaling any limit", () => {
	const records: TeamJournalRecord[] = [];
	const { runtime, teamId } = makeRuntime({ budget: "standard", initialRequests: [{ to: "w1", task: "root" }], journal: new TeamJournalGeneration((record) => records.push(record)) });
	const rootId = runtime.listWorks(teamId)[0]!.work.workId;
	runtime.grantBudget(teamId, { kind: "root", rootId }, { rootModelRequests: Number.MAX_SAFE_INTEGER - 256 }, "near the safe limit");
	const before = runtime.inspectBudget(teamId);
	const count = records.length;
	assert.throws(() => runtime.previewRaiseBudget(teamId, "long"), /safe integer/u);
	assert.throws(() => runtime.raiseBudget(teamId, "long"), /safe integer/u);
	assert.deepEqual(runtime.inspectBudget(teamId), before);
	assert.equal(records.length, count);
});

let calls = 0;
function act(runtime: TeamRuntime, activation: RuntimeActivation, args: unknown) {
	const id = `call-${++calls}`;
	const sequence = calls;
	return { id, reply: runtime.handleAction(activation.binding, activation.scope, sequence, id, args, id) };
}

function ok(runtime: TeamRuntime, activation: RuntimeActivation, args: unknown) {
	const result = act(runtime, activation, args);
	assert.equal(result.reply.ok, true, JSON.stringify(result.reply));
	return result;
}

function errorCode(runtime: TeamRuntime, activation: RuntimeActivation, args: unknown): string | undefined {
	const { reply } = act(runtime, activation, args);
	return reply.ok ? undefined : reply.error.code;
}

function ready(runtime: TeamRuntime, activation: RuntimeActivation): void {
	assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
}

function settle(runtime: TeamRuntime, activation: RuntimeActivation, completion: NativeCompletion): void {
	const settled = runtime.nativeSettled(activation.binding, activation.scope.activationId, completion);
	assert.equal(settled.ok, true, JSON.stringify(settled));
	const cleaned = runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true });
	assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
}

/** Stage an end intent and settle it as confirmed by the native transcript. */
function end(runtime: TeamRuntime, activation: RuntimeActivation, args: unknown, usage?: SubagentUsage): void {
	const { id } = ok(runtime, activation, args);
	settle(runtime, activation, { status: "success", appliedToolCallId: id, ...(usage ? { usage } : {}) });
}

const yieldNow = { action: "yield" };
const replyWith = (summary: string) => ({ action: "reply", result: { status: "succeeded", summary } });

/** Take the next activation, letting idle Manager batches yield until a worker (or nothing) is next. */
function nextWork(runtime: TeamRuntime, teamId: string, manager?: (activation: RuntimeActivation) => void): RuntimeActivation | undefined {
	for (let index = 0; index < 20; index++) {
		const activation = runtime.takeNextActivation(teamId);
		if (!activation || activation.scope.kind === "work") {
			if (activation) ready(runtime, activation);
			return activation;
		}
		ready(runtime, activation);
		if (manager) manager(activation);
		else end(runtime, activation, yieldNow);
	}
	throw new Error("Manager kept taking activations");
}

function takeManager(runtime: TeamRuntime, teamId: string): RuntimeActivation {
	const activation = runtime.takeNextActivation(teamId);
	assert.equal(activation?.scope.kind, "events");
	ready(runtime, activation!);
	return activation!;
}

function acceptedWork(reply: ReturnType<typeof act>["reply"]): WorkRef {
	assert.ok(reply.ok && reply.receipt?.status === "accepted", JSON.stringify(reply));
	return reply.receipt.work;
}

function denial(decision: GateDecision): string | undefined {
	return decision.allow ? undefined : decision.reason;
}

function rootView(team: TeamTeamView, rootId: string) {
	const root = team.budget.roots.find((item) => item.rootId === rootId);
	assert.ok(root, `missing budget view for ${rootId}`);
	return root;
}

function openBudgetIncidents(team: TeamTeamView) {
	return team.incidents.filter((incident) => incident.code === "BUDGET_HIT" && incident.state === "open");
}

test("G05/G08: new child IDs accumulate on the same root until it holds; unrelated roots continue; a root grant resumes the same work", () => {
	const { runtime, teamId } = makeRuntime({ limits: { rootActivations: 2 }, initialRequests: [{ to: "w1", task: "root A" }, { to: "w1", task: "root B" }] });
	const rootA = nextWork(runtime, teamId)!;
	const refA = rootA.scope.work!;
	const child1 = acceptedWork(ok(runtime, rootA, { action: "request", to: "w2", task: "child with a fresh id" }).reply);
	const child2 = acceptedWork(ok(runtime, rootA, { action: "request", to: "w2", task: "another fresh id" }).reply);
	end(runtime, rootA, { action: "yield", waitingFor: [child1, child2], checkpoint: "wait for both children" });

	const rootB = nextWork(runtime, teamId)!;
	assert.equal(rootB.scope.work!.workId !== refA.workId && rootB.binding.memberId, "w1");
	const first = nextWork(runtime, teamId)!;
	assert.deepEqual(first.scope.work, child1);
	end(runtime, first, replyWith("child 1 done"));
	// Root A has now used both of its activations; its next child cannot start.
	assert.equal(nextWork(runtime, teamId), undefined);
	const held = runtime.getWork(teamId, child2)!.current;
	assert.equal(held.state, "blocked");
	assert.equal(held.hold?.reason, "budget");
	let team = runtime.getTeam(teamId);
	const incidents = openBudgetIncidents(team);
	assert.equal(incidents.length, 1, "one deduplicated incident per exhausted root");
	assert.equal(incidents[0]!.rootId, refA.workId);
	assert.equal(incidents[0]!.work, undefined, "the incident is root scoped, not per work item");
	assert.equal(held.hold?.incidentId, incidents[0]!.id);
	assert.deepEqual(rootView(team, refA.workId).used, { rootActivations: 2, rootModelRequests: 0, rootToolCalls: 0, rootChildren: 2 });

	// G08: the unrelated root still runs and settles.
	end(runtime, rootB, replyWith("root B done"));
	assert.equal(runtime.getWork(teamId, rootB.scope.work!)!.current.state, "resolved");

	const receipt = runtime.hostControl(teamId).grant({ kind: "root", rootId: refA.workId }, { rootActivations: 2 }, "allow root A to finish");
	assert.equal(receipt.actor, "@host");
	assert.ok(receipt.status === "applied" && "released" in receipt);
	assert.deepEqual(receipt.released, [child2]);
	team = runtime.getTeam(teamId);
	assert.equal(openBudgetIncidents(team).length, 0);
	assert.deepEqual(rootView(team, refA.workId).limits.rootActivations, 4);
	assert.equal(rootView(team, refA.workId).used.rootActivations, 2, "a grant never resets counters");
	assert.equal(team.budget.limits.rootActivations, 2, "a root grant affects only that root");
	assert.deepEqual(team.budget.grants.map(({ actor, scope, increments }) => ({ actor, scope, increments })),
		[{ actor: "@host", scope: { kind: "root", rootId: refA.workId }, increments: { rootActivations: 2 } }]);
	const resumed = nextWork(runtime, teamId)!;
	assert.deepEqual(resumed.scope.work, child2, "the same held WorkRef continues after the grant");
	runtime.assertInvariants(teamId);
});

test("G06: revisions keep accumulating root activations instead of resetting them", () => {
	const { runtime, teamId } = makeRuntime({ limits: { rootActivations: 2 }, initialRequests: [{ to: "w1", task: "draft" }] });
	const first = nextWork(runtime, teamId)!;
	const ref = first.scope.work!;
	end(runtime, first, replyWith("draft v1"));
	const revise = (revision: number, task: string) => (manager: RuntimeActivation) => {
		ok(runtime, manager, { action: "control", command: "revise_work", workId: ref.workId, expectedRevision: revision, task, inputRefs: [] });
		end(runtime, manager, yieldNow);
	};
	const second = nextWork(runtime, teamId, revise(1, "draft v2 with different words"))!;
	assert.deepEqual(second.scope.work, { workId: ref.workId, revision: 2 });
	end(runtime, second, replyWith("draft v2"));
	assert.equal(nextWork(runtime, teamId, revise(2, "draft v3")), undefined);
	const third = runtime.getWork(teamId, { workId: ref.workId, revision: 3 })!.current;
	assert.equal(third.hold?.reason, "budget");
	assert.equal(rootView(runtime.getTeam(teamId), ref.workId).used.rootActivations, 2);
	runtime.assertInvariants(teamId);
});

test("G07/G09: new roots cannot evade the Team budget; the Manager gets bounded restricted emergency activations, then only the host", () => {
	const { runtime, teamId } = makeRuntime({ limits: { teamActivations: 3 } });
	const boot = takeManager(runtime, teamId);
	const roots = ["r1", "r2", "r3"].map((task, index) => acceptedWork(ok(runtime, boot, { action: "request", to: index === 1 ? "w2" : "w1", task }).reply));
	end(runtime, boot, yieldNow);
	const r1 = runtime.takeNextActivation(teamId)!;
	const r2 = runtime.takeNextActivation(teamId)!;
	ready(runtime, r1);
	ready(runtime, r2);
	end(runtime, r1, replyWith("r1 done"));
	end(runtime, r2, replyWith("r2 done"));

	const emergency = takeManager(runtime, teamId);
	assert.equal(emergency.input.scope.kind === "events" && emergency.input.scope.emergency, true);
	assert.equal(runtime.takeNextActivation(teamId), undefined, "a fresh root still waits on the exhausted Team budget");
	let team = runtime.getTeam(teamId);
	assert.equal(runtime.getWork(teamId, roots[2]!)!.current.hold?.reason, "budget");
	assert.equal(openBudgetIncidents(team).length, 1);
	assert.equal(openBudgetIncidents(team)[0]!.rootId, undefined, "Team exhaustion is attributed to the Team");
	assert.equal(team.budget.used.teamActivations, 3);
	assert.equal(team.budget.used.emergencyLeadActivations, 1);
	assert.equal(errorCode(runtime, emergency, { action: "request", to: "w1", task: "new root" }), "BUDGET_BLOCKED");
	assert.equal(errorCode(runtime, emergency, { action: "control", command: "revise_work", workId: roots[0]!.workId, expectedRevision: 1, task: "redo", inputRefs: [] }), "BUDGET_BLOCKED");
	ok(runtime, emergency, { action: "status", view: "team" });
	ok(runtime, emergency, { action: "control", command: "accept_result", work: roots[0]!, disposition: "accepted" });
	end(runtime, emergency, yieldNow);
	assert.throws(() => normalizeTeamAction({ action: "control", command: "grant_budget", scope: "team" }), TeamProtocolError, "the model has no grant action");

	for (let used = 2; used <= 3; used++) {
		runtime.hostControl(teamId).message_lead(`emergency ${used}`);
		const next = takeManager(runtime, teamId);
		assert.equal(next.input.scope.kind === "events" && next.input.scope.emergency, true);
		end(runtime, next, yieldNow);
	}
	runtime.hostControl(teamId).message_lead("no more automatic Manager calls");
	assert.equal(runtime.takeNextActivation(teamId), undefined, "exhausted emergency budget leaves only host control");
	team = runtime.getTeam(teamId);
	assert.equal(team.budget.used.emergencyLeadActivations, 3);
	assert.equal(team.budget.used.teamActivations, 3, "emergency activations are counted separately");

	const grant = runtime.hostControl(teamId).grant({ kind: "team" }, { teamActivations: 2 }, "continue after review");
	assert.ok(grant.status === "applied" && "released" in grant);
	assert.deepEqual(grant.released, [roots[2]]);
	const normal = takeManager(runtime, teamId);
	assert.equal(normal.input.scope.kind === "events" && normal.input.scope.emergency, false);
	end(runtime, normal, yieldNow);
	const r3 = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(r3.scope.work, roots[2]);
	team = runtime.getTeam(teamId);
	assert.equal(team.budget.limits.teamActivations, 5);
	assert.equal(team.budget.used.teamActivations, 5);
	assert.equal(team.budget.used.emergencyLeadActivations, 3, "a grant never resets used counters");
	runtime.assertInvariants(teamId);
});

test("gates: every observable provider request counts, including a retry, and exhaustion is a budget hold", () => {
	const { runtime, teamId } = makeRuntime({ limits: { activationModelRequests: 2 }, initialRequests: [{ to: "w1", task: "bounded" }] });
	const held = nextWork(runtime, teamId)!;
	const gate = () => runtime.gate(held.binding, held.scope, "provider_gate");
	assert.deepEqual(gate(), { allow: true });
	assert.deepEqual(gate(), { allow: true }, "an observable provider retry is its own counted request");
	assert.equal(denial(gate()), "budget");
	assert.equal(runtime.getTeam(teamId).budget.used.teamModelRequests, 2, "a denied request is not counted");
	settle(runtime, held, { status: "aborted" });
	assert.equal(runtime.getWork(teamId, held.scope.work!)!.current.hold?.reason, "budget");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.lifecycle, "open", "budget hold is not a member fault");
	runtime.assertInvariants(teamId);
});

test("gates: invalid end intents consume tool budget; one charged final attempt lets a legal reply finish", () => {
	const { runtime, teamId } = makeRuntime({ limits: { activationToolCalls: 2, activationModelRequests: 5 }, initialRequests: [{ to: "w2", task: "finishes" }] });
	const work = nextWork(runtime, teamId)!;
	const gate = (phase: "provider_gate" | "tool_gate", toolCallId?: string, toolName?: string, endIntent = false) =>
		runtime.gate(work.binding, work.scope, phase, toolCallId, toolName, endIntent);
	let sequence = 0;
	const attempt = (id: string, args: unknown) => {
		assert.deepEqual(gate("tool_gate", id, "team", true), { allow: true });
		assert.deepEqual(gate("tool_gate", id, "team", true), { allow: true }, "a repeated preflight of the same native call is not charged again");
		const reply = runtime.handleAction(work.binding, work.scope, ++sequence, id, args, id);
		assert.equal(runtime.toolResult(work.binding, work.scope, id, "team").ok, true);
		return reply;
	};
	const toolCalls = () => rootView(runtime.getTeam(teamId), work.scope.work!.workId).used.rootToolCalls;
	assert.deepEqual(gate("provider_gate"), { allow: true });
	assert.equal(attempt("bad-yield", { action: "yield", waitingFor: [{ workId: "missing-work", revision: 1 }] }).ok, false);
	assert.deepEqual(gate("provider_gate"), { allow: true });
	assert.equal(attempt("bad-idle-yield", { action: "yield" }).ok, false, "a worker cannot use the Manager idle yield");
	assert.equal(toolCalls(), 2, "failed end intents are real, charged tool attempts");
	assert.deepEqual(gate("provider_gate"), { allow: true });
	assert.equal(attempt("final-reply", replyWith("finished at the limit")).ok, true, "one end intent may still run after exhaustion");
	assert.equal(toolCalls(), 3, "the final attempt is charged too");
	settle(runtime, work, { status: "success", appliedToolCallId: "final-reply" });
	assert.equal(runtime.getWork(teamId, work.scope.work!)!.current.state, "resolved");
	runtime.assertInvariants(teamId);
});

test("gates: repeated invalid end intents cannot bypass exhaustion; the next attempt and request stop as a budget hold", () => {
	const { runtime, teamId } = makeRuntime({ limits: { activationToolCalls: 1, activationModelRequests: 10 }, initialRequests: [{ to: "w1", task: "loops" }] });
	const work = nextWork(runtime, teamId)!;
	const gate = (phase: "provider_gate" | "tool_gate", toolCallId?: string) =>
		runtime.gate(work.binding, work.scope, phase, toolCallId, toolCallId ? "team" : undefined, toolCallId !== undefined);
	const invalid = { action: "yield", waitingFor: [{ workId: "missing-work", revision: 1 }] };
	assert.deepEqual(gate("provider_gate"), { allow: true });
	assert.deepEqual(gate("tool_gate", "bad-1"), { allow: true });
	assert.equal(runtime.handleAction(work.binding, work.scope, 1, "bad-1", invalid, "bad-1").ok, false);
	runtime.toolResult(work.binding, work.scope, "bad-1", "team");
	assert.deepEqual(gate("provider_gate"), { allow: true });
	assert.deepEqual(gate("tool_gate", "bad-2"), { allow: true }, "the single post-exhaustion end-intent attempt");
	assert.equal(runtime.handleAction(work.binding, work.scope, 2, "bad-2", invalid, "bad-2").ok, false);
	runtime.toolResult(work.binding, work.scope, "bad-2", "team");
	assert.deepEqual(gate("provider_gate"), { allow: true });
	assert.equal(denial(gate("tool_gate", "bad-3")), "budget", "no further end-intent attempt is admitted");
	runtime.toolResult(work.binding, work.scope, "bad-3", "team");
	assert.equal(denial(gate("provider_gate")), "budget", "the activation stops at its next provider safe point");
	settle(runtime, work, { status: "aborted" });
	const version = runtime.getWork(teamId, work.scope.work!)!.current;
	assert.equal(version.hold?.reason, "budget");
	assert.equal(rootView(runtime.getTeam(teamId), work.scope.work!.workId).used.rootToolCalls, 2, "refused attempts are not charged");
	runtime.assertInvariants(teamId);
});

test("gates: tool-budget denials that end naturally become a budget hold, not a protocol failure", () => {
	const { runtime, teamId } = makeRuntime({ limits: { rootToolCalls: 1 }, initialRequests: [{ to: "w1", task: "tools" }] });
	const work = nextWork(runtime, teamId)!;
	assert.deepEqual(runtime.gate(work.binding, work.scope, "provider_gate"), { allow: true });
	assert.deepEqual(runtime.gate(work.binding, work.scope, "tool_gate", "t1", "read"), { allow: true });
	assert.equal(denial(runtime.gate(work.binding, work.scope, "tool_gate", "t2", "read")), "budget");
	settle(runtime, work, { status: "success", finalAssistantText: "stopped by budget" });
	const version = runtime.getWork(teamId, work.scope.work!)!.current;
	assert.equal(version.state, "blocked");
	assert.equal(version.hold?.reason, "budget");
	const incident = runtime.getTeam(teamId).incidents.find((item) => item.id === version.hold?.incidentId);
	assert.equal(incident?.rootId, work.scope.work!.workId);
	assert.equal(runtime.getTeam(teamId).incidents.some((item) => item.code === "PROTOCOL_FAILURE"), false);
	runtime.assertInvariants(teamId);
});

test("C04: a parked pause resumed after exhaustion stops at budget, and grants never lift attention or pause holds", async () => {
	const { runtime, teamId } = makeRuntime({ limits: { activationModelRequests: 1 }, initialRequests: [{ to: "w1", task: "paused" }, { to: "w2", task: "attention" }] });
	const paused = nextWork(runtime, teamId)!;
	const attention = nextWork(runtime, teamId)!;
	end(runtime, attention, { action: "yield", attention: "needs a human check", checkpoint: "stopped" });
	assert.deepEqual(runtime.gate(paused.binding, paused.scope, "provider_gate"), { allow: true });
	runtime.hostControl(teamId).message_lead("pause w1");
	const pauseManager = takeManager(runtime, teamId);
	ok(runtime, pauseManager, { action: "control", command: "pause_member", memberId: "w1" });
	end(runtime, pauseManager, yieldNow);
	const parked = runtime.waitAtProviderGate(paused.binding, paused.scope);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.pause, "confirmed");
	runtime.hostControl(teamId).message_lead("resume w1");
	const resumeManager = takeManager(runtime, teamId);
	ok(runtime, resumeManager, { action: "control", command: "resume_member", memberId: "w1" });
	end(runtime, resumeManager, yieldNow);
	const decision = await parked;
	assert.equal(decision.allow === false && decision.reason, "budget", "resume does not bypass the budget");
	settle(runtime, paused, { status: "aborted" });
	assert.equal(runtime.getWork(teamId, paused.scope.work!)!.current.hold?.reason, "budget");

	const grant = runtime.hostControl(teamId).grant({ kind: "team" }, { teamModelRequests: 1 }, "lift budget only");
	assert.ok(grant.status === "applied" && "released" in grant);
	assert.deepEqual(grant.released, [paused.scope.work], "only the budget hold is released");
	assert.equal(runtime.getWork(teamId, attention.scope.work!)!.current.hold?.reason, "attention");
	assert.equal(runtime.getTeam(teamId).health, "needs_attention", "the attention incident stays open");
	runtime.assertInvariants(teamId);
});

test("X05: root child capacity rejects before admission; grants validate everything before applying anything", () => {
	const { runtime, teamId } = makeRuntime({ limits: { rootChildren: 1 }, initialRequests: [{ to: "w1", task: "parent" }] });
	const parent = nextWork(runtime, teamId)!;
	const root = parent.scope.work!;
	const child = acceptedWork(ok(runtime, parent, { action: "request", to: "w2", task: "first child" }).reply);
	const before = runtime.getTeam(teamId);
	assert.equal(errorCode(runtime, parent, { action: "request", to: "w2", task: "second child" }), "BUDGET_BLOCKED");
	assert.equal(runtime.getTeam(teamId).works.total, before.works.total, "rejected admission leaves no ledger side effect");

	const host = runtime.hostControl(teamId);
	const rejects = (scope: Parameters<typeof host.grant>[0], increments: Record<string, number>, reason = "why", code = "INVALID_ARGUMENT") =>
		assert.throws(() => host.grant(scope, increments, reason), (error: unknown) => error instanceof TeamProtocolError && error.code === code);
	rejects({ kind: "root", rootId: root.workId }, { teamActivations: 1 });
	rejects({ kind: "team" }, { activationToolCalls: 1, teamActivations: 1 });
	rejects({ kind: "team" }, { rootChildren: 1, teamActivations: 1 });
	rejects({ kind: "root", rootId: root.workId }, { rootChildren: 0 });
	rejects({ kind: "root", rootId: root.workId }, { rootChildren: 1.5 });
	rejects({ kind: "root", rootId: root.workId }, { rootChildren: 1, rootToolCalls: -1 });
	rejects({ kind: "team" }, { teamActivations: Number.MAX_SAFE_INTEGER });
	rejects({ kind: "root", rootId: root.workId }, {});
	rejects({ kind: "root", rootId: root.workId }, { rootChildren: 1 }, "");
	rejects({ kind: "root", rootId: child.workId }, { rootChildren: 1 }, "why", "UNKNOWN_WORK");
	rejects({ kind: "root", rootId: "missing" }, { rootChildren: 1 }, "why", "UNKNOWN_WORK");
	const unchanged = runtime.getTeam(teamId);
	assert.deepEqual(unchanged.budget.grants, []);
	assert.deepEqual(unchanged.budget.limits, before.budget.limits);

	host.grant({ kind: "root", rootId: root.workId }, { rootChildren: 1 }, "one more child");
	acceptedWork(ok(runtime, parent, { action: "request", to: "w2", task: "second child" }).reply);
	assert.equal(rootView(runtime.getTeam(teamId), root.workId).used.rootChildren, 2);
	runtime.assertInvariants(teamId);
});

test("X08: host cancel of a budget-held Team explains both causes and later grants are refused", () => {
	const { runtime, teamId } = makeRuntime({ limits: { teamActivations: 2 }, initialRequests: [{ to: "w1", task: "a" }, { to: "w2", task: "b" }] });
	const first = nextWork(runtime, teamId)!;
	assert.equal(runtime.takeNextActivation(teamId), undefined, "the second root waits on the exhausted Team budget");
	const emergency = runtime.takeNextActivation(teamId)!;
	assert.equal(emergency.input.scope.kind === "events" && emergency.input.scope.emergency, true, "the budget incident reaches the Manager once");
	ready(runtime, emergency);
	const page = ok(runtime, emergency, { action: "status", view: "work" }).reply;
	const items = page.ok && page.data && "view" in page.data && page.data.view === "work" ? page.data.items : [];
	const blocked = items.find((item) => "hold" in item && item.hold === "budget");
	assert.ok(blocked && "work" in blocked);
	const cancelled = runtime.hostControl(teamId).cancel_team("user stop");
	assert.equal(cancelled.status, "applied");
	assert.equal(runtime.hostControl(teamId).cancel_team("user stop").status, "unchanged");
	const team = runtime.getTeam(teamId);
	assert.equal(team.lifecycle, "cancelled");
	assert.equal(runtime.getWork(teamId, first.scope.work!)!.current.state, "cancelled");
	assert.equal(runtime.getWork(teamId, blocked.work)!.current.state, "cancelled");
	assert.equal(openBudgetIncidents(team).length, 1, "the budget cause stays visible after cancellation");
	assert.throws(() => runtime.hostControl(teamId).grant({ kind: "team" }, { teamActivations: 1 }, "too late"),
		(error: unknown) => error instanceof TeamProtocolError && error.code === "RECIPIENT_CLOSING");
	runtime.assertInvariants(teamId);
});

test("usage: one fold per activation, repeats never double-bill, contextTokens keeps the latest value", () => {
	const { runtime, teamId } = makeRuntime({ initialRequests: [{ to: "w1", task: "u1" }, { to: "w1", task: "u2" }] });
	const usage = (input: number, contextTokens: number): SubagentUsage => ({ input, output: 1, cacheRead: 2, cacheWrite: 3, cost: 0.5, contextTokens, turns: 1 });
	const boot = takeManager(runtime, teamId);
	end(runtime, boot, yieldNow, usage(5, 700));
	const first = nextWork(runtime, teamId)!;
	const { id } = ok(runtime, first, replyWith("u1"));
	const completion = { status: "success", appliedToolCallId: id, usage: usage(10, 900) } as const;
	settle(runtime, first, completion);
	assert.equal(runtime.nativeSettled(first.binding, first.scope.activationId, completion).ok, true, "an exact late duplicate is idempotent");
	assert.throws(() => runtime.nativeSettled(first.binding, first.scope.activationId, { ...completion, usage: usage(1000, 1) }),
		(error: unknown) => error instanceof TeamProtocolError, "a conflicting late settlement is rejected, not billed");
	const second = nextWork(runtime, teamId)!;
	end(runtime, second, replyWith("u2"), usage(20, 0));
	const team = runtime.getTeam(teamId);
	assert.deepEqual(team.members.find((member) => member.id === "lead")?.usage, usage(5, 700));
	assert.deepEqual(team.members.find((member) => member.id === "w1")?.usage,
		{ input: 30, output: 2, cacheRead: 4, cacheWrite: 6, cost: 1, contextTokens: 900, turns: 2 });
	assert.deepEqual(team.usage, { input: 35, output: 3, cacheRead: 6, cacheWrite: 9, cost: 1.5, contextTokens: 900, turns: 3 });
	runtime.assertInvariants(teamId);
});

function journal(failOn?: (record: TeamJournalRecord) => boolean) {
	const records: TeamJournalRecord[] = [];
	const generation = new TeamJournalGeneration((record) => {
		if (failOn?.(record)) throw new Error(`disk full at ${record.kind}`);
		records.push(structuredClone(record));
	});
	return { records, generation };
}

function closeSucceeded(runtime: TeamRuntime, teamId: string): void {
	const work = nextWork(runtime, teamId)!;
	runtime.gate(work.binding, work.scope, "provider_gate");
	end(runtime, work, replyWith("done"));
	const manager = takeManager(runtime, teamId);
	ok(runtime, manager, { action: "status", view: "team" });
	const resultRef = runtime.getWork(teamId, work.scope.work!)!.current.resultRef!;
	ok(runtime, manager, { action: "control", command: "accept_result", work: work.scope.work!, disposition: "accepted" });
	const { id, reply } = ok(runtime, manager, { action: "control", command: "close_team", outcome: "succeeded", resultRefs: [resultRef] });
	assert.ok(reply.ok && reply.receipt?.status === "closing");
	settle(runtime, manager, { status: "success", appliedToolCallId: id });
	for (const memberId of ["w1", "w2", "lead"]) {
		assert.equal(runtime.memberReleased(runtime.bindingForDriver(teamId, memberId), reply.receipt.closeId, { ok: true }).ok, true);
	}
}

test("journal: bounded critical facts only, written before publish, terminal written once; the generation deactivates permanently", () => {
	const { records, generation } = journal();
	const { runtime, teamId } = makeRuntime({ initialRequests: [{ to: "w1", task: "journaled" }], journal: generation });
	closeSucceeded(runtime, teamId);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closed");
	runtime.getTeamResult(teamId);
	assert.deepEqual(records.map((record) => record.kind), ["launched", "result", "close_decision", "terminal"],
		"gates, ACKs, status and cleanup never write history");
	assert.ok(records.every((record) => JSON.stringify(record).length < 4096), "no full-ledger snapshots");
	const terminal = records.at(-1)!;
	assert.equal(terminal.kind === "terminal" && terminal.result.lifecycle, "closed");
	generation.deactivate();
	assert.equal(generation.active, false);
	assert.throws(() => generation.write({ version: 2, kind: "launched", teamId, at: 0,
		roster: { lead: "lead", members: ["lead", "w1", "w2"] }, goal: "journaled" }), /inactive/);
	runtime.assertInvariants(teamId);
});

test("actual Runtime terminal journal records round-trip through the strict history codec", () => {
	const { records, generation } = journal();
	const { runtime, teamId } = makeRuntime({ initialRequests: [{ to: "w1", task: "journaled round trip" }], journal: generation });
	closeSucceeded(runtime, teamId);
	const restored = restoreTeamHistory(records.map((record) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: record })));
	assert.equal(restored.skipped, 0);
	assert.equal(restored.teams.length, 1);
	const [entry] = restored.teams;
	assert.equal(entry?.lifecycle, "closed");
	assert.equal(entry?.outcome, "succeeded");
	assert.equal(entry?.results.length, 1);
	assert.deepEqual(entry?.results[0], runtime.getResult(teamId, runtime.getTeamResult(teamId)!.finalResultRefs[0]!));
});

test("journal: a lost terminal write reports the Team as failed, never as a clean close", () => {
	const { generation } = journal((record) => record.kind === "terminal");
	const { runtime, teamId } = makeRuntime({ initialRequests: [{ to: "w1", task: "journaled" }], journal: generation });
	closeSucceeded(runtime, teamId);
	const result = runtime.getTeamResult(teamId);
	assert.equal(result?.lifecycle, "failed");
	assert.match(runtime.getTeam(teamId).reason ?? "", /journal/i);
});

test("journal: a failed result write never publishes the result and fails the Team closed", () => {
	const { generation } = journal((record) => record.kind === "result");
	const { runtime, teamId } = makeRuntime({ initialRequests: [{ to: "w1", task: "lost" }], journal: generation });
	const work = nextWork(runtime, teamId)!;
	end(runtime, work, replyWith("unjournaled"));
	const version = runtime.getWork(teamId, work.scope.work!)!.current;
	assert.equal(version.state, "failed");
	assert.equal(version.error?.code, "JOURNAL_FAILURE");
	assert.equal(version.resultRef, undefined);
	const team = runtime.getTeam(teamId);
	assert.equal(team.lifecycle, "failed");
	assert.match(team.reason ?? "", /journal/i);
	assert.equal(runtime.takeNextActivation(teamId), undefined, "no Manager is scheduled on a failed Team");
	runtime.assertInvariants(teamId);
});

test("journal: close decision and grant failures refuse the mutation; launch failure ends the Team as failed", () => {
	{
		const { generation } = journal((record) => record.kind === "launched");
		const { runtime, teamId } = makeRuntime({ journal: generation, launch: false });
		assert.throws(() => runtime.launch(teamId), (error: unknown) => error instanceof TeamProtocolError && error.code === "PROTOCOL_FAILURE");
		assert.equal(runtime.getTeam(teamId).lifecycle, "failed");
		assert.ok(runtime.getTeamResult(teamId)?.members.every((member) => member.resourceState === "released"), "unclaimed pure-runtime members need no native cleanup");
		assert.equal(runtime.takeNextActivation(teamId), undefined);
	}
	{
		const { generation } = journal((record) => record.kind === "close_decision");
		const { runtime, teamId } = makeRuntime({ journal: generation });
		const manager = takeManager(runtime, teamId);
		assert.equal(errorCode(runtime, manager, { action: "control", command: "close_team", outcome: "failed", resultRefs: [], reason: "stop" }), "PROTOCOL_FAILURE");
		const team = runtime.getTeam(teamId);
		assert.equal(team.lifecycle, "failed", "a lost close decision fails closed instead of closing silently");
		assert.equal(team.outcome, undefined);
	}
	{
		const { generation } = journal((record) => record.kind === "grant");
		const { runtime, teamId } = makeRuntime({ journal: generation });
		const before = runtime.getTeam(teamId).budget.limits;
		assert.throws(() => runtime.hostControl(teamId).grant({ kind: "team" }, { teamActivations: 1 }, "grant"),
			(error: unknown) => error instanceof TeamProtocolError && error.code === "PROTOCOL_FAILURE");
		const team = runtime.getTeam(teamId);
		assert.deepEqual(team.budget.limits, before);
		assert.deepEqual(team.budget.grants, []);
		assert.equal(team.lifecycle, "failed");
	}
	{
		const { generation } = journal();
		const { runtime, teamId } = makeRuntime({ journal: generation });
		generation.deactivate();
		assert.throws(() => runtime.hostControl(teamId).grant({ kind: "team" }, { teamActivations: 1 }, "after switch"),
			(error: unknown) => error instanceof TeamProtocolError && error.code === "PROTOCOL_FAILURE");
	}
});

test("usage: loss keeps observed cost once; settle/lost races and repeats never double-bill; cancellation keeps its cost", () => {
	const { runtime, teamId } = makeRuntime({ initialRequests: [{ to: "w1", task: "lost" }, { to: "w2", task: "settled then lost" }] });
	const usage = (input: number, contextTokens: number): SubagentUsage => ({ input, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens, turns: 1 });
	const lost = nextWork(runtime, teamId)!;
	const settled = nextWork(runtime, teamId)!;
	const lostError = { code: "NATIVE_OUTCOME_UNKNOWN", message: "socket closed", outcomeUnknown: true };
	assert.equal(runtime.activationLost(lost.binding, lost.scope.activationId, lostError, true, usage(7, 300)).ok, true);
	assert.equal(runtime.activationLost(lost.binding, lost.scope.activationId, lostError, true, usage(7, 300)).ok, true, "a repeated loss report is idempotent");
	assert.throws(() => runtime.nativeSettled(lost.binding, lost.scope.activationId, { status: "success", usage: usage(50, 1) }),
		TeamProtocolError, "a late settlement after isolation is rejected, not billed");

	assert.equal(runtime.nativeSettled(settled.binding, settled.scope.activationId, { status: "aborted", usage: usage(11, 400) }).ok, true);
	assert.throws(() => runtime.activationLost(settled.binding, settled.scope.activationId, lostError, true, usage(99, 1)), TeamProtocolError,
		"a settled activation cannot additionally be billed as lost");
	assert.equal(runtime.cleanupFinished(settled.binding, settled.scope.activationId, { ok: true }).ok, true);

	let team = runtime.getTeam(teamId);
	assert.equal(team.members.find((member) => member.id === "w1")?.usage.input, 7);
	assert.equal(team.members.find((member) => member.id === "w2")?.usage.input, 11);
	assert.equal(team.usage.contextTokens, 400, "contextTokens keeps the latest metric");

	// Host cancellation while an activation runs: the aborted native settlement still carries its real cost.
	const { runtime: cancelRuntime, teamId: cancelTeamId } = makeRuntime({ initialRequests: [{ to: "w1", task: "cancelled" }] });
	const running = nextWork(cancelRuntime, cancelTeamId)!;
	cancelRuntime.hostControl(cancelTeamId).cancel_team("user stop");
	settle(cancelRuntime, running, { status: "aborted", usage: usage(13, 500) });
	team = cancelRuntime.getTeam(cancelTeamId);
	assert.equal(team.lifecycle, "cancelled");
	assert.equal(team.members.find((member) => member.id === "w1")?.usage.input, 13);
	assert.equal(team.usage.input, 13);

	// Malformed loss evidence cannot block isolation and is not billed.
	const { runtime: badRuntime, teamId: badTeamId } = makeRuntime({ initialRequests: [{ to: "w1", task: "bad usage" }] });
	const bad = nextWork(badRuntime, badTeamId)!;
	assert.equal(badRuntime.activationLost(bad.binding, bad.scope.activationId, lostError, true, { ...usage(1, 1), input: -1 }).ok, true);
	assert.equal(badRuntime.getTeam(badTeamId).usage.input, 0);
});

test("9.4: activation input carries the tightest current scope budget summary", () => {
	const { runtime, teamId } = makeRuntime({ limits: { rootActivations: 2, rootModelRequests: 5, activationModelRequests: 3, leadActivations: 2 },
		initialRequests: [{ to: "w1", task: "summarised" }] });
	const boot = takeManager(runtime, teamId);
	assert.deepEqual(boot.input.budget, { emergency: false, modelRequests: 3, toolCalls: 256, activations: 1 });
	end(runtime, boot, yieldNow);
	const work = runtime.takeNextActivation(teamId)!;
	assert.deepEqual(work.input.budget, { emergency: false, modelRequests: 3, toolCalls: 256, activations: 1 });
	ready(runtime, work);
	for (let index = 0; index < 3; index++) assert.deepEqual(runtime.gate(work.binding, work.scope, "provider_gate"), { allow: true });
	assert.equal(denial(runtime.gate(work.binding, work.scope, "provider_gate")), "budget");
	settle(runtime, work, { status: "aborted" });
	assert.equal(runtime.getWork(teamId, work.scope.work!)!.current.hold?.reason, "budget");
	runtime.hostControl(teamId).grant({ kind: "root", rootId: work.scope.work!.workId }, { rootActivations: 1 }, "continue");
	const again = nextWork(runtime, teamId)!;
	assert.deepEqual(again.input.budget, { emergency: false, modelRequests: 2, toolCalls: 256, activations: 1 }, "root model requests left: 5 - 3; root activations left: 3 - 2");
	const hold = { action: "yield", attention: "stop here", checkpoint: "held" };
	end(runtime, again, hold);
	runtime.hostControl(teamId).message_lead("status");
	const emergency = takeManager(runtime, teamId);
	assert.deepEqual(emergency.input.budget, { emergency: true, modelRequests: 3, toolCalls: 256, activations: 2 });
});

test("grant validation rejects a safe-integer overflow of any raised limit atomically, before the journal", () => {
	const near = Number.MAX_SAFE_INTEGER - 10;
	const { records, generation } = journal();
	const { runtime, teamId } = makeRuntime({ limits: { rootModelRequests: near, teamToolCalls: near }, initialRequests: [{ to: "w1", task: "root" }], journal: generation });
	const work = nextWork(runtime, teamId)!;
	const rootId = work.scope.work!.workId;
	const host = runtime.hostControl(teamId);
	host.grant({ kind: "root", rootId }, { rootModelRequests: 5 }, "root headroom");
	const before = runtime.getTeam(teamId);
	const journalBefore = records.length;
	const overflow = (scope: Parameters<typeof host.grant>[0], increments: Record<string, number>) =>
		assert.throws(() => host.grant(scope, increments, "overflow"), (error: unknown) => error instanceof TeamProtocolError && error.code === "INVALID_ARGUMENT");
	// The earlier root grant counts toward the root's effective limit; a valid sibling field is not applied either.
	overflow({ kind: "root", rootId }, { rootToolCalls: 1, rootModelRequests: 6 });
	overflow({ kind: "team" }, { teamActivations: 1, teamToolCalls: 11 });
	const after = runtime.getTeam(teamId);
	assert.equal(records.length, journalBefore, "nothing is journaled for a rejected grant");
	assert.deepEqual(after.budget.limits, before.budget.limits);
	assert.deepEqual(after.budget.grants, before.budget.grants);
	assert.deepEqual(rootView(after, rootId).limits, rootView(before, rootId).limits);
	host.grant({ kind: "root", rootId }, { rootModelRequests: 5 }, "exactly reaches the safe limit");
	host.grant({ kind: "team" }, { teamToolCalls: 10 }, "exactly reaches the safe limit");
	const final = runtime.getTeam(teamId);
	assert.equal(rootView(final, rootId).limits.rootModelRequests, Number.MAX_SAFE_INTEGER);
	assert.equal(final.budget.limits.teamToolCalls, Number.MAX_SAFE_INTEGER);
	assert.equal(final.budget.limits.rootModelRequests, near, "a root grant never changes the Team-wide root default");
	assert.equal(records.filter((record) => record.kind === "grant").length, 3);
});

test("final first-wins: host cancel of an already failed Team keeps failed, its original reason and close decision", () => {
	const { runtime, teamId } = makeRuntime({ initialRequests: [{ to: "w1", task: "closing fails" }] });
	const work = nextWork(runtime, teamId)!;
	end(runtime, work, replyWith("done"));
	const manager = takeManager(runtime, teamId);
	const resultRef = runtime.getWork(teamId, work.scope.work!)!.current.resultRef!;
	ok(runtime, manager, { action: "control", command: "accept_result", work: work.scope.work!, disposition: "accepted" });
	const { id, reply } = ok(runtime, manager, { action: "control", command: "close_team", outcome: "succeeded", resultRefs: [resultRef] });
	assert.ok(reply.ok && reply.receipt?.status === "closing");
	settle(runtime, manager, { status: "success", appliedToolCallId: id });
	const closeId = reply.receipt.closeId;
	// An unclean but confirmed exit during close fails the Team.
	runtime.memberReleased(runtime.bindingForDriver(teamId, "w1"), closeId,
		{ ok: false, resourceReleased: true, error: { code: "CLEANUP_FAILED", message: "private unbind failed" } });
	for (const memberId of ["w2", "lead"]) runtime.memberReleased(runtime.bindingForDriver(teamId, memberId), closeId, { ok: true });
	const failed = runtime.getTeam(teamId);
	const failedResult = runtime.getTeamResult(teamId);
	assert.equal(failed.lifecycle, "failed");
	assert.ok(failed.reason);
	const cancel = runtime.hostControl(teamId).cancel_team("user stop after failure");
	assert.equal(cancel.status, "unchanged");
	assert.equal("lifecycle" in cancel && cancel.lifecycle, "failed");
	const after = runtime.getTeam(teamId);
	assert.equal(after.lifecycle, "failed");
	assert.equal(after.reason, failed.reason, "the original failure reason is kept");
	assert.equal(after.outcome, failed.outcome);
	assert.deepEqual(runtime.getTeamResult(teamId), failedResult, "the committed close decision and its result refs are kept");
	assert.deepEqual(failedResult?.finalResultRefs, [resultRef]);

	// A Team failed closed by a journal loss (no close decision) is also terminal for a later host cancel.
	const { generation } = journal((record) => record.kind === "result");
	const { runtime: lostRuntime, teamId: lostTeamId } = makeRuntime({ initialRequests: [{ to: "w1", task: "lost" }], journal: generation });
	end(lostRuntime, nextWork(lostRuntime, lostTeamId)!, replyWith("unjournaled"));
	const lostBefore = lostRuntime.getTeam(lostTeamId);
	assert.equal(lostBefore.lifecycle, "failed");
	assert.equal(lostRuntime.hostControl(lostTeamId).cancel_team("user stop").status, "unchanged");
	assert.equal(lostRuntime.getTeam(lostTeamId).lifecycle, "failed");
	assert.equal(lostRuntime.getTeam(lostTeamId).reason, lostBefore.reason);
	runtime.assertInvariants(teamId);
});

test("G09: a Manager stopped mid-activation by budget does not replay its batch; emergency activations stay bounded", () => {
	const { runtime, teamId } = makeRuntime({ limits: { teamModelRequests: 3 } });
	const boot = takeManager(runtime, teamId);
	assert.deepEqual(runtime.gate(boot.binding, boot.scope, "provider_gate"), { allow: true });
	end(runtime, boot, yieldNow);
	runtime.hostControl(teamId).message_lead("please review");
	const manager = takeManager(runtime, teamId);
	assert.ok(manager.input.scope.kind === "events" && manager.input.scope.events.some((event) => event.message === "please review"));
	assert.deepEqual(runtime.gate(manager.binding, manager.scope, "provider_gate"), { allow: true });
	ok(runtime, manager, { action: "status", view: "team" });
	assert.deepEqual(runtime.gate(manager.binding, manager.scope, "provider_gate"), { allow: true });
	assert.equal(denial(runtime.gate(manager.binding, manager.scope, "provider_gate")), "budget");
	settle(runtime, manager, { status: "aborted" });
	let team = runtime.getTeam(teamId);
	assert.equal(team.members.find((member) => member.id === "lead")?.lifecycle, "open", "a budget stop is not a Manager fault");

	const kinds: string[][] = [];
	for (let round = 0; round < 3; round++) {
		if (round > 0) runtime.hostControl(teamId).message_lead(`round ${round}`);
		const emergency = takeManager(runtime, teamId);
		assert.equal(emergency.input.scope.kind === "events" && emergency.input.scope.emergency, true);
		kinds.push(emergency.input.scope.kind === "events" ? emergency.input.scope.events.map((event) => event.message) : []);
		assert.deepEqual(runtime.gate(emergency.binding, emergency.scope, "provider_gate"), { allow: true }, "emergency ignores the exhausted Team counter");
		end(runtime, emergency, yieldNow);
	}
	assert.ok(kinds.flat().every((message) => message !== "please review"), "the stopped batch is not replayed");
	assert.equal(kinds[0]!.length, 1, "the first emergency sees only the deduplicated budget incident");
	runtime.hostControl(teamId).message_lead("no more");
	assert.equal(runtime.takeNextActivation(teamId), undefined);
	team = runtime.getTeam(teamId);
	assert.equal(team.budget.used.emergencyLeadActivations, 3);
	assert.equal(team.budget.used.leadActivations, 2);
	runtime.assertInvariants(teamId);
});

test("team view and status pages stay inside one private reply frame with maximal roots, grants, incidents and multi-byte text", () => {
	const wide = (bytes: number) => "界".repeat(Math.floor(bytes / 3) - 2);
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `size-${++ids}` });
	const workers = Array.from({ length: TEAM_MAX_MEMBERS - 1 }, (_, index) => ({ alias: `w${index + 1}`, roleDescription: wide(TEAM_MAX_ROLE_BYTES) }));
	const { teamId } = runtime.prepare({
		members: [{ alias: "lead", roleDescription: wide(TEAM_MAX_ROLE_BYTES) }, ...workers], lead: "lead",
		brief: { goal: wide(TEAM_MAX_TEXT_ITEM_BYTES), target: wide(TEAM_MAX_TEXT_ITEM_BYTES), constraints: [wide(TEAM_MAX_TEXT_ITEM_BYTES)] },
		initialRequests: [], timeoutSeconds: null,
	});
	runtime.launch(teamId);
	const boot = takeManager(runtime, teamId);
	const rootCount = 64;
	for (let index = 0; index < rootCount; index++) ok(runtime, boot, { action: "request", to: `w${(index % (TEAM_MAX_MEMBERS - 1)) + 1}`, task: `root ${index}` });
	end(runtime, boot, yieldNow);
	// Every root runs once and holds with a maximal multi-byte attention note: each is an open incident.
	for (let index = 0; index < rootCount; index++) {
		const work = nextWork(runtime, teamId)!;
		end(runtime, work, { action: "yield", attention: wide(TEAM_MAX_NOTE_BYTES), checkpoint: wide(TEAM_MAX_NOTE_BYTES) });
	}
	const host = runtime.hostControl(teamId);
	const rootIds = runtime.getTeam(teamId).budget.roots.map((root) => root.rootId);
	for (let index = 0; index < TEAM_MAX_BUDGET_GRANTS; index++) {
		host.grant(index % 2 ? { kind: "team" } : { kind: "root", rootId: rootIds[index % rootIds.length]! }, index % 2 ? { teamToolCalls: 1 } : { rootToolCalls: 1 }, wide(512));
	}
	assert.throws(() => host.grant({ kind: "team" }, { teamToolCalls: 1 }, "one too many"), TeamProtocolError);
	host.message_lead(wide(TEAM_MAX_NOTE_BYTES));
	const manager = takeManager(runtime, teamId);
	const frameBytes = (reply: ReturnType<typeof act>["reply"], rpcRequestId: string) => {
		const frame = { version: 2, commandId: `cmd-${rpcRequestId}`, operation: "reply", binding: manager.binding, activation: manager.scope,
			rpcRequestId, reply: { kind: "business", reply } };
		parseParentCommand(frame);
		return Buffer.byteLength(JSON.stringify(frame), "utf8");
	};
	const teamPage = ok(runtime, manager, { action: "status", view: "team" }).reply;
	assert.ok(teamPage.ok && teamPage.data && "teamId" in teamPage.data);
	const view = teamPage.data as TeamTeamView;
	assert.equal(view.incidents.length, TEAM_VIEW_MAX_INCIDENTS);
	assert.equal(view.incidentsOmitted, rootCount - TEAM_VIEW_MAX_INCIDENTS);
	assert.equal(view.budget.roots.length, TEAM_VIEW_MAX_BUDGET_ROOTS);
	assert.equal(view.budget.rootsOmitted, rootCount - TEAM_VIEW_MAX_BUDGET_ROOTS);
	assert.equal(view.budget.grants.length, TEAM_VIEW_MAX_GRANTS);
	assert.equal(view.budget.grantsOmitted, TEAM_MAX_BUDGET_GRANTS - TEAM_VIEW_MAX_GRANTS);
	const sizes: Record<string, number> = { team: frameBytes(teamPage, "status-team") };
	for (const pageView of ["work", "incident", "result"] as const) {
		let cursor: string | undefined;
		let items = 0;
		do {
			const page = ok(runtime, manager, { action: "status", view: pageView, limit: TEAM_STATUS_MAX_LIMIT, ...(cursor ? { cursor } : {}) }).reply;
			sizes[pageView] = Math.max(sizes[pageView] ?? 0, frameBytes(page, `status-${pageView}-${items}`));
			const data = page.ok && page.data && "items" in page.data ? page.data : undefined;
			items += data?.items.length ?? 0;
			cursor = data?.cursor;
		} while (cursor);
		if (pageView !== "result") assert.equal(items, rootCount, `${pageView} pages cover every item`);
	}
	for (const [name, bytes] of Object.entries(sizes)) assert.ok(bytes <= TEAM_MAX_FRAME_BYTES, `${name} reply frame is ${bytes} bytes`);
	console.log(`reply frame bytes: ${JSON.stringify(sizes)} (limit ${TEAM_MAX_FRAME_BYTES})`);
	runtime.assertInvariants(teamId);
});
