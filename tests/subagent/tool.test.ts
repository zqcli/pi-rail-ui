import assert from "node:assert/strict";
import { test } from "node:test";
import { installStatefulSubagentTool, type StatefulSubagentToolOptions } from "../../tools/subagents/tool";
import { WorkerControlError, type ControlRequest, type ControlResult, type DispatchRequest, type DispatchResult, type SessionBroker } from "../../tools/subagents/session-broker";
import { RunResultCollector, assistantText } from "../../tools/subagents/run-result";
import { SubagentTranscript } from "../../tools/subagents/transcript";

const model = {
	provider: "cus-resp",
	api: "openai-responses",
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
	readonly controls: ControlRequest[] = [];
	controlError: Error | undefined;

	async validateContextWindowForTarget(_target: string, contextWindow: number): Promise<void> {
		if (contextWindow <= 16_384) throw new Error("contextWindow must be greater than the child reserveTokens (16384)");
	}

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

	async control(request: ControlRequest): Promise<ControlResult> {
		if (this.controlError) throw this.controlError;
		this.controls.push(request);
		return {
			instance: {
				version: 2,
				agentId: "agt_auth",
				alias: request.target,
				model: railModel,
				sessionId: "session-auth",
				sessionFile: "/tmp/auth.jsonl",
				cwd: "/tmp/project",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				lastTask: "review auth",
			},
			delivery: request.delivery,
		};
	}
}

function setupTool(options: { runStateless?: StatefulSubagentToolOptions["runStateless"] } = {}) {
	const broker = new FakeBroker();
	let tool: any;
	let hook: ((event: any) => any) | undefined;
	const pi: any = {
		registerTool: (definition: any) => { tool = definition; },
		on: (event: string, handler: (value: any) => any) => {
			if (event === "tool_result") hook = handler;
		},
	};
	installStatefulSubagentTool(pi, {
		broker: broker as unknown as SessionBroker,
		...(options.runStateless ? { runStateless: options.runStateless } : {}),
	});
	return { tool, broker, hook };
}

test("tool prompt teaches the LLM stateless, persistent, follow-up, and orchestration rules", () => {
	const { tool } = setupTool();

	assert.match(tool.description, /Use exactly one mode: single, parallel, chain, or control/);
	assert.match(tool.description, /\{"model":"provider\/model:thinking","task":"one-off work","contextWindow":null\}/);
	assert.match(tool.description, /\{"model":"provider\/model:thinking","alias":"worker","task":"initial work","contextWindow":null\}/);
	assert.match(tool.description, /\{"target":"worker","task":"follow-up","contextWindow":null\}/);
	assert.match(tool.description, /\{"tasks":\[\{"task":"A","contextWindow":null\},\{"model":"provider\/model","alias":"worker","task":"B","contextWindow":null\}\]\}/);
	assert.match(tool.description, /Explicit single example: \{"task":"work","contextWindow":64000\}/);
	assert.match(tool.description, /Explicit grouped example: \{"tasks":\[\{"task":"A","contextWindow":64000\},\{"task":"B","contextWindow":128000\}\]\}/);
	assert.match(tool.description, /\{"chain":\[\{"task":"plan","contextWindow":null\},\{"target":"worker","task":"implement \{previous\}","contextWindow":null\}\]\}/);
	assert.match(tool.description, /\{"target":"worker","control":\{"delivery":"steer","message":"redirect now"\}\}/);
	assert.match(tool.description, /Set contextWindow to null by default/);
	assert.match(tool.description, /fastMode/);
	assert.match(tool.description, /existing target.*descriptor|descriptor.*existing target/iu);
	assert.match(tool.description, /through \/rail-agent/);
	assert.match(tool.description, /Null or omission uses the selected child model's native default/);
	assert.match(tool.description, /Only use a positive safe integer when the user explicitly requests a specific child context or compaction budget/);
	assert.match(tool.description, /Top-level numeric contextWindow is only for single mode/);
	assert.match(tool.description, /each tasks or chain item owns its own numeric contextWindow/);
	assert.match(tool.description, /multiple sibling subagent calls in the same assistant turn/);
	assert.match(tool.description, /do not use tasks/);
	assert.equal(tool.executionMode, "parallel");
	const contextWindowSchemas = [
		tool.parameters.properties.contextWindow,
		tool.parameters.properties.tasks.items.properties.contextWindow,
		tool.parameters.properties.chain.items.properties.contextWindow,
	];
	for (const schema of contextWindowSchemas) {
		assert.equal(schema.default, null);
		assert.deepEqual(schema.anyOf.map((variant: any) => variant.type), ["number", "null"]);
	}
	const fastModeSchemas = [
		tool.parameters.properties.fastMode,
		tool.parameters.properties.tasks.items.properties.fastMode,
		tool.parameters.properties.chain.items.properties.fastMode,
	];
	for (const schema of fastModeSchemas) {
		assert.equal(schema.default, null);
		assert.deepEqual(schema.anyOf.map((variant: any) => variant.type), ["boolean", "null"]);
	}
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
	assert.match(guidance, /Use contextWindow:null by default/);
	assert.match(guidance, /fastMode/);
	assert.match(guidance, /existing.*rail-agent|rail-agent.*existing/iu);
	assert.match(guidance, /Only use a positive integer when the user explicitly requests/);
	assert.match(guidance, /Null or omission uses the selected child model's native default/);
	assert.match(guidance, /create no child JSONL and never appear in \/resume/);
	assert.match(guidance, /separate top-level Tool Call panels/);
	assert.match(guidance, /Pi preflights sibling calls in order and executes them concurrently/);
	assert.match(guidance, /tasks array only when the user wants one grouped subagent Tool Call/);
	assert.match(guidance, /Live controls apply only to an already-running local persistent subagent/);
	assert.match(guidance, /needs_input.*specialist_request/);
	assert.match(guidance, /permanently deleted from the \/rail-agent panel/);
	assert.match(guidance, /later target calls.*unknown persistent subagent/);
	assert.equal(tool.promptGuidelines.some((line: string) => /cannot recursively call subagent/.test(line)), true);
});

test("control mode steers and queues follow-ups for an active persistent target", async () => {
	const { tool, broker } = setupTool();

	const rawSteer = {
		model: "ignored/model",
		target: "auth-review",
		alias: "ignored-alias",
		cwd: "/ignored/path",
		session: { mode: "fork" as const, path: "/ignored/session.jsonl" },
		control: { delivery: "steer" as const, message: "Focus on tests" },
		contextWindow: null,
		tasks: [],
		chain: [],
		unexpected: "ignored",
	};
	assert.deepEqual(tool.prepareArguments(rawSteer), {
		target: "auth-review",
		control: { delivery: "steer", message: "Focus on tests" },
	});
	const steer = await tool.execute("call-steer", rawSteer, undefined, undefined, context());
	const followUp = await tool.execute("call-follow-up", {
		target: "auth-review",
		control: { delivery: "followUp", message: "Then summarize risks" },
	}, undefined, undefined, context());

	assert.deepEqual(broker.controls, [
		{ target: "auth-review", delivery: "steer", message: "Focus on tests" },
		{ target: "auth-review", delivery: "followUp", message: "Then summarize risks" },
	]);
	assert.match(steer.content[0].text, /Steer accepted by auth-review/);
	assert.match(followUp.content[0].text, /Follow-up accepted by auth-review/);
	assert.equal(steer.details.mode, "control");
	assert.equal(steer.details.results[0].status, "accepted");
	assert.equal(steer.details.results[0].persistent, true);
	assert.equal(steer.details.results[0].model, "cus-resp/gpt-5.6-sol:xhigh");
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	assert.match(tool.renderCall({ target: "auth-review", control: { delivery: "steer", message: "Focus on tests" } }, theme).render(100).join("\n"), /steer · auth-review/);
	const controlPanel = tool.renderResult(steer, { expanded: false }, theme).render(100).join("\n");
	assert.match(controlPanel, /↪ accepted · auth-review/);
	assert.match(controlPanel, /accepted/);
	const expandedControlPanel = tool.renderResult(steer, { expanded: true }, theme).render(100).join("\n");
	assert.match(expandedControlPanel, /Control acknowledgement/);
	assert.doesNotMatch(expandedControlPanel, /Final answer/);
	await assert.rejects(
		() => tool.execute("call-invalid-control", {
			target: "auth-review",
			task: "continue",
			control: { delivery: "steer", message: "Focus" },
		}, undefined, undefined, context()),
		/exactly one mode/,
	);
	await assert.rejects(
		() => tool.execute("call-numeric-control-window", {
			target: "auth-review",
			control: { delivery: "steer", message: "Focus" },
			contextWindow: 64_000,
		}, undefined, undefined, context()),
		/only supported on the single task/,
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => tool.execute("call-aborted-control", {
			target: "auth-review",
			control: { delivery: "steer", message: "Do not deliver" },
		}, controller.signal, undefined, context()),
		/aborted before delivery/,
	);
	assert.equal(broker.controls.length, 2);
});

test("fastMode null is the default, while explicit target/grouped/control values are rejected", async () => {
	const { tool, broker } = setupTool({
		runStateless: async () => ({
			exitCode: 0,
			output: "done",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		}),
	});

	await tool.execute("call-null-fast", { task: "one-off", fastMode: null }, undefined, undefined, context());
	assert.equal(broker.requests.length, 0);

	await assert.rejects(
		() => tool.execute("call-target-fast", { target: "auth-review", task: "continue", fastMode: true }, undefined, undefined, context()),
		/existing target.*rail-agent|rail-agent.*existing target/iu,
	);
	await assert.rejects(
		() => tool.execute("call-group-fast", { tasks: [{ task: "one" }], fastMode: true }, undefined, undefined, context()),
		/fastMode.*grouped|grouped.*fastMode/iu,
	);
	await assert.rejects(
		() => tool.execute("call-control-fast", { target: "auth-review", fastMode: true, control: { delivery: "steer", message: "Focus" } }, undefined, undefined, context()),
		/fastMode.*control|control.*fastMode/iu,
	);
	const unsupported = {
		...context(),
		model: { ...model, id: "deepseek-v4", name: "DeepSeek V4" },
		modelRegistry: {
			getAvailable: () => [{ ...model, id: "deepseek-v4", name: "DeepSeek V4" }],
			find: (provider: string, id: string) => provider === "cus-resp" && id === "deepseek-v4" ? { ...model, id, name: "DeepSeek V4" } : undefined,
		},
		scopedModels: [{ model: { ...model, id: "deepseek-v4", name: "DeepSeek V4" }, thinkingLevel: "xhigh" }],
	};
	await assert.rejects(
		() => tool.execute("call-unsupported-fast", { model: "cus-resp/deepseek-v4", task: "native only", fastMode: true }, undefined, undefined, unsupported as any),
		/GPT.*supported|supported.*GPT/iu,
	);
});

test("fastMode is forwarded to stateless and initial persistent dispatches without entering result details", async () => {
	const { tool, broker } = setupTool({
		runStateless: async (request) => ({
			exitCode: 0,
			output: request.fastMode ? "fast done" : "done",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		}),
	});
	await tool.execute("call-fast-stateless", { task: "fast", fastMode: true }, undefined, undefined, context());
	const persistent = await tool.execute("call-fast-persistent", { model: "cus-resp/gpt-5.6-sol", alias: "fast-review", task: "fast initial", fastMode: true }, undefined, undefined, context());
	assert.equal(broker.requests.length, 1);
	assert.equal(broker.requests[0]?.fastMode, true);

	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const createdArgs = { model: "cus-resp/gpt-5.6-sol", alias: "fast-review", task: "fast initial", fastMode: true };
	assert.match(tool.renderCall(createdArgs, theme).render(120).join("\n"), /FAST/);
	assert.doesNotMatch(tool.renderResult(persistent, { expanded: false }, theme, { args: createdArgs }).render(120).join("\n"), /FAST/);

	const groupedArgs = { tasks: [{ task: "one", fastMode: null }, { target: "fast-review", task: "two", fastMode: null }] };
	const grouped = tool.renderResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "parallel",
			results: [
				{ alias: "one", model: "cus-resp/gpt-5.6-sol", status: "completed", output: "one", persistent: false },
				{ alias: "two", model: "cus-resp/gpt-5.6-sol", status: "completed", output: "two", persistent: true },
			],
			durationMs: 1,
		},
	}, { expanded: false, isPartial: false }, theme, { args: groupedArgs }).render(120).join("\n");
	assert.doesNotMatch(tool.renderCall(groupedArgs, theme).render(120).join("\n"), /fast|FAST/);
	assert.doesNotMatch(grouped, /fast|FAST/);

	const targetArgs = { target: "fast-review", task: "continue", fastMode: null };
	assert.doesNotMatch(tool.renderCall(targetArgs, theme).render(120).join("\n"), /FAST|fast (?:on|off|agent)/u);
	assert.doesNotMatch(tool.renderResult(persistent, { expanded: false }, theme, { args: targetArgs }).render(120).join("\n"), /FAST|fast (?:on|off|agent)/u);
	assert.doesNotMatch(JSON.stringify(persistent.details), /fastMode/);
});

test("renderCall owns task-free dispatch metadata and single results do not repeat it", async () => {
	const { tool } = setupTool({
		runStateless: async () => ({
			exitCode: 0,
			output: "done",
			usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, cost: 0.01, contextTokens: 120, turns: 1 },
		}),
	});
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const defaultArgs = { task: "PRIVATE TASK PREVIEW MUST NOT RENDER" };
	const defaultCall = tool.renderCall(defaultArgs, theme).render(120).join("\n");
	assert.doesNotMatch(defaultCall, /PRIVATE TASK PREVIEW/);
	assert.doesNotMatch(defaultCall, /budget|FAST|fast off/);

	const explicitArgs = { model: "cus-resp/gpt-5.6-sol", task: "PRIVATE TASK PREVIEW MUST NOT RENDER", contextWindow: 64_000, fastMode: true };
	const offArgs = { model: "cus-resp/gpt-5.6-sol", task: "off", fastMode: false };
	assert.doesNotMatch(tool.renderCall(offArgs, theme).render(120).join("\n"), /FAST/);
	const offResult = await tool.execute("layout-off", offArgs, undefined, undefined, context());
	assert.doesNotMatch(tool.renderResult(offResult, { expanded: false }, theme, { args: offArgs }).render(120).join("\n"), /FAST/);
	const explicitResult = await tool.execute("layout-explicit", explicitArgs, undefined, undefined, context());
	const explicitCall = tool.renderCall(explicitArgs, theme).render(120).join("\n");
	const explicitPanel = tool.renderResult(explicitResult, { expanded: false }, theme, { args: explicitArgs }).render(120).join("\n");
	assert.match(explicitCall, /budget 64K/);
	assert.match(explicitCall, /FAST/);
	assert.doesNotMatch(explicitCall, /PRIVATE TASK PREVIEW/);
	assert.match(explicitPanel, /PRIVATE TASK PREVIEW/);
	assert.doesNotMatch(explicitPanel, /budget 64K|FAST|Usage ·/);
	assert.match(tool.renderCall({
		model: "cus-resp/gpt-5.6-sol",
		alias: "adopted-review",
		task: "resume",
		session: { mode: "fork", path: "/tmp/review.jsonl" },
	}, theme).render(120).join("\n"), /adopt fork · adopted-review · cus-resp\/gpt-5\.6-sol/);
	for (const width of [1, 2, 3, 40, 80, 120]) {
		assert.equal(tool.renderCall(explicitArgs, theme).render(width).length, 1);
	}
});

test("control failures retain an explicit unknown-delivery result for the panel", async () => {
	const { tool, broker, hook } = setupTool();
	broker.controlError = new WorkerControlError("Subagent control delivery outcome is unknown", "unknown");

	await assert.rejects(() => tool.execute("call-unknown-control", {
		target: "auth-review",
		control: { delivery: "steer", message: "Focus on tests" },
	}, undefined, undefined, context()), /outcome is unknown/);
	const restored = hook?.({ toolName: "subagent", toolCallId: "call-unknown-control", isError: true });
	assert.equal(restored.details.mode, "control");
	assert.equal(restored.details.results[0].status, "failed");
	assert.match(restored.details.results[0].errorMessage, /outcome is unknown/);
	assert.equal(restored.details.results[0].transcript.entries.some((entry: any) => entry.initial && entry.text === "Focus on tests"), true);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const panel = tool.renderResult(restored, { expanded: true }, theme).render(100).join("\n");
	assert.match(panel, /failed · auth-review/);
	assert.doesNotMatch(panel, /Focus on tests|initial task|cus-resp\/gpt-5\.6-sol|persistent|0 in/);
});

test("failed tool results restore the last streamed transcript through Pi's tool_result hook", async () => {
	const { tool, hook } = setupTool({
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
	const restored = hook?.({ toolName: "subagent", toolCallId: "call-failed", isError: true });
	assert.equal(restored.details.results[0].status, "failed");
	assert.deepEqual(restored.details.results[0].transcript.entries.map((entry: any) => entry.kind), ["user", "thinking", "assistant"]);
});

test("model plus alias creates a persistent session and target continues it", async () => {
	const { tool, broker } = setupTool();
	const continueUpdates: any[] = [];

	const created = await tool.execute("call-1", {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		target: "",
		alias: "auth-review",
		task: "review auth",
		cwd: "",
		session: { mode: "fork", path: "" },
		control: { delivery: "steer", message: "" },
		tasks: [],
		chain: [],
		confirmSessionAttach: false,
		unexpected: "ignored",
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
	assert.match(call.render(100).join("\n"), /continue · auth-review/);
	const progressPanel = tool.renderResult(continueUpdates[0], { expanded: false }, theme);
	assert.match(progressPanel.render(120)[0], /Running · cus-resp\/gpt-5\.6-sol:xhigh/);
});

test("native compaction progress reaches the Tool Call panel through the runner seam", async () => {
	const { tool } = setupTool({
		runStateless: async (request) => {
			const collector = new RunResultCollector(request.task, assistantText);
			collector.ingest({ type: "compaction_start", reason: "threshold" });
			request.onUpdate?.({ ...collector.result("(running...)"), exitCode: 0 });
			collector.ingest({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 5, errorMessage: "temporary" });
			collector.ingest({ type: "compaction_end", reason: "threshold", result: { summary: "PRIVATE MODEL SUMMARY" }, aborted: false, willRetry: true });
			collector.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
			return { ...collector.result("(no output)"), exitCode: 0 };
		},
	});
	const updates: any[] = [];
	const result = await tool.execute(
		"call-compacting",
		{ model: "cus-resp/gpt-5.6-sol:xhigh", task: "compact this child" },
		undefined,
		(update: any) => updates.push(update),
		context(),
	);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const compacting = updates.find((update) => update.details.results[0].isCompacting === true);
	assert.ok(compacting);
	assert.match(tool.renderResult(compacting, { expanded: false, isPartial: true }, theme).render(100).join("\n"), /Compacting/);
	assert.equal(result.details.results[0].isCompacting, undefined);
	assert.doesNotMatch(JSON.stringify(result), /PRIVATE MODEL SUMMARY/);
});

test("parallel parent content is fair and details keep a bounded retained answer", async () => {
	const output = "界".repeat(100_000);
	const { tool } = setupTool({
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

test("full initial task rendering stays out of bounded parent details", async () => {
	const initialTask = [
		"FULL INITIAL TASK START",
		...Array.from({ length: 80 }, (_, index) => `initial detail ${index} ${"x".repeat(220)}`),
		"FULL INITIAL TASK END",
	].join("\n");
	const { tool } = setupTool({
		runStateless: async (request) => ({
			output: "done",
			exitCode: 0,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			transcript: new SubagentTranscript(request.task).snapshot(),
		}),
	});

	const result = await tool.execute("call-full-initial", {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		task: initialTask,
	}, undefined, undefined, context());
	const detailInitial = result.details.results[0].transcript.entries.find((entry: any) => entry.initial);
	assert.ok(detailInitial);
	assert.notEqual(detailInitial.text, initialTask);
	assert.match(detailInitial.text, /initial task truncated in parent details/);
	assert.ok(Buffer.byteLength(JSON.stringify(result.details), "utf8") <= 512 * 1024);

	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const restored = structuredClone(result);
	const panel = tool.renderResult(restored, { expanded: false }, theme, {
		args: { model: "cus-resp/gpt-5.6-sol:xhigh", task: initialTask },
	}).render(120).join("\n");
	assert.match(panel, /FULL INITIAL TASK START/);
	assert.match(panel, /FULL INITIAL TASK END/);

	const legacy = structuredClone(result);
	for (const entry of legacy.details.results[0].transcript.entries) {
		delete entry.initial;
		if (entry.kind === "user") entry.text = `[… earlier text omitted]\n${initialTask.slice(-(4000 - 28))}`;
	}
	const legacyPanel = tool.renderResult(legacy, { expanded: false }, theme, {
		args: { model: "cus-resp/gpt-5.6-sol:xhigh", task: initialTask },
	}).render(120).join("\n");
	assert.equal((legacyPanel.match(/initial task/gu) ?? []).length, 1);
	assert.match(legacyPanel, /FULL INITIAL TASK END/);
});

test("legacy restored details keep a follow-up user entry separate when the initial was evicted", async () => {
	const initialTask = [
		"EVICTED INITIAL START",
		...Array.from({ length: 80 }, (_, index) => `initial detail ${index} ${"q".repeat(220)}`),
		"EVICTED INITIAL END",
	].join("\n");
	const { tool } = setupTool({
		runStateless: async (request) => ({
			output: "done",
			exitCode: 0,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			transcript: new SubagentTranscript(request.task).snapshot(),
		}),
	});
	const result = await tool.execute("call-legacy-evicted", {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		task: initialTask,
	}, undefined, undefined, context());
	const legacy = structuredClone(result);
	const firstUser = legacy.details.results[0].transcript.entries.find((entry: any) => entry.kind === "user");
	assert.ok(firstUser);
	delete firstUser.initial;
	firstUser.text = "FOLLOW-UP AFTER INITIAL EVICTION";

	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const panel = tool.renderResult(legacy, { expanded: true }, theme, {
		args: { model: "cus-resp/gpt-5.6-sol:xhigh", task: initialTask },
	}).render(120).join("\n");
	assert.equal((panel.match(/initial task/gu) ?? []).length, 1);
	assert.match(panel, /EVICTED INITIAL END/);
	assert.match(panel, /FOLLOW-UP AFTER INITIAL EVICTION/);
});

test("restored grouped panels recover parallel and chain initial tasks from render args", async () => {
	const makeTask = (label: string) => [
		`${label} START`,
		...Array.from({ length: 50 }, (_, index) => `${label} detail ${index} ${"y".repeat(220)}`),
		`${label} END`,
	].join("\n");
	const parallelTasks = [makeTask("PARALLEL ALPHA"), makeTask("PARALLEL BETA")];
	const chainTasks = [makeTask("CHAIN FIRST"), makeTask("CHAIN SECOND")];
	const { tool } = setupTool({
		runStateless: async (request) => ({
			output: `done ${request.task.slice(0, 24)}`,
			exitCode: 0,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			transcript: new SubagentTranscript(request.task).snapshot(),
		}),
	});
	const parallel = await tool.execute("call-restored-parallel", {
		tasks: parallelTasks.map((task) => ({ model: "cus-resp/gpt-5.6-sol:xhigh", task })),
	}, undefined, undefined, context());
	const chain = await tool.execute("call-restored-chain", {
		chain: chainTasks.map((task) => ({ model: "cus-resp/gpt-5.6-sol:xhigh", task })),
	}, undefined, undefined, context());
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

	const parallelPanel = tool.renderResult(structuredClone(parallel), { expanded: false }, theme, {
		args: { tasks: parallelTasks.map((task) => ({ model: "cus-resp/gpt-5.6-sol:xhigh", task })) },
	}).render(120).join("\n");
	assert.match(parallelPanel, /PARALLEL ALPHA START/);
	assert.match(parallelPanel, /PARALLEL ALPHA END/);
	assert.match(parallelPanel, /PARALLEL BETA START/);
	assert.match(parallelPanel, /PARALLEL BETA END/);
	assert.ok(parallelPanel.indexOf("PARALLEL ALPHA START") < parallelPanel.indexOf("PARALLEL BETA START"));

	const chainPanel = tool.renderResult(structuredClone(chain), { expanded: false }, theme, {
		args: { chain: chainTasks.map((task) => ({ model: "cus-resp/gpt-5.6-sol:xhigh", task })) },
	}).render(120).join("\n");
	assert.match(chainPanel, /CHAIN FIRST START/);
	assert.match(chainPanel, /CHAIN FIRST END/);
	assert.match(chainPanel, /CHAIN SECOND START/);
	assert.match(chainPanel, /CHAIN SECOND END/);
	assert.ok(chainPanel.indexOf("CHAIN FIRST START") < chainPanel.indexOf("CHAIN SECOND START"));
});

test("restored control panels keep control messages bounded and out of initial-task rendering", async () => {
	const message = ["CONTROL TASK START", ...Array.from({ length: 50 }, (_, index) => `control detail ${index} ${"z".repeat(220)}`), "CONTROL TASK END"].join("\n");
	const { tool } = setupTool();
	const result = await tool.execute("call-restored-control", {
		target: "auth-review",
		control: { delivery: "steer", message },
	}, undefined, undefined, context());
	assert.ok(Buffer.byteLength(result.details.results[0].task, "utf8") <= 8 * 1024);
	assert.notEqual(result.details.results[0].task, message);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const panel = tool.renderResult(structuredClone(result), { expanded: false }, theme, {
		args: { target: "auth-review", control: { delivery: "steer", message } },
	}).render(120).join("\n");
	assert.match(panel, /Steer accepted by auth-review/);
	assert.doesNotMatch(panel, /CONTROL TASK END/);
	assert.doesNotMatch(panel, /initial task/);
});

test("an aborted parallel call does not create not-yet-dispatched persistent sessions", async () => {
	const { tool, broker } = setupTool();
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
	const statelessModels: unknown[] = [];
	const statelessUpdates: any[] = [];
	const { tool, broker } = setupTool({
		runStateless: async (request) => {
			statelessModels.push(request.model);
			return {
				output: "one-off done",
				exitCode: 0,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			};
		},
	});

	const rawStateless = {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		target: "",
		alias: "",
		task: "one-off review",
		cwd: "",
		session: { mode: "fork" as const, path: "" },
		control: { delivery: "steer" as const, message: "" },
		tasks: [],
		chain: [],
		confirmSessionAttach: true,
		unexpected: "ignored",
	};
	assert.deepEqual(tool.prepareArguments(rawStateless), {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		task: "one-off review",
		confirmSessionAttach: true,
	});
	const result = await tool.execute("call-stateless", rawStateless, undefined, (update: any) => statelessUpdates.push(update), context());

	assert.deepEqual(statelessModels, [railModel]);
	assert.equal(broker.requests.length, 0);
	assert.match(result.content[0].text, /Stateless model session cus-resp\/gpt-5\.6-sol:xhigh completed/);
	assert.equal(result.details.results[0].persistent, false);
	assert.equal(statelessUpdates[0].details.results[0].model, "cus-resp/gpt-5.6-sol:xhigh");
	assert.equal(statelessUpdates[0].details.results[0].persistent, false);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const rendered = tool.renderCall({
		model: "cus-resp/gpt-5.6-sol:xhigh",
		target: "",
		alias: "",
		task: "one-off review",
		session: { mode: "fork", path: "" },
		control: { delivery: "steer", message: "" },
		tasks: [],
		chain: [],
	}, theme).render(100).join("\n");
	assert.match(rendered, /stateless · cus-resp\/gpt-5\.6-sol:xhigh/);
	assert.doesNotMatch(rendered, /contextWindow default|budget/);
	assert.doesNotMatch(rendered, /control|persistent new/);
});

test("omitting model uses the current Pi model for stateless work", async () => {
	let selected: unknown;
	const { tool } = setupTool({
		runStateless: async (request) => {
			selected = request.model;
			return { output: "done", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } };
		},
	});

	await tool.execute("call-current", { task: "quick check" }, undefined, undefined, context());

	assert.deepEqual(selected, railModel);
});

test("parallel mode allows one model to back stateless and persistent sessions", async () => {
	const statelessTasks: string[] = [];
	const { tool, broker } = setupTool({
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

test("forwards contextWindow only as per-task execution metadata", async () => {
	const statelessWindows: Array<number | undefined> = [];
	const { tool, broker } = setupTool({
		runStateless: async (request) => {
			statelessWindows.push(request.contextWindow);
			return { output: "stateless", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } };
		},
	});
	const result = await tool.execute("context-window-forwarding", {
		tasks: [
			{ task: "stateless budget", contextWindow: 64_000 },
			{ alias: "persistent-budget", task: "persistent budget", contextWindow: 128_000 },
		],
	}, undefined, undefined, context());

	assert.deepEqual(statelessWindows, [64_000]);
	assert.equal(broker.requests[0]?.contextWindow, 128_000);
	assert.equal("contextWindow" in result.details.results[0], false);
	assert.equal("contextWindow" in result.details.results[1], false);

	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const args = {
		tasks: [
			{ task: "stateless budget", contextWindow: 64_000 },
			{ alias: "persistent-budget", task: "persistent budget", contextWindow: 128_000 },
		],
	};
	const call = tool.renderCall(args, theme).render(140).join("\n");
	assert.match(call, /budget 1=64K, 2=128K/);
	const panel = tool.renderResult(result, { expanded: false }, theme, { args }).render(160).join("\n");
	assert.match(panel, /cus-resp\/gpt-5\.6-sol #1 · one-off · cus-resp\/gpt-5\.6-sol:xhigh · budget 64K/);
	assert.match(panel, /persistent-budget · persistent · cus-resp\/gpt-5\.6-sol:xhigh · budget 128K/);
});

test("null contextWindow uses the native default without forwarding a temporary budget", async () => {
	const statelessWindows: Array<{ hasValue: boolean; value: number | undefined }> = [];
	const { tool, broker } = setupTool({
		runStateless: async (request) => {
			statelessWindows.push({ hasValue: Object.hasOwn(request, "contextWindow"), value: request.contextWindow });
			return {
				output: `done: ${request.task}`,
				exitCode: 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			};
		},
	});
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

	const singleArgs = { task: "single default", contextWindow: null };
	const single = await tool.execute("null-single-window", singleArgs, undefined, undefined, context());
	assert.doesNotMatch(tool.renderCall(singleArgs, theme).render(100).join("\n"), /contextWindow default|budget/);
	assert.doesNotMatch(tool.renderResult(single, { expanded: false }, theme, { args: singleArgs }).render(140).join("\n"), /contextWindow default|budget/);

	const groupedArgs = {
		contextWindow: null,
		tasks: [
			{ task: "parallel default", contextWindow: null },
			{ alias: "persistent-default", task: "persistent default", contextWindow: null },
		],
	};
	await tool.execute("null-parallel-window", groupedArgs, undefined, undefined, context());
	assert.doesNotMatch(tool.renderCall(groupedArgs, theme).render(140).join("\n"), /contextWindow default|budget/);
	assert.equal(Object.hasOwn(broker.requests[0]!, "contextWindow"), false);

	await tool.execute("null-chain-window", {
		contextWindow: null,
		chain: [
			{ task: "chain first", contextWindow: null },
			{ task: "chain second {previous}", contextWindow: null },
		],
	}, undefined, undefined, context());

	assert.deepEqual(statelessWindows, [
		{ hasValue: false, value: undefined },
		{ hasValue: false, value: undefined },
		{ hasValue: false, value: undefined },
		{ hasValue: false, value: undefined },
	]);
});

test("context window display omits omitted single and grouped budgets", async () => {
	const { tool } = setupTool({
		runStateless: async () => ({
			output: "done",
			exitCode: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		}),
	});
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

	const singleArgs = { task: "default single" };
	const single = await tool.execute("default-single-window", singleArgs, undefined, undefined, context());
	assert.doesNotMatch(tool.renderCall(singleArgs, theme).render(100).join("\n"), /contextWindow default|budget/);
	assert.doesNotMatch(
		tool.renderResult(single, { expanded: false }, theme, { args: singleArgs }).render(140).join("\n"),
		/contextWindow default|budget/,
	);

	const groupedArgs = { tasks: [{ task: "default child" }, { task: "explicit child", contextWindow: 65_536 }] };
	const grouped = await tool.execute("mixed-context-window-display", groupedArgs, undefined, undefined, context());
	assert.match(tool.renderCall(groupedArgs, theme).render(140).join("\n"), /budget 2=65\.536K/);
	const groupedPanel = tool.renderResult(grouped, { expanded: false }, theme, { args: groupedArgs }).render(160).join("\n");
	assert.equal((groupedPanel.match(/budget default/gu) ?? []).length, 0);
	assert.equal((groupedPanel.match(/budget 65\.536K/gu) ?? []).length, 1);
});

test("chain mode preserves ordering and substitutes the previous final output", async () => {
	const { tool, broker } = setupTool();

	const result = await tool.execute("call-chain", {
		chain: [
			{ model: "cus-resp/gpt-5.6-sol:xhigh", alias: "planner", task: "make a plan" },
			{ model: "cus-resp/gpt-5.6-sol:xhigh", alias: "reviewer", task: "review this: {previous}" },
		],
	}, undefined, undefined, context());

	assert.equal(result.details.mode, "chain");
	assert.deepEqual(broker.requests.map((request) => request.task), [
		"make a plan",
		"review this: done: make a plan",
	]);
	assert.deepEqual(result.details.results.map((item: any) => item.step), [1, 2]);
	assert.match(result.content[0].text, /Chain: 2\/2 succeeded/);
});

test("chain rendering uses the full substituted task cached by tool call and slot", async () => {
	const updates: any[] = [];
	const { tool, hook } = setupTool({
		runStateless: async (request) => {
			const transcript = new SubagentTranscript(request.task);
			request.onUpdate?.({
				output: `partial: ${request.task}`,
				exitCode: 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				transcript: transcript.snapshot(),
			});
			return {
				output: `done: ${request.task}`,
				exitCode: 0,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
				transcript: transcript.snapshot(),
			};
		},
	});
	const args = {
		chain: [
			{ model: "cus-resp/gpt-5.6-sol:xhigh", task: "first result" },
			{ model: "cus-resp/gpt-5.6-sol:xhigh", task: `REPLACED TASK START\nreview {previous}\n${"r".repeat(10_000)}\nREPLACED TASK END` },
		],
	};
	const result = await tool.execute("chain-render-cache", args, undefined, (update: any) => updates.push(update), context());
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	hook?.({ toolName: "subagent", toolCallId: "chain-render-cache", isError: false });
	const panel = tool.renderResult(result, { expanded: false }, theme, {
		args,
		toolCallId: "chain-render-cache",
	}).render(120).join("\n");
	const restoredWithoutCache = tool.renderResult(structuredClone(result), { expanded: false }, theme, {
		args,
		toolCallId: "different-call",
	}).render(120).join("\n");

	assert.ok(updates.some((update) => update.details.results.some((run: any) => run.task.includes("REPLACED TASK START"))));
	assert.ok(Buffer.byteLength(result.details.results[1].task, "utf8") <= 8 * 1024);
	assert.match(panel, /REPLACED TASK START/);
	assert.match(panel, /REPLACED TASK END/);
	assert.doesNotMatch(panel, /review \{previous\}/);
	assert.doesNotMatch(restoredWithoutCache, /REPLACED TASK END/);
});

test("restored results without Tool args preserve the transcript initial entry", () => {
	const { tool } = setupTool();
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const transcript = new SubagentTranscript("TRANSCRIPT INITIAL TASK").snapshot();
	const result = {
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "single",
			durationMs: 10,
			results: [{
				alias: "restored",
				model: "provider/model",
				status: "completed",
				output: "done",
				persistent: false,
				task: "DIFFERENT BOUNDED TASK FIELD",
				transcript,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
				durationMs: 10,
			}],
		},
	};
	const panel = tool.renderResult(result, { expanded: false }, theme).render(120).join("\n");

	assert.match(panel, /TRANSCRIPT INITIAL TASK/);
	assert.doesNotMatch(panel, /DIFFERENT BOUNDED TASK FIELD/);
});

test("details mode keeps one-result parallel and chain results in grouped panels", () => {
	const { tool } = setupTool();
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const parallelArgs = { tasks: [{ task: "one parallel task" }] };
	const parallel = {
		content: [{ type: "text", text: "parallel" }],
		details: {
			mode: "parallel",
			durationMs: 100,
			results: [{ alias: "parallel-one", model: "provider/model", status: "completed", output: "parallel done", persistent: false, task: "one parallel task", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 12, turns: 1 }, durationMs: 100, slot: 0 }],
		},
	};
	const parallelPanel = tool.renderResult(parallel, { expanded: false }, theme, { args: parallelArgs }).render(120).join("\n");
	assert.match(parallelPanel, /1 model session · 1 complete/);
	assert.match(parallelPanel, /╭/);
	assert.match(parallelPanel, /parallel-one/);

	const chainArgs = { chain: [{ task: "first" }, { task: "second {previous}" }] };
	const chain = {
		content: [{ type: "text", text: "chain" }],
		details: {
			mode: "chain",
			durationMs: 100,
			results: [{ alias: "chain-one", model: "provider/model", status: "failed", output: "failed", persistent: false, task: "first", step: 1, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 12, turns: 1 }, durationMs: 100, slot: 0, stopReason: "error", errorMessage: "failed" }],
		},
	};
	const chainPanel = tool.renderResult(chain, { expanded: false }, theme, { args: chainArgs }).render(120).join("\n");
	assert.match(chainPanel, /1 model session · 0 complete · 0 running · 1 failed/);
	assert.match(chainPanel, /1\/2 · chain-one/);
	assert.match(chainPanel, /╭/);
});

test("parallel streaming updates retain the recent transcript from every active child", async () => {
	const updates: any[] = [];
	const { tool } = setupTool({
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
	let confirmations = 0;
	const { tool, broker } = setupTool();
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

test("a later parallel slot keeps its own initial task while an earlier worker starts", async () => {
	const { tool, broker } = setupTool({
		runStateless: async () => ({ exitCode: 0, output: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } }),
	});
	const dispatch = broker.dispatch.bind(broker);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	broker.dispatch = async (request) => { await gate; return dispatch(request); };
	const args = { tasks: [{ alias: "slow", task: "SLOW PERSISTENT TASK" }, { task: "FAST STATELESS TASK" }] };
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	let fastPanel = "";
	const pending = tool.execute("parallel-slots", args, undefined, (result: any) => {
		if (result.details.results.length === 1 && !result.details.results[0].persistent) {
			fastPanel = tool.renderResult(result, { expanded: false, isPartial: true }, theme, { args }).render(100).join("\n");
		}
	}, context());
	try {
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(fastPanel, /FAST STATELESS TASK/);
		assert.doesNotMatch(fastPanel, /SLOW PERSISTENT TASK/);
	} finally {
		release();
		await pending;
	}
});

test("normalization trims placeholders for single, parallel, and chain and keeps task text intact", async () => {
	const { tool } = setupTool();

	assert.deepEqual(tool.prepareArguments({
		model: " cus-resp/gpt-5.6-sol:xhigh ",
		target: "",
		alias: "   ",
		task: "  keep my spaces  ",
		cwd: " /tmp/x ",
		session: { mode: "fork", path: " " },
		control: { delivery: "steer", message: "" },
		tasks: [],
		chain: [],
	}), {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		task: "  keep my spaces  ",
		cwd: "/tmp/x",
	});
	assert.deepEqual(tool.prepareArguments({
		model: null,
		target: null,
		alias: null,
		task: "null placeholders stay gone",
		cwd: null,
		session: null,
		control: null,
		tasks: [],
		chain: [],
	}), {
		task: "null placeholders stay gone",
	});
	assert.deepEqual(tool.prepareArguments({
		contextWindow: null,
		tasks: [
			{ model: "", target: " keep-target ", alias: " ", task: "alpha", cwd: " ", session: { mode: "fork", path: "  " }, contextWindow: null },
		],
	}), {
		tasks: [{ target: "keep-target", task: "alpha" }],
	});
	assert.deepEqual(tool.prepareArguments({
		contextWindow: null,
		chain: [{ model: " m ", alias: " a ", task: "chain task", cwd: "", contextWindow: null }],
	}), {
		chain: [{ model: "m", alias: "a", task: "chain task" }],
	});
});

test("validates every contextWindow before any parallel or chain dispatch", async () => {
	const { tool, broker } = setupTool({
		runStateless: async () => ({
			output: "unexpected",
			exitCode: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		}),
	});

	await assert.rejects(() => tool.execute("invalid-parallel-window", {
		tasks: [
			{ task: "first", contextWindow: 64_000 },
			{ task: "invalid", contextWindow: 1.5 as any },
			{ task: "third", alias: "persistent", contextWindow: 128_000 },
		],
	}, undefined, undefined, context()), /contextWindow/);
	assert.equal(broker.requests.length, 0);

	await assert.rejects(() => tool.execute("invalid-chain-window", {
		chain: [
			{ task: "first", contextWindow: 64_000 },
			{ task: "invalid", contextWindow: "128000" as any },
		],
	}, undefined, undefined, context()), /contextWindow/);
	assert.equal(broker.requests.length, 0);

	await assert.rejects(() => tool.execute("invalid-target-parallel-window", {
		tasks: [
			{ target: "existing", task: "invalid target budget", contextWindow: 1 },
			{ task: "must not start", contextWindow: 64_000 },
		],
	}, undefined, undefined, context()), /reserveTokens/);
	assert.equal(broker.requests.length, 0);
});

test("an aborted single call throws before dispatch and restores aborted details", async () => {
	const { tool, broker, hook } = setupTool();
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(() => tool.execute("call-aborted-single", {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		task: "never runs",
	}, controller.signal, undefined, context()), /aborted before dispatch/);
	assert.equal(broker.requests.length, 0);
	const restored = hook?.({ toolName: "subagent", toolCallId: "call-aborted-single", isError: true });
	assert.equal(restored.details.mode, "single");
	assert.equal(restored.details.results[0].status, "failed");
	assert.equal(restored.details.results[0].stopReason, "aborted");
	assert.match(restored.details.results[0].errorMessage, /aborted before dispatch/);
});

test("an aborted chain stops immediately and dispatches no persistent sessions", async () => {
	const { tool, broker } = setupTool();
	const controller = new AbortController();
	controller.abort();

	const result = await tool.execute("call-aborted-chain", {
		chain: [
			{ model: "cus-resp/gpt-5.6-sol:xhigh", alias: "step-one", task: "first" },
			{ model: "cus-resp/gpt-5.6-sol:xhigh", alias: "step-two", task: "second" },
		],
	}, controller.signal, undefined, context());

	assert.equal(broker.requests.length, 0);
	assert.equal(result.details.mode, "chain");
	assert.equal(result.details.results.length, 1);
	assert.equal(result.details.results[0].status, "failed");
	assert.equal(result.details.results[0].stopReason, "aborted");
	assert.equal(result.details.results[0].step, 1);
	assert.match(result.content[0].text, /Chain: 0\/1 succeeded/);
});

test("a single persistent failure throws and restores failed details with error status", async () => {
	const { tool, broker, hook } = setupTool();
	broker.dispatch = async (request) => {
		broker.requests.push(request);
		throw new Error("persistent broke");
	};

	await assert.rejects(() => tool.execute("call-fail-single", {
		model: "cus-resp/gpt-5.6-sol:xhigh",
		alias: "fragile",
		task: "do work",
	}, undefined, undefined, context()), /persistent broke/);

	assert.equal(broker.requests.length, 1);
	assert.equal(broker.requests[0]?.alias, "fragile");
	assert.equal(broker.requests[0]?.task, "do work");
	const restored = hook?.({ toolName: "subagent", toolCallId: "call-fail-single", isError: true });
	assert.equal(restored.details.mode, "single");
	assert.equal(restored.details.results[0].status, "failed");
	assert.equal(restored.details.results[0].stopReason, "error");
	assert.equal(restored.details.results[0].persistent, true);
	assert.match(restored.details.results[0].errorMessage, /persistent broke/);
	assert.deepEqual(restored.details.results[0].usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
});

test("parallel aggregates failed and completed results without throwing", async () => {
	const { tool, broker } = setupTool({
		runStateless: async () => ({ exitCode: 0, output: "stateless done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 } }),
	});
	broker.dispatch = async (request) => {
		broker.requests.push(request);
		throw new Error("persistent broke");
	};

	const result = await tool.execute("call-mixed-fail", {
		tasks: [
			{ task: "quick" },
			{ model: "cus-resp/gpt-5.6-sol:xhigh", alias: "fragile", task: "broken" },
		],
	}, undefined, undefined, context());

	assert.equal(result.details.mode, "parallel");
	assert.equal(result.details.results.length, 2);
	assert.deepEqual(broker.requests.map((request) => request.task), ["broken"]);
	assert.deepEqual(result.details.results.map((item: any) => item.status).sort(), ["completed", "failed"]);
	assert.equal(result.details.results[1].status, "failed");
	assert.equal(result.details.results[1].stopReason, "error");
	assert.equal(result.details.results[1].persistent, true);
	assert.match(result.details.results[1].errorMessage, /persistent broke/);
	assert.match(result.content[0].text, /Parallel: 1\/2 succeeded/);
});

test("chain stops at the first failed step after substituting {previous}", async () => {
	const { tool, broker } = setupTool();
	const dispatch = broker.dispatch.bind(broker);
	broker.dispatch = async (request) => {
		if (request.task.includes("STEP TWO")) {
			broker.requests.push(request);
			throw new Error("step two broke");
		}
		return dispatch(request);
	};

	const result = await tool.execute("call-chain-fail", {
		chain: [
			{ model: "cus-resp/gpt-5.6-sol:xhigh", alias: "one", task: "STEP ONE" },
			{ model: "cus-resp/gpt-5.6-sol:xhigh", alias: "two", task: "STEP TWO {previous}" },
			{ model: "cus-resp/gpt-5.6-sol:xhigh", alias: "three", task: "STEP THREE" },
		],
	}, undefined, undefined, context());

	assert.deepEqual(broker.requests.map((request) => request.task), [
		"STEP ONE",
		"STEP TWO done: STEP ONE",
	]);
	assert.deepEqual(result.details.results.map((item: any) => item.status), ["completed", "failed"]);
	assert.deepEqual(result.details.results.map((item: any) => item.step), [1, 2]);
	assert.match(result.details.results[1].errorMessage, /step two broke/);
	assert.match(result.content[0].text, /Chain: 1\/2 succeeded/);
});

test("single, parallel, and chain carry per-mode alias and step for the same stateless run", async () => {
	const expectedUsage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.2, contextTokens: 7, turns: 1 };
	const { tool } = setupTool({
		runStateless: async () => ({ exitCode: 0, output: "shared output", usage: { ...expectedUsage } }),
	});
	const cases = [
		{ mode: "single", args: { model: "cus-resp/gpt-5.6-sol:xhigh", task: "equiv task" }, alias: "cus-resp/gpt-5.6-sol", step: undefined as number | undefined },
		{ mode: "parallel", args: { tasks: [{ model: "cus-resp/gpt-5.6-sol:xhigh", task: "equiv task" }] }, alias: "cus-resp/gpt-5.6-sol #1", step: undefined as number | undefined },
		{ mode: "chain", args: { chain: [{ model: "cus-resp/gpt-5.6-sol:xhigh", task: "equiv task" }] }, alias: "cus-resp/gpt-5.6-sol #1", step: 1 },
	];
	for (const { mode, args, alias, step } of cases) {
		const result = await tool.execute(`call-equiv-${mode}`, args, undefined, undefined, context());
		assert.equal(result.details.mode, mode);
		const run = result.details.results[0]!;
		assert.equal(run.alias, alias);
		assert.equal(run.model, "cus-resp/gpt-5.6-sol:xhigh");
		assert.equal(run.task, "equiv task");
		assert.equal(run.status, "completed");
		assert.equal(run.output, "shared output");
		assert.deepEqual(run.usage, expectedUsage);
		assert.equal(run.persistent, false);
		assert.equal(run.stopReason, undefined);
		assert.equal(run.errorMessage, undefined);
		assert.equal(typeof run.durationMs, "number");
		assert.equal(Object.hasOwn(run, "step"), mode === "chain");
		assert.equal(run.step, step);
	}
});
