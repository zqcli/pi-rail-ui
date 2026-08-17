import assert from "node:assert/strict";
import { test } from "node:test";
import { installStatefulSubagentTool } from "../../subagent/tool";
import type { DispatchRequest, DispatchResult, SessionBroker } from "../../subagent/session-broker";
import { SubagentTranscript } from "../../subagent/transcript";

const model = {
	provider: "cus-resp",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
};

const railModel = {
	provider: "cus-resp",
	modelId: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	thinkingLevel: "xhigh" as const,
};

function context() {
	return {
		cwd: "/tmp/project",
		hasUI: true,
		model,
		thinkingLevel: "xhigh",
		scopedModels: [{ model, thinkingLevel: "xhigh" }],
		modelRegistry: {
			getAvailable: () => [model],
			find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
		},
		ui: { confirm: async () => true },
	};
}

class FakeBroker {
	readonly requests: DispatchRequest[] = [];

	async dispatch(request: DispatchRequest): Promise<DispatchResult> {
		this.requests.push(request);
		const selectedModel = request.model ?? railModel;
		const instance = {
			version: 2,
			agentId: "agt_auth",
			alias: request.alias ?? request.target ?? "auth-review",
			model: selectedModel,
			sessionId: "session-auth",
			sessionFile: "/tmp/auth.jsonl",
			cwd: request.cwd ?? "/tmp/project",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			lastTask: request.task,
			lastOutput: `done: ${request.task}`,
		} as const;
		request.onUpdate?.({
			instance,
			run: {
				output: "(starting...)",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			},
		});
		return {
			instance,
			run: {
				output: `done: ${request.task}`,
				usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 12, turns: 1 },
			},
		};
	}
}

test("tool prompt teaches the LLM stateless, persistent, follow-up, and orchestration rules", () => {
	let tool: any;
	installStatefulSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
		broker: new FakeBroker() as unknown as SessionBroker,
	});

	assert.match(tool.description, /model\+task with no alias\/target\/session for one-off stateless work/);
	assert.match(tool.description, /model\+alias\+concrete task/);
	assert.match(tool.description, /target\+task/);
	assert.match(tool.description, /multiple sibling subagent calls in the same assistant turn/);
	assert.match(tool.description, /do not use the tasks array/);
	assert.match(tool.description, /one grouped parent Tool Call/);
	assert.equal(tool.executionMode, "parallel");
	const guidance = tool.promptGuidelines.join("\n");
	assert.match(guidance, /lifecycle by continuity/);
	assert.match(guidance, /existing saved Pi session/);
	assert.match(guidance, /fork by default/);
	assert.match(guidance, /another repository/);
	assert.match(guidance, /preserve that session's project cwd/);
	assert.match(guidance, /new long-term helper expected to receive follow-ups/);
	assert.match(guidance, /do not create an empty, idle, or placeholder persistent session/);
	assert.match(guidance, /stateless one-off work/);
	assert.match(guidance, /make the task self-contained/);
	assert.match(guidance, /create no child JSONL and never appear in \/resume/);
	assert.match(guidance, /separate top-level Tool Call panels/);
	assert.match(guidance, /Pi preflights sibling calls in order and executes them concurrently/);
	assert.match(guidance, /tasks array only when the user wants one grouped subagent Tool Call/);
	assert.match(guidance, /permanently deleted from the \/rail-agent panel/);
	assert.match(guidance, /later target calls.*unknown persistent subagent/);
	assert.equal(tool.promptGuidelines.some((line: string) => /cannot recursively call subagent/.test(line)), true);
});

test("failed tool results restore the last streamed transcript through Pi's tool_result hook", async () => {
	let tool: any;
	let toolResultHandler: ((event: any) => any) | undefined;
	installStatefulSubagentTool({
		registerTool: (definition: any) => { tool = definition; },
		on: (event: string, handler: (value: any) => any) => {
			if (event === "tool_result") toolResultHandler = handler;
		},
	} as any, {
		broker: new FakeBroker() as unknown as SessionBroker,
		runStateless: async (request) => {
			const transcript = new SubagentTranscript(request.task);
			transcript.ingest({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "before failure" } });
			request.onUpdate?.({
				output: "(running...)",
				exitCode: 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				transcript: transcript.snapshot(),
			});
			throw new Error("child crashed");
		},
	});

	await assert.rejects(() => tool.execute(
		"call-failed",
		{ model: "cus-resp/gpt-5.6-sol:xhigh", task: "inspect failure" },
		undefined,
		() => {},
		context(),
	), /child crashed/);
	const restored = toolResultHandler?.({ toolName: "subagent", toolCallId: "call-failed", isError: true });
	assert.equal(restored.details.results[0].status, "failed");
	assert.deepEqual(restored.details.results[0].transcript.entries.map((entry: any) => entry.kind), ["user", "thinking", "assistant"]);
});

test("model plus alias creates a persistent session and target continues it", async () => {
	let tool: any;
	const broker = new FakeBroker();
	const continueUpdates: any[] = [];
	installStatefulSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
		broker: broker as unknown as SessionBroker,
	});

	const created = await tool.execute("call-1", {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		alias: "auth-review",
		task: "review auth",
	}, undefined, undefined, context());
	const continued = await tool.execute("call-2", {
		target: "auth-review",
		task: "check tests",
	}, undefined, (update: any) => continueUpdates.push(update), context());

	assert.deepEqual(broker.requests[0]?.model, railModel);
	assert.equal(broker.requests[1]?.target, "auth-review");
	assert.match(created.content[0].text, /Reuse with target="auth-review"/);
	assert.match(continued.content[0].text, /done: check tests/);
	assert.equal("messages" in continued.details.results[0], false);
	assert.equal(continued.details.results[0].model, "cus-resp/gpt-5.6-sol:xhigh");
	assert.equal(continued.details.results[0].persistent, true);
	assert.equal(typeof continued.details.durationMs, "number");
	assert.equal(typeof continued.details.results[0].durationMs, "number");
	assert.deepEqual(continued.details.results[0].usage, { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 12, turns: 1 });
	assert.equal(continueUpdates[0].details.results[0].agentId, "agt_auth");
	assert.equal(continueUpdates[0].details.results[0].sessionId, "session-auth");
	assert.equal(continueUpdates[0].details.results[0].model, "cus-resp/gpt-5.6-sol:xhigh");
	assert.equal(continueUpdates[0].details.results[0].persistent, true);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const call = tool.renderCall({ target: "auth-review", task: "check tests" }, theme);
	assert.match(call.render(100).join("\n"), /persistent continue auth-review/);
	const progressPanel = tool.renderResult(continueUpdates[0], { expanded: false }, theme);
	assert.match(progressPanel.render(120)[0], /auth-review · persistent · cus-resp\/gpt-5\.6-sol:xhigh/);
});

test("parallel parent content is fair and details keep a bounded retained answer", async () => {
	let tool: any;
	const output = "界".repeat(100_000);
	installStatefulSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
		broker: new FakeBroker() as unknown as SessionBroker,
		runStateless: async () => ({
			output,
			exitCode: 0,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
		}),
	});

	const result = await tool.execute("call-large", {
		tasks: [
			{ model: "cus-resp/gpt-5.6-sol:xhigh", task: "alpha" },
			{ model: "cus-resp/gpt-5.6-sol:xhigh", task: "beta" },
		],
	}, undefined, undefined, context());

	assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 50 * 1024);
	assert.match(result.content[0].text, /cus-resp\/gpt-5\.6-sol #1 · completed/);
	assert.match(result.content[0].text, /cus-resp\/gpt-5\.6-sol #2 · completed/);
	assert.ok(Buffer.byteLength(result.details.results[0].output, "utf8") <= 256 * 1024);
	assert.ok(Buffer.byteLength(result.details.results[1].output, "utf8") <= 256 * 1024);
	assert.equal(result.details.results[0].outputTruncated, true);
	assert.equal(result.details.results[1].outputTruncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(result.details), "utf8") <= 512 * 1024);
});

test("an aborted parallel call does not create not-yet-dispatched persistent sessions", async () => {
	let tool: any;
	const broker = new FakeBroker();
	installStatefulSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
		broker: broker as unknown as SessionBroker,
	});
	const controller = new AbortController();
	controller.abort();

	const result = await tool.execute("call-aborted-parallel", {
		tasks: Array.from({ length: 6 }, (_, index) => ({
			model: "cus-resp/gpt-5.6-sol:xhigh",
			alias: `persistent-${index}`,
			task: `task ${index}`,
		})),
	}, controller.signal, undefined, context());

	assert.equal(broker.requests.length, 0);
	assert.equal(result.details.results.every((item: any) => item.stopReason === "aborted"), true);
});

test("model without alias or session runs stateless and creates no broker instance", async () => {
	let tool: any;
	const broker = new FakeBroker();
	const statelessModels: unknown[] = [];
	const statelessUpdates: any[] = [];
	installStatefulSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
		broker: broker as unknown as SessionBroker,
		runStateless: async (request) => {
			statelessModels.push(request.model);
			return {
				output: "one-off done",
				exitCode: 0,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			};
		},
	});

	const result = await tool.execute("call-stateless", {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		target: "",
		alias: "",
		task: "one-off review",
		cwd: "",
		session: { mode: "fork", path: "" },
		tasks: [],
		chain: [],
		confirmSessionAttach: true,
	}, undefined, (update: any) => statelessUpdates.push(update), context());

	assert.deepEqual(statelessModels, [railModel]);
	assert.equal(broker.requests.length, 0);
	assert.match(result.content[0].text, /Stateless model session cus-resp\/gpt-5\.6-sol:xhigh completed/);
	assert.equal(result.details.results[0].persistent, false);
	assert.equal(statelessUpdates[0].details.results[0].model, "cus-resp/gpt-5.6-sol:xhigh");
	assert.equal(statelessUpdates[0].details.results[0].persistent, false);
});

test("omitting model uses the current Pi model for stateless work", async () => {
	let tool: any;
	let selected: unknown;
	installStatefulSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
		broker: new FakeBroker() as unknown as SessionBroker,
		runStateless: async (request) => {
			selected = request.model;
			return { output: "done", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } };
		},
	});

	await tool.execute("call-current", { task: "quick check" }, undefined, undefined, context());

	assert.deepEqual(selected, railModel);
});

test("parallel mode allows one model to back stateless and persistent sessions", async () => {
	let tool: any;
	const broker = new FakeBroker();
	const statelessTasks: string[] = [];
	installStatefulSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
		broker: broker as unknown as SessionBroker,
		runStateless: async (request) => {
			statelessTasks.push(request.task);
			return {
				output: "one-off done",
				exitCode: 0,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			};
		},
	});

	const result = await tool.execute("call-mixed", {
		tasks: [
			{ model: "cus-resp/gpt-5.6-sol:xhigh", task: "quick check" },
			{ model: "cus-resp/gpt-5.6-sol:xhigh", alias: "kept-review", task: "long review" },
		],
	}, undefined, undefined, context());

	assert.deepEqual(statelessTasks, ["quick check"]);
	assert.equal(broker.requests.length, 1);
	assert.deepEqual(result.details.results.map((item: any) => item.persistent), [false, true]);
});

test("parallel streaming updates retain the recent transcript from every active child", async () => {
	let tool: any;
	const updates: any[] = [];
	installStatefulSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
		broker: new FakeBroker() as unknown as SessionBroker,
		runStateless: async (request) => {
			const transcript = new SubagentTranscript(request.task);
			transcript.ingest({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: `thinking ${request.task}` } });
			request.onUpdate?.({
				output: "(running...)",
				exitCode: 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				transcript: transcript.snapshot(),
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `done ${request.task}` }] } });
			return {
				output: `done ${request.task}`,
				exitCode: 0,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
				transcript: transcript.snapshot(),
			};
		},
	});

	const result = await tool.execute("call-parallel-transcript", {
		tasks: [
			{ model: "cus-resp/gpt-5.6-sol:xhigh", task: "alpha" },
			{ model: "cus-resp/gpt-5.6-sol:xhigh", task: "beta" },
		],
	}, undefined, (update: any) => updates.push(update), context());

	const combined = updates.find((update) => update.details.results.length === 2
		&& update.details.results.every((item: any) => item.transcript?.entries.length));
	assert.ok(combined);
	assert.deepEqual(combined.details.results.map((item: any) => item.transcript.entries[0].text), ["alpha", "beta"]);
	assert.ok(result.details.results.reduce((total: number, item: any) => total + item.transcript.entries.length, 0) <= 18);
});

test("session attachment confirms before forking an ordinary session", async () => {
	let tool: any;
	let confirmations = 0;
	const broker = new FakeBroker();
	installStatefulSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
		broker: broker as unknown as SessionBroker,
	});
	const ctx = context();
	ctx.ui.confirm = async () => { confirmations++; return true; };

	await tool.execute("call-3", {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		alias: "adopted-review",
		task: "continue review",
		session: { mode: "fork", path: "/tmp/source.jsonl" },
	}, undefined, undefined, ctx);

	assert.equal(confirmations, 1);
	assert.deepEqual(broker.requests[0]?.session, { mode: "fork", path: "/tmp/source.jsonl" });
});
