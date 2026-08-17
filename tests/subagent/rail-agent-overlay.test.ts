import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RailAgentOverlayComponent } from "../../subagent/rail-agent-overlay";
import type { RailModelRef } from "../../subagent/models";

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

function setup() {
	let renders = 0;
	let closed = false;
	const manager = {
		snapshot: async () => snapshot,
		subscribe: () => () => undefined,
		changeModel: async () => snapshot.agents[0]!.instance,
		link: async () => snapshot.agents[0]!.instance,
		stop: async () => snapshot.agents[0]!.instance,
		detach: async () => snapshot.agents[0]!.instance,
		create: async () => ({ instance: snapshot.agents[0]!.instance, run: { output: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } } }),
		adopt: async () => snapshot.agents[0]!.instance,
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
		{ requestRender: () => { renders++; } } as any,
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
			sessions: [{
				path: "/tmp/saved.jsonl", id: "saved-session", cwd: "/tmp/other",
				created: new Date("2026-01-01"), modified: new Date("2026-01-02"), messageCount: 2,
				name: "Saved Auth", firstMessage: "Review auth", allMessagesText: "Review auth",
			}],
			currentCwd: "/tmp/project",
			insertMention: () => undefined,
		},
		snapshot,
	);
	return { component, get renders() { return renders; }, get closed() { return closed; } };
}

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
