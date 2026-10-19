import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openRailContinueOverlay } from "../components/rail-continue";
import {
	parseRailContinueDuration,
	RailContinueScheduler,
	type RailContinueTask,
} from "./rail-continue-scheduler";

export { parseRailContinueDuration } from "./rail-continue-scheduler";

type Manager = ExtensionContext["sessionManager"];
type State = {
	manager: Manager;
	sessionId: string;
	ctx: ExtensionContext;
	scheduler: RailContinueScheduler;
	tick?: ReturnType<typeof setTimeout> | undefined;
	unsubscribe: () => void;
	disposed: boolean;
};
const states = new WeakMap<Manager, State>();
const listeners = new WeakMap<Manager, Set<() => void>>();
const STATUS_KEY = "rail-continue";
const USAGE = "Usage: /rail-continue [<duration> <message> | status | cancel <id>|all]. Duration: positive integer s/m/h; bare integer = minutes.";

export type RailContinueCommand =
	| { action: "open" }
	| { action: "status" }
	| { action: "cancel"; id: string }
	| { action: "create"; intervalMs: number; message: string };

/** Parse only the command prefix; never lowercase or trim the accepted message body. */
export function parseRailContinueCommand(args: string): RailContinueCommand {
	if (!args.trim()) return { action: "open" };
	if (/^\s*status\s*$/i.test(args)) return { action: "status" };
	const cancel = /^\s*cancel\s+(\S+)\s*$/i.exec(args);
	if (cancel) return { action: "cancel", id: cancel[1]!.toLowerCase() === "all" ? "all" : cancel[1]! };
	const create = /^\s*(\S+)[ \t]+([\s\S]*)$/.exec(args);
	if (!create || !create[2]!.trim()) throw new Error(USAGE);
	return { action: "create", intervalMs: parseRailContinueDuration(create[1]!), message: create[2]! };
}

export function formatRailContinueCountdown(deadline: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function intervalText(ms: number): string {
	return ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1000}s`;
}

function checkTime(task: RailContinueTask): string {
	const date = new Date(task.nextCheckAt);
	return Number.isNaN(date.getTime()) ? `in ${formatRailContinueCountdown(task.nextCheckAt)}` : date.toLocaleString();
}

export function railContinueLabel(manager: Manager): string | undefined {
	const state = states.get(manager);
	const tasks = state?.scheduler.snapshot().tasks;
	if (!tasks?.length) return undefined;
	const nearest = tasks.reduce((next, task) => Math.min(next, task.nextCheckAt), Infinity);
	return `CONT ${tasks.length} · ${formatRailContinueCountdown(nearest)}`;
}

export function railContinueStatus(manager: Manager): string {
	const tasks = states.get(manager)?.scheduler.snapshot().tasks ?? [];
	if (!tasks.length) return "Rail continue: no pending tasks.";
	return [
		`Rail continue: ${tasks.length} pending. Next CHECK is not a guaranteed send time; busy/queued checks restart the full interval.`,
		...tasks.map((task) => `${task.id} · CHECK ${formatRailContinueCountdown(task.nextCheckAt)} (${checkTime(task)}) · interval ${intervalText(task.intervalMs)} · resets ${task.resetCount}${task.lastCheckReason ? ` (${task.lastCheckReason})` : ""}\n  ${task.message.replace(/\s+/g, " ").slice(0, 120)}`),
	].join("\n");
}

export function onRailContinueChange(manager: Manager, callback: () => void): () => void {
	let callbacks = listeners.get(manager);
	if (!callbacks) { callbacks = new Set(); listeners.set(manager, callbacks); }
	callbacks.add(callback);
	return () => {
		callbacks.delete(callback);
		if (!callbacks.size && listeners.get(manager) === callbacks) listeners.delete(manager);
	};
}

function publish(state: State): void {
	try { state.ctx.ui.setStatus(STATUS_KEY, state.disposed ? undefined : railContinueLabel(state.manager)); }
	catch { /* A retired runtime must not keep its countdown renderer alive. */ }
	for (const callback of [...(listeners.get(state.manager) ?? [])]) {
		try { callback(); } catch { /* Rendering cannot affect scheduling. */ }
	}
}

function refresh(state: State): void {
	clearTimeout(state.tick);
	state.tick = undefined;
	publish(state);
	if (!state.disposed && state.scheduler.snapshot().tasks.length) {
		state.tick = setTimeout(() => { state.tick = undefined; refresh(state); }, 1000);
		state.tick.unref?.();
	}
}

function dispose(state: State): void {
	if (state.disposed) return;
	state.disposed = true;
	clearTimeout(state.tick);
	state.tick = undefined;
	state.unsubscribe();
	if (states.get(state.manager) === state) states.delete(state.manager);
	state.scheduler.dispose();
	publish(state);
}

export function installRailContinue(pi: ExtensionAPI): void {
	let current: State | undefined;
	let generation = 0;

	function start(ctx: ExtensionContext): State {
		if (current) dispose(current);
		const manager = ctx.sessionManager;
		const previous = states.get(manager);
		if (previous) dispose(previous);
		const sessionId = manager.getSessionId();
		const owner = ++generation;
		const isCurrent = () => {
			try {
				return current === state && !state.disposed && generation === owner && states.get(manager) === state
					&& ctx.sessionManager === manager && manager.getSessionId() === sessionId;
			} catch { return false; }
		};
		const state: State = {
			manager, sessionId, ctx, disposed: false, unsubscribe: () => {},
			scheduler: new RailContinueScheduler({
				isCurrent,
				busyReason: () => !ctx.isIdle() ? "session busy" : ctx.hasPendingMessages() ? "pending messages" : undefined,
				submit: (message, task) => {
					if (!isCurrent()) return;
					// This public API is void: consuming a task means one attempt, not acknowledged delivery.
					// No deliverAs means a busy preflight race fails rather than becoming queued work.
					pi.sendUserMessage(message, { expandPromptTemplates: false });
					try { ctx.ui.notify(`Rail continue ${task.id}: submission attempted; task consumed (no automatic retry).`, "info"); } catch { /* Retired UI. */ }
				},
				onError: (error, task) => {
					try {
						const pending = state.scheduler.snapshot().tasks.some((entry) => entry.id === task.id);
						const outcome = pending ? "check failed; task remains pending" : "task consumed/canceled; no automatic send retry";
						ctx.ui.notify(`Rail continue ${task.id}: ${outcome}. ${error instanceof Error ? error.message : String(error)}`, "warning");
					} catch { /* Retired UI. */ }
				},
			}),
		};
		current = state;
		states.set(manager, state);
		state.unsubscribe = state.scheduler.subscribe(() => refresh(state));
		refresh(state);
		return state;
	}

	function invalidate(): void {
		generation++;
		if (current) dispose(current);
		current = undefined;
	}

	pi.on("session_start", (_event, ctx) => { start(ctx); });
	pi.on("session_shutdown", () => { invalidate(); });
	// Cancel before asynchronous navigation/preflight can change the context. Even a
	// canceled navigation does not restore old authorization; a fresh command may arm again.
	pi.on("session_before_switch", () => { invalidate(); });
	pi.on("session_before_fork", () => { invalidate(); });
	pi.on("session_before_tree", () => { invalidate(); });
	pi.on("session_tree", () => { invalidate(); });

	pi.registerCommand("rail-continue", {
		description: "One-shot session continuation: open tasks, <duration> <message>, status, or cancel <id>|all",
		getArgumentCompletions: (prefix) => ["status", "cancel all", "30s ", "5m ", "1h "]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			let command: RailContinueCommand;
			try { command = parseRailContinueCommand(args); }
			catch (error) { ctx.ui.notify(error instanceof Error ? error.message : USAGE, "warning"); return; }
			if (command.action === "status") { ctx.ui.notify(railContinueStatus(ctx.sessionManager), "info"); return; }
			if (command.action === "cancel") {
				const scheduler = states.get(ctx.sessionManager)?.scheduler;
				const count = command.id === "all" ? scheduler?.cancelAll() ?? 0 : scheduler?.cancel(command.id) ? 1 : 0;
				ctx.ui.notify(count ? `Rail continue: canceled ${count} task${count === 1 ? "" : "s"}.` : "Rail continue: no matching pending task.", "info");
				return;
			}
			if (command.action === "open" && ctx.mode !== "tui") {
				ctx.ui.notify(`${railContinueStatus(ctx.sessionManager)}\n${USAGE} The task panel requires interactive TUI mode.`, "info");
				return;
			}
			const manager = ctx.sessionManager;
			let state = current;
			if (!state || state.disposed || state.manager !== manager || state.sessionId !== manager.getSessionId()) state = start(ctx);
			if (command.action === "open") { await openRailContinueOverlay(ctx, state.scheduler); return; }
			try {
				const task = state.scheduler.create(command.intervalMs, command.message);
				ctx.ui.notify(`Rail continue ${task.id} armed now: next CHECK in ${intervalText(task.intervalMs)} (${checkTime(task)}); one submission attempt only.`, "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
		},
	});
}
