import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	RpcSessionWorker,
	buildRpcWorkerArgs,
	type RpcEvent,
	type RpcTransport,
} from "../../tools/subagents/rpc-worker";
import type { RailModelRef } from "../../tools/subagents/models";
import type { WorkerStartSpec } from "../../tools/subagents/session-broker";

class FakeTransport implements RpcTransport {
	readonly commands: Array<Record<string, unknown>> = [];
	readonly listeners = new Set<(event: RpcEvent) => void>();
	stopped = false;
	failClearQueue = false;
	clearQueueGate: Promise<void> | undefined;

	constructor(
		private readonly failPrompt = false,
		private sessionName?: string,
		private readonly waitForAbort = false,
		private readonly failControl = false,
	) {}
	private selectedModel = { provider: "cus-resp", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" };
	private thinkingLevel = "xhigh";

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async request(command: Record<string, unknown>): Promise<unknown> {
		this.commands.push(command);
		if (command["type"] === "get_state") {
			return { sessionId: "child-session", sessionFile: "/tmp/child.jsonl", sessionName: this.sessionName, isStreaming: false, model: this.selectedModel, thinkingLevel: this.thinkingLevel };
		}
		if (command["type"] === "set_session_name") {
			this.sessionName = command["name"] as string;
			return undefined;
		}
		if (command["type"] === "set_model") {
			this.selectedModel = { provider: String(command["provider"]), id: String(command["modelId"]), name: String(command["modelId"]) };
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

describe("RPC worker arguments", () => {
	test("starts a forked child session with the selected Pi model", () => {
		assert.deepEqual(buildRpcWorkerArgs(spec("fork", "/tmp/source.jsonl")), [
			"--mode", "rpc",
			"--fork", "/tmp/source.jsonl",
			"--name", "subagent · Main Auth Work · auth-review",
			"--model", "cus-resp/gpt-5.6-sol",
			"--thinking", "xhigh",
			"--exclude-tools", "subagent",
		]);
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

		assert.deepEqual(transport.commands.map((command) => command["type"]), ["get_state", "set_session_name"]);
		assert.equal(transport.commands[1]?.["name"], "subagent · Main Auth Work · auth-review");
		await worker.stop();
	});

	test("changes the child model and thinking level through RPC", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const selected = await worker.setModel({ provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" });

		assert.deepEqual(selected, { provider: "deepseek", modelId: "deepseek-v4-flash", name: "deepseek-v4-flash", thinkingLevel: "high" });
		assert.deepEqual(transport.commands.slice(1).map((command) => command["type"]), ["set_model", "set_thinking_level", "get_state"]);
	});

	test("maps child controls to Pi steer and follow_up RPC commands", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);

		await worker.control({ delivery: "steer", message: "Focus on tests" });
		await worker.control({ delivery: "followUp", message: "Then summarize risks" });

		assert.deepEqual(transport.commands.slice(1), [
			{ type: "steer", message: "Focus on tests" },
			{ type: "follow_up", message: "Then summarize risks" },
		]);
	});

	test("a handled prompt without a run fails without opening control admission", async () => {
		const transport = new FakeTransport();
		const request = transport.request.bind(transport);
		transport.request = async (command) => command["type"] === "prompt" ? undefined : request(command);
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
		transport.request = async (command) => command["type"] === "get_state" ? { isStreaming: true } : undefined;
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
		assert.deepEqual(transport.commands.slice(2).map((command) => command["type"]), ["clear_queue", "abort"]);
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
		assert.deepEqual(transport.commands.slice(2).map((command) => command["type"]), ["clear_queue", "abort"]);
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
		assert.deepEqual(transport.commands.slice(2).map((command) => command["type"]), ["clear_queue", "abort"]);
	});

	test("keeps the child session and returns the settled assistant output", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);
		const updates: any[] = [];

		const result = await worker.send("review auth", { onUpdate: (update) => updates.push(update) });

		assert.equal(worker.sessionId, "child-session");
		assert.equal(worker.sessionFile, "/tmp/child.jsonl");
		assert.deepEqual(transport.commands.map((command) => command["type"]), ["get_state", "prompt"]);
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
});
