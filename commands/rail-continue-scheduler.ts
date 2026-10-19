/** A pending, session-local one-shot request. Its deadline is a check, not a promised send time. */
export interface RailContinueTask {
	id: string;
	message: string;
	intervalMs: number;
	createdAt: number;
	nextCheckAt: number;
	resetCount: number;
	lastCheckReason?: string;
}

export interface RailContinueSnapshot {
	tasks: RailContinueTask[];
	/** The last observed busy reason; reading a snapshot never polls session idleness. */
	busyReason?: string;
	active: boolean;
}

export interface RailContinueController {
	snapshot(): RailContinueSnapshot;
	create(intervalMs: number, message: string): RailContinueTask;
	cancel(id: string): boolean;
	cancelAll(): number;
	/** Mutation notifications only. Views may refresh their own countdown without changing deadlines. */
	subscribe(listener: () => void): () => void;
}

export interface RailContinueSchedulerOptions {
	now?: () => number;
	/** Return undefined only when the current session is idle and has no pending messages. */
	busyReason: () => string | undefined;
	/** Must verify current runtime/session ownership, independently of idleness. */
	isCurrent: () => boolean;
	/** One synchronous submission attempt. A void return cannot acknowledge actual delivery. */
	submit: (message: string, task: RailContinueTask) => void;
	onError?: (error: unknown, task: RailContinueTask) => void;
}

const MAX_TIMER_MS = 2 ** 31 - 1;
const BATCH_BUSY_REASON = "another task submitted at this check";

/** Shared by the command and create form; no text/message normalization is performed here. */
export function parseRailContinueDuration(value: string): number {
	const match = /^(\d+)([smh]?)$/i.exec(value.trim());
	if (!match) throw new Error("Duration must be a positive integer s/m/h; bare integers are minutes");
	const amount = Number(match[1]);
	const unit = match[2]!.toLowerCase();
	const intervalMs = amount * (unit === "s" ? 1_000 : unit === "h" ? 3_600_000 : 60_000);
	if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(intervalMs)) {
		throw new RangeError("Duration must be positive and within the supported safe-integer range");
	}
	return intervalMs;
}

/**
 * One timer, no activity hooks and no persistence. Only a due check consults idleness.
 * Long intervals are split into safe timer chunks; waking late checks once at the actual current time.
 */
export class RailContinueScheduler implements RailContinueController {
	private readonly tasks = new Map<string, RailContinueTask>();
	private readonly listeners = new Set<() => void>();
	private nextId = 1n;
	private active = true;
	private checking = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private timerGeneration = 0;
	private lastBusyReason: string | undefined;

	constructor(private readonly options: RailContinueSchedulerOptions) {}

	snapshot(): RailContinueSnapshot {
		this.isActive();
		return {
			tasks: [...this.tasks.values()].map((task) => ({ ...task })),
			...(this.lastBusyReason === undefined ? {} : { busyReason: this.lastBusyReason }),
			active: this.active,
		};
	}

	create(intervalMs: number, message: string): RailContinueTask {
		if (!this.isActive()) throw new Error("Rail Continue is no longer active for this session");
		if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
			throw new RangeError("Interval must be a positive safe integer number of milliseconds");
		}
		if (typeof message !== "string" || !message.trim()) throw new Error("Message must not be empty");
		const createdAt = this.now();
		const nextCheckAt = this.deadline(createdAt, intervalMs);
		const task: RailContinueTask = {
			id: (this.nextId++).toString(), message, intervalMs, createdAt, nextCheckAt, resetCount: 0,
		};
		this.tasks.set(task.id, task);
		this.schedule();
		this.changed();
		return { ...task };
	}

	cancel(id: string): boolean {
		if (!this.isActive() || !this.tasks.delete(id)) return false;
		if (!this.tasks.size) this.lastBusyReason = undefined;
		this.schedule();
		this.changed();
		return true;
	}

	cancelAll(): number {
		if (!this.isActive()) return 0;
		const count = this.tasks.size;
		this.tasks.clear();
		this.lastBusyReason = undefined;
		this.clearTimer();
		if (count) this.changed();
		return count;
	}

	subscribe(listener: () => void): () => void {
		if (!this.isActive()) return () => {};
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Invalidate authorization before notifying views, so reentrant callbacks cannot revive it. */
	dispose(): void {
		if (!this.active) return;
		this.active = false;
		this.tasks.clear();
		this.lastBusyReason = undefined;
		this.clearTimer();
		this.changed();
		this.listeners.clear();
	}

	private now(): number {
		const now = this.options.now?.() ?? Date.now();
		if (!Number.isSafeInteger(now)) throw new RangeError("Current time must be a safe integer");
		return now;
	}

	private deadline(now: number, intervalMs: number): number {
		const deadline = now + intervalMs;
		if (!Number.isSafeInteger(deadline)) throw new RangeError("Next check exceeds the supported time range");
		return deadline;
	}

	private isActive(): boolean {
		if (!this.active) return false;
		try {
			const current = this.options.isCurrent();
			if (current && this.active) return true;
		} catch (error) {
			const task = this.tasks.values().next().value;
			this.dispose();
			if (task) this.reportError(error, task);
			return false;
		}
		this.dispose();
		return false;
	}

	private changed(): void {
		for (const listener of [...this.listeners]) {
			if (!this.listeners.has(listener)) continue;
			try { listener(); } catch { /* A rendering failure must not alter scheduling authorization. */ }
		}
	}

	private reportError(error: unknown, task: RailContinueTask): void {
		try { this.options.onError?.(error, { ...task }); } catch { /* Reporting must not retry a submission. */ }
	}

	private clearTimer(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.timerGeneration++;
	}

	private schedule(): void {
		if (this.checking) return;
		this.clearTimer();
		if (!this.isActive() || !this.tasks.size) return;
		let nearest = Infinity;
		for (const task of this.tasks.values()) nearest = Math.min(nearest, task.nextCheckAt);
		const generation = this.timerGeneration;
		this.timer = setTimeout(() => {
			if (generation !== this.timerGeneration || !this.isActive()) return;
			this.timer = undefined;
			this.checkDue();
		}, Math.min(MAX_TIMER_MS, Math.max(0, nearest - this.now())));
		this.timer.unref?.();
	}

	private restart(task: RailContinueTask, reason: string): void {
		if (!this.isActive() || this.tasks.get(task.id) !== task) return;
		try {
			task.nextCheckAt = this.deadline(this.now(), task.intervalMs);
			task.resetCount++;
			task.lastCheckReason = reason;
			this.lastBusyReason = reason;
		} catch (error) {
			// Arithmetic exhaustion is not a reason to arm an overflowing timer or loop immediately.
			this.tasks.delete(task.id);
			this.reportError(error, task);
		}
		this.changed();
	}

	private checkDue(): void {
		if (this.checking || !this.isActive()) return;
		this.checking = true;
		try {
			const now = this.now();
			const due = [...this.tasks.values()].filter((task) => task.nextCheckAt <= now)
				.sort((left, right) => left.nextCheckAt - right.nextCheckAt);
			let attempted = false;
			for (const task of due) {
				if (!this.isActive()) break;
				if (this.tasks.get(task.id) !== task) continue;
				if (attempted) { this.restart(task, BATCH_BUSY_REASON); continue; }
				let reason: string | undefined;
				try { reason = this.options.busyReason(); }
				catch (error) {
					reason = "idle check failed";
					this.reportError(error, task);
				}
				// The ownership/idle callback may cancel, dispose or change the session synchronously.
				if (!this.isActive()) break;
				if (this.tasks.get(task.id) !== task) continue;
				if (reason !== undefined) { this.restart(task, reason); continue; }
				this.tasks.delete(task.id);
				this.lastBusyReason = undefined;
				attempted = true;
				// Consume before calling the public void send API; throws are attempts, never retries.
				try { this.options.submit(task.message, { ...task }); }
				catch (error) { this.reportError(error, task); }
				this.changed();
			}
		} finally {
			this.checking = false;
			this.schedule();
		}
	}
}
