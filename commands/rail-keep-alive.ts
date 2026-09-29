import { AgentSession, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createStore } from "../core/patching";

// Pi 0.87.1's CacheWarmer is private and the bundled CLI has a different class
// from dist/core/cache-warmer.js. Capture the live instance through the public
// AgentSession's prompt boundary; never import or patch the detached dist class.
const ENTRY = "rail-keep-alive";
const INTERVAL = 60_000;
/** A refresh later than this after its planned time (sleep, blocked event loop) pauses instead of catching up. */
const LATE_MS = 15_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
type Mode = { minutes?: number | null | undefined; paused?: string | undefined };
type Run = { timer?: ReturnType<typeof setTimeout> | undefined; controller: AbortController; isCurrent: () => boolean; nextWarmAt: number; phase: string; [key: string]: any };
type Warmer = {
	run?: Run | undefined; sessionManager: unknown; models: { streamSimple: (...args: any[]) => any };
	getMode: () => string; decide: (event: any) => Promise<string>;
	start: (request: any, isCurrent: () => boolean) => void; schedule: (run: Run) => void; onAgentSettled: () => void;
	refreshDeadlineMissed: (run: Run) => boolean; evaluate: (run: Run) => any; refresh: (run: Run) => Promise<void>;
	stop: (reason: string) => void; cancel: () => void; clearRun: () => void;
};
type State = { manager: any; mode: Mode; warmer?: Warmer | undefined; unsupported?: string | undefined; restore?: (() => void) | undefined; notify: (text: string) => void; isIdle: () => boolean };
type Bridge = { pending: Set<State>; original?: AgentSession["prompt"] | undefined; wrapper?: AgentSession["prompt"] | undefined };
const bridge = createStore<Bridge>("keep-alive-bridge", () => ({ pending: new Set() }));
const states = createStore<Map<any, State>>("keep-alive-states", () => new Map());
const listeners = createStore<Map<any, Set<() => void>>>("keep-alive-listeners", () => new Map());
const WARMER_METHODS = ["start", "schedule", "refresh", "onAgentSettled", "refreshDeadlineMissed", "evaluate", "decide", "getMode", "stop", "cancel", "clearRun"];

export function onKeepAliveChange(manager: any, callback: () => void): () => void {
	const subscriptions = listeners();
	let callbacks = subscriptions.get(manager);
	if (!callbacks) { callbacks = new Set(); subscriptions.set(manager, callbacks); }
	callbacks.add(callback);
	return () => {
		callbacks.delete(callback);
		if (callbacks.size === 0 && subscriptions.get(manager) === callbacks) subscriptions.delete(manager);
	};
}

function changed(state: State): void {
	for (const callback of [...(listeners().get(state.manager) ?? [])]) {
		try { callback(); } catch { /* A footer render must never affect cache warming. */ }
	}
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const validMinutes = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value * INTERVAL <= MAX_TIMER_MS;

function releaseBridge(state: State): void {
	const b = bridge();
	b.pending.delete(state);
	if (!b.pending.size && b.wrapper && AgentSession.prototype.prompt === b.wrapper) {
		AgentSession.prototype.prompt = b.original!;
		b.wrapper = b.original = undefined;
	}
}

/** The first prompt of the session (a real request or a slash command) binds its live warmer. */
function awaitSession(state: State): void {
	const b = bridge();
	b.pending.add(state);
	if (b.wrapper) return;
	const original = b.original = AgentSession.prototype.prompt;
	b.wrapper = function(this: AgentSession, ...args: Parameters<AgentSession["prompt"]>) {
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
	const status = w && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w), "status");
	return VERSION === "0.87.1" && session instanceof AgentSession && w?.sessionManager === state.manager
		&& typeof status?.get === "function" && WARMER_METHODS.every((name) => typeof w[name] === "function")
		&& typeof w.models?.streamSimple === "function";
}

function pause(state: State, reason: string): void {
	state.mode.paused = reason;
	state.warmer?.stop(reason);
	changed(state);
	state.notify(`Rail keep-alive PAUSED: ${reason}`);
}

/**
 * In manual mode the native warmer keeps its request snapshot, refresh, usage entry and extension decision;
 * Rail replaces only the schedule (a fixed idle interval without TTL metadata or 30/60-minute windows), forces
 * the decision to warm, and pauses visibly where the native best-effort path would silently retry or stop.
 */
function bind(state: State, session: AgentSession): void {
	const w = (session as any)._cacheWarmer;
	if (!valid(w, session, state)) {
		state.unsupported = "unsupported Pi CacheWarmer (requires 0.87.1 live session)";
		state.mode.paused = state.unsupported;
		changed(state);
		state.notify(`Rail keep-alive unavailable: ${state.unsupported}; cannot control native warming`);
		return;
	}
	state.warmer = w;
	state.unsupported = undefined;
	const nativeStatus = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w), "status")!.get!;
	const original = {
		start: w.start, schedule: w.schedule, onAgentSettled: w.onAgentSettled, refreshDeadlineMissed: w.refreshDeadlineMissed,
		evaluate: w.evaluate, getMode: w.getMode, decide: w.decide, models: w.models, clearRun: w.clearRun,
	};
	const manual = () => Boolean(state.mode.minutes);
	const nativeEconomics = (run: Run) => {
		// Missing price metadata must not be represented as a zero-dollar estimate.
		try { if (run["model"]?.cost) return original.evaluate.call(w, run); } catch { /* Unknown economics. */ }
		return { phase: run.phase, warmCost: NaN, missCost: NaN,
			continuationProbability: NaN, expectedSavings: NaN, economicsAvailable: false, action: "stop" };
	};
	// Native isCurrent compares agent messages and model; context edits and branch ancestry change the
	// provider context without that, while usage, labels and metadata entries do not.
	const contextPath = () => state.manager.getBranch()
		.filter((entry: any) => !["usage", "session_info", "label", "custom"].includes(entry.type))
		.map((entry: any) => entry.id ?? entry);
	let path = contextPath();
	const samePath = () => {
		const now = contextPath();
		return now.length === path.length && now.every((id: any, index: number) => id === path[index]);
	};
	w.getMode = () => state.mode.minutes === null ? "off" : manual() ? "idle" : original.getMode.call(w);
	Object.defineProperty(w, "status", { configurable: true, get() {
		const run = w.run;
		if (!manual() || !run || !run.isCurrent()) return nativeStatus.call(w);
		if (run.phase !== "idle") return { state: "inactive", reason: "Rail manual: waiting for agent settlement" };
		return { state: run.timer === undefined ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt, decision: nativeEconomics(run), extensionOverride: true,
			reason: `Rail manual ${state.mode.minutes}m idle interval`, manual: true };
	} });
	w.start = function(request, isCurrent) {
		if (state.mode.minutes === null) { w.stop("Rail keep-alive off"); changed(state); return; }
		if (!manual()) { original.start.call(w, request, isCurrent); changed(state); return; }
		w.clearRun();
		state.mode.paused = undefined;
		if (request.options?.cacheRetention === "none") { pause(state, "request disabled prompt caching"); return; }
		if (request.options?.reasoning && request.model?.api === "anthropic-messages" && request.model?.compat?.forceAdaptiveThinking !== true) {
			pause(state, "Anthropic thinking request cannot be replayed with a one-token cap"); return;
		}
		path = contextPath();
		// Only settlement schedules the idle interval; there is no streaming timer.
		w.run = { ...request, isCurrent: () => isCurrent() && samePath(), controller: new AbortController(), phase: "streaming", nextWarmAt: 0, extensionOverride: false };
		changed(state);
	};
	w.onAgentSettled = function() {
		if (!manual()) { original.onAgentSettled.call(w); return; }
		if (!w.run || state.mode.paused) return;
		path = contextPath();
		w.run.phase = "idle";
		w.schedule(w.run);
	};
	w.schedule = function(run) {
		if (!manual()) { original.schedule.call(w, run); return; }
		if (w.run !== run || state.mode.paused) return;
		if (run.timer) clearTimeout(run.timer);
		const delay = state.mode.minutes! * INTERVAL;
		run.nextWarmAt = Date.now() + delay;
		run.timer = setTimeout(() => {
			run.timer = undefined;
			changed(state);
			void w.refresh(run);
		}, delay);
		run.timer.unref?.();
		changed(state);
	};
	w.refreshDeadlineMissed = function(run) {
		if (!manual()) return original.refreshDeadlineMissed.call(w, run);
		if (Date.now() <= run.nextWarmAt + LATE_MS) return false;
		if (w.run === run) pause(state, "timer late after sleep; send a fresh real request");
		return true;
	};
	w.evaluate = (run) => manual() ? { ...nativeEconomics(run), action: "warm" } : original.evaluate.call(w, run);
	w.decide = async (event) => {
		const run = w.run;
		const action = await original.decide.call(w, event);
		// Another extension's veto still wins; make it visible instead of a silent native stop.
		if (manual() && action === "stop" && run && w.run === run) pause(state, "stopped by another extension");
		return action;
	};
	w.clearRun = function() {
		original.clearRun.call(w);
		if (manual()) changed(state);
	};
	// Native refresh swallows provider failures and reschedules; a paid manual interval pauses instead.
	w.models = { streamSimple(...args: any[]) {
		if (!manual()) return original.models.streamSimple(...args);
		const run = w.run;
		const fail = (error: unknown): never => {
			if (w.run === run) pause(state, errorText(error));
			throw error;
		};
		if (!state.isIdle()) fail(new Error("session is busy; send a fresh real request"));
		let stream: any;
		try { stream = original.models.streamSimple(...args); } catch (error) { fail(error); }
		return { result: async () => {
			let result: any;
			try { result = await stream.result(); } catch (error) { fail(error); }
			if (result.stopReason === "error" || result.stopReason === "aborted") fail(new Error(`provider ${result.stopReason}: ${result.errorMessage ?? "no details"}`));
			return result;
		} };
	} };
	state.restore = () => {
		w.clearRun();
		delete (w as any).status;
		Object.assign(w, original);
	};
	changed(state);
}

function stop(state: State): void {
	releaseBridge(state);
	state.restore?.();
	state.warmer = state.restore = undefined;
	states().delete(state.manager);
	changed(state);
	listeners().delete(state.manager);
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
	return keepAliveStatus(manager)?.split(" (")[0];
}

export function installRailKeepAlive(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const manager = ctx.sessionManager;
		const previous = states().get(manager);
		if (previous) stop(previous);
		// Only the same session ID restores the choice: a fork or clone copying this entry is not authorized.
		const saved = [...manager.getEntries()].reverse().find((entry: any) => entry.type === "custom" && entry.customType === ENTRY
			&& entry.data?.sessionId === manager.getSessionId()) as { data?: { minutes?: unknown } } | undefined;
		const minutes = saved?.data?.minutes;
		const state: State = { manager, mode: { minutes: minutes === null || validMinutes(minutes) ? minutes : undefined },
			notify: (text) => ctx.ui.notify(text, "warning"), isIdle: () => ctx.isIdle() };
		states().set(manager, state);
		changed(state);
		awaitSession(state);
	});
	pi.on("session_shutdown", (_event, ctx) => { const state = states().get(ctx.sessionManager); if (state) stop(state); });
	const invalidate = (ctx: ExtensionContext) => {
		const state = states().get(ctx.sessionManager);
		if (!state?.mode.minutes) return;
		state.warmer?.cancel();
		state.mode.paused = undefined;
		changed(state);
	};
	// A new request, model, branch or compaction replaces the cached prefix; the next real request re-arms.
	pi.on("input", (_event, ctx) => { invalidate(ctx); });
	pi.on("before_agent_start", (_event, ctx) => { invalidate(ctx); });
	pi.on("model_select", (_event, ctx) => { invalidate(ctx); });
	pi.on("session_tree", (_event, ctx) => { invalidate(ctx); });
	pi.on("session_before_compact", (_event, ctx) => { invalidate(ctx); });
	pi.registerCommand("rail-keep-alive", {
		description: "Session-only paid idle cache refresh: N minutes, off, or status",
		getArgumentCompletions: (prefix) => ["30", "50", "off", "status"]
			.filter((value) => value.startsWith(prefix.trim()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const state = states().get(ctx.sessionManager);
			if (!state) { ctx.ui.notify("Rail keep-alive unavailable: session not initialized", "warning"); return; }
			const text = args.trim();
			const unavailable = `Rail keep-alive unavailable: ${state.unsupported ?? "live Pi session not captured"}; cannot control native warming`;
			if (!text || text === "status") {
				const status = keepAliveStatus(ctx.sessionManager);
				ctx.ui.notify(!state.warmer ? unavailable
					: status ? `${status} · refresh fees unknown; cache hit unverified` : state.mode.minutes === null
					? "Rail keep-alive off (native warming disabled for this session)"
					: "Rail keep-alive not enabled (native warming unchanged)", "info");
				return;
			}
			if (text !== "off" && (!/^[1-9]\d*$/.test(text) || !validMinutes(Number(text)))) {
				ctx.ui.notify("Usage: /rail-keep-alive N|off|status (N: positive integer minutes)", "warning"); return;
			}
			if (!state.warmer) { ctx.ui.notify(`${unavailable}; no setting changed`, "warning"); return; }
			state.warmer.cancel();
			state.mode = { minutes: text === "off" ? null : Number(text) };
			pi.appendEntry(ENTRY, { sessionId: ctx.sessionManager.getSessionId(), minutes: state.mode.minutes });
			changed(state);
			const status = keepAliveStatus(ctx.sessionManager);
			ctx.ui.notify(status ? `${status} · refresh fees unknown; cache hit unverified`
				: "Rail keep-alive off for this session (native timer cancelled)", "info");
		},
	});
}
