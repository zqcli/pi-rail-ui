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

test("Rail subagent installer exposes only Rail-namespaced slash commands", () => {
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

	assert.deepEqual(commands, ["rail-team", "rail-agent"]);
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

for (const mode of ["rpc", "print"] as const) {
	test(`/rail-agent only warns outside the TUI (${mode})`, async () => {
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const ctx = {
			mode, hasUI: mode === "rpc",
			ui: {
				notify: (message: string, type?: string) => notifications.push({ message, type }),
				select: async () => { throw new Error("no fallback menu"); },
				custom: async () => { throw new Error("no overlay"); },
			},
		};
		await runRailAgentManager(ctx as any, {});
		assert.deepEqual(notifications, [{
			message: "/rail-agent requires the interactive TUI; use the subagent tool (or @agent/<alias>) instead.",
			type: "warning",
		}]);
	});
}

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
	} as any, { listSessions: async () => { listSessionCalls++; return [savedSession]; } });

	assert.equal(overlayOptions.length, 1);
	assert.equal(overlayOptions[0].overlay, true);
	assert.equal(overlayOptions[0].overlayOptions.anchor, "center");
	assert.equal(overlayOptions[0].overlayOptions.width, "92%");
	assert.equal(listSessionCalls, 0);
});
