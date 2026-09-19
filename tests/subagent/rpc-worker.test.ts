import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { railFastExtensionPath, RAIL_FAST_MODE_FLAG } from "../../commands/rail-fast";
import { railOaiSearchExtensionPath, RAIL_OAI_SEARCH_MODE_FLAG } from "../../commands/rail-oai-search";
import { HOSTED_SEARCH_ENTRY_TYPE } from "../../openai/hosted-search-activity";
import {
	RpcSessionWorker,
	buildRpcWorkerArgs,
	type RpcEvent,
	type RpcTransport,
} from "../../tools/subagents/rpc-worker";
import { CONTEXT_PROTOCOL_ERROR_PREFIX, contextExtensionPath } from "../../tools/subagents/context-window";
import { gptCompactionExtensionPath } from "../../tools/gpt-compaction/extension";
import type { RailModelRef } from "../../tools/subagents/models";
import type { WorkerStartSpec } from "../../tools/subagents/session-broker";

class FakeTransport implements RpcTransport {
	readonly commands: Array<Record<string, unknown>> = [];
	readonly listeners = new Set<(event: RpcEvent) => void>();
	stopped = false;
	failClearQueue = false;
	failContextCommand = false;
	failResetCommand = false;
	includeContextCommand = true;
	contextWindowAfterReset: number | undefined;
	clearQueueGate: Promise<void> | undefined;

	constructor(
		private readonly failPrompt = false,
		private sessionName?: string,
		private readonly waitForAbort = false,
		private readonly failControl = false,
	) {}
	private selectedModel = { provider: "cus-resp", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", contextWindow: 128000 };
	private contextWindow = 128000;
	private restoreContextWindow = 128000;
	setContextWindow(value: number): void { this.contextWindow = value; this.restoreContextWindow = value; }
	private thinkingLevel = "xhigh";

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async request(command: Record<string, unknown>): Promise<unknown> {
		this.commands.push(command);
		if (command["type"] === "get_state") {
			return { sessionId: "child-session", sessionFile: "/tmp/child.jsonl", sessionName: this.sessionName, isStreaming: false, isCompacting: false, model: { ...this.selectedModel, contextWindow: this.contextWindow }, thinkingLevel: this.thinkingLevel };
		}
		if (command["type"] === "get_commands") {
			return { commands: this.includeContextCommand ? [{ name: "rail-context-internal-v1", source: "extension", description: "Rail private context protocol v1" }] : [] };
		}
		if (command["type"] === "set_session_name") {
			this.sessionName = command["name"] as string;
			return undefined;
		}
		if (command["type"] === "set_model") {
			this.selectedModel = { provider: String(command["provider"]), id: String(command["modelId"]), name: String(command["modelId"]), contextWindow: 128000 };
			this.contextWindow = 128000;
			this.restoreContextWindow = 128000;
			return this.selectedModel;
		}
		if (command["type"] === "set_thinking_level") {
			this.thinkingLevel = String(command["level"]);
			return undefined;
		}
		if (command["type"] === "clear_queue") {
			if (this.failClearQueue) throw new Error("clear queue failed");
			await this.clearQueueGate;
			return { steering: [], followUp: [] };
		}
		if (command["type"] === "abort" && this.waitForAbort) {
			queueMicrotask(() => this.emit({ type: "agent_settled" }));
			return undefined;
		}
		if (command["type"] === "steer" || command["type"] === "follow_up") {
			if (this.failControl) throw new Error("connection lost after write");
			return undefined;
		}
		if (command["type"] === "prompt") {
			if (String(command["message"]).startsWith("/rail-context-internal-v1 ")) {
				if (this.failContextCommand) {
					this.emit({ type: "extension_error", error: `${CONTEXT_PROTOCOL_ERROR_PREFIX}context command failed` });
					return undefined;
				}
				const parts = String(command["message"]).trim().split(/\s+/u);
				if (parts[1] === "prepare" && parts[2] !== "omit") {
					this.restoreContextWindow = this.contextWindow;
					this.contextWindow = Number(parts[2]);
				} else if (parts[1] === "reset") {
					this.contextWindow = this.contextWindowAfterReset ?? this.restoreContextWindow;
				} else {
					this.contextWindow = this.restoreContextWindow;
				}
				if (parts[1] === "reset" && this.failResetCommand) {
					this.contextWindow = 999;
					return undefined;
				}
				if (parts[1] === "reset" && this.contextWindowAfterReset !== undefined) this.contextWindow = this.contextWindowAfterReset;
				return undefined;
			}
			this.emit({ type: "agent_start" });
			if (this.waitForAbort) return undefined;
			queueMicrotask(() => {
				if (this.failPrompt) {
					this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
					this.emit({
						type: "message_update",
						usage: { input: 7, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 10, cost: { total: 0.01 } },
						assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "before crash" },
					});
					this.emit({ type: "transport_error", error: "child crashed" });
					return;
				}
				this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
				this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspect auth" } });
				this.emit({
					type: "message_update",
					assistantMessageEvent: {
						type: "toolcall_end",
						contentIndex: 1,
						toolCall: { type: "toolCall", id: "call-auth", name: "read", arguments: { path: "auth.ts" } },
					},
				});
				this.emit({
					type: "message_end",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Inspect auth" },
							{ type: "toolCall", id: "call-auth", name: "read", arguments: { path: "auth.ts" } },
						],
						stopReason: "toolUse",
					},
				});
				this.emit({ type: "tool_execution_start", toolCallId: "call-auth", toolName: "read", args: { path: "auth.ts" } });
				this.emit({
					type: "tool_execution_update",
					toolCallId: "call-auth",
					toolName: "read",
					partialResult: { content: [{ type: "text", text: "partial auth" }] },
				});
				this.emit({
					type: "tool_execution_end",
					toolCallId: "call-auth",
					toolName: "read",
					result: { content: [{ type: "text", text: "auth source" }] },
					isError: false,
				});
				this.emit({
					type: "message_end",
					message: { role: "toolResult", toolCallId: "call-auth", toolName: "read", content: [{ type: "text", text: "auth source" }], isError: false },
				});
				this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
				this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "review complete" } });
				this.emit({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "review complete" }],
						usage: {
							input: 100,
							output: 20,
							cacheRead: 40,
							cacheWrite: 0,
							totalTokens: 160,
							cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
						},
						stopReason: "stop",
					},
				});
				this.contextWindow = this.restoreContextWindow;
				this.emit({ type: "agent_settled" });
			});
		}
		return undefined;
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}

	emit(event: RpcEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

function isContextPrompt(command: Record<string, unknown>): boolean {
	return command["type"] === "prompt" && String(command["message"] ?? "").startsWith("/rail-context-internal-v1 ");
}

function model(): RailModelRef {
	return { provider: "cus-resp", modelId: "gpt-5.6-sol", thinkingLevel: "xhigh" };
}

function spec(mode: WorkerStartSpec["mode"], sessionPath?: string): WorkerStartSpec {
	return {
		agentId: "agt_auth",
		mode,
		model: model(),
		alias: "auth-review",
		sessionName: "subagent · Main Auth Work · auth-review",
		cwd: "/tmp/project",
		...(sessionPath ? { sessionPath } : {}),
	};
}

function hostedSearchEntryEvent(id: string, callIds: string[]): RpcEvent {
	return {
		type: "entry_appended",
		entry: {
			id,
			type: "custom",
			customType: HOSTED_SEARCH_ENTRY_TYPE,
			data: {
				version: 1,
				responseId: `resp_${id}`,
				provider: "cus-resp",
				model: "gpt-5.6-sol",
				phase: "completed",
				startedAt: 1000,
				endedAt: 2000,
				calls: callIds.map((callId) => ({ id: callId, status: "completed", type: "search", query: callId })),
				sources: [],
			},
		},
	};
}

describe("RPC worker arguments", () => {
	test("starts a forked child session with the selected Pi model", () => {
		assert.deepEqual(buildRpcWorkerArgs(spec("fork", "/tmp/source.jsonl")), [
			"--mode", "rpc",
			"--fork", "/tmp/source.jsonl",
			"--name", "subagent · Main Auth Work · auth-review",
			"--model", "cus-resp/gpt-5.6-sol",
			"--thinking", "xhigh",
			"--exclude-tools", "subagent",
			"-e", railOaiSearchExtensionPath(), `--${RAIL_OAI_SEARCH_MODE_FLAG}`, "live",
			"-e", gptCompactionExtensionPath(),
			"-e", contextExtensionPath(), "--rail-context-protocol", "1",
		]);
	});

	test("every persistent worker starts the standalone search extension in live mode", () => {
		const assertLiveSearch = (args: string[]) => {
			const extensionIndex = args.indexOf(railOaiSearchExtensionPath());
			assert.notEqual(extensionIndex, -1);
			assert.deepEqual(args.slice(extensionIndex - 1, extensionIndex + 3), [
				"-e", railOaiSearchExtensionPath(), `--${RAIL_OAI_SEARCH_MODE_FLAG}`, "live",
			]);
			assert.equal(args.filter((arg) => arg === railOaiSearchExtensionPath()).length, 1);
			assert.equal(args.filter((arg) => arg === `--${RAIL_OAI_SEARCH_MODE_FLAG}`).length, 1);
		};
		assertLiveSearch(buildRpcWorkerArgs(spec("new")));
		assertLiveSearch(buildRpcWorkerArgs(spec("fork", "/tmp/source.jsonl")));
		assertLiveSearch(buildRpcWorkerArgs(spec("open", "/tmp/child.jsonl")));
		assertLiveSearch(buildRpcWorkerArgs(spec("exclusive", "/tmp/source.jsonl")));
		assertLiveSearch(buildRpcWorkerArgs({ ...spec("new"), fastMode: true } as any));
		assertLiveSearch(buildRpcWorkerArgs({ ...spec("new"), fastMode: false } as any));
	});

	test("adds the private fast flag to new and resumed workers when enabled", () => {
		const created = buildRpcWorkerArgs({ ...spec("new"), fastMode: true } as any);
		const resumed = buildRpcWorkerArgs({ ...spec("open", "/tmp/child.jsonl"), fastMode: true } as any);
		const ordinary = buildRpcWorkerArgs({ ...spec("new"), fastMode: false } as any);
		assert.equal(created.includes(`--${RAIL_FAST_MODE_FLAG}`), true);
		assert.equal(created.includes(railFastExtensionPath()), true);
		assert.equal(resumed.includes(`--${RAIL_FAST_MODE_FLAG}`), true);
		assert.equal(resumed.includes(railFastExtensionPath()), true);
		assert.equal(ordinary.includes(`--${RAIL_FAST_MODE_FLAG}`), false);
		assert.equal(ordinary.includes(railFastExtensionPath()), false);
	});

	test("opens a managed child session instead of forking it again", () => {
		const args = buildRpcWorkerArgs(spec("open", "/tmp/child.jsonl"));
		assert.deepEqual(args.slice(0, 4), ["--mode", "rpc", "--session", "/tmp/child.jsonl"]);
		assert.equal(args.includes("--fork"), false);
		assert.equal(args.includes("--name"), false);
	});

	test("names an exclusively adopted session as a managed subagent", () => {
		const args = buildRpcWorkerArgs(spec("exclusive", "/tmp/source.jsonl"));
		assert.deepEqual(args.slice(0, 6), [
			"--mode", "rpc",
			"--session", "/tmp/source.jsonl",
			"--name", "subagent · Main Auth Work · auth-review",
		]);
	});
});

describe("RpcSessionWorker", () => {
	test("renames a legacy managed session when it is next opened", async () => {
		const transport = new FakeTransport(false, "auth-review");
		const worker = await RpcSessionWorker.connect(spec("open", "/tmp/child.jsonl"), transport);

		assert.deepEqual(transport.commands.map((command) => command["type"]), ["get_state", "get_commands", "set_session_name"]);
		assert.equal(transport.commands[2]?.["name"], "subagent · Main Auth Work · auth-review");
		await worker.stop();
	});

	test("changes the child model and thinking level through RPC", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const selected = await worker.setModel({ provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" });

		assert.deepEqual(selected, { provider: "deepseek", modelId: "deepseek-v4-flash", name: "deepseek-v4-flash", thinkingLevel: "high" });
		assert.deepEqual(transport.commands.slice(2).map((command) => command["type"]), ["get_state", "set_model", "set_thinking_level", "get_state"]);
	});

	test("maps child controls to Pi steer and follow_up RPC commands", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);

		await worker.control({ delivery: "steer", message: "Focus on tests" });
		await worker.control({ delivery: "followUp", message: "Then summarize risks" });

		assert.deepEqual(transport.commands.slice(2), [
			{ type: "steer", message: "Focus on tests" },
			{ type: "follow_up", message: "Then summarize risks" },
		]);
	});

	test("prepares explicit and omitted budgets through private handled commands", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		await worker.send("explicit budget", { contextWindow: 64000 });
		const beforeOmitted = transport.commands.length;
		await worker.send("omitted budget");

		const privatePrompts = transport.commands
			.filter((command) => command["type"] === "prompt" && isContextPrompt(command))
			.map((command) => command["message"]);
		assert.deepEqual(privatePrompts, [
			"/rail-context-internal-v1 prepare 64000",
			"/rail-context-internal-v1 reset",
		]);
		assert.deepEqual(transport.commands.slice(beforeOmitted).map((command) => command["type"]), ["prompt"]);
		assert.equal(worker.isReusable(), true);
	});

	test("rejects overlapping runs while the first budget is being prepared", async () => {
		const transport = new FakeTransport();
		const request = transport.request.bind(transport);
		const gate = Promise.withResolvers<void>();
		transport.request = async (command) => {
			if (isContextPrompt(command) && String(command["message"]).includes(" prepare ")) await gate.promise;
			return request(command);
		};
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const first = worker.send("first", { contextWindow: 64000 });
		await new Promise((resolve) => setImmediate(resolve));
		await assert.rejects(() => worker.send("second", { contextWindow: 64000 }), /overlapping/);
		gate.resolve();
		await first;
	});

	test("rejects a budget at or below the effective reserve before sending a private command", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		await assert.rejects(() => worker.send("too small", { contextWindow: 1 }), /reserveTokens/);
		assert.equal(transport.commands.some((command) => command["type"] === "prompt"), false);
		assert.equal(worker.isReusable(), true);
	});

	test("retires a worker when reset confirmation fails", async () => {
		const transport = new FakeTransport();
		transport.failResetCommand = true;
		const worker = await RpcSessionWorker.connect(spec("new"), transport);

		await assert.rejects(() => worker.send("cleanup failure", { contextWindow: 64000 }), /confirmation failed/);
		assert.equal(worker.isReusable(), false);
	});

	test("keeps an observed current-model refresh as the native omitted default", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		await worker.send("before refresh");
		transport.setContextWindow(1_050_000);

		await worker.send("after refresh");
		assert.equal(worker.isReusable(), true);
	});

	test("requires the versioned private context command at startup", async () => {
		const transport = new FakeTransport();
		transport.includeContextCommand = false;
		await assert.rejects(() => RpcSessionWorker.connect(spec("new"), transport), /missing.*context adapter/);
		assert.equal(transport.stopped, true);
	});

	test("a handled prompt without a run fails without opening control admission", async () => {
		const transport = new FakeTransport();
		const request = transport.request.bind(transport);
		transport.request = async (command) => command["type"] === "prompt" && !isContextPrompt(command) ? undefined : request(command);
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		let accepted = false;
		const pending = worker.send("/handled-command", { onAccepted: () => { accepted = true; } });
		const outcome = await Promise.race([
			pending.then(() => "completed", (error: Error) => error.message),
			new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 40)),
		]);
		transport.emit({ type: "transport_error", error: "test cleanup" });
		await pending.catch(() => undefined);
		assert.match(outcome, /handled without starting/);
		assert.equal(accepted, false);
		assert.equal(transport.listeners.size, 0);
	});

	test("rejects a handled compaction-only prompt without admitting a run", async () => {
		const transport = new FakeTransport();
		const request = transport.request.bind(transport);
		let connected = false;
		let handled = false;
		transport.request = async (command) => {
			if (isContextPrompt(command) && String(command["message"]).endsWith(" reset")) handled = false;
			if (command["type"] === "prompt" && !isContextPrompt(command)) {
				handled = true;
				return undefined;
			}
			if (command["type"] === "get_state" && connected && handled) {
				return { ...(await request(command) as any), isStreaming: false, isCompacting: true };
			}
			return request(command);
		};
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		connected = true;
		let accepted = false;
		const pending = worker.send("/manual-compaction-only", { onAccepted: () => { accepted = true; } });
		const outcomePromise = pending.then(() => "settled", (error: Error) => error.message);
		await new Promise((resolve) => setImmediate(resolve));
		transport.emit({ type: "compaction_start", reason: "manual" });
		transport.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, errorMessage: "Compaction failed" });
		const outcome = await Promise.race([
			outcomePromise,
			new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 40)),
		]);
		if (outcome === "still-pending") {
			transport.emit({ type: "transport_error", error: "test cleanup" });
			await pending.catch(() => undefined);
		}
		assert.match(outcome, /handled without starting/);
		assert.equal(accepted, false);
		assert.equal(transport.listeners.size, 0);
	});

	test("publishes compaction as a running subphase without settling the child run", async () => {
		const transport = new FakeTransport(false, undefined, true);
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const updates: any[] = [];
		const pending = worker.send("compact child", { onUpdate: (update) => updates.push(update) });
		await new Promise((resolve) => setImmediate(resolve));

		transport.emit({ type: "compaction_start", reason: "threshold" });
		assert.equal(updates.at(-1)?.isCompacting, true);
		transport.emit({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 5, errorMessage: "temporary" });
		assert.equal(updates.at(-1)?.isCompacting, true);
		transport.emit({ type: "compaction_end", reason: "threshold", result: { summary: "PRIVATE MODEL SUMMARY" }, aborted: false, willRetry: true });
		assert.equal(updates.at(-1)?.isCompacting, undefined);
		assert.equal(updates.at(-1)?.output, "(running...)");
		let finished = false;
		void pending.then(() => { finished = true; });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(finished, false);
		transport.emit({ type: "agent_settled" });
		const result = await pending;
		assert.equal(result.isCompacting, undefined);
		assert.doesNotMatch(JSON.stringify(updates), /PRIVATE MODEL SUMMARY/);
	});

	test("clears compaction on transport failure and local abort", async () => {
		const transport = new FakeTransport(false, undefined, true);
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const updates: any[] = [];
		const pending = worker.send("transport failure", { onUpdate: (update) => updates.push(update) });
		await new Promise((resolve) => setImmediate(resolve));
		transport.emit({ type: "compaction_start", reason: "threshold" });
		transport.emit({ type: "transport_error", error: "child transport failed" });
		await assert.rejects(pending, /child transport failed/);
		assert.equal(updates.at(-1)?.isCompacting, undefined);

		const abortedTransport = new FakeTransport(false, undefined, true);
		const abortedWorker = await RpcSessionWorker.connect(spec("new"), abortedTransport);
		const controller = new AbortController();
		const abortedUpdates: any[] = [];
		const aborted = abortedWorker.send("abort during compaction", {
			signal: controller.signal,
			onUpdate: (update) => abortedUpdates.push(update),
		});
		await new Promise((resolve) => setImmediate(resolve));
		abortedTransport.emit({ type: "compaction_start", reason: "threshold" });
		controller.abort();
		const result = await aborted;
		assert.equal(result.stopReason, "aborted");
		assert.equal(result.isCompacting, undefined);
		assert.equal(abortedUpdates.at(-1)?.isCompacting, undefined);
	});

	test("classifies a lost control acknowledgement as unknown delivery", async () => {
		const transport = new FakeTransport(false, undefined, false, true);
		const worker = await RpcSessionWorker.connect(spec("new"), transport);

		await assert.rejects(
			() => worker.control({ delivery: "steer", message: "Focus on tests" }),
			/outcome is unknown.*connection lost after write/,
		);
	});

	test("a running prompt waits for settlement even when its start event is delayed", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const accepted = Promise.withResolvers<void>();
		let taskStarted = false;
		let taskSettled = false;
		const request = transport.request.bind(transport);
		transport.request = async (command) => {
			if (command["type"] === "prompt" && !isContextPrompt(command)) {
				taskStarted = true;
				return undefined;
			}
			if (command["type"] === "get_state") return taskStarted && !taskSettled
				? { isStreaming: true, model: { provider: "cus-resp", id: "gpt-5.6-sol", contextWindow: 128000 } }
				: request(command);
			return request(command);
		};
		const phaseUnsubscribe = transport.onEvent((event) => { if (event.type === "agent_settled") taskSettled = true; });
		let finished = false;
		const pending = worker.send("normal task", { onAccepted: () => accepted.resolve() }).then((result) => {
			finished = true;
			return result;
		});
		await accepted.promise;
		assert.equal(finished, false);
		transport.emit({ type: "agent_start" });
		transport.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
		transport.emit({ type: "agent_settled" });
		assert.equal((await pending).output, "done");
		phaseUnsubscribe();
		assert.equal(transport.listeners.size, 0);
	});

	test("classifies a locally aborted RPC run even when the child settles normally", async () => {
		const transport = new FakeTransport(false, undefined, true);
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const controller = new AbortController();
		const pending = worker.send("long task", { signal: controller.signal });
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();

		const result = await pending;
		assert.equal(result.stopReason, "aborted");
		assert.equal(result.errorMessage, "Subagent request was aborted");
		assert.deepEqual(transport.commands.filter((command) => command["type"] === "clear_queue" || command["type"] === "abort").map((command) => command["type"]), ["clear_queue", "abort"]);
	});

	test("still aborts when clearing the child queue fails", async () => {
		const transport = new FakeTransport(false, undefined, true);
		transport.failClearQueue = true;
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const controller = new AbortController();
		const pending = worker.send("long task", { signal: controller.signal });
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();

		const result = await pending;
		assert.equal(result.stopReason, "aborted");
		assert.deepEqual(transport.commands.filter((command) => command["type"] === "clear_queue" || command["type"] === "abort").map((command) => command["type"]), ["clear_queue", "abort"]);
	});

	test("waits for the abort command chain after the child settles", async () => {
		const transport = new FakeTransport(false, undefined, true);
		let releaseClearQueue!: () => void;
		transport.clearQueueGate = new Promise<void>((resolve) => { releaseClearQueue = resolve; });
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const controller = new AbortController();
		let finished = false;
		const pending = worker.send("long task", { signal: controller.signal }).then((result) => {
			finished = true;
			return result;
		});
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		transport.emit({ type: "agent_settled" });
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(finished, false);
		releaseClearQueue();
		const result = await pending;
		assert.equal(result.stopReason, "aborted");
		assert.deepEqual(transport.commands.filter((command) => command["type"] === "clear_queue" || command["type"] === "abort").map((command) => command["type"]), ["clear_queue", "abort"]);
	});

	test("keeps the child session and returns the settled assistant output", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const updates: any[] = [];

		const result = await worker.send("review auth", { onUpdate: (update) => updates.push(update) });

		assert.equal(worker.sessionId, "child-session");
		assert.equal(worker.sessionFile, "/tmp/child.jsonl");
		assert.deepEqual(transport.commands.map((command) => command["type"]), ["get_state", "get_commands", "prompt"]);
		assert.equal(result.output, "review complete");
		assert.deepEqual(result.transcript?.entries.map((entry) => entry.kind), [
			"user",
			"thinking",
			"tool",
			"toolResult",
			"assistant",
		]);
		assert.equal(updates.some((update) => update.transcript?.entries.some((entry: any) => entry.kind === "toolResult")), true);
		assert.deepEqual(result.usage, {
			input: 100,
			output: 20,
			cacheRead: 40,
			cacheWrite: 0,
			cost: 0.31,
			contextTokens: 160,
			turns: 1,
		});
		await worker.stop();
		assert.equal(transport.stopped, true);
	});

	test("counts hosted search entries in streamed and final usage", async () => {
		const transport = new FakeTransport(false, undefined, true);
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const updates: any[] = [];
		const pending = worker.send("search child", { onUpdate: (update) => updates.push(update) });
		await new Promise((resolve) => setImmediate(resolve));

		transport.emit({ type: "agent_start" });
		transport.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "searching" }], usage: { input: 4, output: 2, totalTokens: 6, cost: { total: 0.01 } }, stopReason: "stop" },
		});
		transport.emit(hostedSearchEntryEvent("search-1", ["ws_1", "ws_2"]));
		transport.emit(hostedSearchEntryEvent("search-1", ["ws_1", "ws_2"]));
		transport.emit(hostedSearchEntryEvent("search-2", ["ws_3"]));
		await new Promise((resolve) => setImmediate(resolve));
		transport.emit({ type: "agent_settled" });

		const result = await pending;
		assert.equal(result.output, "searching");
		assert.deepEqual(result.usage, {
			input: 4,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			contextTokens: 6,
			turns: 1,
			searches: 3,
		});
		assert.equal(updates.some((update) => update.usage.searches === 3), true);
		assert.equal(updates.every((update) => (update.usage.searches ?? 0) <= 3), true);
		await worker.stop();
	});

	test("rejects a run when the child exits after accepting the prompt", async () => {
		const transport = new FakeTransport(true);
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const updates: any[] = [];

		await assert.rejects(() => worker.send("review auth", { onUpdate: (update) => updates.push(update) }), /child crashed/);
		assert.equal(updates.at(-1)?.transcript.entries.at(-1).text, "before crash");
		assert.deepEqual(updates.at(-1)?.usage, {
			input: 7,
			output: 1,
			cacheRead: 2,
			cacheWrite: 0,
			cost: 0.01,
			contextTokens: 10,
			turns: 1,
		});
		await worker.stop();
	});

	test("flushes a live update on every message_end, including tool results", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const updates: any[] = [];
		let taskStarted = false;
		let taskSettled = false;
		const request = transport.request.bind(transport);
		transport.request = async (command) => {
			if (command["type"] === "prompt" && !isContextPrompt(command)) {
				taskStarted = true;
				return undefined;
			}
			if (command["type"] === "get_state") return taskStarted && !taskSettled
				? { isStreaming: true, model: { provider: "cus-resp", id: "gpt-5.6-sol", contextWindow: 128000 } }
				: request(command);
			return request(command);
		};
		const phaseUnsubscribe = transport.onEvent((event) => { if (event.type === "agent_settled") taskSettled = true; });
		const pending = worker.send("review auth", { onUpdate: (update) => updates.push(update) });
		await new Promise((resolve) => setImmediate(resolve));

		transport.emit({ type: "agent_start" });
		transport.emit({
			type: "message_end",
			message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "auth source" }], isError: false },
		});
		assert.equal(updates.length, 1);
		assert.equal(updates.at(-1)?.output, "(running...)");
		assert.equal(updates.at(-1)?.transcript.entries.at(-1).kind, "toolResult");

		transport.emit({ type: "agent_settled" });
		const result = await pending;
		assert.equal(result.output, "(no output)");
		phaseUnsubscribe();
	});

	test("publishes no updates after the run settles", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const updates: any[] = [];
		await worker.send("review auth", { onUpdate: (update) => updates.push(update) });
		const settledCount = updates.length;

		transport.emit({ type: "agent_start" });
		transport.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }], stopReason: "stop" } });
		transport.emit({ type: "agent_settled" });

		assert.equal(updates.length, settledCount);
		assert.equal(transport.listeners.size, 0);
	});

	test("tolerates malformed content parts in RPC message_end events", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const updates: any[] = [];
		let taskStarted = false;
		let taskSettled = false;
		const request = transport.request.bind(transport);
		transport.request = async (command) => {
			if (command["type"] === "prompt" && !isContextPrompt(command)) {
				taskStarted = true;
				return undefined;
			}
			if (command["type"] === "get_state") return taskStarted && !taskSettled
				? { isStreaming: true, model: { provider: "cus-resp", id: "gpt-5.6-sol", contextWindow: 128000 } }
				: request(command);
			return request(command);
		};
		const phaseUnsubscribe = transport.onEvent((event) => { if (event.type === "agent_settled") taskSettled = true; });
		const pending = worker.send("review auth", { onUpdate: (update) => updates.push(update) });
		await new Promise((resolve) => setImmediate(resolve));

		transport.emit({ type: "agent_start" });
		transport.emit({
			type: "message_end",
			message: { role: "assistant", content: [null, { type: "text", text: "done" }], usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { total: 0.02 } }, stopReason: "stop" },
		});
		assert.equal(updates.length, 1);
		assert.equal(updates.at(-1)?.output, "done");

		transport.emit({ type: "agent_settled" });
		const result = await pending;
		assert.equal(result.output, "done");
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.usage, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 11, turns: 1 });
		phaseUnsubscribe();
	});
});
