import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession, VERSION, getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// Test-only import: production always captures the live instance, never this class.
const { CacheWarmer, formatCacheWarmingStatus } = await import(pathToFileURL(join(getPackageDir(), "dist/core/cache-warmer.js")).href);
import { installRailKeepAlive, keepAliveLabel, keepAliveStatus, onKeepAliveChange } from "../../commands/rail-keep-alive";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness() {
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, Function>();
	let argumentCompletions: ((prefix: string) => Array<{ value: string }>) | undefined;
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
		registerCommand(name: string, { handler, getArgumentCompletions }: { handler: Function; getArgumentCompletions?: (prefix: string) => Array<{ value: string }> }) {
			commands.set(name, handler);
			if (name === "rail-keep-alive") argumentCompletions = getArgumentCompletions;
		},
		appendEntry(_kind: string, data: any) { manager.entries.push({ type: "custom", customType: "rail-keep-alive", data }); manager.leaf++; },
	} as unknown as ExtensionAPI;
	const calls: any[] = [];
	const notices: string[] = [];
	const manager = {
		entries: [] as any[], leaf: 0, getLeafId() { return String(this.leaf); }, getSessionId() { return "parent"; },
		getBranch() { return this.entries; }, getEntries() { return this.entries; },
		appendUsage(kind: string, provider: string, model: string, usage: any) {
			const entry = { type: "usage", kind, provider, model, usage };
			this.entries.push(entry); this.leaf++; return entry;
		},
	};
	let result: any = { stopReason: "stop", provider: "test", model: "model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.01 } } };
	const models = { streamSimple(model: any, context: any, options: any) {
		calls.push({ model, context, options });
		return { result: async () => result };
	} };
	const decision = async (event: any) => {
		const actions = handlers.get("cache_warming_decision") ?? [];
		let action = event.action;
		for (const handler of actions) action = (await handler(event, ctx))?.action ?? action;
		return action;
	};
	const warmer = new CacheWarmer(models as any, manager as any, () => "streaming", decision) as any;
	const session = Object.create(AgentSession.prototype) as AgentSession;
	Object.defineProperties(session, { sessionManager: { value: manager }, _cacheWarmer: { value: warmer } });
	let idle = true;
	const ctx = { sessionManager: manager, isIdle: () => idle, ui: { notify(text: string) { notices.push(text); } } } as any;
	const emitAt = async (name: string, target: any, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, target); };
	const emit = (name: string, event: any = {}) => emitAt(name, ctx, event);
	const command = async (args: string) => commands.get("rail-keep-alive")!(args, ctx);
	const request = { model: { provider: "test", id: "model", api: "openai-responses", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, context: { messages: [{ role: "system", content: "secret" }] }, options: { onPayload: () => {}, onResponse: () => {}, headers: { token: "local" } } };
	// AgentSession.model reads agent.state.model.
	const parentController = new AbortController();
	const agent = { state: { model: request.model, streamingMessage: undefined as any }, signal: parentController.signal };
	Object.defineProperty(session, "agent", { value: agent });
	const originalPrompt = AgentSession.prototype.prompt;
	const originalDispose = AgentSession.prototype.dispose;
	AgentSession.prototype.prompt = async () => {};
	AgentSession.prototype.dispose = () => {};
	installRailKeepAlive(pi);
	return { warmer, session, agent, parentController, manager, ctx, emit, emitAt, command, request, calls, notices, completions: (prefix: string) => argumentCompletions?.(prefix).map((item) => item.value), setIdle: (value: boolean) => { idle = value; }, registerHook: (name: string, fn: Function) => pi.on(name as any, fn as any), setResult(value: any) { result = value; }, async begin() {
		await emit("session_start", { reason: "startup" });
		await session.prompt("capture without real request");
	}, cleanup: async () => { await emit("session_shutdown"); AgentSession.prototype.prompt = originalPrompt; AgentSession.prototype.dispose = originalDispose; } };
}

test("manual idle interval reuses native refresh and usage, beyond 30/180 minutes without metadata", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		assert.equal(VERSION, "0.87.1");
		await h.begin();
		await h.command("1");
		assert.match(keepAliveStatus(h.manager)!, /WAIT.*fresh real request/);
		h.warmer.start({ ...h.request, model: { ...h.request.model, cost: undefined } }, () => true);
		assert.equal(h.calls.length, 0);
		h.warmer.onAgentSettled();
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0].options.maxTokens, 1);
		assert.equal(h.calls[0].options.onPayload, h.request.options.onPayload);
		assert.equal(h.calls[0].options.onResponse, h.request.options.onResponse);
		assert.deepEqual(h.calls[0].options.headers, h.request.options.headers);
		assert.equal(h.manager.entries.filter(e => e.type === "usage").length, 1);
		for (let i = 0; i < 181; i++) { t.mock.timers.tick(60_000); await flush(); }
		assert.equal(h.calls.length, 182, "continues beyond the native 30/180-minute windows");
		t.mock.timers.setTime(Date.now() + 120_000);
		t.mock.timers.tick(60_000); await flush();
		assert.match(keepAliveStatus(h.manager)!, /PAUSED.*late after sleep/);
		assert.equal(h.calls.length, 182, "sleep must not cause catch-up requests");
	} finally { await h.cleanup(); }
});

test("manual native status remains scheduled with unknown costs, and retains real known estimates", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		h.warmer.start({ ...h.request, model: { ...h.request.model, cost: undefined } }, () => true);
		h.warmer.onAgentSettled();
		const unknown = h.session.cacheWarmingStatus! as any;
		assert.equal(unknown.state, "scheduled");
		assert.equal(unknown.decision.economicsAvailable, false);
		assert.ok(Number.isNaN(unknown.decision.warmCost), "unknown does not become $0");
		assert.match(unknown.reason, /Rail manual 1m/);
		assert.match(formatCacheWarmingStatus(unknown, Date.now()), /extension override, cache economics unavailable/);
		h.manager.entries.push({ type: "message", message: { role: "assistant", usage: { input: 20_000, cacheRead: 0, cacheWrite: 0 } } });
		const priced = { ...h.request, model: { ...h.request.model, cost: { input: 10, output: 2, cacheRead: 1, cacheWrite: 10 } } };
		h.warmer.start(priced, () => true); h.warmer.onAgentSettled();
		const known = h.session.cacheWarmingStatus! as any;
		assert.equal(known.state, "scheduled");
		assert.equal(known.decision.economicsAvailable, true);
		assert.ok(Number.isFinite(known.decision.warmCost) && known.decision.warmCost > 0);
		assert.ok(Number.isFinite(known.decision.missCost) && known.decision.missCost > 0);
		assert.equal(known.decision.action, "stop", "status reports the native economic decision");
		assert.equal(h.warmer.evaluate(h.warmer.run).action, "warm", "manual execution remains explicitly warm");
		assert.match(formatCacheWarmingStatus(known, Date.now()), /expected savings \$0\.007 < \$0\.050/);
		assert.doesNotMatch(formatCacheWarmingStatus(known, Date.now()), /\$0\.007 >= \$0\.050/);
		assert.equal(known.extensionOverride, true);
		assert.equal(known.manual, true);
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1, "manual warm still dispatches below the native threshold");
		await h.command("off");
		assert.equal(h.session.cacheWarmingStatus!.state, "inactive");
	} finally { await h.cleanup(); }
});

test("keep-alive change subscription covers start/schedule/refresh/pause/off and unsubscribes", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	const labels: Array<string | undefined> = [];
	const unsubscribe = onKeepAliveChange(h.manager, () => labels.push(keepAliveLabel(h.manager)));
	try {
		await h.begin();
		assert.ok(labels.length >= 2, "session start and live instance bind both publish");
		await h.command("1");
		h.warmer.start(h.request, () => true);
		h.warmer.onAgentSettled();
		t.mock.timers.tick(60_000); await flush();
		h.warmer.start({ ...h.request, options: { cacheRetention: "none" } }, () => true);
		await h.command("off");
		assert.ok(labels.includes("KA 1|-"));
		assert.ok(labels.includes("KA 1|0"));
		assert.ok(labels.includes("KA 1|PAUSED"));
		assert.equal(labels.at(-1), undefined);
		const count = labels.length;
		unsubscribe();
		await h.command("1");
		assert.equal(labels.length, count);
	} finally { unsubscribe(); await h.cleanup(); }
});

test("footer label counts down whole minutes to the next refresh and re-renders each minute", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
	const h = harness();
	let renders = 0;
	const unsubscribe = onKeepAliveChange(h.manager, () => renders++);
	try {
		await h.begin(); await h.command("3");
		assert.equal(keepAliveLabel(h.manager), "KA 3|-", "no countdown before a real request settles");
		h.warmer.start(h.request, () => true);
		assert.equal(keepAliveLabel(h.manager), "KA 3|-", "no countdown while the agent runs");
		h.warmer.onAgentSettled();
		assert.equal(keepAliveLabel(h.manager), "KA 3|3");
		t.mock.timers.tick(30_000);
		assert.equal(keepAliveLabel(h.manager), "KA 3|3", "a partial minute rounds up");
		const before = renders;
		t.mock.timers.tick(30_000);
		assert.ok(renders > before, "each minute boundary re-renders the footer");
		assert.equal(keepAliveLabel(h.manager), "KA 3|2");
		t.mock.timers.tick(60_000);
		assert.equal(keepAliveLabel(h.manager), "KA 3|1");
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1, "the refresh fires when the countdown reaches 0");
		assert.equal(keepAliveLabel(h.manager), "KA 3|3", "a completed refresh restarts the countdown");
		await h.command("off");
		const afterOff = renders;
		t.mock.timers.tick(10 * 60_000);
		assert.equal(renders, afterOff, "off stops the minute ticks");
	} finally { unsubscribe(); await h.cleanup(); }
});

test("command argument completions include common intervals, off and status", async () => {
	const h = harness();
	try {
		const completions = h.completions;
		assert.deepEqual(completions(""), ["30", "50", "off", "status"]);
		assert.deepEqual(completions("5"), ["50"]);
		assert.deepEqual(completions("o"), ["off"]);
	} finally { await h.cleanup(); }
});

test("command arguments are case-insensitive", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin();
		await h.command("1");
		await h.command("STATUS");
		assert.doesNotMatch(h.notices.at(-1)!, /Usage/);
		await h.command("OFF");
		assert.equal(h.session.cacheWarmingStatus!.state, "inactive");
		assert.match(h.notices.at(-1)!, /off for this session/);
	} finally { await h.cleanup(); }
});

test("off aborts, stop veto wins, failed refresh pauses until fresh request", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		await h.command("off");
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 0);
		assert.equal(keepAliveLabel(h.manager), undefined);
		await h.command("1");
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		h.setResult({ stopReason: "error", errorMessage: "authentication rejected" });
		t.mock.timers.tick(60_000); await flush();
		assert.match(keepAliveStatus(h.manager)!, /PAUSED.*authentication rejected/);
		t.mock.timers.tick(180 * 60_000); await flush();
		assert.equal(h.calls.length, 1);
		h.setResult({ stopReason: "stop", provider: "test", model: "model", usage: { input: 1, cost: { total: 0 } } });
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		handlersStop(h);
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1);
		assert.match(keepAliveStatus(h.manager)!, /PAUSED.*stopped by another extension/);
	} finally { await h.cleanup(); }
});

function handlersStop(h: ReturnType<typeof harness>) {
	h.registerHook("cache_warming_decision", (event: any) => {
		assert.equal(event.action, "warm", "manual decision is warm even without economics");
		return { action: "stop" }; // an independent extension vetoes the refresh
	});
}

const responseEnded = (h: ReturnType<typeof harness>, stopReason = "toolUse") =>
	h.emit("message_end", { message: { role: "assistant", stopReason } });

test("completed responses warm while working for hours; sibling tools, progress and queued input do not reset the interval", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("50"); h.setIdle(false);
		h.warmer.start(h.request, () => true);
		t.mock.timers.tick(60 * 60_000); await flush();
		assert.equal(h.calls.length, 0, "no warm during a long model response");
		await responseEnded(h);
		const deadline = h.warmer.run.nextWarmAt;
		assert.equal(keepAliveLabel(h.manager), "KA 50|50");
		assert.match(keepAliveStatus(h.manager)!, /waiting for tools/);
		assert.equal(h.session.cacheWarmingStatus!.state, "scheduled");
		for (let cycle = 0; cycle < 4; cycle++) {
			for (const toolName of ["subagent", "subagent_team", "bash"]) {
				await h.emit("tool_execution_start", { toolName, toolCallId: toolName });
				t.mock.timers.tick(10 * 60_000);
				await h.emit("tool_execution_update", { toolName, toolCallId: toolName });
				await h.emit("input", { text: "queued follow-up", source: "interactive" });
				await h.emit("message_end", { message: { role: "toolResult", toolCallId: toolName } });
				await h.emit("tool_execution_end", { toolName, toolCallId: toolName });
			}
			assert.equal(keepAliveLabel(h.manager), "KA 50|20");
			assert.equal(h.warmer.run.nextWarmAt, deadline + cycle * 50 * 60_000);
			t.mock.timers.tick(20 * 60_000); await flush();
			assert.equal(h.calls.length, cycle + 1, "one loop for all tools; continues past 1h/3h");
			assert.equal(keepAliveLabel(h.manager), "KA 50|50");
		}
		assert.equal(h.manager.entries.filter(e => e.type === "usage").length, 4);
		assert.equal(h.calls[0].context, h.request.context, "replay the parent's request, not child progress/results");
		assert.equal(h.calls[0].options.maxTokens, 1);
	} finally { await h.cleanup(); }
});

test("settlement preserves the post-response deadline and an in-flight refresh", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("3"); h.setIdle(false);
		h.warmer.start(h.request, () => true); await responseEnded(h, "stop");
		t.mock.timers.tick(60_000);
		h.setIdle(true); h.warmer.onAgentSettled();
		assert.equal(keepAliveLabel(h.manager), "KA 3|2", "settling does not restart the interval");
		t.mock.timers.tick(120_000); await flush();
		assert.equal(h.calls.length, 1);
		h.setIdle(false); h.warmer.start(h.request, () => true); await responseEnded(h);
		let resolve!: (result: any) => void;
		const result = new Promise(r => { resolve = r; });
		h.setResult(result);
		t.mock.timers.tick(180_000); await flush();
		assert.equal(h.calls.length, 2);
		h.setIdle(true); h.warmer.onAgentSettled();
		assert.equal(keepAliveLabel(h.manager), "KA 3|0", "settlement cannot schedule a second refresh over the first");
		resolve({ stopReason: "stop", provider: "test", model: "model", usage: { input: 1, cost: { total: 0 } } });
		await flush();
		assert.equal(keepAliveLabel(h.manager), "KA 3|3");
	} finally { await h.cleanup(); }
});

test("new parent requests abort pending warms; late results cannot pause or reschedule the replacement", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1"); h.setIdle(false);
		let resolve!: (result: any) => void;
		h.setResult(new Promise(r => { resolve = r; }));
		h.warmer.start(h.request, () => true); await responseEnded(h);
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1);
		const old = h.warmer.run;
		h.warmer.start({ ...h.request, context: { messages: ["new request"] } }, () => true);
		assert.equal(old.controller.signal.aborted, true);
		resolve({ stopReason: "aborted" }); await flush();
		assert.equal(keepAliveLabel(h.manager), "KA 1|-");
		assert.equal(h.notices.some(n => n.includes("PAUSED")), false);
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1, "nothing scheduled during the replacement model request");
		h.setResult({ stopReason: "stop", provider: "test", model: "model", usage: { input: 1, cost: { total: 0 } } });
		await responseEnded(h);
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 2);
		assert.deepEqual(h.calls[1].context.messages, ["new request"]);
		assert.equal(h.manager.entries.filter(e => e.type === "usage").length, 1);
	} finally { await h.cleanup(); }
});

test("cancelling a waiting parent immediately aborts its warm and does not re-arm at settlement", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1"); h.setIdle(false);
		let resolve!: (result: any) => void;
		h.setResult(new Promise(r => { resolve = r; }));
		h.warmer.start(h.request, () => true); await responseEnded(h);
		const old = h.warmer.run;
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1);
		h.parentController.abort();
		assert.equal(old.controller.signal.aborted, true);
		assert.equal(h.warmer.run, undefined);
		resolve({ stopReason: "aborted" }); await flush();
		h.setIdle(true); h.warmer.onAgentSettled();
		t.mock.timers.tick(120_000); await flush();
		assert.equal(h.calls.length, 1);
		assert.equal(h.manager.entries.filter(e => e.type === "usage").length, 0);
	} finally { await h.cleanup(); }
});

test("compaction, model/tree changes, off and shutdown invalidate a waiting snapshot", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1"); h.setIdle(false);
		for (const event of ["session_before_compact", "model_select", "session_tree", "session_shutdown"]) {
			h.warmer.start(h.request, () => true); await responseEnded(h);
			const old = h.warmer.run;
			assert.equal(keepAliveLabel(h.manager), "KA 1|1", event);
			await h.emit(event);
			assert.equal(old.controller.signal.aborted, true, event);
			t.mock.timers.tick(60_000); await flush();
			assert.equal(h.calls.length, 0, event);
		}
		await h.begin();
		h.warmer.start(h.request, () => true); await responseEnded(h);
		await h.command("off");
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 0);
	} finally { await h.cleanup(); }
});

test("failed parent responses and context rewrites cannot become replayable at settlement", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		for (const stopReason of ["error", "aborted"]) {
			h.warmer.start(h.request, () => true); await responseEnded(h, stopReason);
			h.warmer.onAgentSettled();
			t.mock.timers.tick(60_000); await flush();
			assert.equal(h.calls.length, 0);
		}
		h.warmer.start(h.request, () => true); await responseEnded(h);
		h.manager.entries.push({ id: "edit", type: "context_edit", targetId: "original", replacement: null });
		h.warmer.onAgentSettled();
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 0, "settlement must not bless a rewritten prefix by replacing the snapshot path");
	} finally { await h.cleanup(); }
});

test("a decision pending during tool wait cannot send after a new request or compaction", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1"); h.setIdle(false);
		let release!: () => void;
		h.registerHook("cache_warming_decision", () => new Promise(resolve => { release = () => resolve({ action: "warm" }); }));
		for (const event of ["request", "turn_start", "session_before_compact"]) {
			h.warmer.start(h.request, () => true); await responseEnded(h);
			t.mock.timers.tick(60_000); await flush();
			assert.equal(typeof release, "function", "the post-response countdown must reach the decision hook");
			if (event === "request") h.warmer.start(h.request, () => true);
			else await h.emit(event);
			release(); await flush();
			t.mock.timers.tick(120_000); await flush(); // A slow request-preparation hook must not keep the old timer alive.
			assert.equal(h.calls.length, 0);
		}
	} finally { await h.cleanup(); }
});

test("branch/model/compaction/input invalidate while preserving session choice", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		for (const event of ["input", "before_agent_start", "turn_start", "model_select", "session_tree", "session_before_compact"]) {
			h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
			await h.emit(event);
			t.mock.timers.tick(60_000); await flush();
			assert.equal(h.calls.length, 0, event);
			assert.match(keepAliveStatus(h.manager)!, /WAIT.*fresh real request/);
		}
	} finally { await h.cleanup(); }
});

test("new child session never inherits paid authorization; parent's off cannot disable child's native warmer", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		const childManager = {
			...h.manager, entries: [...h.manager.entries], leaf: 0,
			getSessionId() { return "child"; },
		};
		const childWarmer = new CacheWarmer({ streamSimple() { throw new Error("child must not warm in this test"); } } as any, childManager as any, () => "streaming") as any;
		const child = Object.create(AgentSession.prototype) as AgentSession;
		Object.defineProperties(child, { sessionManager: { value: childManager }, _cacheWarmer: { value: childWarmer } });
		const childCtx = { ...h.ctx, sessionManager: childManager };
		await h.emitAt("session_start", childCtx, { reason: "fork" });
		await child.prompt("capture");
		assert.equal(keepAliveStatus(childManager), undefined);
		await h.command("off");
		const nativeRequest = { ...h.request, model: { ...h.request.model, promptCache: { short: 300 } } };
		childWarmer.start(nativeRequest, () => true);
		assert.ok(childWarmer.run?.timer, "child still uses native streaming mode");
		await h.emitAt("session_shutdown", childCtx);
	} finally { await h.cleanup(); }
});

test("native cancel (what AgentSession.dispose calls) aborts a pending manual timer", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		h.warmer.start(h.request, () => true);
		h.warmer.onAgentSettled();
		h.warmer.cancel();
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 0);
		assert.match(keepAliveStatus(h.manager)!, /WAIT.*fresh real request/);
	} finally { await h.cleanup(); }
});

test("unsafe replay and missing live warmer pause visibly without a request", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		h.warmer.start({ ...h.request, options: { cacheRetention: "none" } }, () => true);
		assert.match(keepAliveStatus(h.manager)!, /PAUSED.*disabled prompt caching/);
		h.warmer.start({ ...h.request, model: { ...h.request.model, api: "anthropic-messages" }, options: { reasoning: "high" } }, () => true);
		assert.match(keepAliveStatus(h.manager)!, /PAUSED.*cannot be replayed/);
		t.mock.timers.tick(120_000); await flush();
		assert.equal(h.calls.length, 0);
	} finally { await h.cleanup(); }
});

test("unsupported live warmer cannot claim N/off succeeded or persist an uncontrolled setting", async () => {
	const h = harness();
	try {
		h.warmer.refresh = undefined;
		await h.begin();
		await h.command("1");
		await h.command("off");
		await h.command("status");
		assert.equal(keepAliveStatus(h.manager), undefined);
		assert.equal(h.manager.entries.filter((e) => e.customType === "rail-keep-alive").length, 0);
		assert.ok(h.notices.every((text) => /unavailable.*cannot control native warming/.test(text)), h.notices.join("; "));
		assert.equal(h.warmer.getMode(), "streaming", "native mode is unchanged, not falsely reported disabled");
		assert.equal(h.calls.length, 0);
	} finally { await h.cleanup(); }
});

test("unsupported resume retains a PAUSED reason when subsequent N/off commands are rejected", async () => {
	const h = harness();
	try {
		h.manager.entries.push({ type: "custom", customType: "rail-keep-alive", data: { sessionId: "parent", minutes: 30 } });
		h.warmer.refresh = undefined;
		await h.begin();
		assert.match(keepAliveStatus(h.manager)!, /KA 30m PAUSED.*unsupported Pi CacheWarmer/);
		await h.command("50");
		await h.command("off");
		assert.match(keepAliveStatus(h.manager)!, /KA 30m PAUSED/);
		assert.equal(h.manager.entries.length, 1, "no new authorization entry is recorded");
	} finally { await h.cleanup(); }
});

test("/reload keeps a scheduled refresh on time; a quit and resume waits for a fresh request", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("3");
		h.warmer.start(h.request, () => true);
		h.warmer.onAgentSettled();
		t.mock.timers.tick(60_000);
		assert.equal(keepAliveLabel(h.manager), "KA 3|2");
		await h.emit("session_shutdown", { reason: "reload" });
		await h.emit("session_start", { reason: "reload" });
		assert.equal(keepAliveLabel(h.manager), "KA 3|2", "the countdown continues without a new request");
		t.mock.timers.tick(120_000); await flush();
		assert.equal(h.calls.length, 1, "the refresh fires at its original time");
		assert.equal(h.calls[0].options.onPayload, h.request.options.onPayload, "the same request snapshot is replayed");
		assert.equal(keepAliveLabel(h.manager), "KA 3|3");
		await h.emit("session_shutdown", { reason: "quit" });
		await h.emit("session_start", { reason: "resume" });
		assert.equal(keepAliveLabel(h.manager), "KA 3|-", "a new process has no request snapshot to replay");
		t.mock.timers.tick(10 * 60_000); await flush();
		assert.equal(h.calls.length, 1);
		await h.session.prompt("fresh capture");
		h.warmer.start(h.request, () => true);
		h.warmer.onAgentSettled();
		t.mock.timers.tick(3 * 60_000); await flush();
		assert.equal(h.calls.length, 2);
		await h.command("off");
		await h.emit("session_shutdown", { reason: "reload" });
		await h.emit("session_start", { reason: "reload" });
		await h.session.prompt("bind after off");
		assert.equal(h.warmer.getMode(), "off", "persisted off overrides native streaming");
		h.warmer.start({ ...h.request, model: { ...h.request.model, promptCache: { short: 300 } } }, () => true);
		assert.equal(h.warmer.run, undefined);
	} finally { await h.cleanup(); }
});

test("re-projected agent messages keep the snapshot; a model switch stales it", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		// Pi's native check compares message objects, which a turn_end refresh re-creates for compaction summaries.
		h.warmer.start(h.request, () => false);
		h.warmer.onAgentSettled();
		assert.equal(keepAliveLabel(h.manager), "KA 1|1");
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1, "the same session entries still refresh");
		h.agent.state.model = { ...h.request.model, id: "other" };
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1);
		assert.equal(keepAliveLabel(h.manager), "KA 1|-");
	} finally { await h.cleanup(); }
});

test("a provider exception pauses instead of silently rescheduling", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		h.setResult({ then: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error("no API key for provider")) });
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		t.mock.timers.tick(60_000); await flush();
		assert.match(keepAliveStatus(h.manager)!, /PAUSED.*no API key/);
		t.mock.timers.tick(120_000); await flush();
		assert.equal(h.calls.length, 1, "no retry until a fresh real request");
	} finally { await h.cleanup(); }
});

test("a stale decision veto cannot cancel a newer settled request", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	let resolveOld!: (value: { action: string }) => void;
	let decisions = 0;
	try {
		await h.begin(); await h.command("1");
		h.registerHook("cache_warming_decision", () => ++decisions === 1
			? new Promise(resolve => { resolveOld = resolve; }) : { action: "warm" });
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		t.mock.timers.tick(60_000); await flush();
		assert.equal(decisions, 1);
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		resolveOld({ action: "stop" }); await flush();
		assert.match(keepAliveStatus(h.manager)!, /WAIT \(next/);
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1, "B's first refresh must survive A's late veto");
		assert.equal(h.manager.entries.filter(e => e.type === "usage").length, 1);
	} finally { await h.cleanup(); }
});

test("a hung stale decision cannot block the replacement run", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	let decisions = 0;
	try {
		await h.begin(); await h.command("1");
		h.registerHook("cache_warming_decision", () => ++decisions === 1 ? new Promise(() => {}) : { action: "warm" });
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		t.mock.timers.tick(60_000); await flush();
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		t.mock.timers.tick(30_000); await flush();
		assert.match(keepAliveStatus(h.manager)!, /WAIT \(next/);
		t.mock.timers.tick(30_000); await flush();
		assert.equal(h.calls.length, 1);
	} finally { await h.cleanup(); }
});

test("metadata and appended messages keep the snapshot; context_edit and branch replacement stale it", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		h.manager.entries.push({ id: "user-a", type: "message", message: { role: "user" } });
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		h.manager.entries.push({ id: "title", type: "session_info" }, { id: "note", type: "custom" }, { id: "label", type: "label" });
		h.manager.entries.push({ id: "bang", type: "message", message: { role: "bashExecution" } });
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1, "an appended `!cmd` output leaves the cached prefix intact");
		h.manager.entries.push({ id: "edit", type: "context_edit", targetId: "user-a", replacement: null });
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1, "a context edit invalidates even if the original messages still match");
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		h.manager.entries.splice(h.manager.entries.findIndex(e => e.id === "user-a"), 1, { id: "user-b", type: "message" });
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 1, "different branch must not reuse the request snapshot");
	} finally { await h.cleanup(); }
});

test("a timer and an async decision both refuse dispatch while the session is busy", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	const h = harness();
	try {
		await h.begin(); await h.command("1");
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		h.setIdle(false);
		t.mock.timers.tick(60_000); await flush();
		assert.equal(h.calls.length, 0);
		assert.match(keepAliveStatus(h.manager)!, /PAUSED.*busy/);
		h.setIdle(true);
		h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
		let release!: () => void;
		h.registerHook("cache_warming_decision", () => new Promise(resolve => { release = () => resolve({ action: "warm" }); }));
		t.mock.timers.tick(60_000); await flush();
		h.setIdle(false); release(); await flush();
		assert.equal(h.calls.length, 0);
		assert.match(keepAliveStatus(h.manager)!, /PAUSED.*busy/);
	} finally { await h.cleanup(); }
});
