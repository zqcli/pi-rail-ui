import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { railModelKey, type RailModelRef } from "./models";
import { resolvePiInvocation, type PiInvocation } from "./pi-invocation";
import type { SubagentUsage, WorkerRunResult } from "./session-broker";
import { SubagentTranscript } from "./transcript";
import { addCompletedAssistantUsage, emptySubagentUsage, providerReportedUsage, usageWithActiveTurn } from "./usage";

const STDERR_CAP = 50 * 1024;

export interface StatelessRunRequest {
	model: RailModelRef;
	task: string;
	cwd: string;
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

interface JsonAssistantMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	stopReason?: string;
	errorMessage?: string;
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const value = message as { role?: string; content?: Array<{ type?: string; text?: string }> };
	if (value.role !== "assistant" || !Array.isArray(value.content)) return "";
	return value.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text!)
		.join("\n");
}

export function createStatelessAgentRunner(options: StatelessAgentRunnerOptions = {}): StatelessAgentRunner {
	return async (request) => {
		if (!request.task.trim()) throw new Error("Subagent task cannot be empty");
		if (request.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
		const args = ["--mode", "json", "-p", "--no-session", "--model", railModelKey(request.model)];
		if (request.model.thinkingLevel) args.push("--thinking", request.model.thinkingLevel);
		args.push("--exclude-tools", "subagent");
		args.push(`Task: ${request.task}`);

		const invocation = (options.resolveInvocation ?? resolvePiInvocation)(args);
		const usage = emptySubagentUsage();
		let activeUsage: SubagentUsage | undefined;
		let output = "";
		let stderr = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let aborted = false;
		let killTimer: NodeJS.Timeout | undefined;
		let updateTimer: NodeJS.Timeout | undefined;
		const transcript = new SubagentTranscript(request.task);
		const publishUpdate = () => {
			updateTimer = undefined;
			request.onUpdate?.({
				output: output || "(running...)",
				exitCode: 0,
				usage: usageWithActiveTurn(usage, activeUsage),
				transcript: transcript.snapshot(),
				...(stopReason ? { stopReason } : {}),
				...(errorMessage ? { errorMessage } : {}),
			});
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
							const event = JSON.parse(line) as { type?: string; message?: JsonAssistantMessage; usage?: unknown };
							const transcriptChanged = transcript.ingest(event);
							if (event.type === "message_update") {
								const reported = providerReportedUsage(event.usage);
								if (reported) activeUsage = reported;
							}
							if (event.type === "message_end" && event.message?.role === "assistant") {
								const text = assistantText(event.message);
								if (text) output = text;
								addCompletedAssistantUsage(usage, event.message);
								activeUsage = undefined;
								stopReason = event.message.stopReason;
								errorMessage = event.message.errorMessage;
								queueUpdate(true);
							} else if (transcriptChanged || (event.type === "message_update" && activeUsage !== undefined)) {
								queueUpdate(event.type === "tool_execution_start" || event.type === "tool_execution_end");
							}
						} catch {
							// Ignore non-JSON diagnostic output on stdout.
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
					errorMessage = error.message;
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
		if (aborted) {
			stopReason = "aborted";
			errorMessage = "Subagent request was aborted";
			publishUpdate();
			throw new Error("Subagent request was aborted");
		}
		const failure = errorMessage ?? (exitCode === 0 ? undefined : stderr.trim() || `Subagent process exited with code ${exitCode}`);
		return {
			output: output || (failure ? failure : "(no output)"),
			exitCode,
			usage: usageWithActiveTurn(usage, activeUsage),
			transcript: transcript.snapshot(),
			...(stopReason ? { stopReason } : {}),
			...(failure ? { errorMessage: failure } : {}),
		};
	};
}