import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { FileAgentInstanceStore } from "../../tools/subagents/instance-store";
import { SessionBroker } from "../../tools/subagents/session-broker";
import { FileSessionLeaseManager } from "../../tools/subagents/session-lease";
import { SessionAgentRoster } from "../../tools/subagents/session-links";
import { createRpcWorkerFactory } from "../../tools/subagents/worker-factory";
import { TeamHub } from "../../tools/subagents/team-hub";
import { TeamRunManager } from "../../tools/subagents/team-runner";
import { installTeamTool } from "../../tools/subagents/team-tool";
import { installStatefulSubagentTool } from "../../tools/subagents/tool";
import type { TeamSnapshot } from "../../tools/subagents/team-protocol";

const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/team-coordination-provider.mjs", import.meta.url));
const nativeModel = { provider: "rail-team-e2e", id: "probe", name: "Team probe", api: "rail-team-e2e-api", contextWindow: 128000 };

async function setup(t: TestContext, count: number, scenario = "eight") {
	const sandbox = await mkdtemp(join(tmpdir(), "rail-team-e2e-"));
	const agentDir = join(sandbox, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 } }));
	const previous = process.env["PI_CODING_AGENT_DIR"];
	const previousScenario = process.env["TEAM_E2E_SCENARIO"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	process.env["TEAM_E2E_SCENARIO"] = scenario;
	const history: TeamSnapshot[] = [];
	const hub = new TeamHub({ startupTimeoutMs: 30_000, onSnapshot: (value) => { history.push(value); } });
	const stateDir = join(agentDir, "stateful-subagents");
	const store = new FileAgentInstanceStore(stateDir);
	const leases = new FileSessionLeaseManager(stateDir);
	const broker = new SessionBroker({ store, roster: new SessionAgentRoster(), defaultCwd: sandbox,
		aliasLeaseManager: leases,
		workerFactory: createRpcWorkerFactory({ stateDir, startupTimeoutMs: 30_000,
			resolveInvocation: (args) => ({ command: process.execPath, args: [cli, "--no-extensions", "--offline", ...args, "-e", fixture] }),
		}),
	});
	t.after(async () => {
		hub.dispose();
		await broker.shutdown();
		if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previous;
		if (previousScenario === undefined) delete process.env["TEAM_E2E_SCENARIO"];
		else process.env["TEAM_E2E_SCENARIO"] = previousScenario;
		await rm(sandbox, { recursive: true, force: true });
	});
	const tools = new Map<string, any>();
	const pi: any = { registerTool: (tool: any) => tools.set(tool.name, tool), on: () => undefined };
	const ctx: any = { cwd: sandbox, hasUI: false, model: nativeModel, scopedModels: [],
		modelRegistry: { find: (provider: string, id: string) => provider === nativeModel.provider && id === nativeModel.id ? nativeModel : undefined, getAvailable: () => [nativeModel] },
	};
	const manager = new TeamRunManager(hub);
	installTeamTool(pi, () => hub);
	installStatefulSubagentTool(pi, { broker, team: () => manager, renderContext: () => ctx });
	const prepared = await tools.get("subagent_team").execute("prepare", { action: "prepare", coordinator: "A", workers: Array.from({ length: count }, (_, i) => `B${i + 1}`), timeoutSeconds: 60.1234 }, undefined, undefined, ctx);
	const teamId = prepared.details.snapshots[0].id;
	const updates: any[] = [];
	const subagent = tools.get("subagent");
	const dispatch = () => [
		subagent.execute("call-A", { teamId, alias: "A", model: "rail-team-e2e/probe", task: "TEAM_MEMBER_A coordinate the workers" }, undefined, (value: any) => updates.push(value), ctx),
		subagent.execute("call-B", { teamId, tasks: Array.from({ length: count }, (_, i) => ({ alias: `B${i + 1}`, model: "rail-team-e2e/probe", task: `TEAM_MEMBER_B${i + 1} complete the assigned work`, ...(scenario === "compaction" ? { contextWindow: 64000 } : {}) })) }, undefined, (value: any) => updates.push(value), ctx),
	] as [Promise<any>, Promise<any>];
	const journal = async (alias: string) => {
		const instance = (await store.list()).find((item) => item.alias === alias)!;
		return (await readFile(instance.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	};
	return { hub, teamId, history, tools, ctx, dispatch, updates, journal, store, leases, broker };
}

function waitForSnapshot(hub: TeamHub, teamId: string, predicate: (snapshot: TeamSnapshot) => boolean): Promise<void> {
	if (predicate(hub.get(teamId))) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { unsubscribe(); reject(new Error("Expected team state was not reached")); }, 20_000);
		const unsubscribe = hub.subscribe((snapshot) => {
			if (snapshot.id !== teamId || !predicate(snapshot)) return;
			clearTimeout(timer); unsubscribe(); resolve();
		});
	});
}

test("real RPC team keeps two parent calls pending, wakes B1 from B8, and gives A all eight results before its final summary", { timeout: 90_000 }, async (t) => {
	const { hub, teamId, history, dispatch, updates, journal, store } = await setup(t, 8);
	let aDone = false;
	let bDone = false;
	const dependencyObservations: boolean[] = [];
	t.after(hub.subscribe((snapshot) => {
		if (snapshot.members.some((m) => m.id === "B1" && m.state === "waiting" && m.waitingFor === "B8")) dependencyObservations.push(!aDone && !bDone);
	}));
	const [aPending, bPending] = dispatch();
	const [a, b] = await Promise.all([aPending.then((result) => { aDone = true; return result; }), bPending.then((result) => { bDone = true; return result; })]);
	assert.ok(dependencyObservations.length > 0);
	assert.ok(dependencyObservations.every(Boolean), "neither parent call may finish while B1 is waiting");
	assert.equal(a.details.results[0].status, "completed");
	assert.match(a.details.results[0].output, /TEAM_FINAL: all eight workers/u);
	assert.doesNotMatch(a.details.results[0].output, /EARLY_COORDINATOR_OUTPUT/u);
	assert.equal(b.details.results.length, 8);
	for (const result of b.details.results) assert.equal(result.status, "completed", JSON.stringify(result));
	assert.match(b.details.results[0].output, /consumed B8 result and B2 peer evidence/u);
	assert.equal(hub.get(teamId).phase, "completed");
	for (const snapshot of history.filter((s) => s.phase === "finalizing" || s.phase === "completed")) assert.ok(snapshot.members.filter((m) => m.role === "worker").every((m) => m.state === "completed"));
	assert.ok(updates.some((u) => u.details.results.some((r: any) => r.coordination?.state === "waiting")));
	assert.doesNotMatch(JSON.stringify([a, b, updates]), /"epoch"|"binding"/u);
	const instances = await store.list();
	assert.equal(instances.length, 9);
	for (const instance of instances) {
		const modelTurns = (await journal(instance.alias)).filter((entry) => entry.customType === "team-e2e-turn");
		const result = instance.alias === "A" ? a.details.results[0] : b.details.results.find((r: any) => r.alias === instance.alias);
		assert.equal(result.usage.turns, modelTurns.length, "all actual native turns are counted once");
		assert.ok(modelTurns.length <= (instance.alias === "A" ? 6 : 3), "waiting must not poll the provider");
	}
});

test("real coordinator pauses a worker, receives safe-point confirmation, redirects it and resumes it", { timeout: 90_000 }, async (t) => {
	const { hub, teamId, dispatch, history, updates } = await setup(t, 2, "control");
	const [a, b] = await Promise.all(dispatch());
	assert.equal(hub.get(teamId).phase, "completed");
	assert.match(a.details.results[0].output, /CONTROL_FINAL/u);
	assert.match(b.details.results[0].output, /B1 result: CORRECTED_DIRECTION/u);
	assert.ok(history.some((s) => s.members.some((m) => m.id === "B1" && m.state === "paused")));
	assert.ok(updates.some((u) => u.details.results.some((r: any) => r.alias === "B1" && r.coordination?.state === "paused")));
	const events = hub.get(teamId).events;
	const commands = events.filter((e) => e.kind === "control" && e.to === "B1").map((e) => e.message);
	assert.deepEqual(commands, ["pause", "redirect", "resume"]);
	const paused = events.find((e) => e.member === "B1" && e.kind === "state" && e.state === "paused");
	const redirect = events.find((e) => e.kind === "control" && e.message === "redirect");
	assert.ok(paused && redirect && paused.seq < redirect.seq);
});

test("real cancellation wakes both parked calls and awaits native lease cleanup without a final summary", { timeout: 90_000 }, async (t) => {
	const { hub, teamId, dispatch, tools, ctx, store, leases } = await setup(t, 1, "cancel");
	const settled = Promise.allSettled(dispatch());
	await waitForSnapshot(hub, teamId, (s) => s.members.every((m) => m.state === "waiting" && m.waitingFor === "message"));
	await tools.get("subagent_team").execute("cancel", { action: "cancel", teamId, reason: "test cancellation" }, undefined, undefined, ctx);
	const results = await settled;
	assert.equal(hub.get(teamId).phase, "cancelled");
	assert.ok(results.some((result) => result.status === "rejected"));
	for (const result of results) if (result.status === "fulfilled") assert.ok(result.value.details.results.every((run: any) => run.status === "failed"));
	for (const instance of await store.list()) assert.deepEqual(await leases.inspect(instance.sessionFile), { state: "free" });
});
