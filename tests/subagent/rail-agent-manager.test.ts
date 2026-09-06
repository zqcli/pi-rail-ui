import assert from "node:assert/strict";
import { test } from "node:test";
import { installRailSubagent } from "../../tools/subagents";
import { runRailAgentManager } from "../../tools/subagents/rail-agent-manager";

const model = {
	provider: "cus-resp",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
};

function modelContext() {
	return {
		model,
		thinkingLevel: "xhigh",
		scopedModels: [{ model, thinkingLevel: "xhigh" }],
		modelRegistry: { getAvailable: () => [model] },
	};
}

const savedSession = {
	path: "/tmp/saved.jsonl",
	id: "saved-session",
	cwd: "/tmp/project",
	created: new Date("2026-01-01"),
	modified: new Date("2026-01-02"),
	messageCount: 4,
	firstMessage: "Review auth",
	allMessagesText: "Review auth",
};

function rpcSetup(select: (title: string, options: string[]) => unknown, context = modelContext()) {
	const state = {
		editorText: "",
		attached: [] as any[],
		selectTitles: [] as string[],
		selectOptions: [] as string[][],
		confirmations: 0,
		managed: [] as any[],
	};
	const ctx = {
		...context,
		mode: "rpc",
		cwd: "/tmp/project",
		hasUI: true,
		sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
		ui: {
			select: async (title: string, options: string[]) => {
				state.selectTitles.push(title);
				state.selectOptions.push(options);
				return select(title, options);
			},
			confirm: async () => { state.confirmations++; return true; },
			notify: () => undefined,
			setStatus: () => undefined,
			getEditorText: () => state.editorText,
			setEditorText: (value: string) => { state.editorText = value; },
		},
	};
	const runtime = {
		broker: {
			listLinked: async () => [],
			attach: async (request: any) => {
				state.attached.push(request);
				return { alias: request.alias, agentId: "agt_1" };
			},
		},
		roster: { link: () => undefined },
		store: { list: async () => state.managed },
	};
	return { ctx, runtime, state };
}

test("Rail subagent installer exposes only the Rail-namespaced slash command", () => {
	const commands: string[] = [];
	const previousDepth = process.env["PI_SUBAGENT_DEPTH"];
	process.env["PI_SUBAGENT_DEPTH"] = "0";
	try {
		installRailSubagent({
			registerTool: () => undefined,
			registerCommand: (name: string) => { commands.push(name); },
			on: () => undefined,
			appendEntry: () => undefined,
		} as any);
	} finally {
		if (previousDepth === undefined) delete process.env["PI_SUBAGENT_DEPTH"];
		else process.env["PI_SUBAGENT_DEPTH"] = previousDepth;
	}

	assert.deepEqual(commands, ["rail-agent"]);
});

test("Rail subagent registers an input hook and consumes direct controls before session start", async () => {
	let inputHandler: ((event: any, ctx: any) => Promise<unknown>) | undefined;
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const previousDepth = process.env["PI_SUBAGENT_DEPTH"];
	process.env["PI_SUBAGENT_DEPTH"] = "0";
	try {
		installRailSubagent({
			registerTool: () => undefined,
			registerCommand: () => undefined,
			on: (event: string, handler: (value: any, ctx: any) => Promise<unknown>) => {
				if (event === "input") inputHandler = handler;
			},
			appendEntry: () => undefined,
		} as any);
	} finally {
		if (previousDepth === undefined) delete process.env["PI_SUBAGENT_DEPTH"];
		else process.env["PI_SUBAGENT_DEPTH"] = previousDepth;
	}

	assert.ok(inputHandler);
	const result = await inputHandler!({
		type: "input",
		text: "@agent/auth-review steer Focus on tests",
		source: "interactive",
	}, {
		hasUI: true,
		ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
	});

	assert.deepEqual(result, { action: "handled" });
	assert.deepEqual(notifications, [{ message: "Persistent subagent runtime is not ready", type: "error" }]);
});

test("safe session linking selects a Pi model and defaults to fork", async () => {
	const { ctx, runtime, state } = rpcSetup((title, options) => {
		if (title === "Rail agents") return options.find((option) => option.startsWith("Link saved session"));
		return options[0];
	});
	state.managed.push({ alias: "existing", agentId: "agt_existing", sessionFile: "/tmp/saved.jsonl" });
	await runRailAgentManager(ctx as any, runtime as any, {
		listSessions: async () => [savedSession],
	});

	assert.deepEqual(state.selectTitles, ["Rail agents", "Saved Pi session", "Pi model"]);
	assert.equal(state.confirmations, 0);
	assert.equal(state.attached.length, 1);
	assert.deepEqual(state.attached[0].model, {
		provider: "cus-resp",
		modelId: "gpt-5.6-sol",
		name: "GPT 5.6 Sol",
		thinkingLevel: "xhigh",
	});
	assert.deepEqual(state.attached[0].session, { mode: "fork", path: "/tmp/saved.jsonl" });
	assert.match(state.attached[0].alias, /^gpt-5\.6-sol-/);
	assert.equal(state.editorText, `@agent/${state.attached[0].alias} `);
});

test("starting a persistent session selects a model and defers creation until task submission", async () => {
	const { ctx, runtime, state } = rpcSetup(
		(title, options) => title === "Rail agents" ? options.find((item) => item.startsWith("Start persistent")) : options[0],
	);
	await runRailAgentManager(ctx as any, runtime as any);

	assert.equal(state.attached.length, 0);
	assert.equal(state.editorText, "@new/cus-resp/gpt-5.6-sol:xhigh ");
});

for (const cancelled of [
	{
		name: "session menu",
		select: (title: string, options: string[]) => {
			if (title === "Rail agents") return options.find((option) => option.startsWith("Link saved session"));
			return undefined;
		},
	},
	{
		name: "model menu",
		select: (title: string, options: string[]) => {
			if (title === "Rail agents") return options.find((option) => option.startsWith("Link saved session"));
			if (title === "Saved Pi session") return options[0];
			return undefined;
		},
	},
] as const) {
	test(`RPC cancel at the ${cancelled.name} aborts safe-copy linking`, async () => {
		const { ctx, runtime, state } = rpcSetup(cancelled.select);
		await runRailAgentManager(ctx as any, runtime as any, {
			listSessions: async () => [savedSession],
		});

		assert.equal(state.attached.length, 0);
		assert.equal(state.editorText, "");
	});
}

test("RPC session menu resolves the chosen saved session by label", async () => {
	const sessions = [
		{
			path: "/tmp/first.jsonl", id: "first", cwd: "/tmp/project", name: "First",
			created: new Date("2026-01-01"), modified: new Date("2026-01-02"), messageCount: 1,
			firstMessage: "Alpha", allMessagesText: "Alpha",
		},
		{
			path: "/tmp/second.jsonl", id: "second", cwd: "/tmp/other", name: "Second",
			created: new Date("2026-01-01"), modified: new Date("2026-01-03"), messageCount: 2,
			firstMessage: "Beta", allMessagesText: "Beta",
		},
	];
	const { ctx, runtime, state } = rpcSetup((title, options) => {
		if (title === "Rail agents") return options.find((option) => option.startsWith("Link saved session"));
		if (title === "Saved Pi session") return options[1];
		return options[0];
	});
	await runRailAgentManager(ctx as any, runtime as any, { listSessions: async () => sessions });

	assert.equal(state.selectOptions.length, 3);
	assert.match(state.selectOptions[1]![0]!, /^1\. Current/);
	assert.equal(state.attached.length, 1);
	assert.deepEqual(state.attached[0].session, { mode: "fork", path: "/tmp/second.jsonl" });
	assert.match(state.editorText, /^@agent\//);
});

test("RPC model menu preserves model reference labels and resolution", async () => {
	const first = { provider: "cus-resp", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", thinkingLevel: "xhigh" };
	const second = { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", thinkingLevel: "high" };
	const { ctx, runtime, state } = rpcSetup((title, options) => {
		if (title === "Rail agents") return options.find((option) => option.startsWith("Start persistent"));
		assert.deepEqual(title, "Pi model");
		assert.equal(options[0], "cus-resp/gpt-5.6-sol:xhigh — GPT 5.6 Sol");
		assert.equal(options[1], "deepseek/deepseek-v4-flash:high — DeepSeek V4 Flash");
		return options[1];
	}, {
		model: first,
		thinkingLevel: "xhigh",
		scopedModels: [{ model: first, thinkingLevel: "xhigh" }, { model: second, thinkingLevel: "high" }],
		modelRegistry: { getAvailable: () => [first, second] },
	});
	await runRailAgentManager(ctx as any, runtime as any);

	assert.deepEqual(state.editorText, "@new/deepseek/deepseek-v4-flash:high ");
	assert.equal(state.attached.length, 0);
});

test("TUI management uses one centered unified overlay", async () => {
	const overlayOptions: any[] = [];
	let listSessionCalls = 0;
	const ctx = {
		...modelContext(),
		mode: "tui", cwd: "/tmp/project", hasUI: true,
		sessionManager: { getSessionFile: () => "/tmp/current.jsonl", getSessionId: () => "parent-session" },
		ui: {
			custom: async (_factory: unknown, options: unknown) => { overlayOptions.push(options); },
			confirm: async () => true,
			notify: () => undefined,
			getEditorText: () => "",
			setEditorText: () => undefined,
		},
	};
	await runRailAgentManager(ctx as any, {
		manager: {
			snapshot: async () => ({ agents: [], counts: { linked: 0, global: 0, running: 0, queued: 0, idle: 0, stopped: 0, inUseElsewhere: 0, errors: 0 } }),
			subscribe: () => () => undefined,
		},
		broker: { listLinked: async () => [] },
		roster: { link: () => undefined },
		store: { list: async () => [] },
	} as any, { listSessions: async () => { listSessionCalls++; return [savedSession]; } });

	assert.equal(overlayOptions.length, 1);
	assert.equal(overlayOptions[0].overlay, true);
	assert.equal(overlayOptions[0].overlayOptions.anchor, "center");
	assert.equal(overlayOptions[0].overlayOptions.width, "92%");
	assert.equal(listSessionCalls, 0);
});
