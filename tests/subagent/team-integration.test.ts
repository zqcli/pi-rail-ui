import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
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

const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
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
	for (const result of [a, b]) {
		const runs = result.details.results;
		assert.equal(result.usage.input, runs.reduce((sum: number, run: any) => sum + run.usage.input, 0));
		assert.equal(result.usage.output, runs.reduce((sum: number, run: any) => sum + run.usage.output, 0));
		assert.equal(result.usage.totalTokens, runs.reduce((sum: number, run: any) => sum + run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite, 0));
	}
	assert.equal(hub.get(teamId).phase, "completed");
	for (const snapshot of history.filter((s) => s.phase === "finalizing" || s.phase === "completed")) assert.ok(snapshot.members.filter((m) => m.role === "worker").every((m) => m.state === "completed"));
	assert.ok(updates.some((u) => u.details.results.some((r: any) => r.coordination?.state === "waiting")));
	assert.doesNotMatch(JSON.stringify([a, b, updates]), /"epoch"|"binding"/u);
	const instances = await store.list();
	assert.equal(instances.length, 9);
	for (const instance of instances) {
		const entries = await journal(instance.alias);
		const modelTurns = entries.filter((entry) => entry.customType === "team-e2e-turn");
		const result = instance.alias === "A" ? a.details.results[0] : b.details.results.find((r: any) => r.alias === instance.alias);
		assert.equal(result.usage.turns, modelTurns.length, "all actual native turns are counted once");
		// Staggered worker events may legitimately wake A in separate turns.
		// Verify actual event-driven wakeups, not a timing-dependent turn count.
		const waits = new Set(entries.flatMap((entry) => entry.message?.role === "assistant" ? entry.message.content.filter((part: any) => part.type === "toolCall" && part.name === "team" && part.arguments.action === "wait" && part.arguments.wait?.kind === "message").map((part: any) => part.id) : []));
		for (const entry of entries) if (entry.message?.role === "toolResult" && waits.has(entry.message.toolCallId)) {
			const reply = JSON.parse(entry.message.content.find((part: any) => part.type === "text").text);
			assert.equal(reply.ok, true);
			assert.ok(reply.events?.length > 0, "a message wait must wake from an actual event");
		}
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

test("explicit coordinator reports complete the READY/pause/resume/dependency handshake without a message-wait cycle", { timeout: 90_000 }, async (t) => {
	const { hub, teamId, history, dispatch, journal } = await setup(t, 2, "report-handshake");
	const timeout = setTimeout(() => hub.cancel(teamId, "Handshake regression timed out"), 15_000);
	t.after(() => clearTimeout(timeout));
	const [a, b] = await Promise.all(dispatch());
	assert.equal(hub.get(teamId).phase, "completed");
	assert.match(a.details.results[0].output, /HANDSHAKE_FINAL/u);
	assert.ok(b.details.results.every((run: any) => run.status === "completed"));
	const events = [...new Map(history.flatMap((snapshot) => snapshot.events.map((event) => [event.seq, event] as const))).values()];
	const seq = (predicate: (event: typeof events[number]) => boolean) => {
		const event = events.find(predicate);
		assert.ok(event, "required handshake event must actually occur");
		return event.seq;
	};
	const b1Ready = seq((e) => e.kind === "report" && e.from === "B1" && e.message === "B1_READY");
	const b2Ready = seq((e) => e.kind === "report" && e.from === "B2" && e.message === "B2_READY");
	const paused = seq((e) => e.member === "B1" && e.state === "paused");
	const redirect = seq((e) => e.kind === "control" && e.to === "B1" && e.message === "redirect");
	const resume = seq((e) => e.kind === "control" && e.to === "B1" && e.message === "resume");
	const resumed = seq((e) => e.kind === "report" && e.from === "B1" && e.message === "B1_RESUMED");
	const dependency = seq((e) => e.member === "B1" && e.state === "waiting" && e.message === "waiting for member B2");
	const release = seq((e) => e.kind === "message" && e.from === "A" && e.to === "B2" && e.message === "B2_RELEASE");
	const b2Done = seq((e) => e.member === "B2" && e.state === "completed");
	const observed = seq((e) => e.kind === "report" && e.from === "B1" && e.message === "B1_OBSERVED_B2_TERMINAL");
	const ordered = [Math.max(b1Ready, b2Ready), paused, redirect, resume, resumed, dependency, release, b2Done, observed];
	assert.ok(ordered.every((value, index) => index === 0 || value > ordered[index - 1]!), JSON.stringify(ordered));
	for (const alias of ["A", "B1", "B2"]) {
		const entries = await journal(alias);
		const replies = entries.filter((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "team");
		assert.ok(replies.length > 0);
		assert.ok(replies.every((entry) => !entry.message.isError), "no Invalid team arguments/retry detour may be hidden");
		if (alias === "A") {
			const calls = entries.flatMap((entry) => entry.message?.role === "assistant" ? entry.message.content.filter((part: any) => part.type === "toolCall") : []);
			const redirectAt = calls.findIndex((call: any) => call.name === "team" && call.arguments.command === "redirect");
			const resumeAt = calls.findIndex((call: any) => call.name === "team" && call.arguments.command === "resume");
			assert.ok(redirectAt >= 0 && resumeAt > redirectAt);
			assert.equal(calls.slice(redirectAt + 1, resumeAt).filter((call: any) => call.name === "team_handshake_tick").length, 2);
		} else {
			const reports = entries.flatMap((entry) => entry.message?.role === "assistant" ? entry.message.content.filter((part: any) => part.type === "toolCall" && part.name === "team" && part.arguments.action === "report") : []);
			assert.equal(reports.length, alias === "B1" ? 3 : 2);
			assert.ok(reports.every((call: any) => call.arguments.to === "A"));
		}
	}
	assert.ok(history.filter((snapshot) => snapshot.phase === "finalizing").every((snapshot) => snapshot.members.filter((member) => member.role === "worker").every((member) => member.state === "completed")));
});

test("native parent rejects a lone team call without starting members, then corrects full-property RPC siblings", { timeout: 90_000 }, async (t) => {
	const { hub, teamId, tools, ctx, store } = await setup(t, 2, "control");
	// Match the real smoke session's provider-filled optional fields, including
	// empty session/control objects at the top level and inside grouped tasks.
	const emptyTask = { model: "", target: "", alias: "", task: "", cwd: "", session: { mode: "fork", path: "" }, contextWindow: null, fastMode: null };
	const emptyCall = { ...emptyTask, teamId, control: { delivery: "steer", message: "" }, tasks: [], chain: [], confirmSessionAttach: true };
	const args = [
		{ ...emptyCall, model: "rail-team-e2e/probe", alias: "A", task: "TEAM_MEMBER_A coordinate the workers", cwd: ctx.cwd },
		{ ...emptyCall, tasks: ["B1", "B2"].map((alias) => ({ ...emptyTask, model: "rail-team-e2e/probe", alias, task: `TEAM_MEMBER_${alias} complete the assigned work`, cwd: ctx.cwd })) },
	];
	const before = structuredClone(args);
	const tool = tools.get("subagent");
	const branch: any[] = [];
	ctx.sessionManager = { getBranch: () => branch };
	let requests = 0;
	const messages = await runAgentLoop([{ role: "user", content: "Start both team siblings", timestamp: Date.now() }], {
		// Pi 0.87 carries the prompt in transcript system messages; AgentContext has no systemPrompt field.
		messages: [{ role: "system", content: "Local parent integration probe", timestamp: Date.now() }],
		tools: [{ ...tool, execute: (id: string, params: any, signal: AbortSignal, onUpdate: any) => tool.execute(id, params, signal, onUpdate, ctx) }],
	}, { model: nativeModel as any, convertToLlm: (items) => items as any, toolExecution: "parallel" }, (event) => {
		// Mirror native AgentSession's public in-memory branch after message_end.
		if (event.type === "message_end") branch.push({ type: "message", message: event.message });
	}, t.signal, async () => {
		assert.ok(++requests <= 3, "one corrective turn is enough; no timeout/retry loop");
		if (requests === 2) {
			assert.equal((await store.list()).length, 0, "the lone call must not create a child session");
			assert.ok(hub.get(teamId).members.every((member) => member.state === "registered"));
			assert.equal(hub.signal(teamId).aborted, false);
		}
		const content = requests === 1 ? [{ type: "toolCall", id: "native-lone", name: "subagent", arguments: args[0] }]
			: requests === 2 ? args.map((arguments_, index) => ({ type: "toolCall", id: `native-team-${index}`, name: "subagent", arguments: arguments_ }))
			: [{ type: "text", text: "ROOT_DONE" }];
		const message: any = { role: "assistant", api: nativeModel.api, provider: nativeModel.provider, model: nativeModel.id,
			content,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: requests < 3 ? "toolUse" : "stop", timestamp: Date.now() };
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
		stream.push({ type: "done", reason: message.stopReason, message });
		stream.end(message);
		return stream;
	});
	const results = messages.filter((message) => message.role === "toolResult") as any[];
	assert.equal(results.length, 3);
	assert.equal(results[0].isError, true);
	assert.match(results[0].content[0].text, /retry BOTH calls in same assistant message/u);
	for (const result of results.slice(1)) assert.equal(result.isError, false, JSON.stringify(result.content));
	assert.match(results.find((result) => result.toolCallId === "native-team-0").details.results[0].output, /CONTROL_FINAL/u);
	assert.equal(results.find((result) => result.toolCallId === "native-team-1").details.results.length, 2);
	assert.equal(hub.get(teamId).phase, "completed");
	assert.equal((await store.list()).length, 3, "all three real child sessions must be created");
	assert.deepEqual(args, before);
});

test("real cancellation wakes both parked calls and awaits native lease cleanup without a final summary", { timeout: 90_000 }, async (t) => {
	const { hub, teamId, dispatch, tools, ctx, store, leases, journal } = await setup(t, 1, "cancel");
	const settled = Promise.allSettled(dispatch());
	await waitForSnapshot(hub, teamId, (s) => s.members.every((m) => m.state === "waiting" && m.waitingFor === "message"));
	const turns = async () => Promise.all(["A", "B1"].map(async (alias) => (await journal(alias)).filter((entry) => entry.customType === "team-e2e-turn").length));
	const before = await turns();
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.deepEqual(await turns(), before, "parked members must not poll the provider");
	await tools.get("subagent_team").execute("cancel", { action: "cancel", teamId, reason: "test cancellation" }, undefined, undefined, ctx);
	const results = await settled;
	assert.equal(hub.get(teamId).phase, "cancelled");
	assert.ok(results.some((result) => result.status === "rejected"));
	for (const result of results) {
		if (result.status === "rejected") assert.match(String(result.reason), /test cancellation/u);
		else for (const run of result.value.details.results) {
			assert.equal(run.status, "failed");
			assert.match(run.errorMessage, /test cancellation/u);
		}
	}
	for (const instance of await store.list()) assert.deepEqual(await leases.inspect(instance.sessionFile), { state: "free" });
});

test("team finalization waits through native automatic retry rather than the first agent_end", { timeout: 90_000 }, async (t) => {
	const { hub, teamId, dispatch, journal, history } = await setup(t, 1, "retry");
	const [a, b] = await Promise.all(dispatch());
	assert.equal(hub.get(teamId).phase, "completed");
	assert.match(a.details.results[0].output, /LIFECYCLE_FINAL/u);
	assert.equal(b.details.results[0].status, "completed");
	const turns = (await journal("B1")).filter((entry) => entry.customType === "team-e2e-turn");
	assert.equal(turns.length, 2, "native retry must actually execute a second provider request");
	assert.ok(history.filter((snapshot) => snapshot.phase === "finalizing").every((snapshot) => snapshot.members.find((member) => member.id === "B1")?.output === "B1 result"));
});

test("team preserves native threshold compaction and restores the temporary context window before reuse", { timeout: 90_000 }, async (t) => {
	const { hub, teamId, dispatch, journal, broker, updates } = await setup(t, 1, "compaction");
	const [a, b] = await Promise.all(dispatch());
	assert.equal(hub.get(teamId).phase, "completed");
	assert.match(a.details.results[0].output, /LIFECYCLE_FINAL/u);
	assert.equal(b.details.results[0].status, "completed");
	const entries = await journal("B1");
	assert.ok(entries.some((entry) => entry.type === "compaction"), "native threshold compaction must write its real checkpoint");
	assert.ok(entries.some((entry) => entry.customType === "team-e2e-compaction" && entry.data.contextWindow === 64000));
	assert.ok(updates.some((update) => update.details.results.some((run: any) => run.alias === "B1" && run.isCompacting)));
	const reused = await broker.dispatch({ target: "B1", task: "VERIFY_NATIVE_WINDOW" });
	assert.equal(reused.run.output, "window=128000");
});
