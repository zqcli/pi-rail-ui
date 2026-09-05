import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { assertValidAgentAlias } from "./identity";
import type { RailModelRef } from "./models";
import { buildSubagentSessionName } from "./session-name";
import type { SessionLease } from "./session-lease";
import type { SubagentTranscriptSnapshot } from "./transcript";

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface WorkerRunResult {
	output: string;
	usage: SubagentUsage;
	transcript?: SubagentTranscriptSnapshot;
	stopReason?: string;
	errorMessage?: string;
}

export function runErrorMessage(run: Pick<WorkerRunResult, "stopReason" | "errorMessage">): string | undefined {
	return run.errorMessage || (run.stopReason === "aborted" ? "Subagent request was aborted"
		: run.stopReason === "error" ? "Subagent run failed" : undefined);
}

export type WorkerStartMode = "new" | "open" | "fork" | "exclusive";

export interface WorkerStartSpec {
	agentId: string;
	mode: WorkerStartMode;
	model: RailModelRef;
	alias: string;
	sessionName?: string;
	cwd: string;
	sessionPath?: string;
}

export interface WorkerSendOptions {
	signal?: AbortSignal;
	onUpdate?: (result: WorkerRunResult) => void;
	onAccepted?: () => void;
}

export type WorkerControlDelivery = "steer" | "followUp";

export interface WorkerControlRequest {
	delivery: WorkerControlDelivery;
	message: string;
}

export class WorkerControlError extends Error {
	constructor(
		message: string,
		readonly outcome: "rejected" | "unknown",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "WorkerControlError";
	}
}

export interface SessionWorker {
	readonly sessionId: string;
	readonly sessionFile: string;
	send(task: string, options?: WorkerSendOptions): Promise<WorkerRunResult>;
	control?(request: WorkerControlRequest): Promise<void>;
	setModel?(model: RailModelRef): Promise<RailModelRef>;
	stop(): Promise<void>;
}

export type SessionWorkerFactory = (spec: WorkerStartSpec) => Promise<SessionWorker>;

export interface AgentInstance {
	version: 2;
	agentId: string;
	alias: string;
	model: RailModelRef;
	sessionId: string;
	sessionFile: string;
	sessionName?: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	lastTask: string;
	lastOutput?: string;
}

export interface AgentInstanceStore {
	get(agentId: string): Promise<AgentInstance | undefined>;
	put(instance: AgentInstance): Promise<void>;
	delete(agentId: string): Promise<void>;
	list(): Promise<AgentInstance[]>;
}

export interface AgentRosterLink {
	alias: string;
	agentId: string;
}

export interface AgentRoster {
	resolve(target: string): string | undefined;
	link(alias: string, agentId: string): void;
	unlink(alias: string): void;
	list(): AgentRosterLink[];
}

export interface SessionSource {
	mode: "new" | "fork" | "exclusive";
	path?: string;
}

export interface DispatchRequest {
	model?: RailModelRef;
	target?: string;
	alias?: string;
	task: string;
	cwd?: string;
	session?: SessionSource;
	signal?: AbortSignal;
	onUpdate?: (progress: DispatchProgress) => void;
}

export interface DispatchResult {
	instance: AgentInstance;
	run: WorkerRunResult;
}

export interface DispatchProgress {
	instance: AgentInstance;
	run: WorkerRunResult;
}

export interface ControlRequest extends WorkerControlRequest {
	target: string;
	signal?: AbortSignal;
}

export interface ControlResult {
	instance: AgentInstance;
	delivery: WorkerControlDelivery;
}

export interface AttachRequest {
	model: RailModelRef;
	alias?: string;
	cwd?: string;
	session?: SessionSource;
}

interface WorkerState {
	instance: AgentInstance;
	worker: SessionWorker;
	tail: Promise<void>;
	controlTail: Promise<void>;
	active: boolean;
	activeRunId: number | undefined;
	activeRunAccepted: boolean;
	nextRunId: number;
	stopping: boolean;
	unknownControlRunId: number | undefined;
	controlPoisoned: boolean;
	controlErrorMessage: string | undefined;
	queued: number;
}

export type AgentRuntimePhase = "starting" | "running" | "queued" | "idle" | "stopped" | "error";

export interface AgentRuntimeStatus {
	phase: AgentRuntimePhase;
	queued: number;
	errorMessage?: string;
}

export interface SessionBrokerOptions {
	store: AgentInstanceStore;
	roster: AgentRoster;
	workerFactory: SessionWorkerFactory;
	defaultCwd?: string;
	parentSessionLabel?: string;
	aliasLeaseManager?: { acquire(key: string): Promise<SessionLease> };
}

function generatedAlias(modelId: string, agentId: string): string {
	const base = modelId.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[._-]+|[._-]+$/gu, "").slice(0, 48) || "model";
	return `${base}-${agentId.slice(4, 10)}`;
}

function createAgentId(): string {
	return `agt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function compactMetadata(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function emptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export class SessionBroker {
	private readonly workers = new Map<string, WorkerState>();
	private readonly workerStarts = new Map<string, Promise<WorkerState>>();
	private readonly instanceCreations = new Set<Promise<AgentInstance>>();
	private readonly pendingAliases = new Set<string>();
	private readonly store: AgentInstanceStore;
	private readonly roster: AgentRoster;
	private readonly workerFactory: SessionWorkerFactory;
	private readonly defaultCwd: string;
	private readonly parentSessionLabel: string;
	private readonly aliasLeaseManager: { acquire(key: string): Promise<SessionLease> } | undefined;
	private readonly runtimeListeners = new Set<() => void>();
	private shuttingDown = false;
	private readonly lifecycleEpochs = new Map<string, number>();
	private readonly runtimeErrors = new Map<string, string>();
	private readonly stoppingAgents = new Set<string>();
	private readonly modelChanges = new Map<string, Promise<AgentInstance>>();

	constructor(options: SessionBrokerOptions) {
		this.store = options.store;
		this.roster = options.roster;
		this.workerFactory = options.workerFactory;
		this.defaultCwd = options.defaultCwd ?? process.cwd();
		this.parentSessionLabel = options.parentSessionLabel ?? "main";
		this.aliasLeaseManager = options.aliasLeaseManager;
	}

	async dispatch(request: DispatchRequest): Promise<DispatchResult> {
		if (this.shuttingDown) throw new Error("Subagent broker is shutting down");
		if (!request.task.trim()) throw new Error("Subagent task cannot be empty");
		if (request.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
		if (Boolean(request.model) === Boolean(request.target)) {
			throw new Error("Provide exactly one of model (new instance) or target (existing instance)");
		}

		const requestedAgentId = request.target ? (this.roster.resolve(request.target) ?? request.target) : undefined;
		const expectedEpoch = requestedAgentId ? this.lifecycleEpoch(requestedAgentId) : undefined;
		if (requestedAgentId && this.stoppingAgents.has(requestedAgentId)) throw new Error("Subagent worker is stopping");
		const instance = request.model
			? await this.attach({
				model: request.model,
				...(request.alias ? { alias: request.alias } : {}),
				...(request.cwd ? { cwd: request.cwd } : {}),
				...(request.session ? { session: request.session } : {}),
			})
			: await this.resolveInstance(request.target!);
		if (this.shuttingDown || this.stoppingAgents.has(instance.agentId)
			|| (expectedEpoch !== undefined && this.lifecycleEpoch(instance.agentId) !== expectedEpoch)) {
			throw new Error("Subagent dispatch was interrupted by stop or shutdown");
		}
		if (request.target && !this.roster.resolve(request.target)) this.roster.link(instance.alias, instance.agentId);
		request.onUpdate?.({ instance, run: { output: "(starting...)", usage: emptyUsage() } });
		try {
			const state = await this.workerState(instance, expectedEpoch);
			return await this.enqueue(state, async () => {
				const run = await state.worker.send(request.task, {
					...(request.signal ? { signal: request.signal } : {}),
					...(request.onUpdate ? { onUpdate: (partial) => request.onUpdate!({ instance, run: partial }) } : {}),
					onAccepted: () => {
						if (state.activeRunId !== undefined && !state.stopping) {
							state.activeRunAccepted = true;
							this.emitRuntimeChange();
						}
					},
				});
				state.activeRunId = undefined;
				state.activeRunAccepted = false;
				this.emitRuntimeChange();
				const stored = await this.store.get(instance.agentId) ?? instance;
				const persisted: AgentInstance = {
					...stored,
					updatedAt: new Date().toISOString(),
					lastTask: compactMetadata(request.task, 2000),
					lastOutput: compactMetadata(run.output, 16 * 1024),
				};
				await this.store.put(persisted);
				state.instance = persisted;
				this.runtimeErrors.delete(instance.agentId);
				return { instance: { ...persisted, alias: instance.alias }, run };
			}, "run");
		} catch (error) {
			if (this.stoppingAgents.has(instance.agentId) || request.signal?.aborted) this.runtimeErrors.delete(instance.agentId);
			else {
				this.runtimeErrors.set(instance.agentId, error instanceof Error ? error.message : String(error));
				await this.retireFailedWorker(instance.agentId);
			}
			this.emitRuntimeChange();
			throw error;
		}
	}

	async control(request: ControlRequest): Promise<ControlResult> {
		const message = request.message.trim();
		if (!message) throw new Error("Subagent control message cannot be empty");
		if (request.signal?.aborted) throw new Error("Subagent control was aborted before delivery");
		const agentId = this.roster.resolve(request.target) ?? request.target;
		if (this.shuttingDown || this.stoppingAgents.has(agentId)) throw new Error("Subagent worker is stopping");
		if (this.workerStarts.has(agentId)) throw new Error("Subagent worker is still starting");
		const state = this.workers.get(agentId);
		if (!state) {
			const instance = await this.store.get(agentId);
			if (!instance) throw new Error(`Unknown persistent subagent: ${request.target}`);
			throw new Error(`Subagent ${instance.alias} is not currently running; use target+task to continue an idle or stopped session`);
		}
		const instance = state.instance;
		const runId = state.activeRunId;
		if (runId === undefined || state.stopping) throw new Error(`Subagent ${instance.alias} is not currently running; use target+task to continue an idle or stopped session`);
		if (!state.activeRunAccepted) throw new Error(`Subagent ${instance.alias} has not accepted the running prompt yet`);
		if (!state.worker.control) throw new Error("Subagent worker does not support live controls");
		if (state.unknownControlRunId === runId) {
			throw new Error(`Subagent ${instance.alias} has an earlier control with unknown delivery outcome; wait for the current run to settle`);
		}
		const deliver = async () => {
			if (request.signal?.aborted) throw new Error("Subagent control was aborted before delivery");
			if (state.stopping || state.activeRunId !== runId || !state.activeRunAccepted) throw new Error(`Subagent ${instance.alias} finished before the control could be delivered`);
			if (state.unknownControlRunId === runId) {
				throw new Error(`Subagent ${instance.alias} has an earlier control with unknown delivery outcome; wait for the current run to settle`);
			}
			try {
				await state.worker.control!({ delivery: request.delivery, message });
				if (state.stopping || state.activeRunId !== runId) {
					state.unknownControlRunId = runId;
					state.controlPoisoned = true;
					state.controlErrorMessage = `Subagent ${instance.alias} acknowledged a control after the target run ended`;
					throw new WorkerControlError(`Subagent ${instance.alias} acknowledged the control after the target run ended; delivery outcome is unknown`, "unknown");
				}
			} catch (error) {
				if (error instanceof WorkerControlError && error.outcome === "unknown") {
					state.unknownControlRunId = runId;
					state.controlPoisoned = true;
					state.controlErrorMessage = error.message;
				}
				throw error;
			}
		};
		const result = state.controlTail.then(deliver, deliver);
		state.controlTail = result.then(() => undefined, () => undefined);
		await result;
		return { instance, delivery: request.delivery };
	}

	async attach(request: AttachRequest): Promise<AgentInstance> {
		if (this.shuttingDown) throw new Error("Subagent broker is shutting down");
		const creation = this.createInstance(request, "(attached; no task yet)");
		this.instanceCreations.add(creation);
		try {
			return await creation;
		} finally {
			this.instanceCreations.delete(creation);
		}
	}

	async listLinked(): Promise<AgentInstance[]> {
		const values = await Promise.all(this.roster.list().map(async (link) => {
			const instance = await this.store.get(link.agentId);
			return instance ? { ...instance, alias: link.alias } : undefined;
		}));
		return values.filter((value): value is AgentInstance => value !== undefined);
	}

	runtimeStatus(agentId: string): AgentRuntimeStatus {
		if (this.workerStarts.has(agentId)) return { phase: "starting", queued: 0 };
		const state = this.workers.get(agentId);
		if (state) {
			if (state.activeRunId !== undefined) return { phase: state.activeRunAccepted ? "running" : "starting", queued: state.queued };
			if (state.controlPoisoned) return { phase: "error", queued: state.queued, errorMessage: state.controlErrorMessage ?? "Subagent control delivery outcome is unknown" };
			if (state.active || state.queued > 0) return { phase: "queued", queued: Math.max(1, state.queued) };
			const stateError = this.runtimeErrors.get(agentId);
			return stateError ? { phase: "error", queued: 0, errorMessage: stateError } : { phase: "idle", queued: 0 };
		}
		const errorMessage = this.runtimeErrors.get(agentId);
		if (errorMessage) return { phase: "error", queued: 0, errorMessage };
		return { phase: "stopped", queued: 0 };
	}

	subscribeRuntime(listener: () => void): () => void {
		this.runtimeListeners.add(listener);
		return () => this.runtimeListeners.delete(listener);
	}

	async stop(target: string): Promise<AgentInstance | undefined> {
		const agentId = this.roster.resolve(target) ?? target;
		this.lifecycleEpochs.set(agentId, this.lifecycleEpoch(agentId) + 1);
		this.stoppingAgents.add(agentId);
		const state = this.workers.get(agentId);
		if (state) state.stopping = true;
		try {
			const instance = await this.resolveInstance(target).catch(() => undefined);
			if (!instance) return undefined;
			await this.stopWorker(instance.agentId);
			return instance;
		} finally {
			this.stoppingAgents.delete(agentId);
		}
	}

	async changeModel(target: string, model: RailModelRef): Promise<AgentInstance> {
		const instance = await this.resolveInstance(target);
		if (this.workerStarts.has(instance.agentId)) throw new Error("Subagent worker is still starting");
		if (this.modelChanges.has(instance.agentId)) throw new Error("Subagent model change is already pending");
		const change = (async () => {
			const state = this.workers.get(instance.agentId);
			const apply = async () => {
				const latest = await this.store.get(instance.agentId) ?? instance;
				if (!state) {
					const updated = { ...latest, model: structuredClone(model), updatedAt: new Date().toISOString() };
					await this.store.put(updated);
					return updated;
				}
				if (!state.worker.setModel) throw new Error("Subagent worker does not support model changes");
				try {
					const effective = await state.worker.setModel(model);
					const updated = { ...latest, model: structuredClone(effective), updatedAt: new Date().toISOString() };
					await this.store.put(updated);
					return updated;
				} catch (error) {
					try {
						await state.worker.setModel(latest.model);
					} catch (rollbackError) {
						const message = `Subagent model change failed and worker rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
						this.runtimeErrors.set(instance.agentId, message);
						await this.retireFailedWorker(instance.agentId);
						this.emitRuntimeChange();
						throw new Error(message, { cause: error });
					}
					throw error;
				}
			};
			const updated = state ? await this.enqueue(state, apply) : await apply();
			if (state) state.instance = updated;
			this.runtimeErrors.delete(instance.agentId);
			this.emitRuntimeChange();
			return updated;
		})();
		this.modelChanges.set(instance.agentId, change);
		try {
			return await change;
		} finally {
			this.modelChanges.delete(instance.agentId);
		}
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		for (const state of this.workers.values()) state.stopping = true;
		await Promise.allSettled([...this.workerStarts.values(), ...this.instanceCreations]);
		const states = Array.from(this.workers.values());
		this.workers.clear();
		for (const state of states) state.stopping = true;
		await Promise.allSettled(states.map((state) => state.worker.stop()));
		await Promise.allSettled(states.flatMap((state) => [state.tail, state.controlTail]));
		this.emitRuntimeChange();
	}

	async detach(target: string): Promise<AgentInstance | undefined> {
		const instance = await this.resolveInstance(target).catch(() => undefined);
		if (!instance) return undefined;
		const links = this.roster.list();
		const alias = links.some((link) => link.alias === target)
			? target
			: links.find((link) => link.agentId === instance.agentId)?.alias;
		if (alias) this.roster.unlink(alias);
		if (!this.roster.list().some((link) => link.agentId === instance.agentId)) await this.stopWorker(instance.agentId);
		return instance;
	}

	async delete(target: string): Promise<AgentInstance | undefined> {
		const instance = await this.resolveInstance(target).catch(() => undefined);
		if (!instance) return undefined;
		await this.stopWorker(instance.agentId);
		await rm(instance.sessionFile, { force: true });
		await this.store.delete(instance.agentId);
		for (const link of this.roster.list().filter((item) => item.agentId === instance.agentId)) this.roster.unlink(link.alias);
		this.runtimeErrors.delete(instance.agentId);
		this.emitRuntimeChange();
		return instance;
	}

	private async createInstance(request: AttachRequest, lastTask: string): Promise<AgentInstance> {
		if (this.shuttingDown) throw new Error("Subagent broker is shutting down");
		const agentId = createAgentId();
		const alias = request.alias?.trim() || generatedAlias(request.model.modelId, agentId);
		assertValidAgentAlias(alias);
		if (this.roster.resolve(alias) || this.pendingAliases.has(alias)) throw new Error(`Subagent alias already exists: ${alias}`);
		this.pendingAliases.add(alias);
		let worker: SessionWorker | undefined;
		let aliasLease: SessionLease | undefined;
		try {
			aliasLease = await this.aliasLeaseManager?.acquire(`alias:${alias}`);
			if ((await this.store.list()).some((instance) => instance.alias === alias)) throw new Error(`Persistent subagent alias already exists globally: ${alias}`);
			const session = request.session ?? { mode: "new" as const };
			if ((session.mode === "fork" || session.mode === "exclusive") && !session.path) {
				throw new Error(`${session.mode} requires a session path`);
			}
			const cwd = request.cwd ?? this.defaultCwd;
			const sessionName = buildSubagentSessionName(this.parentSessionLabel, alias);
			worker = await this.workerFactory({
				agentId,
				mode: session.mode,
				model: request.model,
				alias,
				sessionName,
				cwd,
				...(session.path ? { sessionPath: session.path } : {}),
			});
			if (this.shuttingDown) throw new Error("Subagent broker is shutting down");
			const now = new Date().toISOString();
			const instance: AgentInstance = {
				version: 2,
				agentId,
				alias,
				model: structuredClone(request.model),
				sessionId: worker.sessionId,
				sessionFile: worker.sessionFile,
				sessionName,
				cwd,
				createdAt: now,
				updatedAt: now,
				lastTask,
			};
			await this.store.put(instance);
			if (this.shuttingDown) {
				await this.store.delete(agentId).catch(() => undefined);
				throw new Error("Subagent broker is shutting down");
			}
			this.roster.link(alias, agentId);
			this.workers.set(agentId, {
				instance,
				worker,
				tail: Promise.resolve(),
				controlTail: Promise.resolve(),
				active: false,
				activeRunId: undefined,
				activeRunAccepted: false,
				nextRunId: 0,
				stopping: false,
				unknownControlRunId: undefined,
				controlPoisoned: false,
				controlErrorMessage: undefined,
				queued: 0,
			});
			this.emitRuntimeChange();
			return instance;
		} catch (error) {
			if (worker) await worker.stop().catch(() => undefined);
			throw error;
		} finally {
			this.pendingAliases.delete(alias);
			await aliasLease?.release();
		}
	}

	private async resolveInstance(target: string, linkByAgentId = false): Promise<AgentInstance> {
		const linkedAgentId = this.roster.resolve(target);
		const agentId = linkedAgentId ?? target;
		const instance = await this.store.get(agentId);
		if (!instance) throw new Error(`Unknown persistent subagent: ${target}`);
		if (!linkedAgentId && linkByAgentId) this.roster.link(instance.alias, instance.agentId);
		return linkedAgentId && target !== agentId ? { ...instance, alias: target } : instance;
	}

	private async workerState(instance: AgentInstance, expectedEpoch = this.lifecycleEpoch(instance.agentId)): Promise<WorkerState> {
		if (this.shuttingDown || this.stoppingAgents.has(instance.agentId) || this.lifecycleEpoch(instance.agentId) !== expectedEpoch) {
			throw new Error("Subagent dispatch was interrupted by stop or shutdown");
		}
		const changing = this.modelChanges.get(instance.agentId);
		if (changing) {
			await changing;
			instance = await this.store.get(instance.agentId) ?? instance;
		}
		const existing = this.workers.get(instance.agentId);
		if (existing && !existing.controlPoisoned) return existing;
		if (existing?.controlPoisoned) await this.retireFailedWorker(instance.agentId);
		const starting = this.workerStarts.get(instance.agentId);
		if (starting) return starting;
		const start = (async () => {
			const sessionName = instance.sessionName ?? buildSubagentSessionName(this.parentSessionLabel, instance.alias);
			if (!instance.sessionName) await this.store.put({ ...instance, sessionName });
			const worker = await this.workerFactory({
				agentId: instance.agentId,
				mode: "open",
				model: instance.model,
				alias: instance.alias,
				sessionName,
				cwd: instance.cwd,
				sessionPath: instance.sessionFile,
			});
			if (this.shuttingDown || this.stoppingAgents.has(instance.agentId) || this.lifecycleEpoch(instance.agentId) !== expectedEpoch) {
				await worker.stop().catch(() => undefined);
				throw new Error("Subagent dispatch was interrupted by stop or shutdown");
			}
			const state: WorkerState = {
				instance: { ...instance, sessionName },
				worker,
				tail: Promise.resolve(),
				controlTail: Promise.resolve(),
				active: false,
				activeRunId: undefined,
				activeRunAccepted: false,
				nextRunId: 0,
				stopping: false,
				unknownControlRunId: undefined,
				controlPoisoned: false,
				controlErrorMessage: undefined,
				queued: 0,
			};
			this.workers.set(instance.agentId, state);
			this.emitRuntimeChange();
			return state;
		})();
		this.workerStarts.set(instance.agentId, start);
		this.emitRuntimeChange();
		try {
			return await start;
		} finally {
			this.workerStarts.delete(instance.agentId);
			this.emitRuntimeChange();
		}
	}

	private async enqueue<T>(state: WorkerState, operation: () => Promise<T>, kind: "run" | "maintenance" = "maintenance"): Promise<T> {
		state.queued++;
		this.emitRuntimeChange();
		const run = async () => {
			if (kind === "run") {
				try {
					await state.controlTail;
					if (state.controlPoisoned) throw new WorkerControlError(state.controlErrorMessage ?? "Subagent control delivery outcome is unknown", "unknown");
				} catch (error) {
					state.queued--;
					this.emitRuntimeChange();
					throw error;
				}
			}
			state.queued--;
			state.active = true;
			const runId = kind === "run" ? ++state.nextRunId : undefined;
			state.activeRunId = runId;
			state.activeRunAccepted = false;
			if (runId !== undefined) state.unknownControlRunId = undefined;
			this.emitRuntimeChange();
			try {
				return await operation();
			} finally {
				state.active = false;
				state.activeRunId = undefined;
				state.activeRunAccepted = false;
				this.emitRuntimeChange();
			}
		};
		const result = state.tail.then(run, run);
		state.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	private async stopWorker(agentId: string): Promise<void> {
		const starting = this.workerStarts.get(agentId);
		if (starting) await starting.catch(() => undefined);
		const state = this.workers.get(agentId);
		if (!state) return;
		this.stoppingAgents.add(agentId);
		this.workers.delete(agentId);
		state.stopping = true;
		try {
			await state.worker.stop();
			await Promise.allSettled([state.tail, state.controlTail]);
			this.runtimeErrors.delete(agentId);
		} finally {
			this.stoppingAgents.delete(agentId);
			this.emitRuntimeChange();
		}
	}

	private async retireFailedWorker(agentId: string): Promise<void> {
		const state = this.workers.get(agentId);
		if (!state) return;
		this.workers.delete(agentId);
		await state.worker.stop().catch(() => undefined);
	}

	private emitRuntimeChange(): void {
		for (const listener of this.runtimeListeners) listener();
	}

	private lifecycleEpoch(agentId: string): number {
		return this.lifecycleEpochs.get(agentId) ?? 0;
	}
}
