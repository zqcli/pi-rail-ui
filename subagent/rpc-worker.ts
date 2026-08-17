import { railModelKey } from "./models";
import type {
	SessionWorker,
	SubagentUsage,
	WorkerRunResult,
	WorkerSendOptions,
	WorkerStartSpec,
} from "./session-broker";

export interface RpcEvent {
	type: string;
	message?: any;
	error?: string;
	[key: string]: unknown;
}
export interface RpcTransport {
	request(command: Record<string, unknown>): Promise<unknown>;
	onEvent(listener: (event: RpcEvent) => void): () => void;
	stop(): Promise<void>;
}

interface RpcState {
	sessionId: string;
	sessionFile?: string;
	isStreaming?: boolean;
}

const EMPTY_USAGE: SubagentUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

export function buildRpcWorkerArgs(spec: WorkerStartSpec): string[] {
	const args = ["--mode", "rpc"];
	if (spec.mode === "fork") args.push("--fork", spec.sessionPath!);
	else if (spec.mode === "open" || spec.mode === "exclusive") args.push("--session", spec.sessionPath!);
	if (spec.mode === "new" || spec.mode === "fork") args.push("--name", spec.alias);
	args.push("--model", railModelKey(spec.model));
	if (spec.model.thinkingLevel) args.push("--thinking", spec.model.thinkingLevel);
	args.push("--exclude-tools", "subagent");
	return args;
}

function assistantText(message: any): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function addAssistantUsage(total: SubagentUsage, message: any): void {
	if (message?.role !== "assistant") return;
	const usage = message.usage;
	if (!usage) return;
	total.input += usage.input ?? 0;
	total.output += usage.output ?? 0;
	total.cacheRead += usage.cacheRead ?? 0;
	total.cacheWrite += usage.cacheWrite ?? 0;
	total.cost += usage.cost?.total ?? 0;
	total.contextTokens = usage.totalTokens ?? total.contextTokens;
	total.turns++;
}

export class RpcSessionWorker implements SessionWorker {
	private constructor(
		readonly sessionId: string,
		readonly sessionFile: string,
		private readonly transport: RpcTransport,
	) {}

	static async connect(_spec: WorkerStartSpec, transport: RpcTransport): Promise<RpcSessionWorker> {
		const state = await transport.request({ type: "get_state" }) as RpcState;
		if (!state?.sessionId || !state.sessionFile) {
			await transport.stop();
			throw new Error("Subagent RPC worker did not start a persistent session");
		}
		if (state.isStreaming) {
			await transport.stop();
			throw new Error("Subagent session is already streaming; live attach is not supported");
		}
		const worker = new RpcSessionWorker(state.sessionId, state.sessionFile, transport);
		return worker;
	}

	async send(task: string, options: WorkerSendOptions = {}): Promise<WorkerRunResult> {
		if (options.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
		const usage = { ...EMPTY_USAGE };
		let output = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let settled = false;
		let resolveSettled!: () => void;
		let transportError: Error | undefined;
		const settledPromise = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const unsubscribe = this.transport.onEvent((event) => {
			if (event.type === "message_end") {
				const text = assistantText(event.message);
				if (text) output = text;
				addAssistantUsage(usage, event.message);
				if (event.message?.role === "assistant") {
					stopReason = event.message.stopReason;
					errorMessage = event.message.errorMessage;
				}
				options.onUpdate?.({
					output: output || "(running...)",
					usage: { ...usage },
					...(stopReason ? { stopReason } : {}),
					...(errorMessage ? { errorMessage } : {}),
				});
			}
			if (event.type === "agent_settled" && !settled) {
				settled = true;
				resolveSettled();
			}
			if (event.type === "transport_error" && !settled) {
				settled = true;
				transportError = new Error(event.error ?? "Subagent RPC transport failed");
				resolveSettled();
			}
		});
		const abort = () => { void this.transport.request({ type: "abort" }).catch(() => undefined); };
		options.signal?.addEventListener("abort", abort, { once: true });

		try {
			await this.transport.request({ type: "prompt", message: task });
			await settledPromise;
			if (transportError) throw transportError;
			return {
				output: output || "(no output)",
				usage,
				...(stopReason ? { stopReason } : {}),
				...(errorMessage ? { errorMessage } : {}),
			};
		} finally {
			options.signal?.removeEventListener("abort", abort);
			unsubscribe();
		}
	}

	async stop(): Promise<void> {
		await this.transport.stop();
	}
}
