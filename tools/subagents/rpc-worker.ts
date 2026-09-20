import { railFastExtensionPath, RAIL_FAST_MODE_FLAG } from "../../commands/rail-fast";
import { railOaiSearchExtensionPath, RAIL_OAI_SEARCH_MODE_FLAG } from "../../commands/rail-oai-search";
import { railResponsesWebSocketExtensionPath } from "../../openai/responses-websocket";
import { gptCompactionExtensionPath } from "../gpt-compaction/extension";
import {
	CONTEXT_COMMAND,
	CONTEXT_PROTOCOL_FLAG,
	CONTEXT_PROTOCOL_VERSION,
	ContextProtocolError,
	ContextWindowValidationError,
	contextExtensionPath,
	createChildContextSettings,
	formatContextWindow,
	normalizeContextWindow,
	readContextProtocolError,
	resolveChildContextCwd,
	validateContextWindowReserve,
} from "./context-window";
import { railModelKey, type RailModelRef } from "./models";
import { RpcCommandError } from "./rpc-transport";
import { WorkerControlError } from "./session-broker";
import type {
	SessionWorker,
	WorkerRunResult,
	WorkerSendOptions,
	WorkerControlRequest,
	WorkerStartSpec,
} from "./session-broker";
import { isSharedImmediateEvent, RunResultCollector, assistantText } from "./run-result";

export interface RpcEvent {
	type: string;
	message?: unknown;
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
	model?: { provider?: string; id?: string; name?: string; contextWindow?: number };
	thinkingLevel?: RailModelRef["thinkingLevel"];
	isCompacting?: boolean;
}

export function buildRpcWorkerArgs(spec: WorkerStartSpec): string[] {
	const args = ["--mode", "rpc"];
	if (spec.mode === "fork") args.push("--fork", spec.sessionPath!);
	else if (spec.mode === "open" || spec.mode === "exclusive") args.push("--session", spec.sessionPath!);
	if (spec.mode !== "open") args.push("--name", spec.sessionName ?? spec.alias);
	args.push("--model", railModelKey(spec.model));
	if (spec.model.thinkingLevel) args.push("--thinking", spec.model.thinkingLevel);
	args.push("--exclude-tools", "subagent");
	if (spec.fastMode === true) args.push("-e", railFastExtensionPath(), `--${RAIL_FAST_MODE_FLAG}`);
	args.push("-e", railOaiSearchExtensionPath(), `--${RAIL_OAI_SEARCH_MODE_FLAG}`, "live");
	args.push("-e", railResponsesWebSocketExtensionPath());
	args.push("-e", gptCompactionExtensionPath());
	args.push("-e", contextExtensionPath(), `--${CONTEXT_PROTOCOL_FLAG}`, CONTEXT_PROTOCOL_VERSION);
	return args;
}

export class RpcSessionWorker implements SessionWorker {
	private constructor(
		readonly sessionId: string,
		readonly sessionFile: string,
		private readonly transport: RpcTransport,
		private readonly cwd: string,
		private modelProvider: string,
		private modelId: string,
	) {}
	private unusable = false;
	private runInFlight = false;
	private modelChangeInFlight = false;

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
		const commands = await transport.request({ type: "get_commands" }) as { commands?: Array<{ name?: string; source?: string; description?: string }> } | undefined;
		if (!commands?.commands?.some((command) => command.name === CONTEXT_COMMAND
			&& command.source === "extension"
			&& command.description?.includes(`protocol v${CONTEXT_PROTOCOL_VERSION}`))) {
			await transport.stop();
			throw new ContextProtocolError(`Subagent RPC worker is missing the ${CONTEXT_COMMAND} context adapter`);
		}
		const stateModel = state.model;
		if (!stateModel?.provider || !stateModel.id || typeof stateModel.contextWindow !== "number"
			|| !Number.isSafeInteger(stateModel.contextWindow) || stateModel.contextWindow <= 0) {
			await transport.stop();
			throw new ContextProtocolError("Subagent RPC worker did not expose a verifiable model contextWindow");
		}
		if (stateModel.provider !== spec.model.provider || stateModel.id !== spec.model.modelId) {
			await transport.stop();
			throw new ContextProtocolError(`Subagent RPC worker opened ${stateModel.provider}/${stateModel.id}, expected ${railModelKey(spec.model)}`);
		}
		if (spec.mode === "open" && spec.sessionName && state.sessionName !== spec.sessionName) {
			await transport.request({ type: "set_session_name", name: spec.sessionName });
		}
		const worker = new RpcSessionWorker(
			state.sessionId,
			state.sessionFile,
			transport,
			await resolveChildContextCwd(spec.cwd, { mode: "open", path: state.sessionFile }),
			stateModel.provider,
			stateModel.id,
		);
		return worker;
	}

	isReusable(): boolean {
		return !this.unusable;
	}

	private protocolFailure(message: string, cause?: unknown): ContextProtocolError {
		this.unusable = true;
		return new ContextProtocolError(message, cause instanceof Error ? { cause } : undefined);
	}

	private validateBudget(value: number | undefined): number | undefined {
		if (value === undefined) return undefined;
		const settings = createChildContextSettings(this.cwd).getCompactionSettings({ provider: this.modelProvider, id: this.modelId });
		return validateContextWindowReserve(value, settings.reserveTokens, settings.enabled);
	}

	private assertModelState(state: RpcState, expectedWindow?: number): void {
		const model = state.model;
		if (!model?.provider || !model.id) {
			throw this.protocolFailure("Subagent state did not expose its current provider/model identity");
		}
		if (model.provider !== this.modelProvider || model.id !== this.modelId) {
			throw this.protocolFailure(`Subagent model changed during context protocol: ${model.provider}/${model.id}`);
		}
		if (typeof model.contextWindow !== "number" || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
			throw this.protocolFailure("Subagent state did not expose a verifiable current contextWindow");
		}
		if (expectedWindow !== undefined && model?.contextWindow !== expectedWindow) {
			throw this.protocolFailure(`Subagent contextWindow confirmation failed: expected ${expectedWindow}, received ${String(model?.contextWindow)}`);
		}
	}

	private async state(): Promise<RpcState> {
		return await this.transport.request({ type: "get_state" }) as RpcState;
	}

	private async issueContextCommand(message: string): Promise<void> {
		const errors: string[] = [];
		const unsubscribe = this.transport.onEvent((event) => {
			if (event.type === "extension_error") {
				const error = readContextProtocolError(event.error);
				if (error !== undefined) errors.push(error);
			}
		});
		try {
			await this.transport.request({ type: "prompt", message });
		} catch (error) {
			this.unusable = true;
			throw new ContextProtocolError(`Rail context command failed: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? { cause: error } : undefined);
		} finally {
			unsubscribe();
		}
		if (errors.length > 0) {
			this.unusable = true;
			throw new ContextProtocolError(`Rail context command reported an extension error: ${errors.join("; ")}`);
		}
	}

	private async confirmContextWindow(expectedWindow?: number, requireIdle = true): Promise<RpcState> {
		const state = await this.state();
		this.assertModelState(state, expectedWindow);
		if (requireIdle && (state.isStreaming === true || state.isCompacting === true)) {
			throw this.protocolFailure("Rail context protocol expected an idle child after its private command");
		}
		return state;
	}

	private async resetContext(expectedWindow?: number): Promise<void> {
		try {
			await this.issueContextCommand(`/${CONTEXT_COMMAND} reset`);
			await this.confirmContextWindow(expectedWindow);
		} catch (error) {
			this.unusable = true;
			if (error instanceof ContextProtocolError) throw error;
			throw this.protocolFailure(`Rail context cleanup could not be confirmed: ${error instanceof Error ? error.message : String(error)}`, error);
		}
	}

	private async prepareContext(contextWindow: number | undefined): Promise<number | undefined> {
		if (contextWindow === undefined) return undefined;
		let commandSent = false;
		let restoreWindow: number | undefined;
		try {
			const before = await this.state();
			this.assertModelState(before);
			const value = this.validateBudget(contextWindow)!;
			if (before.isStreaming === true || before.isCompacting === true) {
				throw this.protocolFailure("Rail context protocol expected an idle child before its private command");
			}
			restoreWindow = before.model!.contextWindow;
			commandSent = true;
			await this.issueContextCommand(`/${CONTEXT_COMMAND} prepare ${formatContextWindow(value)}`);
			await this.confirmContextWindow(value);
			return restoreWindow;
		} catch (error) {
			if (error instanceof ContextWindowValidationError) throw error;
			if (commandSent && !this.unusable) {
				try {
					await this.resetContext(restoreWindow);
				} catch (cleanupError) {
					throw cleanupError;
				}
			}
			if (error instanceof ContextProtocolError) throw error;
			throw this.protocolFailure(`Rail context preparation failed: ${error instanceof Error ? error.message : String(error)}`, error);
		}
	}

	async send(task: string, options: WorkerSendOptions = {}): Promise<WorkerRunResult> {
		if (this.unusable) throw new ContextProtocolError("Subagent RPC worker is not reusable after a context protocol failure");
		if (this.runInFlight) throw new ContextProtocolError("Subagent RPC worker received an overlapping run");
		if (this.modelChangeInFlight) throw new ContextProtocolError("Subagent model change is in progress");
		if (options.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
		this.runInFlight = true;
		let restoreWindow: number | undefined;
		try {
			restoreWindow = await this.prepareContext(normalizeContextWindow(options.contextWindow));
		} catch (error) {
			this.runInFlight = false;
			throw error;
		}
		const prepared = restoreWindow !== undefined;
		if (options.signal?.aborted) {
			try {
				if (prepared) await this.resetContext(restoreWindow);
			} finally {
				this.runInFlight = false;
			}
			throw new Error("Subagent request was aborted before dispatch");
		}
		const collector = new RunResultCollector(task, assistantText);
		let settled = false;
		let settledNotified = false;
		let started = false;
		let aborted = false;
		let protocolError: ContextProtocolError | undefined;
		let resolveSettled!: () => void;
		let transportError: Error | undefined;
		let abortRequest: Promise<void> | undefined;
		let updateTimer: NodeJS.Timeout | undefined;
		const publishUpdate = () => {
			updateTimer = undefined;
			options.onUpdate?.(collector.result("(running...)"));
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
			if (event.type === "extension_error") {
				const error = readContextProtocolError(event.error);
				if (error !== undefined && !protocolError) {
					protocolError = this.protocolFailure(`Rail context helper failed during the child run: ${error}`);
				}
			}
			if (event.type === "agent_start") started = true;
			const changed = collector.ingest(event);
			const immediate = event.type === "message_end" || isSharedImmediateEvent(event.type);
			if (immediate) {
				queueUpdate(true);
			} else if (changed) {
				queueUpdate(false);
			}
			if (event.type === "agent_settled" && !settled) {
				collector.markSettled();
				queueUpdate(true);
				settled = true;
				if (!settledNotified) {
					settledNotified = true;
					options.onSettled?.();
				}
				resolveSettled();
			}
			if (event.type === "transport_error" && !settled) {
				collector.noteError(event.error ?? "Subagent RPC transport failed");
				this.unusable = true;
				queueUpdate(true);
				settled = true;
				if (!settledNotified) {
					settledNotified = true;
					options.onSettled?.();
				}
				transportError = this.protocolFailure(event.error ?? "Subagent RPC transport failed");
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
			await abortRequest;
			if (transportError) throw transportError;
			if (protocolError) throw protocolError;
			if (aborted) collector.markAborted();
			if (prepared) {
				const settledState = await this.confirmContextWindow();
				await this.resetContext(settledState.model!.contextWindow);
			}
			return collector.result("(no output)");
		} catch (error) {
			if (!settled && prepared && !this.unusable) await this.resetContext(restoreWindow);
			throw error;
		} finally {
			this.runInFlight = false;
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
		if (this.runInFlight || this.modelChangeInFlight) throw new ContextProtocolError("Subagent model change requires an idle worker");
		this.modelChangeInFlight = true;
		try {
			return await this.changeModel(model);
		} finally {
			this.modelChangeInFlight = false;
		}
	}

	private async changeModel(model: RailModelRef): Promise<RailModelRef> {
		if (this.unusable) throw new ContextProtocolError("Subagent RPC worker is not reusable after a context protocol failure");
		const before = await this.state();
		this.assertModelState(before);
		const observed = before.model?.contextWindow;
		if (typeof observed !== "number" || !Number.isSafeInteger(observed) || observed <= 0) {
			throw this.protocolFailure("Subagent model change has no verifiable current contextWindow");
		}
		if (before.isStreaming === true || before.isCompacting === true) throw this.protocolFailure("Subagent model change requires an idle child");
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
		if (!effective?.provider || !effective.id || typeof state.model?.contextWindow !== "number"
			|| !Number.isSafeInteger(state.model.contextWindow) || state.model.contextWindow <= 0) {
			throw this.protocolFailure("Subagent model change did not return a verifiable model contextWindow");
		}
		this.modelProvider = effective.provider;
		this.modelId = effective.id;
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
