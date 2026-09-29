import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession, VERSION, getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// Test-only import: production always captures the live instance, never this class.
const { CacheWarmer } = await import(pathToFileURL(join(getPackageDir(), "dist/core/cache-warmer.js")).href);
import { installRailKeepAlive, keepAliveLabel, keepAliveStatus } from "../../commands/rail-keep-alive";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness() {
 const handlers = new Map<string, Function[]>();
 const commands = new Map<string, Function>();
 const pi = {
  on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
  registerCommand(name: string, { handler }: { handler: Function }) { commands.set(name, handler); },
  appendEntry(_kind: string, data: any) { manager.entries.push({ type: "custom", customType: "rail-keep-alive", data }); manager.leaf++; },
 } as unknown as ExtensionAPI;
 const calls: any[] = [];
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
 const ctx = { sessionManager: manager, isIdle: () => idle, ui: { notify() {} } } as any;
 const emitAt = async (name: string, target: any, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, target); };
 const emit = (name: string, event: any = {}) => emitAt(name, ctx, event);
 const command = async (args: string) => commands.get("rail-keep-alive")!(args, ctx);
 const request = { model: { provider: "test", id: "model", api: "openai-responses", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, context: { messages: [{ role: "system", content: "secret" }] }, options: { onPayload: () => {}, onResponse: () => {}, headers: { token: "local" } } };
 const originalPrompt = AgentSession.prototype.prompt;
 const originalDispose = AgentSession.prototype.dispose;
 AgentSession.prototype.prompt = async () => {};
 AgentSession.prototype.dispose = () => {};
 installRailKeepAlive(pi);
 return { warmer, session, manager, ctx, emit, emitAt, command, request, calls, setIdle: (value: boolean) => { idle = value; }, registerHook: (name: string, fn: Function) => pi.on(name as any, fn as any), setResult(value: any) { result = value; }, async begin() {
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

test("branch/model/compaction/input invalidate while preserving session choice", async (t) => {
 t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
 const h = harness();
 try {
  await h.begin(); await h.command("1");
  for (const event of ["input", "model_select", "session_tree", "session_before_compact", "session_compact", "session_compact_failed"]) {
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

test("SDK dispose aborts a pending manual timer and restores the temporary bridge", async (t) => {
 t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
 const h = harness();
 try {
  await h.begin(); await h.command("1");
  h.warmer.start(h.request, () => true);
  h.warmer.onAgentSettled();
  h.session.dispose();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(keepAliveStatus(h.manager), undefined);
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

test("unsupported live warmer structure fails closed and reports PAUSED", async () => {
 const h = harness();
 try {
  h.warmer.refresh = undefined;
  await h.begin(); await h.command("1");
  assert.match(keepAliveStatus(h.manager)!, /PAUSED.*unsupported Pi CacheWarmer/);
  assert.equal(h.calls.length, 0);
 } finally { await h.cleanup(); }
});

test("reload restores only the same session's choice, never its old request snapshot", async (t) => {
 t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
 const h = harness();
 try {
  await h.begin(); await h.command("1");
  h.warmer.start(h.request, () => true);
  h.warmer.onAgentSettled();
  await h.emit("session_shutdown", { reason: "reload" });
  await h.emit("session_start", { reason: "reload" });
  assert.match(keepAliveStatus(h.manager)!, /WAIT.*fresh real request/);
  t.mock.timers.tick(60_000); await flush();
  assert.equal(h.calls.length, 0);
  await h.session.prompt("fresh capture");
  h.warmer.start(h.request, () => true);
  h.warmer.onAgentSettled();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(h.calls.length, 1);
  await h.command("off");
  await h.emit("session_shutdown", { reason: "reload" });
  await h.emit("session_start", { reason: "reload" });
  await h.session.prompt("bind after off");
  assert.equal(h.warmer.getMode(), "off", "persisted off overrides native streaming");
  h.warmer.start({ ...h.request, model: { ...h.request.model, promptCache: { short: 300 } } }, () => true);
  assert.equal(h.warmer.run, undefined);
 } finally { await h.cleanup(); }
});

test("provider timeout and usage persistence failure pause instead of silently rescheduling", async (t) => {
 t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
 const h = harness();
 try {
  await h.begin(); await h.command("1");
  h.setResult(new Promise(() => {}));
  h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
  t.mock.timers.tick(60_000); await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.match(keepAliveStatus(h.manager)!, /PAUSED.*timed out/);
  h.setResult({ stopReason: "stop", provider: "test", model: "model", usage: { input: 1, cost: { total: 0 } } });
  h.manager.appendUsage = () => { throw new Error("disk full"); };
  h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
  t.mock.timers.tick(60_000); await flush();
  assert.match(keepAliveStatus(h.manager)!, /PAUSED.*disk full/);
  t.mock.timers.tick(120_000); await flush();
  assert.equal(h.calls.length, 2);
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

test("a stale decision timeout cannot pause the replacement run", async (t) => {
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

test("non-context metadata and usage do not stale the snapshot, but context_edit and branch replacement do", async (t) => {
 t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
 const h = harness();
 try {
  await h.begin(); await h.command("1");
  h.manager.entries.push({ id: "user-a", type: "message", message: { role: "user" } });
  h.warmer.start(h.request, () => true); h.warmer.onAgentSettled();
  h.manager.entries.push({ id: "title", type: "session_info" }, { id: "note", type: "custom" }, { id: "label", type: "label" });
  t.mock.timers.tick(60_000); await flush();
  assert.equal(h.calls.length, 1);
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
