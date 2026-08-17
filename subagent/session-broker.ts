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
}

export interface SessionWorker {
	readonly sessionId: string;
	readonly sessionFile: string;
	send(task: string, options?: WorkerSendOptions): Promise<WorkerRunResult>;
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

export interface AttachRequest {
	model: RailModelRef;
	alias?: string;
	cwd?: string;
	session?: SessionSource;
}

interface WorkerState {
	worker: SessionWorker;
	tail: Promise<void>;
	active: boolean;
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
	private readonly pendingAliases = new Set<string>();
	private readonly store: AgentInstanceStore;
	private readonly roster: AgentRoster;
	private readonly workerFactory: SessionWorkerFactory;
	private readonly defaultCwd: string;
	private readonly parentSessionLabel: string;
	private readonly aliasLeaseManager: { acquire(key: string): Promise<SessionLease> } | undefined;
	private readonly runtimeListeners = new Set<() => void>();
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
		if (!request.task.trim()) throw new Error("Subagent task cannot be empty");
		if (request.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
		if (Boolean(request.model) === Boolean(request.target)) {
			throw new Error("Provide exactly one of model (new instance) or target (existing instance)");
		}

		const instance = request.model
			? await this.attach({
				model: request.model,
				...(request.alias ? { alias: request.alias } : {}),
				...(request.cwd ? { cwd: request.cwd } : {}),
				...(request.session ? { session: request.session } : {}),
			})
			: await this.resolveInstance(request.target!, true);
		request.onUpdate?.({ instance, run: { output: "(starting...)", usage: emptyUsage() } });
		let run: WorkerRunResult;
		try {
			const state = await this.workerState(instance);
			run = await this.enqueue(state, () => state.worker.send(request.task, {
				...(request.signal ? { signal: request.signal } : {}),
				...(request.onUpdate ? { onUpdate: (partial) => request.onUpdate!({ instance, run: partial }) } : {}),
			}));
			this.runtimeErrors.delete(instance.agentId);
			this.emitRuntimeChange();
		} catch (error) {
			if (this.stoppingAgents.has(instance.agentId) || request.signal?.aborted) this.runtimeErrors.delete(instance.agentId);
			else {
				this.runtimeErrors.set(instance.agentId, error instanceof Error ? error.message : String(error));
				await this.retireFailedWorker(instance.agentId);
			}
			this.emitRuntimeChange();
			throw error;
		}
		const stored = await this.store.get(instance.agentId) ?? instance;
		const persisted: AgentInstance = {
			...stored,
			updatedAt: new Date().toISOString(),
			lastTask: compactMetadata(request.task, 2000),
			lastOutput: compactMetadata(run.output, 16 * 1024),
		};
		await this.store.put(persisted);
		return { instance: { ...persisted, alias: instance.alias }, run };
	}

	async attach(request: AttachRequest): Promise<AgentInstance> {
		return this.createInstance(request, "(attached; no task yet)");
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
		const errorMessage = this.runtimeErrors.get(agentId);
		if (errorMessage) return { phase: "error", queued: 0, errorMessage };
		const state = this.workers.get(agentId);
		if (state) {
			if (state.active) return { phase: "running", queued: state.queued };
			if (state.queued > 0) return { phase: "queued", queued: state.queued };
			return { phase: "idle", queued: 0 };
		}
		return { phase: "stopped", queued: 0 };
	}

	subscribeRuntime(listener: () => void): () => void {
		this.runtimeListeners.add(listener);
		return () => this.runtimeListeners.delete(listener);
	}

	async stop(target: string): Promise<AgentInstance | undefined> {
		const instance = await this.resolveInstance(target).catch(() => undefined);
		if (!instance) return undefined;
		await this.stopWorker(instance.agentId);
		return instance;
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
				const effective = await state.worker.setModel(model);
				const updated = { ...latest, model: structuredClone(effective), updatedAt: new Date().toISOString() };
				try {
					await this.store.put(updated);
					return updated;
				} catch (error) {
					try {
						await state.worker.setModel(latest.model);
					} catch (rollbackError) {
						const message = `Model metadata update failed and worker rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
						this.runtimeErrors.set(instance.agentId, message);
						await this.retireFailedWorker(instance.agentId);
						this.emitRuntimeChange();
						throw new Error(message, { cause: error });
					}
					throw error;
				}
			};
			const updated = state ? await this.enqueue(state, apply) : await apply();
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
		await Promise.allSettled(this.workerStarts.values());
		const states = Array.from(this.workers.values());
		this.workers.clear();
		await Promise.allSettled(states.map((state) => state.worker.stop()));
		await Promise.allSettled(states.map((state) => state.tail));
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
			this.roster.link(alias, agentId);
			this.workers.set(agentId, { worker, tail: Promise.resolve(), active: false, queued: 0 });
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

	private async workerState(instance: AgentInstance): Promise<WorkerState> {
		const changing = this.modelChanges.get(instance.agentId);
		if (changing) {
			await changing;
			instance = await this.store.get(instance.agentId) ?? instance;
		}
		const existing = this.workers.get(instance.agentId);
		if (existing) return existing;
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
			const state = { worker, tail: Promise.resolve(), active: false, queued: 0 };
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

	private async enqueue<T>(state: WorkerState, operation: () => Promise<T>): Promise<T> {
		state.queued++;
		this.emitRuntimeChange();
		const run = async () => {
			state.queued--;
			state.active = true;
			this.emitRuntimeChange();
			try {
				return await operation();
			} finally {
				state.active = false;
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
		try {
			await state.worker.stop();
			await state.tail.catch(() => undefined);
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
}
