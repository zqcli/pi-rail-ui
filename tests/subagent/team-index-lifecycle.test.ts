import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installRailSubagent } from "../../tools/subagents/index";
import { SessionBroker, type AgentInstance } from "../../tools/subagents/session-broker";
import { TeamMemberDriver } from "../../tools/subagents/team-member-driver";
import { TeamLaunchWaitAbortedError } from "../../tools/subagents/team-tool";

const model = {
	provider: "cus-resp", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", api: "openai-responses",
	contextWindow: 128_000, maxTokens: 4096, reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

test("installRailSubagent lifecycle hooks seal each generation and suppress late callbacks after tree/switch/shutdown", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "rail-team-index-hooks-"));
	const oldAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const oldSubagentDepth = process.env["PI_SUBAGENT_DEPTH"];
	process.env["PI_SUBAGENT_DEPTH"] = "0";
	process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
	await mkdir(process.env["PI_CODING_AGENT_DIR"], { recursive: true });

	const originalOpen = SessionBroker.prototype.openTeamMember;
	const originalOpenAndLaunch = TeamMemberDriver.prototype.openAndLaunch;
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	let branchName = "branch-1";
	let branch: any[] = [];
	const notifications = new Map<string, string[]>();
	const entriesByBranch = new Map<string, any[]>();
	const lateLifetimes: Array<ReturnType<typeof deferred<unknown>>> = [];
	let activationCount = 0;
	let failInterruptionWrite = false;
	let nextCloseBarrier: { promise: Promise<void>; started: ReturnType<typeof deferred<void> >; release: () => void } | undefined;
	let agentNumber = 0;

	(SessionBroker.prototype as any).openTeamMember = async ({ binding, model: requestedModel, cwd }: any) => {
		const barrier = nextCloseBarrier;
		const instance: AgentInstance = {
			version: 2, agentId: `agt_index_${++agentNumber}`, alias: binding.memberId, model: requestedModel,
			sessionId: `session-${binding.memberId}-${agentNumber}`, sessionFile: join(root, `session-${agentNumber}.jsonl`),
			cwd: cwd ?? root, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lastTask: "Lifecycle hook test",
		};
		return {
			instance,
			sessionId: instance.sessionId,
			async runActivation(_activation: unknown, _onRequest: unknown, onNativeSettled: (completion: { status: "aborted" }) => void, signal?: AbortSignal) {
				activationCount++;
				if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				onNativeSettled({ status: "aborted" });
			},
			terminate() {},
			async close() {
				barrier?.started.resolve();
				await barrier?.promise;
				return {};
			},
		};
	};
	TeamMemberDriver.prototype.openAndLaunch = async function (teamId, requests) {
		const opened = await originalOpenAndLaunch.call(this, teamId, requests);
		void opened.lifetime.catch(() => undefined);
		const delayed = deferred<unknown>();
		lateLifetimes.push(delayed);
		return { lifetime: delayed.promise as typeof opened.lifetime };
	};

	let teamTool: any;
	const pi: any = {
		registerTool(definition: any) { if (definition.name === "subagent_team") teamTool = definition; },
		registerCommand() {},
		on(name: string, handler: (...args: any[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		appendEntry(customType: string, data: unknown) {
			if (failInterruptionWrite && (data as any)?.kind === "interrupted") throw new Error("synthetic interruption journal failure");
			const target = entriesByBranch.get(branchName) ?? [];
			target.push({ type: "custom", customType, data });
			entriesByBranch.set(branchName, target);
			return target.at(-1);
		},
	};
	installRailSubagent(pi);

	function makeContext(name: string) {
		const messages: string[] = [];
		notifications.set(name, messages);
		return {
			cwd: root,
			mode: "rpc",
			hasUI: true,
			model,
			thinkingLevel: "medium",
			scopedModels: [{ model, thinkingLevel: "medium" }],
			modelRegistry: { find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined, getAvailable: () => [model] },
			ui: { notify: (message: string) => messages.push(message) },
			sessionManager: {
				getBranch: () => branch,
				getSessionName: () => name,
				getSessionId: () => name,
			},
		};
	}

	async function start() {
		const ctx = makeContext(branchName);
		await handlers.get("session_start")![0]!({}, ctx);
		assert.ok(teamTool, "the real Team tool registration is installed");
		const prepared = await teamTool.execute("prepare", {
			action: "prepare",
			manager: { alias: "lead", roleDescription: "Manage lifecycle cleanup.", model: null, cwd: null, fastMode: null, contextWindow: null },
			workers: [{ alias: "worker", roleDescription: "Wait for the host lifecycle transition.", model: null, cwd: null, fastMode: null, contextWindow: null }],
			brief: { goal: "Verify index-registered branch lifecycle hooks.", acceptanceCriteria: null, constraints: null },
			initialRequests: [], timeoutSeconds: null,
		}, undefined, undefined, ctx);
		const controller = new AbortController();
		const startCount = activationCount;
		const waiting = teamTool.execute("launch", { action: "launch", teamId: prepared.details.view.teamId }, controller.signal, undefined, ctx);
		await waitUntil(() => activationCount > startCount, "a live native Team activation");
		controller.abort();
		await assert.rejects(waiting, (error: unknown) => error instanceof TeamLaunchWaitAbortedError && error.code === "TEAM_LAUNCH_WAIT_ABORTED");
		return { ctx, teamId: prepared.details.view.teamId };
	}

	function makeCloseBarrier() {
		const started = deferred<void>();
		const gate = deferred<void>();
		const barrier = { promise: gate.promise, started, release: () => gate.resolve() };
		nextCloseBarrier = barrier;
		return barrier;
	}

	t.after(async () => {
		SessionBroker.prototype.openTeamMember = originalOpen;
		TeamMemberDriver.prototype.openAndLaunch = originalOpenAndLaunch;
		if (oldAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = oldAgentDir;
		if (oldSubagentDepth === undefined) delete process.env["PI_SUBAGENT_DEPTH"];
		else process.env["PI_SUBAGENT_DEPTH"] = oldSubagentDepth;
		await rm(root, { recursive: true, force: true });
	});

	const barrier = makeCloseBarrier();
	const first = await start();
	const oldTreeBranch = entriesByBranch.get("branch-1") ?? [];
	const beforeTree = handlers.get("session_before_tree")![0]!({}, first.ctx);
	await barrier.started.promise;
	assert.ok(oldTreeBranch.some((entry) => entry.customType?.includes("team") && entry.data?.kind === "interrupted"),
		"the registered pre-tree hook journals the interruption on its current branch before waiting for cleanup");
	barrier.release();
	assert.equal(await beforeTree, undefined);
	branchName = "branch-2";
	branch = [];
	await handlers.get("session_tree")![0]!({}, makeContext("branch-2"));
	const beforeLateTreeWrite = (entriesByBranch.get("branch-2") ?? []).length;
	lateLifetimes[0]!.reject(new Error("late lifetime failure after tree change"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal((entriesByBranch.get("branch-2") ?? []).length, beforeLateTreeWrite, "retired cleanup cannot append to the new leaf");
	assert.deepEqual(notifications.get("branch-2"), [], "the detached launch cannot notify the new context");

	const second = await start();
	const oldSwitchBranch = entriesByBranch.get("branch-2") ?? [];
	failInterruptionWrite = true;
	assert.equal(await handlers.get("session_before_switch")![0]!({ reason: "selected another parent session" }, second.ctx), undefined);
	failInterruptionWrite = false;
	assert.equal(oldSwitchBranch.some((entry) => entry.customType?.includes("team") && entry.data?.kind === "interrupted"), false,
		"a failed history write is never represented as a durable interruption marker");
	assert.ok(notifications.get("branch-2")?.some((message) => /NOT persisted.*synthetic interruption journal failure/u.test(message)),
		"the registered switch hook makes the failed marker visible in the current UI");
	branchName = "branch-3";
	branch = [];
	await handlers.get("session_tree")![0]!({}, makeContext("branch-3"));
	const beforeLateSwitchWrite = (entriesByBranch.get("branch-3") ?? []).length;
	lateLifetimes[1]!.reject(new Error("late lifetime failure after session switch"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal((entriesByBranch.get("branch-3") ?? []).length, beforeLateSwitchWrite);
	assert.deepEqual(notifications.get("branch-3"), []);

	const third = await start();
	const shutdownBranch = entriesByBranch.get("branch-3") ?? [];
	await handlers.get("session_shutdown")![0]!({ reason: "test shutdown" }, third.ctx);
	assert.ok(shutdownBranch.some((entry) => entry.customType?.includes("team") && entry.data?.kind === "interrupted"));
	lateLifetimes[2]!.reject(new Error("late lifetime failure after shutdown"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(notifications.get("branch-3"), [], "shutdown's retired generation emits no late UI notification");

	const fourth = await start();
	const replacementBranch = entriesByBranch.get("branch-3") ?? [];
	branchName = "branch-4";
	branch = [];
	const replacementCtx = makeContext("branch-4");
	const logged: string[] = [];
	const originalConsoleError = console.error;
	failInterruptionWrite = true;
	console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
	try { await handlers.get("session_start")![0]!({}, replacementCtx); }
	finally { console.error = originalConsoleError; failInterruptionWrite = false; }
	assert.equal(replacementBranch.some((entry) => entry.data?.teamId === fourth.teamId && entry.data?.kind === "interrupted"), false);
	assert.equal((entriesByBranch.get("branch-4") ?? []).some((entry) => entry.data?.teamId === fourth.teamId), false,
		"a failed old-generation marker is not appended to the newly selected branch");
	assert.ok(logged.some((message) => /NOT persisted.*synthetic interruption journal failure/u.test(message)),
		"runtime replacement logs the failed marker without notifying the new UI");
	lateLifetimes[3]!.reject(new Error("late lifetime failure after runtime replacement"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(notifications.get("branch-4"), [], "late failures from a replaced host cannot notify the new generation");
	await handlers.get("session_shutdown")![0]!({ reason: "final test shutdown" }, replacementCtx);
});
