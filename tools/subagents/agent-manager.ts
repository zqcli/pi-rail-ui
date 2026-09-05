import type { RailModelRef } from "./models";
import { FileSessionLeaseManager } from "./session-lease";
import { runErrorMessage } from "./session-broker";
import type {
	AgentInstance,
	AgentInstanceStore,
	AgentRoster,
	AgentRuntimePhase,
	DispatchProgress,
	DispatchRequest,
	DispatchResult,
	ControlResult,
	SessionBroker,
	SessionSource,
	WorkerControlRequest,
} from "./session-broker";
import { sessionLeaseKey } from "./worker-factory";

export type RailAgentPhase = AgentRuntimePhase | "in-use-elsewhere" | "unknown";

export interface RailAgentView {
	instance: AgentInstance;
	linkedAliases: string[];
	linkedToCurrentSession: boolean;
	phase: RailAgentPhase;
	queued: number;
	ownerPid?: number;
	errorMessage?: string;
}

export interface RailAgentManagerSnapshot {
	agents: RailAgentView[];
	counts: {
		linked: number;
		global: number;
		running: number;
		queued: number;
		idle: number;
		stopped: number;
		inUseElsewhere: number;
		errors: number;
	};
}

export interface CreateRailAgentRequest {
	model: RailModelRef;
	alias: string;
	task: string;
	cwd: string;
	session?: SessionSource;
	onUpdate?: (progress: DispatchProgress) => void;
	signal?: AbortSignal;
}

export interface AdoptRailAgentRequest {
	model: RailModelRef;
	alias: string;
	cwd: string;
	session: SessionSource;
}

export class RailAgentManager {
	private readonly leases: FileSessionLeaseManager;

	constructor(
		private readonly broker: SessionBroker,
		private readonly store: AgentInstanceStore,
		private readonly roster: AgentRoster,
		stateDir: string,
	) {
		this.leases = new FileSessionLeaseManager(stateDir);
	}

	async snapshot(): Promise<RailAgentManagerSnapshot> {
		const instances = await this.store.list();
		const links = this.roster.list();
		const aliasesByAgent = new Map<string, string[]>();
		for (const link of links) {
			const aliases = aliasesByAgent.get(link.agentId) ?? [];
			aliases.push(link.alias);
			aliasesByAgent.set(link.agentId, aliases);
		}
		const agents = await Promise.all(instances.map(async (instance): Promise<RailAgentView> => {
			const local = this.broker.runtimeStatus(instance.agentId);
			const linkedAliases = aliasesByAgent.get(instance.agentId) ?? [];
			if (local.phase !== "stopped") {
				return {
					instance,
					linkedAliases,
					linkedToCurrentSession: linkedAliases.length > 0,
					phase: local.phase,
					queued: local.queued,
					...(local.errorMessage ? { errorMessage: local.errorMessage } : {}),
				};
			}
			const lease = await this.leases.inspect(sessionLeaseKey(instance.sessionFile));
			if (lease.state === "owned") {
				return {
					instance,
					linkedAliases,
					linkedToCurrentSession: linkedAliases.length > 0,
					phase: lease.owner.pid === process.pid ? "unknown" : "in-use-elsewhere",
					queued: 0,
					ownerPid: lease.owner.pid,
				};
			}
			return {
				instance,
				linkedAliases,
				linkedToCurrentSession: linkedAliases.length > 0,
				phase: lease.state === "unknown" ? "unknown" : "stopped",
				queued: 0,
			};
		}));
		agents.sort((left, right) => {
			if (left.linkedToCurrentSession !== right.linkedToCurrentSession) return left.linkedToCurrentSession ? -1 : 1;
			const activity = (phase: RailAgentPhase) => phase === "running" ? 0 : phase === "queued" || phase === "starting" ? 1 : phase === "idle" ? 2 : 3;
			return activity(left.phase) - activity(right.phase) || right.instance.updatedAt.localeCompare(left.instance.updatedAt);
		});
		return {
			agents,
			counts: {
				linked: new Set(links.map((link) => link.agentId)).size,
				global: agents.length,
				running: agents.filter((agent) => agent.phase === "running" || agent.phase === "starting").length,
				queued: agents.reduce((total, agent) => total + agent.queued, 0),
				idle: agents.filter((agent) => agent.phase === "idle").length,
				stopped: agents.filter((agent) => agent.phase === "stopped").length,
				inUseElsewhere: agents.filter((agent) => agent.phase === "in-use-elsewhere").length,
				errors: agents.filter((agent) => agent.phase === "error" || agent.phase === "unknown").length,
			},
		};
	}

	subscribe(listener: () => void): () => void {
		return this.broker.subscribeRuntime(listener);
	}

	create(request: CreateRailAgentRequest): Promise<DispatchResult> {
		return this.dispatch(request);
	}

	continue(target: string, task: string, signal?: AbortSignal): Promise<DispatchResult> {
		return this.dispatch({ target, task, ...(signal ? { signal } : {}) });
	}

	async control(target: string, request: WorkerControlRequest, signal?: AbortSignal): Promise<ControlResult> {
		const agent = await this.assertLocallyControllable(target);
		if (agent.phase !== "running") {
			throw new Error(`Subagent ${agent.instance.alias} is not currently running; use continue for an idle or stopped session`);
		}
		return this.broker.control({ target: agent.instance.agentId, ...request, ...(signal ? { signal } : {}) });
	}

	adopt(request: AdoptRailAgentRequest): Promise<AgentInstance> {
		return this.broker.attach(request);
	}

	async link(agentId: string): Promise<AgentInstance> {
		const instance = await this.store.get(agentId);
		if (!instance) throw new Error(`Unknown persistent subagent: ${agentId}`);
		this.roster.link(instance.alias, instance.agentId);
		return instance;
	}

	stop(target: string): Promise<AgentInstance | undefined> {
		return this.assertLocallyControllable(target).then(() => this.broker.stop(target));
	}

	detach(target: string): Promise<AgentInstance | undefined> {
		return this.broker.detach(target);
	}

	async delete(target: string): Promise<AgentInstance | undefined> {
		const agent = await this.assertLocallyControllable(target);
		if (agent.phase !== "stopped" && agent.phase !== "error") await this.broker.stop(target);
		const lease = await this.leases.acquire(sessionLeaseKey(agent.instance.sessionFile));
		try {
			return await this.broker.delete(target);
		} finally {
			await lease.release();
		}
	}

	async changeModel(target: string, model: RailModelRef): Promise<AgentInstance> {
		const agent = await this.assertLocallyControllable(target);
		if (agent.phase !== "stopped" && agent.phase !== "error") return this.broker.changeModel(target, model);
		const lease = await this.leases.acquire(sessionLeaseKey(agent.instance.sessionFile));
		try {
			return await this.broker.changeModel(target, model);
		} finally {
			await lease.release();
		}
	}

	private async dispatch(request: DispatchRequest): Promise<DispatchResult> {
		const result = await this.broker.dispatch(request);
		const error = runErrorMessage(result.run);
		if (error) throw new Error(error);
		return result;
	}

	private async assertLocallyControllable(target: string): Promise<RailAgentView> {
		const agent = (await this.snapshot()).agents.find((item) => item.instance.agentId === target
			|| item.instance.alias === target || item.linkedAliases.includes(target));
		if (!agent) throw new Error(`Unknown persistent subagent: ${target}`);
		if (agent.phase === "in-use-elsewhere") throw new Error(`Subagent session is owned by process ${agent.ownerPid ?? "unknown"}`);
		if (agent.phase === "unknown") throw new Error("Subagent session ownership is not yet known");
		return agent;
	}
}
