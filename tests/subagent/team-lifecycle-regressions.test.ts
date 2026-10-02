import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionBroker, TeamOwnedError, TeamMemberOpenError, type AgentInstance, type AgentInstanceStore } from "../../tools/subagents/session-broker";
import { SessionAgentRoster } from "../../tools/subagents/session-links";
import { RpcProcessExitTimeoutError } from "../../tools/subagents/rpc-transport";
import { TeamJournalGeneration, type TeamJournalRecord } from "../../tools/subagents/team-journal";
import { TeamMemberDriver, TeamLaunchError } from "../../tools/subagents/team-member-driver";
import { TeamRuntime } from "../../tools/subagents/team-runtime";

const model = { provider: "synthetic", modelId: "offline" };
const plan = {
	members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "worker", roleDescription: "Work." }], lead: "lead",
	brief: { goal: "Verify admission and confirmed exit without any provider." }, timeoutSeconds: null,
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a pure prepared startup failure needs no native executor, fails its work, and preserves the first terminal decision", async () => {
	const records: TeamJournalRecord[] = [];
	const runtime = new TeamRuntime({ journal: new TeamJournalGeneration((record) => records.push(record)) });
	const team = runtime.prepare({ ...plan, initialRequests: [{ to: "worker", task: "must never run" }] });
	assert.equal(runtime.failStartup(team.teamId, "synthetic startup admission failure").status, "applied");
	const result = await runtime.waitForCompletion(team.teamId);
	assert.equal(result.lifecycle, "failed");
	assert.equal(result.reason, "synthetic startup admission failure");
	assert.ok(result.members.every((member) => member.resourceState === "released"));
	assert.equal(result.roots[0]?.state, "failed");
	assert.equal(runtime.getWork(team.teamId, result.roots[0]!.work)?.current.error?.code, "STARTUP_FAILURE");
	assert.equal(runtime.takeNextActivation(team.teamId), undefined);
	assert.equal(runtime.failStartup(team.teamId, "later cleanup failure").status, "unchanged");
	assert.equal(runtime.cancelTeam(team.teamId, "later user cancel").status, "unchanged");
	assert.deepEqual(runtime.getTeamResult(team.teamId), result);
	assert.equal(records.length, 1);
	assert.equal(records[0]?.kind === "terminal" && records[0].result.lifecycle, "failed");
	runtime.assertInvariants(team.teamId);
});

test("a startup failure report cannot overwrite an already committed Manager close decision", () => {
	const runtime = new TeamRuntime();
	const team = runtime.prepare(plan);
	runtime.launch(team.teamId);
	const activation = runtime.takeNextActivation(team.teamId)!;
	assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
	const reply = runtime.handleAction(activation.binding, activation.scope, 1, "close", {
		action: "control", command: "close_team", outcome: "failed", resultRefs: [], reason: "Manager chose to close",
	}, "close");
	assert.ok(reply.ok && reply.receipt?.status === "closing");
	const before = runtime.getTeam(team.teamId);
	assert.equal(runtime.failStartup(team.teamId, "late startup failure").status, "unchanged");
	assert.deepEqual(runtime.getTeam(team.teamId), before);
	assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "success", appliedToolCallId: "close" }).ok, true);
	assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
	for (const member of team.members) runtime.memberReleased(runtime.bindingForDriver(team.teamId, member.id), reply.receipt.closeId, { ok: true });
	assert.equal(runtime.getTeamResult(team.teamId)?.lifecycle, "closed");
	assert.equal(runtime.getTeamResult(team.teamId)?.reason, "Manager chose to close");
	runtime.assertInvariants(team.teamId);
});

async function brokerHarness(t: TestContext, stop: (alias: string) => Promise<void>, bind: (alias: string) => Promise<void> = async () => undefined) {
	const root = await mkdtemp(join(tmpdir(), "rail-team-lifecycle-regression-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const instances = new Map<string, AgentInstance>();
	const store: AgentInstanceStore = {
		get: async (id) => instances.get(id), put: async (instance) => { instances.set(instance.agentId, instance); },
		delete: async (id) => { instances.delete(id); }, list: async () => [...instances.values()],
	};
	let providerCalls = 0;
	const stops: string[] = [];
	const unbinds: string[] = [];
	const broker = new SessionBroker({
		store, roster: new SessionAgentRoster(() => undefined), defaultCwd: root,
		workerFactory: async (spec) => ({
			sessionId: spec.agentId, sessionFile: join(root, `${spec.agentId}.jsonl`),
			send: async () => { providerCalls++; throw new Error("Provider must not run during failed admission"); },
			openTeamMemberV2: async () => {
				await bind(spec.alias);
				return {
					runActivation: async () => { providerCalls++; throw new Error("Native activation must not start"); },
					terminate: () => undefined, close: async () => { unbinds.push(spec.alias); },
				};
			},
			stop: async () => { stops.push(spec.alias); await stop(spec.alias); },
		}),
	});
	return { broker, instances, stops, unbinds, providerCalls: () => providerCalls };
}

test("member bind failure fails startup, retains its original cause, and records confirmed cleanup without a phantom owner", { timeout: 10000 }, async (t) => {
	const original = new Error("synthetic member bind rejected");
	const harness = await brokerHarness(t, async () => undefined, async (alias) => {
		if (alias === "worker") throw original;
	});
	const records: TeamJournalRecord[] = [];
	const runtime = new TeamRuntime({ journal: new TeamJournalGeneration((record) => records.push(record)) });
	const team = runtime.prepare(plan);
	const driver = new TeamMemberDriver(runtime, harness.broker);
	await assert.rejects(driver.openAndLaunch(team.teamId, team.members.map((member) => ({ teamId: team.teamId, memberId: member.id, model }))), (error: unknown) => {
		assert.ok(error instanceof TeamLaunchError);
		assert.ok(error.cause instanceof TeamMemberOpenError);
		assert.equal(error.cause.cause, original);
		assert.equal(error.cleanup?.lifecycle, "failed");
		assert.match(error.cleanup?.reason ?? "", /synthetic member bind rejected/);
		assert.ok(error.cleanup?.members.every((member) => member.resourceState === "released"));
		assert.equal(error.cleanupError, undefined);
		return true;
	});
	assert.equal(harness.providerCalls(), 0);
	assert.deepEqual(driver.liveLifetimes(team.teamId), []);
	assert.deepEqual(harness.broker.teamOwnedAliases(team.teamId), []);
	assert.equal(records.length, 1);
	assert.equal(records[0]?.kind === "terminal" && records[0].result.lifecycle, "failed");
	await driver.close();
	await harness.broker.shutdown();
	assert.deepEqual(harness.stops.sort(), ["lead", "worker"]);
	assert.deepEqual(harness.unbinds, ["lead"], "the rejected bind has no protocol handle to unbind again");
	runtime.assertInvariants(team.teamId);
});

for (const mode of ["cancel", "interrupt"] as const) {
	test(`host ${mode} during member startup wins a later bind failure and drains every opening handle`, { timeout: 10000 }, async (t) => {
		const entered = deferred<void>();
		const proceed = deferred<void>();
		let bindingCount = 0;
		const original = new Error("bind failed after host stop");
		const harness = await brokerHarness(t, async () => undefined, async (alias) => {
			if (++bindingCount === 2) entered.resolve();
			await proceed.promise;
			if (alias === "worker") throw original;
		});
		t.after(() => proceed.resolve());
		const runtime = new TeamRuntime();
		const team = runtime.prepare(plan);
		const driver = new TeamMemberDriver(runtime, harness.broker);
		const opening = driver.openAndLaunch(team.teamId, team.members.map((member) => ({ teamId: team.teamId, memberId: member.id, model })));
		const rejected = assert.rejects(opening, (error: unknown) => {
			assert.ok(error instanceof TeamLaunchError);
			assert.ok(error.cause instanceof TeamMemberOpenError && error.cause.cause === original);
			assert.equal(error.cleanup?.lifecycle, mode === "cancel" ? "cancelled" : "interrupted");
			assert.equal(error.cleanup?.reason, `host ${mode} first`);
			assert.ok(error.cleanup?.members.every((member) => member.resourceState === "released"));
			return true;
		});
		await entered.promise;
		const stopping = driver.stopTeam(team.teamId, `host ${mode} first`, mode);
		assert.equal(runtime.getTeam(team.teamId).lifecycle, mode === "cancel" ? "cancelled" : "interrupted");
		proceed.resolve();
		await rejected;
		const result = await stopping;
		assert.equal(result.lifecycle, mode === "cancel" ? "cancelled" : "interrupted");
		assert.equal(runtime.failStartup(team.teamId, "even later failure").status, "unchanged");
		assert.equal(harness.providerCalls(), 0);
		assert.deepEqual(driver.liveLifetimes(team.teamId), []);
		assert.deepEqual(harness.broker.teamOwnedAliases(team.teamId), []);
		await driver.close();
		await harness.broker.shutdown();
		assert.deepEqual(harness.stops.sort(), ["lead", "worker"]);
		runtime.assertInvariants(team.teamId);
	});
}

test("Runtime waits past 5s for the Broker's bounded transport exit and releases each owner once", { timeout: 10000 }, async (t) => {
	const stopping = deferred<void>();
	const harness = await brokerHarness(t, async (alias) => {
		if (alias !== "worker") return;
		stopping.resolve();
		await new Promise<void>((resolve) => setTimeout(resolve, 6000));
	});
	const runtime = new TeamRuntime();
	const team = runtime.prepare(plan);
	const driver = new TeamMemberDriver(runtime, harness.broker);
	for (const member of team.members) await driver.openMember({ teamId: team.teamId, memberId: member.id, model });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const lifetime = driver.stopTeam(team.teamId, "Stop the prepared native lifetimes");
	let completed = false;
	void lifetime.then(() => { completed = true; });
	await stopping.promise;
	t.mock.timers.tick(5001);
	await flush();
	assert.equal(completed, false, "an activation-stop timeout must not truncate the transport's close");
	assert.equal(runtime.getTeam(team.teamId).members.find((member) => member.id === "worker")?.resourceState, "stopping");
	await assert.rejects(harness.broker.dispatch({ target: "worker", task: "must remain owned" }), TeamOwnedError);
	t.mock.timers.tick(999);
	const result = await lifetime;
	assert.ok(result.members.every((member) => member.resourceState === "released"));
	assert.deepEqual(driver.liveLifetimes(team.teamId), []);
	await driver.close();
	await harness.broker.shutdown();
	assert.deepEqual(harness.stops.sort(), ["lead", "worker"]);
	assert.deepEqual(harness.unbinds.sort(), ["lead", "worker"]);
	assert.equal(harness.providerCalls(), 0);
	runtime.assertInvariants(team.teamId);
});

for (const rejection of ["journal", "inactive journal"] as const) {
	test(`all opened handles are cleaned when ${rejection} rejects final launch admission`, { timeout: 10000 }, async (t) => {
		const harness = await brokerHarness(t, async () => undefined);
		const records: TeamJournalRecord[] = [];
		const journal = new TeamJournalGeneration((record) => {
			if (record.kind === "launched") throw new Error("synthetic launch journal failure");
			records.push(record);
		});
		const runtime = new TeamRuntime({ journal });
		const team = runtime.prepare(plan);
		if (rejection === "inactive journal") journal.deactivate();
		const driver = new TeamMemberDriver(runtime, harness.broker);
		await assert.rejects(driver.openAndLaunch(team.teamId, team.members.map((member) => ({
			teamId: team.teamId, memberId: member.id, model,
		}))), (error: unknown) => {
			assert.ok(error instanceof TeamLaunchError);
			assert.match(error.message, /admission failed.*journal/iu);
			assert.ok(error.cause instanceof Error);
			assert.equal(error.cleanup?.lifecycle, "failed");
			assert.match(error.cleanup?.reason ?? "", /journal/iu);
			assert.ok(error.cleanup?.members.every((member) => member.resourceState === "released"));
			assert.equal(error.cleanupError, undefined);
			return true;
		});
		assert.equal(harness.providerCalls(), 0);
		assert.equal(runtime.getTeam(team.teamId).lifecycle, "failed", "infrastructure failure is not user cancellation or a retryable prepared Team");
		assert.equal(records.some((record) => record.kind === "launched"), false, "failed journal writes are never represented as persisted");
		if (rejection === "journal") {
			assert.equal(records.length, 1);
			assert.equal(records[0]?.kind === "terminal" && records[0].result.lifecycle, "failed");
		} else assert.deepEqual(records, [], "an inactive writer never persists a fake terminal record");
		assert.deepEqual(driver.liveLifetimes(team.teamId), []);
		assert.throws(() => driver.launch(team.teamId), /Cannot launch Team/);
		await driver.close();
		await harness.broker.shutdown();
		assert.deepEqual(harness.stops.sort(), ["lead", "worker"]);
		assert.deepEqual(harness.unbinds.sort(), ["lead", "worker"]);
		runtime.assertInvariants(team.teamId);
	});
}

test("launch admission failure retains an unknown exit and reconciles a later confirmed exit without restarting or double release", { timeout: 10000 }, async (t) => {
	const exited = deferred<void>();
	const harness = await brokerHarness(t, async (alias) => {
		if (alias === "worker") throw new RpcProcessExitTimeoutError("synthetic transport exit unknown", exited.promise);
	});
	const runtime = new TeamRuntime({ journal: new TeamJournalGeneration((record) => {
		if (record.kind === "launched") throw new Error("synthetic launch journal failure");
	}) });
	const team = runtime.prepare(plan);
	const driver = new TeamMemberDriver(runtime, harness.broker);
	await assert.rejects(driver.openAndLaunch(team.teamId, team.members.map((member) => ({ teamId: team.teamId, memberId: member.id, model }))), (error: unknown) => {
		assert.ok(error instanceof TeamLaunchError);
		assert.equal(error.cleanup?.lifecycle, "failed");
		assert.match(error.cleanup?.reason ?? "", /synthetic launch journal failure/);
		assert.ok(error.cause instanceof Error && /synthetic launch journal failure/.test(error.cause.message), "the launch cause is not replaced by its cleanup failure");
		assert.equal(error.cleanup?.members.find((member) => member.id === "worker")?.resourceState, "cleanup_failed");
		assert.match(runtime.getTeam(team.teamId).members.find((member) => member.id === "worker")?.error?.message ?? "", /synthetic transport exit unknown/);
		return true;
	});
	assert.equal(harness.providerCalls(), 0);
	assert.deepEqual(driver.liveLifetimes(team.teamId), ["worker"]);
	await assert.rejects(harness.broker.dispatch({ target: "worker", task: "must remain owned" }), TeamOwnedError);
	exited.resolve();
	await flush();
	assert.equal(runtime.getTeam(team.teamId).members.find((member) => member.id === "worker")?.resourceState, "cleanup_failed");
	await driver.closeMember(team.teamId, "worker");
	assert.equal(runtime.getTeam(team.teamId).members.find((member) => member.id === "worker")?.resourceState, "released");
	await driver.close();
	await harness.broker.shutdown();
	assert.deepEqual(harness.stops.sort(), ["lead", "worker"], "late exit reconciliation never retries the transport stop");
	assert.deepEqual(harness.unbinds.sort(), ["lead", "worker"]);
	runtime.assertInvariants(team.teamId);
});
