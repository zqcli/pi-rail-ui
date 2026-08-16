import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	RpcSessionWorker,
	buildRpcWorkerArgs,
	type RpcEvent,
	type RpcTransport,
} from "../../subagent/rpc-worker";
import type { AgentConfig } from "../../subagent/agents";
import type { WorkerStartSpec } from "../../subagent/session-broker";

class FakeTransport implements RpcTransport {
	readonly commands: Array<Record<string, unknown>> = [];
	readonly listeners = new Set<(event: RpcEvent) => void>();
	stopped = false;

	constructor(private readonly failPrompt = false) {}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async request(command: Record<string, unknown>): Promise<unknown> {
		this.commands.push(command);
		if (command["type"] === "get_state") {
			return { sessionId: "child-session", sessionFile: "/tmp/child.jsonl", isStreaming: false };
		}
		if (command["type"] === "prompt") {
			queueMicrotask(() => {
				if (this.failPrompt) {
					this.emit({ type: "transport_error", error: "child crashed" });
					return;
				}
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

function profile(): AgentConfig {
	return {
		name: "reviewer",
		description: "Review code",
		tools: ["read", "grep"],
		model: "cus-resp/gpt-5.6-sol:xhigh",
		systemPrompt: "Review carefully.",
		source: "user",
		filePath: "/tmp/reviewer.md",
	};
}

function spec(mode: WorkerStartSpec["mode"], sessionPath?: string): WorkerStartSpec {
	return {
		agentId: "agt_auth",
		mode,
		profile: profile(),
		alias: "auth-review",
		cwd: "/tmp/project",
		...(sessionPath ? { sessionPath } : {}),
	};
}

describe("RPC worker arguments", () => {
	test("starts a forked child session with the pinned agent profile", () => {
		assert.deepEqual(buildRpcWorkerArgs(spec("fork", "/tmp/source.jsonl")), [
			"--mode", "rpc",
			"--fork", "/tmp/source.jsonl",
			"--name", "auth-review",
			"--model", "cus-resp/gpt-5.6-sol:xhigh",
			"--tools", "read,grep",
			"--exclude-tools", "subagent",
			"--append-system-prompt", "Review carefully.",
		]);
	});

	test("opens a managed child session instead of forking it again", () => {
		const args = buildRpcWorkerArgs(spec("open", "/tmp/child.jsonl"));
		assert.deepEqual(args.slice(0, 4), ["--mode", "rpc", "--session", "/tmp/child.jsonl"]);
		assert.equal(args.includes("--fork"), false);
	});
});

describe("RpcSessionWorker", () => {
	test("keeps the child session and returns the settled assistant output", async () => {
		const transport = new FakeTransport();
		const worker = await RpcSessionWorker.connect(spec("new"), transport);

		const result = await worker.send("review auth");

		assert.equal(worker.sessionId, "child-session");
		assert.equal(worker.sessionFile, "/tmp/child.jsonl");
		assert.deepEqual(transport.commands.map((command) => command["type"]), ["get_state", "prompt"]);
		assert.equal(result.output, "review complete");
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

		await assert.rejects(() => worker.send("review auth"), /child crashed/);
		await worker.stop();
	});
});
