import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents";
import { resolvePiInvocation, type PiInvocation } from "./pi-invocation";
import type { SubagentUsage, WorkerRunResult } from "./session-broker";

const STDERR_CAP = 50 * 1024;

export interface StatelessRunRequest {
	profile: AgentConfig;
	task: string;
	cwd: string;
	defaultModel?: string;
	defaultThinkingLevel?: NonNullable<ExtensionContext["thinkingLevel"]>;
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

function emptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
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

function addUsage(total: SubagentUsage, message: JsonAssistantMessage): void {
	if (message?.role !== "assistant" || !message.usage) return;
	const usage = message.usage;
	total.input += usage.input ?? 0;
	total.output += usage.output ?? 0;
	total.cacheRead += usage.cacheRead ?? 0;
	total.cacheWrite += usage.cacheWrite ?? 0;
	total.cost += usage.cost?.total ?? 0;
	total.contextTokens = usage.totalTokens ?? total.contextTokens;
	total.turns++;
}

export function createStatelessAgentRunner(options: StatelessAgentRunnerOptions = {}): StatelessAgentRunner {
	return async (request) => {
		if (!request.task.trim()) throw new Error("Subagent task cannot be empty");
		if (request.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
		const args = ["--mode", "json", "-p", "--no-session"];
		const inheritsModel = !request.profile.model;
		const model = request.profile.model ?? request.defaultModel;
		if (model) args.push("--model", model);
		if (inheritsModel && request.defaultThinkingLevel) args.push("--thinking", request.defaultThinkingLevel);
		if (request.profile.tools?.length) args.push("--tools", request.profile.tools.join(","));
		args.push("--exclude-tools", "subagent");

		let promptDir: string | undefined;
		if (request.profile.systemPrompt.trim()) {
			promptDir = await mkdtemp(join(tmpdir(), "pi-stateless-subagent-"));
			const promptPath = join(promptDir, "system.md");
			await writeFile(promptPath, request.profile.systemPrompt, { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptPath);
		}
		args.push(`Task: ${request.task}`);

		const invocation = (options.resolveInvocation ?? resolvePiInvocation)(args);
		const usage = emptyUsage();
		let output = "";
		let stderr = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let aborted = false;
		let killTimer: NodeJS.Timeout | undefined;
		try {
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
							const event = JSON.parse(line) as { type?: string; message?: JsonAssistantMessage };
							if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
							const text = assistantText(event.message);
							if (text) output = text;
							addUsage(usage, event.message);
							stopReason = event.message.stopReason;
							errorMessage = event.message.errorMessage;
							request.onUpdate?.({
								output: output || "(running...)",
								exitCode: 0,
								usage: { ...usage },
								...(stopReason ? { stopReason } : {}),
								...(errorMessage ? { errorMessage } : {}),
							});
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
			if (aborted) throw new Error("Subagent request was aborted");
			const failure = errorMessage ?? (exitCode === 0 ? undefined : stderr.trim() || `Subagent process exited with code ${exitCode}`);
			return {
				output: output || (failure ? failure : "(no output)"),
				exitCode,
				usage,
				...(stopReason ? { stopReason } : {}),
				...(failure ? { errorMessage: failure } : {}),
			};
		} finally {
			if (promptDir) await rm(promptDir, { recursive: true, force: true });
		}
	};
}