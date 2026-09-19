import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { railFastExtensionPath, RAIL_FAST_MODE_FLAG } from "../../commands/rail-fast";
import { railOaiSearchExtensionPath, RAIL_OAI_SEARCH_MODE_FLAG } from "../../commands/rail-oai-search";
import { CONTEXT_PROTOCOL_ERROR_PREFIX, CONTEXT_PROTOCOL_FLAG, CONTEXT_PROTOCOL_VERSION, CONTEXT_WINDOW_FLAG, contextExtensionPath, formatContextWindow, readContextProtocolError, validateContextWindowReserve } from "./context-window";
import { gptCompactionExtensionPath } from "../gpt-compaction/extension";
import { isGptModelName } from "../gpt-compaction/model-eligibility";
import { readGptCompactionSettings } from "../gpt-compaction/settings";
import { railModelKey, type RailModelRef } from "./models";
import { resolvePiInvocation, type PiInvocation } from "./pi-invocation";
import type { WorkerRunResult } from "./session-broker";
import { isAssistantMessage, isSharedImmediateEvent, RunResultCollector, strictAssistantText, type SubagentRunEvent } from "./run-result";

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
		const gptModel = isGptModelName(request.model.modelId) || isGptModelName(request.model.name);
		const gptCompactionEnabled = readGptCompactionSettings().mode === "on" && gptModel;
		const ephemeralSessionDir = gptCompactionEnabled ? await mkdtemp(join(tmpdir(), "pi-rail-stateless-compaction-")) : undefined;
		const ephemeralSessionPath = ephemeralSessionDir ? join(ephemeralSessionDir, "session.jsonl") : undefined;
		const args = ["--mode", "json", "-p", ...(ephemeralSessionPath ? ["--session", ephemeralSessionPath] : ["--no-session"]), "--model", railModelKey(request.model)];
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
		args.push(`Task: ${request.task}`);

		let invocation: PiInvocation;
		try {
			invocation = (options.resolveInvocation ?? resolvePiInvocation)(args);
		} catch (error) {
			if (ephemeralSessionDir) await rm(ephemeralSessionDir, { recursive: true, force: true });
			throw error;
		}
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
		let exitCode: number;
		try {
			exitCode = await new Promise<number>((resolve) => {
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
							const immediate = (event.type === "message_end" && isAssistantMessage(event.message)) || isSharedImmediateEvent(event.type);
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
		} finally {
			if (ephemeralSessionDir) await rm(ephemeralSessionDir, { recursive: true, force: true });
		}
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