import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { railFastExtensionPath, RAIL_FAST_MODE_FLAG } from "../../commands/rail-fast";
import { railOaiSearchExtensionPath, RAIL_OAI_SEARCH_MODE_FLAG } from "../../commands/rail-oai-search";
import { hasRailResponsesWebSocketRoute, railResponsesWebSocketExtensionPath } from "../../openai/responses-websocket";
import { CONTEXT_PROTOCOL_ERROR_PREFIX, CONTEXT_PROTOCOL_FLAG, CONTEXT_PROTOCOL_VERSION, CONTEXT_WINDOW_FLAG, contextExtensionPath, createChildContextSettings, formatContextWindow, normalizeContextWindow, readContextProtocolError, validateContextWindowReserve } from "./context-window";
import { gptCompactionExtensionPath } from "../gpt-compaction/extension";
import { isGptModel } from "../../openai/model-eligibility";
import { readGptCompactionSettings } from "../gpt-compaction/settings";
import { railModelKey, type RailModelRef } from "./models";
import { resolvePiInvocation, type PiInvocation } from "./pi-invocation";
import type { WorkerRunResult } from "./session-broker";
import { isAssistantMessage, isSharedImmediateEvent, RunResultCollector, strictAssistantText, type SubagentRunEvent } from "./run-result";
import { RETRY_DELAYS_MS, retryContinuation, waitForRetry } from "./retry";

const STDERR_CAP = 50 * 1024;

export interface StatelessRunRequest {
	model: RailModelRef;
	task: string;
	cwd: string;
	contextWindow?: number;
	fastMode?: boolean;
	signal?: AbortSignal;
	onUpdate?: (result: StatelessRunResult) => void;
}

export interface StatelessRunResult extends WorkerRunResult {
	exitCode: number;
}

export type StatelessAgentRunner = (request: StatelessRunRequest) => Promise<StatelessRunResult>;

export interface StatelessAgentRunnerOptions {
	resolveInvocation?: (args: string[]) => PiInvocation;
	waitForRetry?: typeof waitForRetry;
}

export function createStatelessAgentRunner(options: StatelessAgentRunnerOptions = {}): StatelessAgentRunner {
	return async (request) => {
		if (!request.task.trim()) throw new Error("Subagent task cannot be empty");
		if (request.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
		const requestedContextWindow = normalizeContextWindow(request.contextWindow);
		const settings = requestedContextWindow === undefined ? undefined : createChildContextSettings(request.cwd).getCompactionSettings({ provider: request.model.provider, id: request.model.modelId });
		const contextWindow = settings
			? validateContextWindowReserve(requestedContextWindow, settings.reserveTokens, settings.enabled)
			: undefined;
		const gptModel = isGptModel({ id: request.model.modelId, name: request.model.name });
		const gptCompactionEnabled = readGptCompactionSettings().mode === "on" && gptModel;
		// Print processes reopen this call-private session, preserving completed tools.
		// It is never registered with the persistent broker or exposed as an alias.
		const ephemeralSessionDir = await mkdtemp(join(tmpdir(), "pi-rail-stateless-"));
		const ephemeralSessionPath = join(ephemeralSessionDir, "session.jsonl");
		const collector = new RunResultCollector(request.task, strictAssistantText);
		let updateTimer: NodeJS.Timeout | undefined;
		let aborted = false;
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
		const canResume = async () => {
			try {
				const session = await stat(ephemeralSessionPath);
				return session.isFile() && session.size > 0;
			} catch {
				return false;
			}
		};
		try {
			const args = ["--mode", "json", "-p", "--session", ephemeralSessionPath, "--model", railModelKey(request.model)];
			if (hasRailResponsesWebSocketRoute(request.model.provider, request.model.modelId)) args.push("-e", railResponsesWebSocketExtensionPath());
			if (gptCompactionEnabled) args.push("-e", gptCompactionExtensionPath());
			if (request.model.thinkingLevel) args.push("--thinking", request.model.thinkingLevel);
			if (gptModel && request.fastMode === true) args.push("-e", railFastExtensionPath(), `--${RAIL_FAST_MODE_FLAG}`);
			if (gptModel) args.push("-e", railOaiSearchExtensionPath(), `--${RAIL_OAI_SEARCH_MODE_FLAG}`, "live");
			args.push("--exclude-tools", "subagent");
			if (contextWindow !== undefined) {
				args.push(
					"-e", contextExtensionPath(),
					`--${CONTEXT_PROTOCOL_FLAG}`, CONTEXT_PROTOCOL_VERSION,
					`--${CONTEXT_WINDOW_FLAG}`, formatContextWindow(contextWindow),
				);
			}
			let prompt = `Task: ${request.task}`;
			let retryCount = 0;
			while (true) {
				if (request.signal?.aborted) {
					aborted = true;
					throw new Error("Subagent request was aborted");
				}
				const invocation = (options.resolveInvocation ?? resolvePiInvocation)([...args, prompt]);
				let stderr = "";
				let protocolErrorEvent: string | undefined;
				let malformedEvent = false;
				let nativeSettled = false;
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
					let killTimer: NodeJS.Timeout | undefined;
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
								if (event.type === "agent_settled") nativeSettled = true;
								const immediate = (event.type === "message_end" && isAssistantMessage(event.message)) || isSharedImmediateEvent(event.type);
								if (immediate) queueUpdate(true);
								else if (changed) queueUpdate(false);
							} catch {
								// Keep tolerant output, but do not continue an uncertain stream.
								malformedEvent = true;
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
					proc.once("error", (error) => collector.noteError(error.message));
					const abort = () => {
						aborted = true;
						proc.kill("SIGTERM");
						killTimer = setTimeout(() => proc.kill("SIGKILL"), 1500);
						killTimer.unref();
					};
					if (request.signal?.aborted) abort();
					else request.signal?.addEventListener("abort", abort, { once: true });
					// Even failed spawn emits close; never delete the session before reaping.
					proc.once("close", (code) => {
						request.signal?.removeEventListener("abort", abort);
						if (killTimer) clearTimeout(killTimer);
						resolve(code !== null && code >= 0 ? code : 1);
					});
				});
				if (updateTimer) clearTimeout(updateTimer);
				updateTimer = undefined;
				if (aborted || request.signal?.aborted) {
					aborted = true;
					throw new Error("Subagent request was aborted");
				}
				const protocolError = protocolErrorEvent ?? stderr.split(/\r?\n/u)
					.map((line) => line.trim())
					.find((line) => line.startsWith(CONTEXT_PROTOCOL_ERROR_PREFIX))
					?.slice(CONTEXT_PROTOCOL_ERROR_PREFIX.length).trim();
				if (protocolError) {
					const failure = `Subagent context protocol failed before the run started: ${protocolError}`;
					collector.noteError(failure);
					collector.setRetry(undefined);
					const { transcript: _transcript, ...collected } = collector.result(failure);
					return { ...collected, output: failure, exitCode, errorMessage: failure };
				}
				if (malformedEvent) collector.noteError("Subagent process emitted malformed JSON or message events");
				else if (exitCode === 0 && !nativeSettled) collector.noteError("Subagent process exited without native agent_settled");
				const retryError = exitCode === 0 ? collector.retryableError : undefined;
				if (retryError && retryCount < RETRY_DELAYS_MS.length) {
					if (!(await canResume())) {
						collector.noteError("Subagent retry cannot continue because its private session is missing or empty");
					} else {
						const delayMs = RETRY_DELAYS_MS[retryCount]!;
						collector.setRetry({ attempt: retryCount + 1, maxAttempts: RETRY_DELAYS_MS.length, nextAt: Date.now() + delayMs, error: retryError, source: "rail" }, retryCount);
						queueUpdate(true);
						await (options.waitForRetry ?? waitForRetry)(delayMs, request.signal);
						if (request.signal?.aborted) {
							aborted = true;
							throw new Error("Subagent request was aborted");
						}
						// Recheck after waiting: Pi otherwise recreates a missing file.
						if (await canResume()) {
							collector.beginAttempt();
							collector.setRetry(undefined, ++retryCount);
							prompt = retryContinuation(retryError);
							continue;
						}
						collector.noteError("Subagent retry cannot continue because its private session is missing or empty");
					}
				}
				collector.markSettled();
				collector.setRetry(undefined);
				const failure = collector.errorMessage ?? (exitCode === 0 ? undefined : stderr.trim() || `Subagent process exited with code ${exitCode}`);
				return { ...collector.result(failure || "(no output)"), exitCode, ...(failure ? { errorMessage: failure } : {}) };
			}
		} catch (error) {
			collector.setRetry(undefined);
			if (aborted || request.signal?.aborted) {
				collector.markAborted();
				publishUpdate();
				throw new Error("Subagent request was aborted");
			}
			if (collector.result("").retryCount) {
				collector.noteError(error instanceof Error ? error.message : String(error));
				publishUpdate();
			}
			throw error;
		} finally {
			if (updateTimer) clearTimeout(updateTimer);
			await rm(ephemeralSessionDir, { recursive: true, force: true });
		}
	};
}
