import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PauseState } from "./team-protocol";

/** CLI flag that tells the child pause extension which gate file to watch. */
export const PAUSE_GATE_FLAG = "rail-pause-gate";
/** Custom entry the child appends when it parks at, or leaves, the gate. */
export const PAUSE_ENTRY_TYPE = "rail-subagent-pause";

/**
 * Same states as a Team member's pause: `requested` while the child finishes the step it is in,
 * `confirmed` once it is parked at its next provider request or tool call, or has nothing running.
 */
export interface SubagentPause {
	state: Exclude<PauseState, "none">;
	/** Epoch milliseconds of the pause request. */
	since: number;
}

export function pauseExtensionPath(): string {
	return fileURLToPath(new URL("./pause-extension.ts", import.meta.url));
}

/** Child arguments that load the pause extension on this gate file. */
export function pauseGateArgs(file: string): string[] {
	return ["-e", pauseExtensionPath(), `--${PAUSE_GATE_FLAG}`, file];
}

export function pauseStatusText(pause: SubagentPause, now = Date.now()): string {
	if (pause.state === "requested") return "Pausing · finishing current step";
	const minutes = Math.floor((now - pause.since) / 60_000);
	return minutes > 0 ? `Paused · ${minutes}m` : "Paused";
}

/**
 * Parent half of one child's pause. While the gate file exists the child's pause extension holds
 * every new provider request and tool call, so in-flight work finishes and nothing new starts;
 * removing the file lets the same native run continue. The file is the only channel, so print-mode
 * children without stdin pause the same way as RPC children.
 */
export class PauseGate {
	private since: number | undefined;
	private running = false;
	private childParked = false;
	private localWaits = 0;
	private readonly waiters = new Set<() => void>();
	private readonly listeners = new Set<() => void>();

	constructor(readonly file: string, private readonly now: () => number = Date.now) {
		// A gate left by a crashed parent must never hold a new child.
		rmSync(file, { force: true });
	}

	get paused(): SubagentPause | undefined {
		if (this.since === undefined) return undefined;
		const confirmed = !this.running || this.childParked || this.localWaits > 0;
		return { state: confirmed ? "confirmed" : "requested", since: this.since };
	}

	/** Returns false when the gate was already paused. */
	pause(): boolean {
		if (this.since !== undefined) return false;
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(this.file, "");
		this.since = this.now();
		this.emit();
		return true;
	}

	/** Returns false when the gate was not paused. */
	resume(): boolean {
		if (this.since === undefined) return false;
		rmSync(this.file, { force: true });
		this.since = undefined;
		this.childParked = false;
		for (const wake of [...this.waiters]) wake();
		this.emit();
		return true;
	}

	/** The runner marks each native attempt; an idle child counts as already paused. */
	setRunning(running: boolean): void {
		if (this.running === running) return;
		this.running = running;
		if (!running) this.childParked = false;
		this.emit();
	}

	/** Feed child events; returns true for the gate's own entries. */
	observe(event: { type?: string; entry?: unknown }): boolean {
		if (event.type !== "entry_appended") return false;
		const entry = event.entry as { type?: string; customType?: string; data?: { parked?: unknown } } | undefined;
		if (entry?.type !== "custom" || entry.customType !== PAUSE_ENTRY_TYPE) return false;
		const parked = entry.data?.parked === true;
		if (parked !== this.childParked) {
			this.childParked = parked;
			this.emit();
		}
		return true;
	}

	/** Holds the parent between attempts, such as after a retry backoff, until the gate is resumed or aborted. */
	async waitUntilResumed(signal?: AbortSignal): Promise<void> {
		if (this.since === undefined) return;
		if (signal?.aborted) throw new DOMException("Subagent pause wait was aborted", "AbortError");
		this.localWaits++;
		this.emit();
		try {
			await new Promise<void>((resolve, reject) => {
				const done = (error?: unknown) => {
					this.waiters.delete(wake);
					signal?.removeEventListener("abort", abort);
					if (error) reject(error); else resolve();
				};
				const wake = () => done();
				const abort = () => done(new DOMException("Subagent pause wait was aborted", "AbortError"));
				this.waiters.add(wake);
				signal?.addEventListener("abort", abort, { once: true });
			});
		} finally {
			this.localWaits--;
			this.emit();
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Removes the gate file; the gate state itself ends with its owner. */
	dispose(): void {
		rmSync(this.file, { force: true });
		this.listeners.clear();
	}

	private emit(): void {
		for (const listener of [...this.listeners]) {
			try { listener(); } catch { /* A display listener never affects the gate. */ }
		}
	}
}

export interface PauseTarget {
	gate: PauseGate;
	/** Persistent agent id; absent for one-off runs. */
	agentId?: string;
	label: string;
}

/**
 * Every live subagent gate in this process. `pauseAll` also holds runs that start before
 * `resumeAll`, like a paused Team starts nothing new.
 */
export class SubagentPauseRegistry {
	private readonly targets = new Set<PauseTarget>();
	private holdNew = false;
	private readonly listeners = new Set<() => void>();

	get allPaused(): boolean {
		return this.holdNew;
	}

	register(target: PauseTarget): () => void {
		this.targets.add(target);
		if (this.holdNew) target.gate.pause();
		this.emit();
		return () => {
			if (this.targets.delete(target)) this.emit();
		};
	}

	list(): PauseTarget[] {
		return [...this.targets];
	}

	/** Returns how many running gates this call paused. */
	pauseAll(): number {
		this.holdNew = true;
		let count = 0;
		for (const target of this.targets) if (target.gate.pause()) count++;
		this.emit();
		return count;
	}

	/** Returns how many gates this call resumed. */
	resumeAll(): number {
		this.holdNew = false;
		let count = 0;
		for (const target of this.targets) if (target.gate.resume()) count++;
		this.emit();
		return count;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of [...this.listeners]) {
			try { listener(); } catch { /* A display listener never affects pausing. */ }
		}
	}
}

/** Process-wide registry shared by one-off runners, persistent workers and /rail-agent. */
export const subagentPauses = new SubagentPauseRegistry();
