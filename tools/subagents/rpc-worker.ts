import { railModelKey, type RailModelRef } from "./models";
import { RpcCommandError } from "./rpc-transport";
import { WorkerControlError } from "./session-broker";
import { SubagentTranscript } from "./transcript";
import type {
	SessionWorker,
	SubagentUsage,
	WorkerRunResult,
	WorkerSendOptions,
	WorkerControlRequest,
	WorkerStartSpec,
} from "./session-broker";
import { addCompletedAssistantUsage, emptySubagentUsage, providerReportedUsage, usageWithActiveTurn } from "./usage";

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
	sessionName?: string;
	isStreaming?: boolean;
	model?: { provider?: string; id?: string; name?: string };
	thinkingLevel?: RailModelRef["thinkingLevel"];
}

export function buildRpcWorkerArgs(spec: WorkerStartSpec): string[] {
	const args = ["--mode", "rpc"];
	if (spec.mode === "fork") args.push("--fork", spec.sessionPath!);
	else if (spec.mode === "open" || spec.mode === "exclusive") args.push("--session", spec.sessionPath!);
	if (spec.mode !== "open") args.push("--name", spec.sessionName ?? spec.alias);
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

export class RpcSessionWorker implements SessionWorker {
	private constructor(
		readonly sessionId: string,
		readonly sessionFile: string,
		private readonly transport: RpcTransport,
	) {}

	static async connect(spec: WorkerStartSpec, transport: RpcTransport): Promise<RpcSessionWorker> {
		const state = await transport.request({ type: "get_state" }) as RpcState;
		if (!state?.sessionId || !state.sessionFile) {
			await transport.stop();
			throw new Error("Subagent RPC worker did not start a persistent session");
		}
		if (state.isStreaming) {
			await transport.stop();
			throw new Error("Subagent session is already streaming; live attach is not supported");
		}
		if (spec.mode === "open" && spec.sessionName && state.sessionName !== spec.sessionName) {
			await transport.request({ type: "set_session_name", name: spec.sessionName });
		}
		const worker = new RpcSessionWorker(state.sessionId, state.sessionFile, transport);
		return worker;
	}

	async send(task: string, options: WorkerSendOptions = {}): Promise<WorkerRunResult> {
		if (options.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
		const usage = emptySubagentUsage();
		let activeUsage: SubagentUsage | undefined;
		let output = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let settled = false;
		let started = false;
		let aborted = false;
		let resolveSettled!: () => void;
		let transportError: Error | undefined;
		let abortRequest: Promise<void> | undefined;
		const transcript = new SubagentTranscript(task);
		let updateTimer: NodeJS.Timeout | undefined;
		const publishUpdate = () => {
			updateTimer = undefined;
			options.onUpdate?.({
				output: output || "(running...)",
				usage: usageWithActiveTurn(usage, activeUsage),
				transcript: transcript.snapshot(),
				...(stopReason ? { stopReason } : {}),
				...(errorMessage ? { errorMessage } : {}),
			});
		};
		const queueUpdate = (immediate = false) => {
			if (!options.onUpdate) return;
			if (immediate) {
				if (updateTimer) clearTimeout(updateTimer);
				publishUpdate();
				return;
			}
			if (!updateTimer) updateTimer = setTimeout(publishUpdate, 80);
		};
		const settledPromise = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const unsubscribe = this.transport.onEvent((event) => {
			if (event.type === "agent_start") started = true;
			const transcriptChanged = transcript.ingest(event);
			if (event.type === "message_update") {
				const reported = providerReportedUsage(event["usage"]);
				if (reported) activeUsage = reported;
			}
			if (event.type === "message_end") {
				const text = assistantText(event.message);
				if (text) output = text;
				addCompletedAssistantUsage(usage, event.message);
				if (event.message?.role === "assistant") activeUsage = undefined;
				if (event.message?.role === "assistant") {
					stopReason = event.message.stopReason;
					errorMessage = event.message.errorMessage;
				}
				queueUpdate(true);
			}
			if ((transcriptChanged || (event.type === "message_update" && activeUsage !== undefined)) && event.type !== "message_end") {
				queueUpdate(event.type === "tool_execution_start" || event.type === "tool_execution_end");
			}
			if (event.type === "agent_settled" && !settled) {
				queueUpdate(true);
				settled = true;
				resolveSettled();
			}
			if (event.type === "transport_error" && !settled) {
				queueUpdate(true);
				settled = true;
				transportError = new Error(event.error ?? "Subagent RPC transport failed");
				resolveSettled();
			}
		});
		const abort = () => {
			aborted = true;
			abortRequest ??= (async () => {
				try {
					await this.transport.request({ type: "clear_queue" });
				} catch {
					// Aborting the active turn still matters if queue cleanup fails.
				}
				await this.transport.request({ type: "abort" }).catch(() => undefined);
			})();
		};
		options.signal?.addEventListener("abort", abort, { once: true });

		try {
			await this.transport.request({ type: "prompt", message: task });
			if (!started && !settled) {
				const state = await this.transport.request({ type: "get_state" }) as RpcState;
				if (!started && !settled && state?.isStreaming !== true) {
					throw new Error("Subagent prompt was handled without starting an agent run");
				}
			}
			if (!settled) options.onAccepted?.();
			await settledPromise;
			if (transportError) throw transportError;
			if (aborted) {
				stopReason = "aborted";
				errorMessage = "Subagent request was aborted";
			}
			return {
				output: output || "(no output)",
				usage: usageWithActiveTurn(usage, activeUsage),
				transcript: transcript.snapshot(),
				...(stopReason ? { stopReason } : {}),
				...(errorMessage ? { errorMessage } : {}),
			};
		} finally {
			await abortRequest;
			if (updateTimer) clearTimeout(updateTimer);
			options.signal?.removeEventListener("abort", abort);
			unsubscribe();
		}
	}

	async control(request: WorkerControlRequest): Promise<void> {
		const message = request.message.trim();
		if (!message) throw new Error("Subagent control message cannot be empty");
		try {
			await this.transport.request({
				type: request.delivery === "followUp" ? "follow_up" : "steer",
				message,
			});
		} catch (error) {
			if (error instanceof RpcCommandError) {
				throw new WorkerControlError(`Subagent control was rejected: ${error.message}`, "rejected", { cause: error });
			}
			throw new WorkerControlError(`Subagent control delivery outcome is unknown: ${error instanceof Error ? error.message : String(error)}`, "unknown", { cause: error });
		}
	}

	async setModel(model: RailModelRef): Promise<RailModelRef> {
		const selected = await this.transport.request({
			type: "set_model",
			provider: model.provider,
			modelId: model.modelId,
		}) as { provider?: string; id?: string; name?: string } | undefined;
		if (model.thinkingLevel) {
			await this.transport.request({ type: "set_thinking_level", level: model.thinkingLevel });
		}
		const state = await this.transport.request({ type: "get_state" }) as RpcState;
		const effective = state.model ?? selected;
		return {
			provider: effective?.provider ?? model.provider,
			modelId: effective?.id ?? model.modelId,
			...(effective?.name ?? model.name ? { name: effective?.name ?? model.name } : {}),
			...(state.thinkingLevel ?? model.thinkingLevel ? { thinkingLevel: state.thinkingLevel ?? model.thinkingLevel } : {}),
		};
	}

	async stop(): Promise<void> {
		await this.transport.stop();
	}
}
