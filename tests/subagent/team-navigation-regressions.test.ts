import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	AgentSession, AgentSessionRuntime, createExtensionRuntime, ExtensionRunner, SessionManager,
	type Extension, type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { installRailSubagent } from "../../tools/subagents/index";
import { SessionBroker } from "../../tools/subagents/session-broker";
import { TeamSessionHost } from "../../tools/subagents/team-host";

const model = {
	provider: "cus-resp", id: "gpt-5.6-sol", name: "Synthetic", api: "openai-responses",
	contextWindow: 128000, maxTokens: 4096, reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function navigationHarness(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "rail-team-native-navigation-"));
	const savedEnv = new Map(["HOME", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_DEPTH", "PI_OFFLINE", "PI_TELEMETRY"].map((key) => [key, process.env[key]]));
	Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_SUBAGENT_DEPTH: "0", PI_OFFLINE: "1", PI_TELEMETRY: "0" });
	const manager = SessionManager.inMemory(root);
	const target = manager.appendMessage({ role: "user", content: "Navigation target", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "Abandoned branch work to summarize", timestamp: 2 });
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const laterHandlers = new Map<string, Array<(...args: any[]) => unknown>>();
	let teamTool: any;
	const pi: any = {
		on(name: string, handler: (...args: any[]) => unknown) {
			const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
		},
		registerTool(tool: any) { if (tool.name === "subagent_team") teamTool = tool; },
		registerCommand() {},
		appendEntry: (kind: string, data: unknown) => manager.appendCustomEntry(kind, data),
	};
	const hosts: TeamSessionHost[] = [];
	const originalPin = TeamSessionHost.prototype.pin;
	TeamSessionHost.prototype.pin = function (teamId, policies) {
		if (!hosts.includes(this)) hosts.push(this);
		return originalPin.call(this, teamId, policies);
	};
	const originalOpen = SessionBroker.prototype.openTeamMember;
	let exitKnown = true;
	const closes: string[] = [];
	let providerCalls = 0;
	SessionBroker.prototype.openTeamMember = async ({ binding }) => ({
		instance: { agentId: binding.memberId } as any, sessionId: `session-${binding.memberId}`,
		runActivation: async () => { providerCalls++; throw new Error("Navigation must not start a provider"); },
		terminate() {},
		close: async () => {
			closes.push(binding.memberId);
			if (binding.memberId.endsWith("worker") && !exitKnown) throw new Error("synthetic transport exit unknown");
			return {};
		},
	});
	installRailSubagent(pi);
	const extensionRuntime = createExtensionRuntime();
	extensionRuntime.getThinkingLevel = () => "medium";
	const registry = {
		find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
		getAvailable: () => [model],
	} as unknown as ModelRegistry;
	const runner = new ExtensionRunner([
		{ path: "rail", handlers } as unknown as Extension,
		{ path: "later-canceller", handlers: laterHandlers } as unknown as Extension,
	], extensionRuntime, root, manager, registry);
	Object.assign(runner, { getModel: () => model, getScopedModels: () => [{ model, thinkingLevel: "medium" }] });
	const errors: unknown[] = [];
	runner.onError((error) => errors.push(error));
	let summaryOutcome: "aborted" | "error" = "error";
	let summaryCalls = 0;
	let treeEvents = 0;
	laterHandlers.set("session_tree", [() => { treeEvents++; }]);
	// Exercise Pi's REAL navigateTree + branch summarizer; only its environment and provider are fake.
	const session = Object.assign(Object.create(AgentSession.prototype), {
		sessionManager: manager, _extensionRunner: runner,
		agent: { state: { model, isStreaming: false }, streamFunction: async () => ({ result: async () => {
			summaryCalls++;
			return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [], stopReason: summaryOutcome, errorMessage: "synthetic summary failure", timestamp: 3,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		} }) },
		settingsManager: { getBranchSummarySettings: () => ({ reserveTokens: 1000 }), getRetrySettings: () => ({ enabled: false }) },
		_getSummarizationRequestAuth: async () => ({ model, apiKey: "synthetic-only" }),
		_summarizationRetryCallbacks: () => ({}), _resolveIdleWaitIfIdle: () => undefined,
		_refreshFinalizedContext: () => undefined, _restoreToolsFromTranscript: () => undefined,
	});
	const replacement = new AgentSessionRuntime(session, { cwd: root } as any, async () => { throw new Error("Cancelled navigation must not replace the native runtime"); });
	await runner.emit({ type: "session_start", reason: "startup" });
	t.after(async () => {
		try {
			exitKnown = true;
			await runner.emit({ type: "session_shutdown", reason: "quit" });
			assert.deepEqual(errors, [], "ExtensionRunner must not swallow a Rail handler failure");
		} finally {
			SessionBroker.prototype.openTeamMember = originalOpen;
			TeamSessionHost.prototype.pin = originalPin;
			for (const [key, value] of savedEnv) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			await rm(root, { recursive: true, force: true });
		}
	});
	let serial = 0;
	const prepare = async () => {
		const prefix = `attempt${++serial}`;
		const result = await teamTool.execute("prepare", {
			action: "prepare", manager: { alias: `${prefix}_lead`, roleDescription: "Manage." },
			workers: [{ alias: `${prefix}_worker`, roleDescription: "Work." }],
			brief: { goal: "Native navigation regression." }, timeoutSeconds: null,
		}, undefined, undefined, runner.createContext());
		return { host: hosts.at(-1)!, teamId: result.details.view.teamId as string };
	};
	return {
		root, manager, target, runner, session, replacement, laterHandlers, prepare, hosts, closes,
		setExitKnown: (known: boolean) => { exitKnown = known; },
		setSummaryOutcome: (outcome: "aborted" | "error") => { summaryOutcome = outcome; },
		summaryCalls: () => summaryCalls, treeEvents: () => treeEvents, providerCalls: () => providerCalls,
	};
}

for (const kind of ["tree", "switch", "fork"] as const) {
	test(`native ExtensionRunner later session_before_${kind} cancellation leaves a fresh current-branch Team host`, { timeout: 10000 }, async (t) => {
		const h = await navigationHarness(t);
		const old = await h.prepare();
		const leaf = h.manager.getLeafId();
		h.laterHandlers.set(`session_before_${kind}`, [() => ({ cancel: true })]);
		const result = kind === "tree" ? await h.session.navigateTree(h.target)
			: kind === "switch" ? await h.replacement.switchSession(join(h.root, "not-opened.jsonl"))
				: await h.replacement.fork(h.target);
		assert.equal(result.cancelled, true);
		assert.equal(h.manager.getLeafId(), leaf);
		assert.equal(h.treeEvents(), 0);
		const next = await h.prepare();
		assert.notEqual(next.host, old.host);
		assert.equal(next.host.active, true);
		assert.equal(next.host.runtime.getTeam(next.teamId).lifecycle, "prepared");
		assert.notEqual(old.host.runtime.getTeam(old.teamId).lifecycle, "prepared", "stopped Teams are not restored");
		const entries = h.manager.getEntries().length;
		assert.throws(() => old.host.journal.write({ version: 2, kind: "interrupted", teamId: old.teamId, at: 1, reason: "late old callback" }), /inactive/);
		assert.equal(h.manager.getEntries().length, entries, "old writer cannot append even on the unchanged branch");
		assert.equal(h.providerCalls(), 0);
	});
}

for (const outcome of ["aborted", "error"] as const) {
	test(`native tree summary ${outcome} without session_tree leaves the current branch ready for a new Team`, { timeout: 10000 }, async (t) => {
		const h = await navigationHarness(t);
		const old = await h.prepare();
		const leaf = h.manager.getLeafId();
		h.setSummaryOutcome(outcome);
		if (outcome === "aborted") assert.deepEqual(await h.session.navigateTree(h.target, { summarize: true }), { cancelled: true, aborted: true });
		else await assert.rejects(h.session.navigateTree(h.target, { summarize: true }), /synthetic summary failure/);
		assert.equal(h.summaryCalls(), 1, "Pi's real branch summarizer used only the local synthetic provider");
		assert.equal(h.treeEvents(), 0);
		assert.equal(h.manager.getLeafId(), leaf);
		const next = await h.prepare();
		assert.notEqual(next.host, old.host);
		assert.equal(next.host.active, true);
		assert.equal(old.host.active, false);
		assert.throws(() => old.host.journal.write({ version: 2, kind: "interrupted", teamId: old.teamId, at: 1, reason: "late summary callback" }), /inactive/);
		assert.equal(h.providerCalls(), 0);
	});
}

test("native repeated navigation cannot skip a sealed host with unknown exits; only confirmed cleanup admits a fresh generation", { timeout: 10000 }, async (t) => {
	const h = await navigationHarness(t);
	const old = await h.prepare();
	for (const member of old.host.runtime.getTeam(old.teamId).members) {
		await old.host.driver.openMember({ teamId: old.teamId, memberId: member.id, model: { provider: model.provider, modelId: model.id, thinkingLevel: "medium" } });
	}
	h.setExitKnown(false);
	for (let attempt = 1; attempt <= 2; attempt++) {
		assert.equal((await h.session.navigateTree(h.target)).cancelled, true);
		assert.equal(h.treeEvents(), 0);
		assert.equal(old.host.active, false);
		assert.equal(old.host.hasUnreleasedResources(), true);
		assert.equal(h.closes.filter((alias) => alias.endsWith("worker")).length, attempt);
		await assert.rejects(h.prepare(), /runtime.*ended/);
	}
	h.setExitKnown(true);
	h.laterHandlers.set("session_before_tree", [() => ({ cancel: true })]);
	assert.equal((await h.session.navigateTree(h.target)).cancelled, true);
	assert.equal(old.host.hasUnreleasedResources(), false);
	const next = await h.prepare();
	assert.notEqual(next.host, old.host);
	assert.equal(next.host.active, true);
	assert.equal(h.closes.filter((alias) => alias.endsWith("lead")).length, 1, "confirmed owners are not released twice");
	assert.equal(h.providerCalls(), 0);
});
