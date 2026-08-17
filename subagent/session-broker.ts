import { randomUUID } from "node:crypto";
import { assertValidAgentAlias } from "./identity";
import type { RailModelRef } from "./models";
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
	cwd: string;
	createdAt: string;
	updatedAt: string;
	lastTask: string;
	lastOutput?: string;
}

export interface AgentInstanceStore {
	get(agentId: string): Promise<AgentInstance | undefined>;
	put(instance: AgentInstance): Promise<void>;
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
}

export interface SessionBrokerOptions {
	store: AgentInstanceStore;
	roster: AgentRoster;
	workerFactory: SessionWorkerFactory;
	defaultCwd?: string;
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

	constructor(options: SessionBrokerOptions) {
		this.store = options.store;
		this.roster = options.roster;
		this.workerFactory = options.workerFactory;
		this.defaultCwd = options.defaultCwd ?? process.cwd();
	}

	async dispatch(request: DispatchRequest): Promise<DispatchResult> {
		if (!request.task.trim()) throw new Error("Subagent task cannot be empty");
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
		const state = await this.workerState(instance);
		const run = await this.enqueue(state, () => state.worker.send(request.task, {
			...(request.signal ? { signal: request.signal } : {}),
			...(request.onUpdate ? { onUpdate: (partial) => request.onUpdate!({ instance, run: partial }) } : {}),
		}));
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

	async shutdown(): Promise<void> {
		await Promise.allSettled(this.workerStarts.values());
		const states = Array.from(this.workers.values());
		this.workers.clear();
		await Promise.allSettled(states.map((state) => state.worker.stop()));
		await Promise.allSettled(states.map((state) => state.tail));
	}

	async detach(target: string): Promise<AgentInstance | undefined> {
		const instance = await this.resolveInstance(target).catch(() => undefined);
		if (!instance) return undefined;
		const links = this.roster.list();
		const alias = links.some((link) => link.alias === target)
			? target
			: links.find((link) => link.agentId === instance.agentId)?.alias;
		if (alias) this.roster.unlink(alias);
		const state = this.workers.get(instance.agentId);
		if (state) {
			this.workers.delete(instance.agentId);
			await state.worker.stop();
			await state.tail.catch(() => undefined);
		}
		return instance;
	}

	private async createInstance(request: AttachRequest, lastTask: string): Promise<AgentInstance> {
		const agentId = createAgentId();
		const alias = request.alias?.trim() || generatedAlias(request.model.modelId, agentId);
		assertValidAgentAlias(alias);
		if (this.roster.resolve(alias) || this.pendingAliases.has(alias)) throw new Error(`Subagent alias already exists: ${alias}`);
		const session = request.session ?? { mode: "new" as const };
		if ((session.mode === "fork" || session.mode === "exclusive") && !session.path) {
			throw new Error(`${session.mode} requires a session path`);
		}
		const cwd = request.cwd ?? this.defaultCwd;
		this.pendingAliases.add(alias);
		let worker: SessionWorker | undefined;
		try {
			worker = await this.workerFactory({
				agentId,
				mode: session.mode,
				model: request.model,
				alias,
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
				cwd,
				createdAt: now,
				updatedAt: now,
				lastTask,
			};
			await this.store.put(instance);
			this.roster.link(alias, agentId);
			this.workers.set(agentId, { worker, tail: Promise.resolve() });
			return instance;
		} catch (error) {
			if (worker) await worker.stop().catch(() => undefined);
			throw error;
		} finally {
			this.pendingAliases.delete(alias);
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
		const existing = this.workers.get(instance.agentId);
		if (existing) return existing;
		const starting = this.workerStarts.get(instance.agentId);
		if (starting) return starting;
		const start = (async () => {
			const worker = await this.workerFactory({
				agentId: instance.agentId,
				mode: "open",
				model: instance.model,
				alias: instance.alias,
				cwd: instance.cwd,
				sessionPath: instance.sessionFile,
			});
			const state = { worker, tail: Promise.resolve() };
			this.workers.set(instance.agentId, state);
			return state;
		})();
		this.workerStarts.set(instance.agentId, start);
		try {
			return await start;
		} finally {
			this.workerStarts.delete(instance.agentId);
		}
	}

	private async enqueue<T>(state: WorkerState, operation: () => Promise<T>): Promise<T> {
		const result = state.tail.then(operation, operation);
		state.tail = result.then(() => undefined, () => undefined);
		return result;
	}
}
