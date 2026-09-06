import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { RailAgentOverlayComponent } from "../../tools/subagents/rail-agent-overlay";
import { RailAgentManager } from "../../tools/subagents/agent-manager";
import type { RailModelRef } from "../../tools/subagents/models";

const piModel = {
	provider: "cus-resp",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16000,
};
const deepseekModel = { ...piModel, provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" };
const models: [RailModelRef, RailModelRef] = [
	{ provider: "cus-resp", modelId: "gpt-5.6-sol", name: "GPT 5.6 Sol", thinkingLevel: "xhigh" as const },
	{ provider: "deepseek", modelId: "deepseek-v4-flash", name: "DeepSeek V4 Flash", thinkingLevel: "high" as const },
];
const snapshot = {
	agents: [{
		instance: {
			version: 2 as const,
			agentId: "agt_auth",
			alias: "auth-review",
			model: models[0],
			sessionId: "child-session",
			sessionFile: "/tmp/auth.jsonl",
			cwd: "/tmp/project",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			lastTask: "Review authentication",
		},
		linkedAliases: ["auth-review"],
		linkedToCurrentSession: true,
		phase: "idle" as const,
		queued: 0,
	}],
	counts: { linked: 1, global: 1, running: 0, queued: 0, idle: 1, stopped: 0, inUseElsewhere: 0, errors: 0 },
};

function setup(phase: "idle" | "running" = "idle", terminalRows = 30) {
	let renders = 0;
	let closed = false;
	const currentSnapshot: any = structuredClone(snapshot);
	currentSnapshot.agents[0]!.phase = phase;
	currentSnapshot.counts.running = phase === "running" ? 1 : 0;
	currentSnapshot.counts.idle = phase === "idle" ? 1 : 0;
	const controls: unknown[] = [];
	const sessions = [{
		path: "/tmp/saved.jsonl", id: "saved-session", cwd: "/tmp/other",
		created: new Date("2026-01-01"), modified: new Date("2026-01-02"), messageCount: 2,
		name: "Saved Auth", firstMessage: "Review auth", allMessagesText: "Review auth",
	}];
	const manager = {
		snapshot: async () => currentSnapshot,
		subscribe: () => () => undefined,
		changeModel: async () => snapshot.agents[0]!.instance,
		link: async () => snapshot.agents[0]!.instance,
		stop: async () => snapshot.agents[0]!.instance,
		detach: async () => snapshot.agents[0]!.instance,
		create: async () => ({ instance: snapshot.agents[0]!.instance, run: { output: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } } }),
		adopt: async () => snapshot.agents[0]!.instance,
		control: async (target: string, request: unknown) => { controls.push({ target, request }); return { instance: currentSnapshot.agents[0]!.instance, delivery: "steer" }; },
	};
	const ctx = {
		cwd: "/tmp/project",
		model: piModel,
		thinkingLevel: "xhigh",
		modelRegistry: {
			find: (provider: string, id: string) => [piModel, deepseekModel].find((model) => model.provider === provider && model.id === id),
		},
		sessionManager: { getSessionId: () => "parent-session" },
		ui: { confirm: async () => true },
	};
	const keybindings = {
		matches: (data: string, id: string) => {
			if (id === "tui.select.up") return data === "\u001b[A";
			if (id === "tui.select.down") return data === "\u001b[B";
			if (id === "tui.select.confirm") return data === "\r";
			if (id === "tui.select.cancel") return data === "\u001b";
			return false;
		},
	};
	const component = new RailAgentOverlayComponent(
		{ terminal: { rows: terminalRows }, requestRender: () => { renders++; } } as any,
		{
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as any,
		keybindings as any,
		() => { closed = true; },
		ctx as any,
		{
			manager: manager as any,
			models,
			sessions,
			currentCwd: "/tmp/project",
			insertMention: () => undefined,
		},
		currentSnapshot,
	);
	return { component, controls, manager, sessions, get renders() { return renders; }, get closed() { return closed; } };
}

for (const mode of ["fork", "exclusive"] as const) test(`${mode} ${mode === "fork" ? "copies" : "links"} an already managed session`, async () => {
	const state = setup();
	const adopted: any[] = [];
	let linked = 0;
	state.sessions[0]!.path = snapshot.agents[0]!.instance.sessionFile;
	state.manager.link = async () => { linked++; return snapshot.agents[0]!.instance; };
	state.manager.adopt = (async (request: unknown) => {
		adopted.push(request);
		return snapshot.agents[0]!.instance;
	}) as typeof state.manager.adopt;
	try {
		const ui = state.component;
		ui.handleInput("n");
		ui.handleInput("\r");
		for (let index = 0; index < 4; index++) ui.handleInput("\u001b[B");
		ui.handleInput("\r");
		ui.handleInput("\r");
		ui.handleInput("\u001b[B");
		if (mode === "exclusive") ui.handleInput("\r");
		for (let index = 0; index < 3; index++) ui.handleInput("\u001b[B");
		ui.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(adopted.length, mode === "fork" ? 1 : 0);
		assert.equal(linked, mode === "exclusive" ? 1 : 0);
		if (mode === "fork") assert.deepEqual(adopted[0].session, { mode: "fork", path: "/tmp/auth.jsonl" });
		assert.match(ui.render(100).join("\n"), mode === "fork" ? /a safe copy/ : /Linked existing Rail agent/);
	} finally {
		state.component.dispose();
	}
});

test("Create & Run displays a provider failure instead of reporting success", async () => {
	const state = setup();
	const manager = new RailAgentManager({
		dispatch: async () => ({
			instance: snapshot.agents[0]!.instance,
			run: { output: "", stopReason: "error", errorMessage: "HTTP 401" },
		}),
	} as any, {} as any, {} as any, "/tmp");
	state.manager.create = manager.create.bind(manager) as typeof state.manager.create;
	try {
		const ui = state.component;
		ui.handleInput("n");
		for (let index = 0; index < 5; index++) ui.handleInput("\u001b[B");
		ui.handleInput("\r");
		ui.handleInput("review");
		ui.handleInput("\r");
		ui.handleInput("\u001b[B");
		ui.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(ui.render(100).join("\n"), /HTTP 401/);
		assert.doesNotMatch(ui.render(100).join("\n"), /Created /);
	} finally {
		state.component.dispose();
	}
});

test("Rail agent overlay shows current/global counts and truthful worker status", () => {
	const state = setup();
	try {
		const lines = state.component.render(100);
		const text = lines.join("\n");
		assert.match(text, /Current 1/);
		assert.match(text, /All 1/);
		assert.match(text, /0 running · 0 queued · 1 idle/);
		assert.match(text, /auth-review/);
		assert.match(text, /IDLE/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 100));
	} finally {
		state.component.dispose();
	}
});

test("model and saved-session choices open as searchable inline pickers", () => {
	const state = setup();
	try {
		state.component.handleInput("\u001b[C");
		state.component.handleInput("\u001b[C");
		state.component.handleInput("\u001b[B");
		state.component.handleInput("\u001b[B");
		state.component.handleInput("\r");
		assert.match(state.component.render(100).join("\n"), /Select model/);
		for (const char of "deepseek") state.component.handleInput(char);
		assert.match(state.component.render(100).join("\n"), /deepseek\/deepseek-v4-flash/);
		state.component.handleInput("\u001b");

		state.component.handleInput("\u001b[A");
		state.component.handleInput("\u001b[A");
		state.component.handleInput("\r");
		for (let index = 0; index < 4; index++) state.component.handleInput("\u001b[B");
		state.component.handleInput("\r");
		assert.match(state.component.render(100).join("\n"), /Select saved session/);
		assert.match(state.component.render(100).join("\n"), /Saved Auth/);
		assert.ok(state.renders > 0);
	} finally {
		state.component.dispose();
	}
});

test("saved-session search matches words across title, message, cwd, and id from the unified overlay", async () => {
	const state = setup();
	state.sessions.splice(0, state.sessions.length,
		{
			path: "/tmp/auth.jsonl", id: "session-auth", cwd: "/tmp/project", name: "Security review",
			created: new Date("2026-01-01"), modified: new Date("2026-01-02"), messageCount: 2,
			firstMessage: "Inspect login races", allMessagesText: "Inspect login races",
		},
		{
			path: "/tmp/db.jsonl", id: "session-db", cwd: "/tmp/database", name: "Storage",
			created: new Date("2026-01-01"), modified: new Date("2026-01-03"), messageCount: 1,
			firstMessage: "Tune indexes", allMessagesText: "Tune indexes",
		},
	);
	try {
		const ui = state.component;
		ui.handleInput("\u001b[C");
		ui.handleInput("\u001b[C");
		ui.handleInput("\r");
		for (let index = 0; index < 4; index++) ui.handleInput("\u001b[B");
		ui.handleInput("\r");
		assert.match(ui.render(100).join("\n"), /Select saved session/);

		// One multi-token query spanning title, first message, cwd, and id.
		for (const char of "security login project session") ui.handleInput(char);
		let text = ui.render(100).join("\n");
		assert.match(text, /Security review/);
		assert.doesNotMatch(text, /Storage|Tune indexes/);

		ui.handleInput("\r");
		text = ui.render(100).join("\n");
		assert.doesNotMatch(text, /Select saved session/);
		assert.match(text, /Security review/);

		// A second search across cwd and message finds the other session.
		ui.handleInput("\r");
		for (const char of "database indexes") ui.handleInput(char);
		text = ui.render(100).join("\n");
		assert.match(text, /database · Storage/);
		assert.doesNotMatch(text, /Security review/);

		// Cancelling the search keeps the earlier selection.
		ui.handleInput("\u001b");
		text = ui.render(100).join("\n");
		assert.doesNotMatch(text, /Select saved session/);
		assert.match(text, /Security review/);
	} finally {
		state.component.dispose();
	}
});

test("running agents accept inline steer and follow-up controls", async () => {
	const state = setup("running");
	try {
		state.component.handleInput("g");
		assert.match(state.component.render(100).join("\n"), /Steer auth-review/);
		for (const char of "Focus on tests") state.component.handleInput(char);
		state.component.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));

		state.component.handleInput("f");
		assert.match(state.component.render(100).join("\n"), /Follow-up auth-review/);
		for (const char of "Then summarize risks") state.component.handleInput(char);
		state.component.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(state.controls, [
			{ target: "agt_auth", request: { delivery: "steer", message: "Focus on tests" } },
			{ target: "agt_auth", request: { delivery: "followUp", message: "Then summarize risks" } },
		]);
	} finally {
		state.component.dispose();
	}
});

test("idle agents reject live controls and direct the user to continue", () => {
	const state = setup("idle");
	try {
		state.component.handleInput("g");
		const text = state.component.render(100).join("\n");
		assert.match(text, /Live controls require a running local agent/);
		assert.doesNotMatch(text, /Steer auth-review/);
		assert.deepEqual(state.controls, []);
	} finally {
		state.component.dispose();
	}
});

test("short terminals keep the inline control input visible", () => {
	const state = setup("running", 15);
	try {
		state.component.focused = true;
		state.component.handleInput("g");
		const lines = state.component.render(100);
		assert.ok(lines.length <= 13);
		assert.match(lines.join("\n"), /Steer auth-review/);
		assert.match(lines.join("\n"), /Message:/);
		assert.equal(lines.some((line) => line.includes(CURSOR_MARKER)), true);
	} finally {
		state.component.dispose();
	}
});

test("escape cancels a control that has not been delivered yet", async () => {
	const state = setup("running");
	let delivered = false;
	state.manager.control = async (_target: string, _request: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			delivered = true;
			resolve({ instance: snapshot.agents[0]!.instance, delivery: "steer" });
		}, 50);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Subagent control was aborted before delivery"));
		}, { once: true });
	});
	try {
		state.component.handleInput("g");
		for (const char of "Focus on tests") state.component.handleInput(char);
		state.component.handleInput("\r");
		state.component.handleInput("\u001b");
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(delivered, false);
		assert.match(state.component.render(100).join("\n"), /aborted before delivery/);
	} finally {
		state.component.dispose();
	}
});
