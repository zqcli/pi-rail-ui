import { realpathSync } from "node:fs";
import * as path from "node:path";
import { resolvePiInvocation } from "./pi-invocation";
import type { RpcEvent } from "./rpc-worker";
import { buildRpcWorkerArgs, RpcSessionWorker } from "./rpc-worker";
import { PiRpcProcessTransport } from "./rpc-transport";
import type { SessionLease } from "./session-lease";
import { FileSessionLeaseManager } from "./session-lease";
import type { SessionWorker, SessionWorkerFactory, WorkerSendOptions, WorkerRunResult } from "./session-broker";

export interface RpcWorkerFactoryOptions {
	stateDir: string;
	onUiRequest?: (request: RpcEvent, source: { agentId: string; alias: string }) => Promise<Record<string, unknown> | undefined>;
	resolveInvocation?: (args: string[]) => { command: string; args: string[] };
	startupTimeoutMs?: number;
}

export function sessionLeaseKey(sessionPath: string): string {
	let normalized = path.resolve(sessionPath);
	try {
		normalized = realpathSync.native(normalized);
	} catch {
		// A new child may report its path just before the session file is flushed.
	}
	return `session:${normalized}`;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("Subagent RPC worker startup timed out")), timeoutMs);
				timeout.unref();
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

class LeasedSessionWorker implements SessionWorker {
	readonly sessionId: string;
	readonly sessionFile: string;
	private stopped = false;

	constructor(
		private readonly worker: RpcSessionWorker,
		private readonly lease: SessionLease,
	) {
		this.sessionId = worker.sessionId;
		this.sessionFile = worker.sessionFile;
	}

	send(task: string, options?: WorkerSendOptions): Promise<WorkerRunResult> {
		return this.worker.send(task, options);
	}

	setModel(model: Parameters<NonNullable<SessionWorker["setModel"]>>[0]) {
		return this.worker.setModel(model);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		try {
			await this.worker.stop();
		} finally {
			await this.lease.release();
		}
	}
}

export function createRpcWorkerFactory(options: RpcWorkerFactoryOptions): SessionWorkerFactory {
	const leases = new FileSessionLeaseManager(options.stateDir);
	return async (spec) => {
		const startsWithSessionLease = spec.mode === "open" || spec.mode === "exclusive";
		let lease = await leases.acquire(startsWithSessionLease
			? sessionLeaseKey(spec.sessionPath!)
			: `agent:${spec.agentId}`);
		const invocation = (options.resolveInvocation ?? resolvePiInvocation)(buildRpcWorkerArgs(spec));
		const transport = new PiRpcProcessTransport({
			command: invocation.command,
			args: invocation.args,
			cwd: spec.cwd,
			env: {
				...process.env,
				PI_SUBAGENT_DEPTH: String(Number(process.env["PI_SUBAGENT_DEPTH"] ?? "0") + 1),
			},
			...(options.onUiRequest ? {
				onUiRequest: (request: RpcEvent) => options.onUiRequest!(request, { agentId: spec.agentId, alias: spec.alias }),
			} : {}),
		});
		try {
			await transport.start();
			const worker = await withTimeout(RpcSessionWorker.connect(spec, transport), options.startupTimeoutMs ?? 15_000);
			if (!startsWithSessionLease) {
				const sessionLease = await leases.acquire(sessionLeaseKey(worker.sessionFile));
				const startupLease = lease;
				lease = sessionLease;
				await startupLease.release();
			}
			return new LeasedSessionWorker(worker, lease);
		} catch (error) {
			await transport.stop().catch(() => undefined);
			await lease.release();
			throw error;
		}
	};
}