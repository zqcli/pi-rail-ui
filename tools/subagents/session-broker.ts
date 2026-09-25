import type { TeamDispatchChannel, TeamWorkerChannel } from "./team-protocol";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { ContextProtocolError, ContextWindowValidationError, createChildContextSettings, normalizeContextWindow, resolveChildContextCwd, validateContextWindowReserve } from "./context-window";
import { assertValidAgentAlias } from "./identity";
import type { RailModelRef } from "./models";
import { RpcProcessExitTimeoutError } from "./rpc-transport";
import { buildSubagentSessionName } from "./session-name";
import type { SessionLease } from "./session-lease";
import type { SubagentTranscriptSnapshot } from "./transcript";
import { emptySubagentUsage } from "./usage";

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
	/** Observed hosted web_search_call executions; omitted while zero. */
	searches?: number;
}

export interface WorkerRunResult {
	output: string;
	usage: SubagentUsage;
	isCompacting?: boolean;
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
	fastMode?: boolean;
}

export interface WorkerSendOptions {
	team?: TeamWorkerChannel;
	contextWindow?: number;
	signal?: AbortSignal;
	onUpdate?: (result: WorkerRunResult) => void;
	onAccepted?: () => void;
	onSettled?: () => void;
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
	isReusable?(): boolean;
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
	fastMode?: boolean;
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
	team?: TeamDispatchChannel;
	model?: RailModelRef;
	target?: string;
	alias?: string;
	task: string;
	cwd?: string;
	session?: SessionSource;
	contextWindow?: number;
	fastMode?: boolean | null;
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
	fastMode?: boolean | null;
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
	isCompacting: boolean;
}

/**
 * Fast policy and model must always be read and written as one descriptor:
 * the tool renderer derives both from a single cached snapshot.
 */
interface DescriptorSnapshot {
	fastMode: boolean;
	model: RailModelRef;
}

function descriptorSnapshotOf(instance: AgentInstance): DescriptorSnapshot {
	return { fastMode: instance.fastMode === true, model: structuredClone(instance.model) };
}

export type AgentRuntimePhase = "starting" | "running" | "queued" | "idle" | "stopped" | "error";

export interface AgentRuntimeStatus {
	phase: AgentRuntimePhase;
	queued: number;
	isCompacting?: boolean;
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

function freshWorkerState(instance: AgentInstance, worker: SessionWorker): WorkerState {
	return {
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
		isCompacting: false,
	};
}

class TeamActiveError extends Error {}

export class SessionBroker {
	private readonly workers = new Map<string, WorkerState>();
	private readonly teamActive = new Map<string, AbortController>();
	private readonly teamAliases = new Set<string>();
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
	/** Children that outlived SIGKILL: their session file may still be written until the OS reaps them. */
	private readonly unreaped = new Map<string, Promise<void>>();
	/** Stops in progress, so a concurrent cleanup waits for the outcome instead of seeing no worker. */
	private readonly stopsInFlight = new Map<string, Promise<void>>();
	private readonly deletingAgents = new Set<string>();
	private readonly modelChanges = new Map<string, Promise<AgentInstance>>();
	private readonly fastModeChanges = new Map<string, Promise<AgentInstance>>();
	private readonly descriptorSnapshots = new Map<string, DescriptorSnapshot>();
	private readonly descriptorSnapshotEpochs = new Map<string, number>();

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
		const contextWindow = normalizeContextWindow(request.contextWindow);
		if (request.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
		if (Boolean(request.model) === Boolean(request.target)) {
			throw new Error("Provide exactly one of model (new instance) or target (existing instance)");
		}
		if (contextWindow !== undefined && request.model) {
			const cwd = await resolveChildContextCwd(request.cwd ?? this.defaultCwd, request.session);
			this.validateContextWindow(contextWindow, cwd, request.model);
		}
		if (request.team && (request.target || !request.alias || request.session)) throw new Error("Team dispatch requires a new persistent session");
		const requestedAgentId = request.target ? (this.roster.resolve(request.target) ?? request.target) : undefined;
		if (request.target && (this.teamAliases.has(request.target) || (requestedAgentId && this.teamActive.has(requestedAgentId)))) throw new Error("Subagent target has an active team operation");
		const expectedEpoch = requestedAgentId ? this.lifecycleEpoch(requestedAgentId) : undefined;
		if (request.target && request.fastMode !== undefined && request.fastMode !== null) {
			throw new Error("fastMode for an existing target is managed through /rail-agent");
		}
		if (requestedAgentId && (this.stoppingAgents.has(requestedAgentId) || this.deletingAgents.has(requestedAgentId))) throw new Error("Subagent worker is stopping");
		if (requestedAgentId && this.fastModeChanges.has(requestedAgentId)) throw new Error("Subagent fast mode is changing");
		let instance: AgentInstance | undefined;
		const createdInstance = Boolean(request.model);
		let state: WorkerState | undefined;
		let signal = request.signal;
		const reservedTeamAlias = request.team ? request.alias!.trim() : undefined;
		if (reservedTeamAlias !== undefined) {
			if (this.teamAliases.has(reservedTeamAlias)) throw new TeamActiveError("Subagent alias has an active team operation");
			this.teamAliases.add(reservedTeamAlias);
		}
		try {
			instance = request.model
				? await this.attach({
					model: request.model,
					...(request.alias ? { alias: request.alias } : {}),
					...(request.cwd ? { cwd: request.cwd } : {}),
					...(request.session ? { session: request.session } : {}),
					...(request.fastMode !== undefined && request.fastMode !== null ? { fastMode: request.fastMode === true } : {}),
				})
				: await this.resolveInstance(request.target!);
			const resolvedInstance = instance;
			if (request.team) {
				const operation = new AbortController();
				this.teamActive.set(resolvedInstance.agentId, operation);
				signal = signal ? AbortSignal.any([signal, operation.signal]) : operation.signal;
			}
			else if (this.teamActive.has(resolvedInstance.agentId) || this.teamAliases.has(resolvedInstance.alias)) throw new TeamActiveError("Subagent target has an active team operation");
			if (this.shuttingDown || this.stoppingAgents.has(resolvedInstance.agentId) || this.deletingAgents.has(resolvedInstance.agentId)
				|| (expectedEpoch !== undefined && this.lifecycleEpoch(resolvedInstance.agentId) !== expectedEpoch)) {
				throw new Error("Subagent dispatch was interrupted by stop or shutdown");
			}
			if (request.team && signal?.aborted) throw new Error("Team request was aborted during startup");
			if (request.target && contextWindow !== undefined) await this.validateContextWindowForTarget(request.target, contextWindow);
			if (request.target && !this.roster.resolve(request.target)) this.roster.link(resolvedInstance.alias, resolvedInstance.agentId);
			request.onUpdate?.({ instance: resolvedInstance, run: { output: "(starting...)", usage: emptySubagentUsage() } });
			const currentState = await this.workerState(resolvedInstance, expectedEpoch);
			state = currentState;
			return await this.enqueue(currentState, async () => {
				// Model changes share this queue. Validate the descriptor paired with
				// this worker, not the earlier store snapshot used to resolve the target.
				if (contextWindow !== undefined) {
					const cwd = await resolveChildContextCwd(currentState.instance.cwd, { mode: "open", path: currentState.worker.sessionFile });
					this.validateContextWindow(contextWindow, cwd, currentState.instance.model);
				}
				let task: string | undefined = request.task;
				let run!: WorkerRunResult;
				let usage = emptySubagentUsage();
				const aggregateUsage = (next: SubagentUsage): SubagentUsage => {
					const total = { ...next };
					for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) total[key] += usage[key];
					const searches = (usage.searches ?? 0) + (next.searches ?? 0);
					if (searches) total.searches = searches;
					return total;
				};
				while (task !== undefined) {
					if (signal?.aborted) throw new Error("Subagent request was aborted");
					if (currentState.activeRunId === undefined) currentState.activeRunId = ++currentState.nextRunId;
					const nativeRun = await currentState.worker.send(task, {
						...(request.team ? { team: request.team } : {}),
						...(contextWindow !== undefined ? { contextWindow } : {}),
						...(signal ? { signal } : {}),
						onUpdate: (partial) => {
							const isCompacting = partial.isCompacting === true;
							if (currentState.isCompacting !== isCompacting) {
								currentState.isCompacting = isCompacting;
								this.emitRuntimeChange();
							}
							request.onUpdate?.({ instance: resolvedInstance, run: request.team ? { ...partial, usage: aggregateUsage(partial.usage) } : partial });
						},
						onAccepted: () => {
							if (currentState.activeRunId !== undefined && !currentState.stopping) {
								currentState.activeRunAccepted = true;
								this.emitRuntimeChange();
							}
						},
						onSettled: () => {
							currentState.activeRunId = undefined;
							currentState.activeRunAccepted = false;
							this.emitRuntimeChange();
						},
					});
					currentState.activeRunId = undefined;
					currentState.activeRunAccepted = false;
					if (request.team) {
						usage = aggregateUsage(nativeRun.usage);
						run = { ...nativeRun, usage };
						task = await request.team.afterRun?.(nativeRun, signal);
					} else {
						run = nativeRun;
						task = undefined;
					}
				}
				currentState.activeRunId = undefined;
				currentState.activeRunAccepted = false;
				currentState.isCompacting = false;
				this.emitRuntimeChange();
				const stored = await this.store.get(resolvedInstance.agentId) ?? resolvedInstance;
				const persisted: AgentInstance = {
					...stored,
					updatedAt: new Date().toISOString(),
					lastTask: compactMetadata(request.task, 2000),
					lastOutput: compactMetadata(run.output, 16 * 1024),
				};
				await this.store.put(persisted);
				this.commitInstanceSnapshot(persisted);
				currentState.instance = persisted;
				this.runtimeErrors.delete(resolvedInstance.agentId);
				return { instance: { ...persisted, alias: resolvedInstance.alias }, run };
			}, "run");
		} catch (error) {
			if (error instanceof TeamActiveError) throw error;
			const failedAgentId = instance?.agentId;
			if (!failedAgentId) {
				this.emitRuntimeChange();
				throw error;
			}
			if (request.team && createdInstance && instance && request.team.started?.() === false) {
				// The member never passed a team gate, so its model never acted. Free the
				// alias so the team can be retried with the same roster.
				await this.cleanupCreatedInstance(instance, true);
				this.runtimeErrors.delete(failedAgentId);
				this.emitRuntimeChange();
				throw error;
			}
			const mustRetire = error instanceof ContextProtocolError || state?.worker.isReusable?.() === false;
			if (error instanceof ContextWindowValidationError) {
				if (createdInstance && instance) {
					await this.cleanupCreatedInstance(instance, request.session?.mode !== "exclusive");
				}
				this.runtimeErrors.delete(failedAgentId);
			} else if (mustRetire) {
				this.runtimeErrors.set(failedAgentId, error instanceof Error ? error.message : String(error));
				await this.retireFailedWorker(failedAgentId);
			} else if (this.stoppingAgents.has(failedAgentId) || signal?.aborted) {
				if (request.team) await this.retireFailedWorker(failedAgentId);
				this.runtimeErrors.delete(failedAgentId);
			}
			else {
				this.runtimeErrors.set(failedAgentId, error instanceof Error ? error.message : String(error));
				await this.retireFailedWorker(failedAgentId);
			}
			this.emitRuntimeChange();
			throw error;
		} finally {
			if (request.team && instance) this.teamActive.delete(instance.agentId);
			if (reservedTeamAlias !== undefined) this.teamAliases.delete(reservedTeamAlias);
		}
	}

	async control(request: ControlRequest): Promise<ControlResult> {
		const message = request.message.trim();
		if (!message) throw new Error("Subagent control message cannot be empty");
		if (request.signal?.aborted) throw new Error("Subagent control was aborted before delivery");
		const agentId = this.roster.resolve(request.target) ?? request.target;
		if (this.teamActive.has(agentId)) throw new Error("Use team control for an active team member");
		if (this.shuttingDown || this.stoppingAgents.has(agentId) || this.deletingAgents.has(agentId)) throw new Error("Subagent worker is stopping");
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
				if (state.stopping || state.activeRunId !== runId || !state.activeRunAccepted) {
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
		const creation = this.createInstance(request);
		this.instanceCreations.add(creation);
		try {
			return await creation;
		} finally {
			this.instanceCreations.delete(creation);
		}
	}

	async validateContextWindowForTarget(target: string, contextWindow: number): Promise<void> {
		let instance = await this.resolveInstance(target);
		// A queued model change can make persisted target metadata stale. This is
		// only preflight; dispatch revalidates inside the worker's operation queue.
		while (this.modelChanges.has(instance.agentId)) {
			await this.modelChanges.get(instance.agentId);
			instance = await this.resolveInstance(target);
		}
		const selected = this.workers.get(instance.agentId)?.instance ?? instance;
		const cwd = await resolveChildContextCwd(selected.cwd, { mode: "open", path: selected.sessionFile });
		this.validateContextWindow(contextWindow, cwd, selected.model);
	}

	async listLinked(): Promise<AgentInstance[]> {
		const values = await Promise.all(this.roster.list().map(async (link) => {
			const snapshotEpoch = this.descriptorSnapshotEpoch(link.agentId);
			const instance = await this.store.get(link.agentId);
			if (!instance) {
				this.forgetInstanceAtEpoch(link.agentId, snapshotEpoch);
				return undefined;
			}
			const normalized = { ...instance, fastMode: instance.fastMode === true } as AgentInstance;
			this.rememberInstanceAtEpoch(normalized, snapshotEpoch);
			return { ...normalized, alias: link.alias };
		}));
		return values.filter((value): value is AgentInstance => value !== undefined);
	}

	async prewarmFastModes(): Promise<void> {
		const epochsAtStart = new Map(this.descriptorSnapshotEpochs);
		const snapshotAgentIds = new Set(this.descriptorSnapshots.keys());
		const instances = await this.store.list();
		const listedAgentIds = new Set<string>();
		for (const instance of instances) {
			listedAgentIds.add(instance.agentId);
			const normalized = { ...instance, fastMode: instance.fastMode === true } as AgentInstance;
			this.rememberInstanceAtEpoch(normalized, epochsAtStart.get(instance.agentId) ?? 0);
		}
		for (const agentId of snapshotAgentIds) {
			if (!listedAgentIds.has(agentId)) this.forgetInstanceAtEpoch(agentId, epochsAtStart.get(agentId) ?? 0);
		}
	}

	/** Rejects aliases a new persistent session could not claim: linked, being created, or saved by any parent. */
	async assertAliasesAvailable(aliases: readonly string[]): Promise<void> {
		const saved = new Set((await this.store.list()).map((instance) => instance.alias));
		const taken = aliases.filter((alias) => this.roster.resolve(alias) || this.pendingAliases.has(alias) || saved.has(alias));
		if (taken.length) {
			throw new Error(`Persistent subagent alias already exists: ${taken.join(", ")}. Team members need new aliases; choose different ones.`);
		}
	}

	knownFastMode(target: string): boolean | undefined {
		const agentId = this.roster.resolve(target) ?? target;
		return this.descriptorSnapshots.get(agentId)?.fastMode;
	}

	knownModel(target: string): RailModelRef | undefined {
		const agentId = this.roster.resolve(target) ?? target;
		const snapshot = this.descriptorSnapshots.get(agentId);
		return snapshot ? structuredClone(snapshot.model) : undefined;
	}

	runtimeStatus(agentId: string): AgentRuntimeStatus {
		if (this.workerStarts.has(agentId)) return { phase: "starting", queued: 0 };
		const state = this.workers.get(agentId);
		if (state) {
			const activity = state.isCompacting ? { isCompacting: true as const } : {};
			if (state.activeRunId !== undefined) return { phase: state.activeRunAccepted ? "running" : "starting", queued: state.queued, ...activity };
			if (state.controlPoisoned) return { phase: "error", queued: state.queued, ...activity, errorMessage: state.controlErrorMessage ?? "Subagent control delivery outcome is unknown" };
			if (state.active || state.queued > 0) return { phase: "queued", queued: Math.max(1, state.queued), ...activity };
			const stateError = this.runtimeErrors.get(agentId);
			return stateError ? { phase: "error", queued: 0, ...activity, errorMessage: stateError } : { phase: "idle", queued: 0, ...activity };
		}
		const errorMessage = this.runtimeErrors.get(agentId);
		if (errorMessage) return { phase: "error", queued: 0, errorMessage };
		return { phase: "stopped", queued: 0 };
	}

	subscribeRuntime(listener: () => void): () => void {
		this.runtimeListeners.add(listener);
		return () => this.runtimeListeners.delete(listener);
	}

	hasLocalWorker(agentId: string): boolean {
		return this.workers.has(agentId) || this.workerStarts.has(agentId);
	}

	async stop(target: string): Promise<AgentInstance | undefined> {
		const agentId = this.roster.resolve(target) ?? target;
		if (this.fastModeChanges.has(agentId) || this.modelChanges.has(agentId)) {
			throw new Error("Subagent maintenance operation is already pending");
		}
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

	async setFastMode(target: string, enabled: boolean, options: { sessionLeaseHeld?: boolean } = {}): Promise<AgentInstance> {
		const requestedAgentId = this.roster.resolve(target) ?? target;
		if (this.deletingAgents.has(requestedAgentId)) throw new Error("Subagent is being deleted");
		if (this.fastModeChanges.has(requestedAgentId)) throw new Error("Subagent fast mode is already changing");
		const change = (async () => {
			if (this.shuttingDown) throw new Error("Subagent broker is shutting down");
			const instance = await this.resolveInstance(target);
			const agentId = instance.agentId;
			if (this.shuttingDown) throw new Error("Subagent broker is shutting down");
			if (this.deletingAgents.has(agentId)) throw new Error("Subagent is being deleted");
			if (this.workerStarts.has(agentId)) throw new Error("Subagent worker is still starting");
			if (this.modelChanges.has(agentId)) throw new Error("Subagent maintenance operation is already pending");
			if (this.stoppingAgents.has(agentId)) throw new Error("Subagent worker is stopping");
			const state = this.workers.get(agentId);
			if (state && (state.active || state.queued > 0 || state.activeRunId !== undefined || state.isCompacting)) {
				throw new Error("Fast mode can only change while the subagent is idle or stopped");
			}
			if (!state && options.sessionLeaseHeld !== true) {
				throw new Error("Fast mode changes for a stopped subagent require a held session lease");
			}
			this.lifecycleEpochs.set(agentId, this.lifecycleEpoch(agentId) + 1);
			this.stoppingAgents.add(agentId);
			if (state) state.stopping = true;
			try {
				const latest = await this.store.get(agentId) ?? instance;
				const updated = { ...latest, fastMode: enabled, updatedAt: new Date().toISOString() };
				await this.store.put(updated);
				this.commitInstanceSnapshot(updated);
				if (state) await this.stopWorker(agentId);
				this.emitRuntimeChange();
				return updated;
			} finally {
				this.stoppingAgents.delete(agentId);
				if (state && this.workers.get(agentId) === state) state.stopping = false;
				this.emitRuntimeChange();
			}
		})();
		this.fastModeChanges.set(requestedAgentId, change);
		try {
			return await change;
		} finally {
			this.fastModeChanges.delete(requestedAgentId);
		}
	}

	async changeModel(target: string, model: RailModelRef): Promise<AgentInstance> {
		const instance = await this.resolveInstance(target);
		if (this.shuttingDown) throw new Error("Subagent broker is shutting down");
		if (this.deletingAgents.has(instance.agentId)) throw new Error("Subagent is being deleted");
		if (this.workerStarts.has(instance.agentId)) throw new Error("Subagent worker is still starting");
		if (this.modelChanges.has(instance.agentId)) throw new Error("Subagent model change is already pending");
		if (this.fastModeChanges.has(instance.agentId)) throw new Error("Subagent fast mode is changing");
		const change = (async () => {
			const state = this.workers.get(instance.agentId);
			const apply = async () => {
				const latest = await this.store.get(instance.agentId) ?? instance;
				if (this.shuttingDown) throw new Error("Subagent broker is shutting down");
				if (!state) {
					const updated = { ...latest, model: structuredClone(model), updatedAt: new Date().toISOString() };
					await this.store.put(updated);
					this.commitInstanceSnapshot(updated);
					return updated;
				}
				if (!state.worker.setModel) throw new Error("Subagent worker does not support model changes");
				try {
					const effective = await state.worker.setModel(model);
					const updated = { ...latest, model: structuredClone(effective), updatedAt: new Date().toISOString() };
					await this.store.put(updated);
					this.commitInstanceSnapshot(updated);
					state.instance = updated;
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
		// Cancel in-flight team dispatches so their tails settle instead of parking
		// between coordinator rounds.
		for (const operation of this.teamActive.values()) operation.abort();
		// Stop active sends before awaiting model changes queued behind them.
		await Promise.allSettled([...this.workerStarts.values(), ...this.instanceCreations, ...this.fastModeChanges.values()]);
		const states = Array.from(this.workers.values());
		this.workers.clear();
		for (const state of states) state.stopping = true;
		await Promise.allSettled(states.map((state) => state.worker.stop()));
		await Promise.allSettled(this.modelChanges.values());
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
		const agentId = this.roster.resolve(target) ?? target;
		if (this.deletingAgents.has(agentId)) throw new Error("Subagent is already being deleted");
		this.deletingAgents.add(agentId);
		this.lifecycleEpochs.set(agentId, this.lifecycleEpoch(agentId) + 1);
		const state = this.workers.get(agentId);
		if (state) state.stopping = true;
		// Cancel an in-flight team dispatch before awaiting maintenance queued behind
		// it; the coordinator's round barrier would otherwise park delete forever.
		this.teamActive.get(agentId)?.abort();
		this.emitRuntimeChange();
		try {
			const pending = [this.fastModeChanges.get(agentId), this.modelChanges.get(agentId)]
				.filter((operation): operation is Promise<AgentInstance> => operation !== undefined);
			if (pending.length > 0) await Promise.allSettled(pending);
			const instance = await this.resolveInstance(target).catch(() => undefined);
			if (!instance) return undefined;
			await this.stopWorker(instance.agentId);
			if (this.unreaped.has(instance.agentId)) {
				throw new Error(`Subagent ${instance.alias} process has not exited yet; retry delete after it is reaped`);
			}
			await rm(instance.sessionFile, { force: true });
			await this.store.delete(instance.agentId);
			this.commitDeletedSnapshot(instance.agentId);
			for (const link of this.roster.list().filter((item) => item.agentId === instance.agentId)) this.roster.unlink(link.alias);
			this.runtimeErrors.delete(instance.agentId);
			this.emitRuntimeChange();
			return instance;
		} finally {
			this.deletingAgents.delete(agentId);
			this.emitRuntimeChange();
		}
	}

	private async createInstance(request: AttachRequest): Promise<AgentInstance> {
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
				fastMode: request.fastMode === true,
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
				lastTask: "(attached; no task yet)",
				fastMode: request.fastMode === true,
			};
			await this.store.put(instance);
			this.commitInstanceSnapshot(instance);
			if (this.shuttingDown) {
				try {
					await this.store.delete(agentId);
					this.commitDeletedSnapshot(agentId);
				} catch {
					// Preserve the descriptor snapshot when cleanup could not be persisted.
				}
				throw new Error("Subagent broker is shutting down");
			}
			this.roster.link(alias, agentId);
			this.workers.set(agentId, freshWorkerState(instance, worker));
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

	private async resolveInstance(target: string): Promise<AgentInstance> {
		const linkedAgentId = this.roster.resolve(target);
		const agentId = linkedAgentId ?? target;
		const snapshotEpoch = this.descriptorSnapshotEpoch(agentId);
		const instance = await this.store.get(agentId);
		if (!instance) {
			this.forgetInstanceAtEpoch(agentId, snapshotEpoch);
			throw new Error(`Unknown persistent subagent: ${target}`);
		}
		const normalized: AgentInstance = { ...instance, fastMode: instance.fastMode === true };
		this.rememberInstanceAtEpoch(normalized, snapshotEpoch);
		return linkedAgentId && target !== agentId ? { ...normalized, alias: target } : normalized;
	}

	private async workerState(instance: AgentInstance, expectedEpoch = this.lifecycleEpoch(instance.agentId)): Promise<WorkerState> {
		if (this.shuttingDown || this.stoppingAgents.has(instance.agentId) || this.deletingAgents.has(instance.agentId) || this.lifecycleEpoch(instance.agentId) !== expectedEpoch) {
			throw new Error("Subagent dispatch was interrupted by stop or shutdown");
		}
		const changing = this.modelChanges.get(instance.agentId) ?? this.fastModeChanges.get(instance.agentId);
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
			if (!instance.sessionName) {
				const updated = { ...instance, sessionName };
				await this.store.put(updated);
				this.commitInstanceSnapshot(updated);
			}
			const worker = await this.workerFactory({
				agentId: instance.agentId,
				mode: "open",
				model: instance.model,
				alias: instance.alias,
				sessionName,
				cwd: instance.cwd,
				sessionPath: instance.sessionFile,
				fastMode: instance.fastMode === true,
			});
			if (this.shuttingDown || this.stoppingAgents.has(instance.agentId) || this.deletingAgents.has(instance.agentId) || this.lifecycleEpoch(instance.agentId) !== expectedEpoch) {
				await worker.stop().catch(() => undefined);
				throw new Error("Subagent dispatch was interrupted by stop or shutdown");
			}
			const state = freshWorkerState({ ...instance, sessionName }, worker);
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

	private descriptorSnapshotEpoch(agentId: string): number {
		return this.descriptorSnapshotEpochs.get(agentId) ?? 0;
	}

	private bumpDescriptorSnapshotEpoch(agentId: string): number {
		const next = this.descriptorSnapshotEpoch(agentId) + 1;
		this.descriptorSnapshotEpochs.set(agentId, next);
		return next;
	}

	private commitInstanceSnapshot(instance: AgentInstance): void {
		this.bumpDescriptorSnapshotEpoch(instance.agentId);
		this.descriptorSnapshots.set(instance.agentId, descriptorSnapshotOf(instance));
	}

	private commitDeletedSnapshot(agentId: string): void {
		this.bumpDescriptorSnapshotEpoch(agentId);
		this.descriptorSnapshots.delete(agentId);
	}

	private rememberInstanceAtEpoch(instance: AgentInstance, epoch: number): boolean {
		if (this.descriptorSnapshotEpoch(instance.agentId) !== epoch) return false;
		this.descriptorSnapshots.set(instance.agentId, descriptorSnapshotOf(instance));
		return true;
	}

	private forgetInstanceAtEpoch(agentId: string, epoch: number): boolean {
		if (this.descriptorSnapshotEpoch(agentId) !== epoch) return false;
		this.descriptorSnapshots.delete(agentId);
		return true;
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
			if (this.shuttingDown) {
				this.emitRuntimeChange();
				throw new Error("Subagent broker is shutting down");
			}
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
				state.isCompacting = false;
				this.emitRuntimeChange();
			}
		};
		const result = state.tail.then(run, run);
		state.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	private async stopWorker(agentId: string): Promise<void> {
		this.teamActive.get(agentId)?.abort();
		const starting = this.workerStarts.get(agentId);
		if (starting) await starting.catch(() => undefined);
		const inFlight = this.stopsInFlight.get(agentId);
		if (inFlight) return inFlight;
		const state = this.workers.get(agentId);
		if (!state) return;
		this.stoppingAgents.add(agentId);
		try {
			await this.stopProcess(agentId, state);
			await Promise.allSettled([state.tail, state.controlTail]);
			this.runtimeErrors.delete(agentId);
		} finally {
			this.stoppingAgents.delete(agentId);
			this.emitRuntimeChange();
		}
	}

	/** Detaches and stops a worker; a child that outlives SIGKILL is recorded before any waiter resumes. */
	private stopProcess(agentId: string, state: WorkerState): Promise<void> {
		this.workers.delete(agentId);
		state.stopping = true;
		const stop = state.worker.stop().catch((error: unknown) => {
			if (error instanceof RpcProcessExitTimeoutError) {
				this.unreaped.set(agentId, error.exited);
				void error.exited.then(() => this.unreaped.delete(agentId), () => this.unreaped.delete(agentId));
			}
			throw error;
		}).finally(() => {
			if (this.stopsInFlight.get(agentId) === stop) this.stopsInFlight.delete(agentId);
		});
		this.stopsInFlight.set(agentId, stop);
		return stop;
	}

	private async retireFailedWorker(agentId: string): Promise<void> {
		const state = this.workers.get(agentId);
		if (!state) return;
		await this.stopProcess(agentId, state).catch(() => undefined);
	}

	private async cleanupCreatedInstance(agent: AgentInstance, removeSessionFile: boolean): Promise<void> {
		await this.stopWorker(agent.agentId).catch(() => undefined);
		for (const link of this.roster.list().filter((item) => item.agentId === agent.agentId)) this.roster.unlink(link.alias);
		try {
			await this.store.delete(agent.agentId);
			this.commitDeletedSnapshot(agent.agentId);
		} catch {
			// Keep the snapshot when descriptor cleanup did not succeed.
		}
		if (!removeSessionFile) return;
		const exited = this.unreaped.get(agent.agentId);
		// Never unlink a file a still-running child may write; remove it once the child is reaped.
		if (exited) void exited.then(() => rm(agent.sessionFile, { force: true })).catch(() => undefined);
		else await rm(agent.sessionFile, { force: true }).catch(() => undefined);
	}

	private emitRuntimeChange(): void {
		for (const listener of this.runtimeListeners) listener();
	}

	private lifecycleEpoch(agentId: string): number {
		return this.lifecycleEpochs.get(agentId) ?? 0;
	}

	private validateContextWindow(contextWindow: number, cwd: string, model: RailModelRef): void {
		const settings = createChildContextSettings(cwd).getCompactionSettings({ provider: model.provider, id: model.modelId });
		validateContextWindowReserve(contextWindow, settings.reserveTokens, settings.enabled);
	}
}
