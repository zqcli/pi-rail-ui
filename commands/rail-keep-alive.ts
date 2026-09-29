import { AgentSession, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createStore } from "../core/patching";

// Pi 0.87.1's CacheWarmer is private and the bundled CLI has a different class
// from dist/core/cache-warmer.js. Capture the live instance through the public
// AgentSession's prompt boundary; never import or patch the detached dist class.
const ENTRY = "rail-keep-alive";
const INTERVAL = 60_000;
const LATE_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
type Mode = { minutes?: number | null | undefined; paused?: string | undefined };
type Run = { timer?: ReturnType<typeof setTimeout> | undefined; controller: AbortController; isCurrent: () => boolean; nextWarmAt: number; phase: string; [key: string]: any };
type Warmer = {
 run?: Run; models: { streamSimple: (...args: any[]) => any }; sessionManager: any;
 getMode: () => string; decide: (event: any) => Promise<string>; onWarmed?: ((entry: any) => void) | undefined;
 start: (request: any, isCurrent: () => boolean) => void; schedule: (run: Run) => void;
 onAgentSettled: () => void; refreshDeadlineMissed: (run: Run) => boolean;
 evaluate: (run: Run) => any;
 stop: (reason: string) => void; cancel: () => void; clearRun: () => void;
 refresh: (run: Run) => Promise<void>;
};
type State = { manager: any; warmer?: Warmer | undefined; mode: Mode; restore?: (() => void) | undefined; notify?: (text: string) => void; isIdle?: () => boolean };
type Bridge = { pending: Set<State>; active: Set<State>; original?: any; wrapper?: any; disposeOriginal?: any; disposeWrapper?: any };
const bridge = createStore<Bridge>("keep-alive-bridge", () => ({ pending: new Set(), active: new Set() }));
const states = createStore<Map<any, State>>("keep-alive-states", () => new Map());

function releaseBridge(state: State): void {
 const b = bridge();
 b.pending.delete(state);
 if (!b.pending.size && b.wrapper && AgentSession.prototype.prompt === b.wrapper) {
  AgentSession.prototype.prompt = b.original;
  b.wrapper = undefined;
  b.original = undefined;
 }
}
function awaitSession(state: State): void {
 const b = bridge();
 b.pending.add(state);
 b.active.add(state);
 if (!b.disposeWrapper) {
  b.disposeOriginal = AgentSession.prototype.dispose;
  b.disposeWrapper = function(this: AgentSession, ...args: any[]) {
   const original = b.disposeOriginal;
   const owner = [...b.active].find((item) => item.manager === this.sessionManager);
   if (owner) stop(owner);
   return original.apply(this, args);
  };
  AgentSession.prototype.dispose = b.disposeWrapper;
 }
 if (b.wrapper) return;
 b.original = AgentSession.prototype.prompt;
 b.wrapper = function(this: AgentSession, ...args: any[]) {
  const original = b.original;
  for (const waiting of [...b.pending]) {
   if (this.sessionManager !== waiting.manager) continue;
   bind(waiting, this);
   releaseBridge(waiting);
  }
  return original.apply(this, args);
 };
 AgentSession.prototype.prompt = b.wrapper;
}
function valid(w: any, session: AgentSession, state: State): w is Warmer {
 return VERSION === "0.87.1" && session instanceof AgentSession && w?.sessionManager === state.manager &&
  typeof w.start === "function" && typeof w.schedule === "function" &&
  typeof w.refresh === "function" && typeof w.onAgentSettled === "function" &&
  typeof w.refreshDeadlineMissed === "function" && typeof w.evaluate === "function" && typeof w.clearRun === "function" &&
  typeof w.stop === "function" && typeof w.cancel === "function" &&
  typeof w.decide === "function" && typeof w.getMode === "function" &&
  typeof w.models?.streamSimple === "function";
}
function pause(state: State, reason: string): void {
 state.mode.paused = reason;
 state.warmer?.stop(reason);
 state.notify?.(`Rail keep-alive PAUSED: ${reason}`);
}
function bind(state: State, session: AgentSession): void {
 const w = (session as any)._cacheWarmer;
 if (!valid(w, session, state)) {
  state.mode.paused = "unsupported Pi CacheWarmer (requires 0.87.1 live session)";
  state.notify?.(`Rail keep-alive PAUSED: ${state.mode.paused}`);
  return;
 }
 state.warmer = w;
 const original = {
  start: w.start, schedule: w.schedule, settled: w.onAgentSettled,
  deadline: w.refreshDeadlineMissed, evaluate: w.evaluate, mode: w.getMode, decide: w.decide,
  models: w.models, manager: w.sessionManager, warmed: w.onWarmed, clearRun: w.clearRun,
 };
 const compactDescriptor = Object.getOwnPropertyDescriptor(session, "compact");
 const compact = session.compact;
 const compactWrapper = function(this: AgentSession, ...args: Parameters<AgentSession["compact"]>) {
  if (state.mode.minutes) { w.cancel(); state.mode.paused = undefined; }
  return compact.apply(this, args);
 };
 session.compact = compactWrapper;
 const pendingDecisions = new Map<Run, () => void>();
 let generation = 0;
 w.clearRun = function() {
  const run = w.run;
  generation++;
  if (run) pendingDecisions.get(run)?.();
  original.clearRun.call(w);
 };
 // Session entries that cannot change provider context must not invalidate a
 // request snapshot. Keep context edits, compactions and branch ancestry guarded.
 const contextPath = () => state.manager.getBranch()
  .filter((entry: any) => !["usage", "session_info", "label", "custom"].includes(entry.type))
  .map((entry: any) => entry.id ?? entry);
 let path = contextPath();
 const samePath = () => {
  const now = contextPath();
  return now.length === path.length && now.every((id: any, index: number) => id === path[index]);
 };
 w.getMode = () => state.mode.minutes === null ? "off" : state.mode.minutes ? "idle" : original.mode();
 w.start = function(request, isCurrent) {
  if (state.mode.minutes === null) { w.stop("Rail keep-alive off"); return; }
  if (!state.mode.minutes) { original.start.call(w, request, isCurrent); return; }
  w.clearRun();
  state.mode.paused = undefined;
  if (request.options?.cacheRetention === "none") { pause(state, "request disabled prompt caching"); return; }
  if (request.options?.reasoning && request.model?.api === "anthropic-messages" && request.model?.compat?.forceAdaptiveThinking !== true) {
   pause(state, "Anthropic thinking request cannot be replayed with a one-token cap"); return;
  }
  path = contextPath();
  const current = () => isCurrent() && samePath();
  w.run = { ...request, isCurrent: current, controller: new AbortController(), phase: "streaming", nextWarmAt: 0, extensionOverride: false };
  // Only settle schedules the manual idle interval; no streaming timer.
 };
 w.onAgentSettled = function() {
  if (!state.mode.minutes) { original.settled.call(w); return; }
  if (!w.run || state.mode.paused) return;
  path = contextPath();
  w.run.phase = "idle";
  w.schedule(w.run);
 };
 w.schedule = function(run) {
  if (!state.mode.minutes) { original.schedule.call(w, run); return; }
  if (w.run !== run || state.mode.paused) return;
  if (run.timer) clearTimeout(run.timer);
  run.nextWarmAt = Date.now() + state.mode.minutes * INTERVAL;
  run.timer = setTimeout(() => {
   run.timer = undefined;
   if (Date.now() > run.nextWarmAt + LATE_MS) { pause(state, "timer late after sleep; send a fresh real request"); return; }
   if (!state.isIdle?.()) { pause(state, "session is busy; send a fresh real request"); return; }
   void w.refresh(run).catch((error) => {
    if (w.run === run) pause(state, error instanceof Error ? error.message : String(error));
   });
  }, state.mode.minutes * INTERVAL);
  run.timer.unref?.();
 };
 w.refreshDeadlineMissed = function(run) {
  if (!state.mode.minutes) return original.deadline.call(w, run);
  if (Date.now() <= run.nextWarmAt + LATE_MS) return false;
  if (w.run === run) pause(state, "refresh deadline missed; send a fresh real request");
  return true;
 };
 w.evaluate = (run) => state.mode.minutes
  ? { phase: run.phase, warmCost: NaN, missCost: NaN, continuationProbability: NaN,
      expectedSavings: NaN, economicsAvailable: false, action: "warm" }
  : original.evaluate.call(w, run);
 w.decide = async (event) => {
  if (!state.mode.minutes) return original.decide.call(w, event);
  const run = w.run;
  const decisionGeneration = generation;
  const isCurrentDecision = () => w.run === run && generation === decisionGeneration;
  if (!run || !state.isIdle?.()) {
   if (run) pause(state, "session is busy; send a fresh real request");
   return "stop";
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
   const action = await Promise.race([
    original.decide.call(w, event),
    new Promise<string>((resolve) => pendingDecisions.set(run, () => resolve("stop"))),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("decision hook timed out")), REQUEST_TIMEOUT_MS); timeout.unref?.(); }),
   ]);
   if (!isCurrentDecision()) return "stop";
   if (!state.isIdle?.()) {
    pause(state, "session is busy; send a fresh real request");
    return "stop";
   }
   if (action === "stop") pause(state, "stopped by another extension");
   return action;
  } catch (error) {
   if (isCurrentDecision()) pause(state, error instanceof Error ? error.message : String(error));
   return "stop";
  } finally {
   if (timeout) clearTimeout(timeout);
   pendingDecisions.delete(run);
  }
 };
 w.sessionManager = {
  getBranch: () => original.manager.getBranch(),
  appendUsage: (...args: any[]) => {
   try { return original.manager.appendUsage(...args); }
   catch (error) {
    if (state.mode.minutes) pause(state, error instanceof Error ? error.message : String(error));
    throw error;
   }
  },
 };
 // Native refresh retains request options (including payload, response and header
 // hooks), appendUsage and validation. Observe failures its best-effort catch hides.
 w.models = { streamSimple(...args: any[]) {
  if (state.mode.minutes && !state.isIdle?.()) {
   pause(state, "session is busy; send a fresh real request");
   throw new Error("session is busy; refresh not sent");
  }
  let stream: any;
  try { stream = original.models.streamSimple(...args); }
  catch (error) {
   if (state.mode.minutes) pause(state, error instanceof Error ? error.message : String(error));
   throw error;
  }
  if (!state.mode.minutes) return stream;
  return { result: async () => {
   const run = w.run;
   if (!run) throw new Error("no current warming run");
   let timeout: ReturnType<typeof setTimeout> | undefined;
   try {
    const result = await Promise.race([
     stream.result(),
     new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("refresh timed out")), REQUEST_TIMEOUT_MS); timeout.unref?.(); }),
    ]);
    if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(`provider ${result.stopReason}: ${result.errorMessage ?? "no details"}`);
    if (!result.usage || typeof result.provider !== "string" || typeof (result.responseModel ?? result.model) !== "string") {
     throw new Error("provider returned no attributable usage; refresh not recorded");
    }
    return result;
   } catch (error) {
    if (w.run === run) pause(state, error instanceof Error ? error.message : String(error));
    throw error;
   } finally { if (timeout) clearTimeout(timeout); }
  } };
 } };
 w.onWarmed = (entry) => {
  try { original.warmed?.call(w, entry); }
  catch (error) {
   if (state.mode.minutes) pause(state, error instanceof Error ? error.message : String(error));
   throw error;
  }
 };
 state.restore = () => {
  w.clearRun();
  if (session.compact === compactWrapper) {
   if (compactDescriptor) Object.defineProperty(session, "compact", compactDescriptor);
   else delete (session as any).compact;
  }
  w.clearRun = original.clearRun;
  w.start = original.start; w.schedule = original.schedule;
  w.onAgentSettled = original.settled; w.refreshDeadlineMissed = original.deadline;
  w.getMode = original.mode; w.decide = original.decide; w.evaluate = original.evaluate;
  w.models = original.models; w.sessionManager = original.manager; w.onWarmed = original.warmed;
 };
}
function stop(state: State): void {
 releaseBridge(state);
 const b = bridge();
 b.active.delete(state);
 if (!b.active.size && b.disposeWrapper && AgentSession.prototype.dispose === b.disposeWrapper) {
  AgentSession.prototype.dispose = b.disposeOriginal;
  b.disposeWrapper = undefined;
  b.disposeOriginal = undefined;
 }
 state.restore?.();
 state.warmer = undefined;
 state.restore = undefined;
 states().delete(state.manager);
}
export function keepAliveStatus(manager: any): string | undefined {
 const state = states().get(manager);
 if (!state || state.mode.minutes === undefined || state.mode.minutes === null) return undefined;
 const { minutes, paused } = state.mode;
 if (paused) return `KA ${minutes}m PAUSED (${paused})`;
 const run = state.warmer?.run;
 if (!run) return `KA ${minutes}m WAIT (fresh real request required)`;
 if (run.phase !== "idle") return `KA ${minutes}m WAIT (agent running)`;
 return run.timer === undefined ? `KA ${minutes}m WARM` : `KA ${minutes}m WAIT (next ${new Date(run.nextWarmAt).toLocaleTimeString()})`;
}
export function keepAliveLabel(manager: any): string | undefined {
 const status = keepAliveStatus(manager);
 if (!status) return undefined;
 return status.match(/^KA \d+m (?:PAUSED|WAIT|WARM)/)?.[0];
}
export function installRailKeepAlive(pi: ExtensionAPI): void {
 pi.on("session_start", (_event, ctx) => {
  const manager = ctx.sessionManager;
  let state = states().get(manager);
  if (state) stop(state);
  const saved = [...manager.getEntries()].reverse().find((e: any) => e.type === "custom" && e.customType === ENTRY && e.data?.sessionId === manager.getSessionId()) as { data?: { minutes?: number | null } } | undefined;
  const minutes = saved?.data?.minutes;
  state = { manager, mode: { minutes: minutes === null || (typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes > 0 && minutes * INTERVAL <= 2 ** 31 - 1) ? minutes : undefined }, notify: (text) => ctx.ui.notify(text, "warning"), isIdle: () => ctx.isIdle() } as State;
  states().set(manager, state);
  awaitSession(state);
 });
 pi.on("session_shutdown", (_event, ctx) => { const state = states().get(ctx.sessionManager); if (state) stop(state); });
 const invalidate = (ctx: ExtensionContext) => { const state = states().get(ctx.sessionManager); if (state?.mode.minutes) { state.warmer?.cancel(); state.mode.paused = undefined; } };
 pi.on("input", (_event, ctx) => { invalidate(ctx); });
 pi.on("before_agent_start", (_event, ctx) => { invalidate(ctx); });
 pi.on("model_select", (_event, ctx) => { invalidate(ctx); });
 pi.on("session_tree", (_event, ctx) => { invalidate(ctx); });
 pi.on("session_before_compact", (_event, ctx) => { invalidate(ctx); });
 pi.on("session_compact", (_event, ctx) => { invalidate(ctx); });
 pi.on("session_compact_failed", (_event, ctx) => { invalidate(ctx); });
 pi.registerCommand("rail-keep-alive", {
  description: "Session-only paid idle cache refresh: N minutes, off, or status",
  handler: async (args, ctx) => {
   const state = states().get(ctx.sessionManager);
   if (!state) { ctx.ui.notify("Rail keep-alive unavailable: session not initialized", "warning"); return; }
   const text = args.trim();
   if (!text || text === "status") {
    const status = keepAliveStatus(ctx.sessionManager);
    ctx.ui.notify(status ? `${status} · refresh fees unknown; cache hit unverified` : state.mode.minutes === null
     ? "Rail keep-alive off (native warming disabled for this session)"
     : "Rail keep-alive not enabled (native warming unchanged)", "info");
    return;
   }
   if (text !== "off" && (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) * INTERVAL > 2 ** 31 - 1)) {
    ctx.ui.notify("Usage: /rail-keep-alive N|off|status (N: positive integer minutes)", "warning"); return;
   }
   state.warmer?.cancel();
   state.mode = { minutes: text === "off" ? null : Number(text) };
   pi.appendEntry(ENTRY, { sessionId: ctx.sessionManager.getSessionId(), minutes: state.mode.minutes });
   if (state.mode.minutes && !state.warmer) state.mode.paused = "unsupported Pi CacheWarmer (requires live 0.87.1 session)";
   const status = keepAliveStatus(ctx.sessionManager);
   ctx.ui.notify(status ? `${status} · refresh fees unknown; cache hit unverified`
    : "Rail keep-alive off for this session (native timer cancelled)", "info");
  },
 });
}
