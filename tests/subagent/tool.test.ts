import assert from "node:assert/strict";
import { test } from "node:test";
import { installStatefulSubagentTool } from "../../subagent/tool";
import type { DispatchRequest, DispatchResult, SessionBroker } from "../../subagent/session-broker";

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
		return {
			instance: {
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
			},
			run: {
				output: `done: ${request.task}`,
				usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 12, turns: 1 },
			},
		};
	}
}

test("model plus alias creates a persistent session and target continues it", async () => {
	let tool: any;
	const broker = new FakeBroker();
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
	}, undefined, undefined, context());

	assert.deepEqual(broker.requests[0]?.model, railModel);
	assert.equal(broker.requests[1]?.target, "auth-review");
	assert.match(created.content[0].text, /Reuse with target="auth-review"/);
	assert.match(continued.content[0].text, /done: check tests/);
	assert.equal("messages" in continued.details.results[0], false);
	assert.equal(continued.details.results[0].model, "cus-resp/gpt-5.6-sol:xhigh");
});

test("model without alias or session runs stateless and creates no broker instance", async () => {
	let tool: any;
	const broker = new FakeBroker();
	const statelessModels: unknown[] = [];
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
	}, undefined, undefined, context());

	assert.deepEqual(statelessModels, [railModel]);
	assert.equal(broker.requests.length, 0);
	assert.match(result.content[0].text, /Stateless model session cus-resp\/gpt-5\.6-sol:xhigh completed/);
	assert.equal(result.details.results[0].persistent, false);
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
