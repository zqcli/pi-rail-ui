import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CONTEXT_PROTOCOL_ERROR_PREFIX, CONTEXT_PROTOCOL_FLAG, CONTEXT_PROTOCOL_VERSION, CONTEXT_WINDOW_FLAG, contextExtensionPath, formatContextWindow, readContextProtocolError, validateContextWindowReserve } from "./context-window";
import { railModelKey, type RailModelRef } from "./models";
import { resolvePiInvocation, type PiInvocation } from "./pi-invocation";
import type { WorkerRunResult } from "./session-broker";
import { isAssistantMessage, RunResultCollector, strictAssistantText, type SubagentRunEvent } from "./run-result";

const STDERR_CAP = 50 * 1024;

export interface StatelessRunRequest {
	model: RailModelRef;
	task: string;
	cwd: string;
	contextWindow?: number;
	signal?: AbortSignal;
	onUpdate?: (result: StatelessRunResult) => void;
}

export interface StatelessRunResult extends WorkerRunResult {
	exitCode: number;
}

export type StatelessAgentRunner = (request: StatelessRunRequest) => Promise<StatelessRunResult>;

export interface StatelessAgentRunnerOptions {
	resolveInvocation?: (args: string[]) => PiInvocation;
}

export function createStatelessAgentRunner(options: StatelessAgentRunnerOptions = {}): StatelessAgentRunner {
	return async (request) => {
		if (!request.task.trim()) throw new Error("Subagent task cannot be empty");
		if (request.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
		const requestedContextWindow = request.contextWindow;
		const settings = requestedContextWindow === undefined ? undefined : SettingsManager.create(request.cwd, getAgentDir()).getCompactionSettings();
		const contextWindow = settings
			? validateContextWindowReserve(requestedContextWindow, settings.reserveTokens, settings.enabled)
			: undefined;
		const args = ["--mode", "json", "-p", "--no-session", "--model", railModelKey(request.model)];
		if (request.model.thinkingLevel) args.push("--thinking", request.model.thinkingLevel);
		args.push("--exclude-tools", "subagent");
		if (contextWindow !== undefined) {
			args.push(
				"-e", contextExtensionPath(),
				`--${CONTEXT_PROTOCOL_FLAG}`, CONTEXT_PROTOCOL_VERSION,
				`--${CONTEXT_WINDOW_FLAG}`, formatContextWindow(contextWindow),
			);
		}
		args.push(`Task: ${request.task}`);

		const invocation = (options.resolveInvocation ?? resolvePiInvocation)(args);
		const collector = new RunResultCollector(request.task, strictAssistantText);
		let stderr = "";
		let protocolErrorEvent: string | undefined;
		let aborted = false;
		let killTimer: NodeJS.Timeout | undefined;
		let updateTimer: NodeJS.Timeout | undefined;
		const publishUpdate = () => {
			updateTimer = undefined;
			request.onUpdate?.({ ...collector.result("(running...)"), exitCode: 0 });
		};
		const queueUpdate = (immediate = false) => {
			if (!request.onUpdate) return;
			if (immediate) {
				if (updateTimer) clearTimeout(updateTimer);
				publishUpdate();
				return;
			}
			if (!updateTimer) updateTimer = setTimeout(publishUpdate, 80);
		};
		const exitCode = await new Promise<number>((resolve) => {
				const proc = spawn(invocation.command, invocation.args, {
					cwd: request.cwd,
					env: {
						...process.env,
						PI_SUBAGENT_DEPTH: String(Number(process.env["PI_SUBAGENT_DEPTH"] ?? "0") + 1),
					},
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				const decoder = new StringDecoder("utf8");
				let buffer = "";
				const consume = () => {
					while (true) {
						const newline = buffer.indexOf("\n");
						if (newline < 0) return;
						const line = buffer.slice(0, newline).replace(/\r$/u, "");
						buffer = buffer.slice(newline + 1);
						if (!line.trim()) continue;
						try {
							const event = JSON.parse(line) as SubagentRunEvent;
							if (event.type === "extension_error") {
								const detail = readContextProtocolError(event["error"]);
								if (detail !== undefined) protocolErrorEvent = detail;
							}
							const changed = collector.ingest(event);
							const immediate = (event.type === "message_end" && isAssistantMessage(event.message))
								|| event.type === "tool_execution_start"
								|| event.type === "tool_execution_end"
								|| event.type === "compaction_start"
								|| event.type === "compaction_end"
								|| event.type === "summarization_retry_scheduled"
								|| event.type === "summarization_retry_attempt_start"
								|| event.type === "summarization_retry_finished";
							if (immediate) {
								queueUpdate(true);
							} else if (changed) {
								queueUpdate(false);
							}
						} catch {
							// Ignore non-JSON diagnostic output, and skip the malformed message tail.
						}
					}
				};
				proc.stdout.on("data", (chunk) => {
					buffer += decoder.write(chunk);
					consume();
				});
				proc.stdout.on("end", () => {
					buffer += decoder.end();
					if (buffer.trim()) buffer += "\n";
					consume();
				});
				proc.stderr.on("data", (chunk) => {
					stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_CAP);
				});
				proc.once("error", (error) => {
					collector.noteError(error.message);
					resolve(1);
				});
				proc.once("close", (code) => resolve(code ?? 1));
				const abort = () => {
					aborted = true;
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => proc.kill("SIGKILL"), 1500);
					killTimer.unref();
				};
				if (request.signal?.aborted) abort();
				else request.signal?.addEventListener("abort", abort, { once: true });
				proc.once("close", () => {
					request.signal?.removeEventListener("abort", abort);
					if (killTimer) clearTimeout(killTimer);
				});
		});
		if (updateTimer) clearTimeout(updateTimer);
		collector.markSettled();
		if (aborted) {
			collector.markAborted();
			publishUpdate();
			throw new Error("Subagent request was aborted");
		}
		const protocolError = protocolErrorEvent ?? stderr.split(/\r?\n/u)
			.map((line) => line.trim())
			.find((line) => line.startsWith(CONTEXT_PROTOCOL_ERROR_PREFIX))
			?.slice(CONTEXT_PROTOCOL_ERROR_PREFIX.length).trim();
		const failure = protocolError
			? `Subagent context protocol failed before the run started: ${protocolError}`
			: collector.errorMessage ?? (exitCode === 0 ? undefined : stderr.trim() || `Subagent process exited with code ${exitCode}`);
		const collected = collector.result(failure || "(no output)");
		if (protocolError) {
			const { transcript: _transcript, ...withoutTranscript } = collected;
			return {
				...withoutTranscript,
				output: failure!,
				exitCode,
				errorMessage: failure!,
			};
		}
		return {
			...collected,
			exitCode,
			...(failure ? { errorMessage: failure } : {}),
		};
	};
}