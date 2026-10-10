import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { RailAgentOverlayComponent, showRailAgentOverlay } from "../../tools/subagents/rail-agent-overlay";
import { RailAgentManager, type RailAgentView } from "../../tools/subagents/agent-manager";
import { railModelReference, type RailModelRef } from "../../tools/subagents/models";
import { prompt } from "../../core/prompts";
import { SessionBroker } from "../../tools/subagents/session-broker";
import { FileAgentInstanceStore } from "../../tools/subagents/instance-store";
import { SessionAgentRoster } from "../../tools/subagents/session-links";
import { loadoutFor } from "../fixtures/team-loadout";
import { createRpcWorkerFactory } from "../../tools/subagents/worker-factory";

const piModel = {
	provider: "cus-resp",
	api: "openai-responses",
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
			fastMode: false,
		},
		linkedAliases: ["auth-review"],
		linkedToCurrentSession: true,
		phase: "idle" as const,
		queued: 0,
	}],
	counts: { linked: 1, global: 1, running: 0, queued: 0, idle: 1, stopped: 0, inUseElsewhere: 0, errors: 0 },
};

function setup(phase: "idle" | "running" | "starting" | "queued" | "stopped" | "error" | "in-use-elsewhere" | "unknown" = "idle", terminalRows = 30, compacting = false, fg = (_color: string, text: string) => text) {
	let renders = 0;
	let closed = false;
	let subscribed: (() => void) | undefined;
	let unsubscribed = false;
	const continuations: any[] = [];
	const currentSnapshot: any = structuredClone(snapshot);
	currentSnapshot.agents[0]!.phase = phase;
	currentSnapshot.agents[0]!.isCompacting = compacting;
	currentSnapshot.counts.running = phase === "running" ? 1 : 0;
	currentSnapshot.counts.idle = phase === "idle" ? 1 : 0;
	const controls: unknown[] = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const availableModels = structuredClone(models);
	const mentions: string[] = [];
	const sessions = [{
		path: "/tmp/saved.jsonl", id: "saved-session", cwd: "/tmp/other",
		created: new Date("2026-01-01"), modified: new Date("2026-01-02"), messageCount: 2,
		name: "Saved Auth", firstMessage: "Review auth", allMessagesText: "Review auth",
	}];
	const manager = {
		snapshot: async () => currentSnapshot,
		subscribe: (listener: () => void) => { subscribed = listener; return () => { unsubscribed = true; }; },
		continue: async (...args: any[]) => {
			continuations.push(args);
			currentSnapshot.agents[0].phase = "running";
			args[3]?.();
			subscribed?.();
			currentSnapshot.agents[0].phase = "idle";
			return { instance: currentSnapshot.agents[0].instance, run: { output: "done" } };
		},
		changeModel: async () => snapshot.agents[0]!.instance,
		link: async () => snapshot.agents[0]!.instance,
		stop: async () => snapshot.agents[0]!.instance,
		detach: async () => snapshot.agents[0]!.instance,
		create: async () => ({ instance: snapshot.agents[0]!.instance, run: { output: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } } }),
		adopt: async () => snapshot.agents[0]!.instance,
		setFastMode: async (_target: string, enabled: boolean) => {
			currentSnapshot.agents[0]!.instance.fastMode = enabled;
			return currentSnapshot.agents[0]!.instance;
		},
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
		ui: {
			confirm: async () => { throw new Error("native confirm renders under the overlay"); },
			notify: (message: string, type?: string) => { notifications.push({ message, type }); },
		},
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
		{ fg, bold: (text: string) => text } as any,
		keybindings as any,
		() => { closed = true; },
		ctx as any,
		{
			manager: manager as any,
			models: availableModels,
			sessions,
			currentCwd: "/tmp/project",
			insertMention: (alias) => { mentions.push(alias); },
		},
		currentSnapshot,
	);
	return { component, controls, continuations, ctx, manager, notifications, models: availableModels, mentions, sessions, snapshot: currentSnapshot, get renders() { return renders; }, get closed() { return closed; }, get subscribed() { return subscribed; }, get unsubscribed() { return unsubscribed; } };
}

test("rail-agent renders live retry countdown and final recovered count", (t) => {
	t.mock.method(Date, "now", () => 10_000);
	const state = setup("running");
	try {
		state.snapshot.agents[0].retry = { attempt: 2, maxAttempts: 5, nextAt: 40_000, error: "503 temporary", source: "rail" };
		state.snapshot.agents[0].retryCount = 2;
		const during = state.component.render(160).join("\n");
		assert.match(during, /Retrying 2\/5.*next in 30s/);
		assert.match(during, /503 temporary/);
		assert.doesNotMatch(during, /IDLE|ERROR/);
		state.component.handleInput("g");
		assert.match(state.component.render(160).join("\n"), /controls are unavailable during retry backoff/);
		assert.equal(state.component["control"], undefined);
		t.mock.method(Date, "now", () => 25_000);
		assert.match(state.component.render(160).join("\n"), /next in 15s/);
		for (const width of [12, 35, 60]) for (const line of state.component.render(width)) assert.ok(visibleWidth(line) <= width);
		state.snapshot.agents[0].phase = "idle";
		delete state.snapshot.agents[0].retry;
		const after = state.component.render(160).join("\n");
		assert.match(after, /recovered after 2 retries/);
		assert.doesNotMatch(after, /Retrying/);
		for (const phase of ["stopped", "error"]) {
			state.snapshot.agents[0].phase = phase;
			const terminal = state.component.render(160).join("\n");
			assert.match(terminal, /2 retries/);
			assert.doesNotMatch(terminal, /Retrying|recovered after/);
		}
	} finally {
		state.component.dispose();
	}
});

test("agent filtering preserves fields, input order, current-tab scope, selection, and fresh snapshots", async () => {
	const state = setup();
	const agents: RailAgentView[] = ["zulu", "alpha", "foreign", "unmatched"].map((alias) => ({
		...structuredClone(snapshot.agents[0]!),
		instance: {
			...structuredClone(snapshot.agents[0]!.instance), alias: `original-${alias}`, agentId: `agt_${alias}`,
			model: { ...models[0], name: "DisplayOnly" },
		},
		linkedAliases: [`linked-${alias}`],
		linkedToCurrentSession: alias !== "foreign",
	}));
	agents[3]!.instance.lastTask = "Other work";
	state.snapshot.agents = agents;
	try {
		const ui = state.component;
		const filter = (query: string) => {
			ui["searchInput"].setValue(query);
			return ui["filteredAgents"]();
		};
		for (const query of ["", " \t\n\u2003 "]) assert.deepEqual(filter(query), [agents[0], agents[1], agents[3]]);
		for (const query of ["CUS-RESP authentication PROJECT idle", "  IDLE\tproject\nAuthentication  cus-resp  "]) {
			assert.deepEqual(filter(query), [agents[0], agents[1]]);
		}
		assert.deepEqual(filter("original-alpha linked-alpha gpt-5.6-sol xhigh"), [agents[1]]);
		assert.deepEqual(filter("project missing"), []);
		// Agent IDs and model display names are not searchable agent fields.
		assert.deepEqual(filter("agt_zulu"), []);
		assert.deepEqual(filter("DisplayOnly"), []);

		filter("");
		ui.handleInput("\u001b[B");
		assert.match(ui.render(160).join("\n"), /→ linked-alpha/);
		ui.handleInput("/");
		ui.handleInput("AUTHENTICATION project");
		assert.match(ui.render(160).join("\n"), /→ linked-zulu/);
		ui.handleInput("\u001b");
		ui.handleInput("\u001b[C");
		assert.deepEqual(ui["filteredAgents"](), agents.slice(0, 3));
		ui.handleInput("\u001b[B");
		assert.match(ui.render(160).join("\n"), /→ linked-alpha/);

		const refreshed = structuredClone(agents[2]!);
		refreshed.linkedAliases = ["refreshed-foreign"];
		state.manager.snapshot = async () => ({ ...state.snapshot, agents: [refreshed] });
		await ui["refresh"]();
		assert.deepEqual(ui["filteredAgents"](), [refreshed]);
		assert.match(ui.render(160).join("\n"), /→ refreshed-foreign/);
		ui.handleInput("i");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(state.mentions, ["refreshed-foreign"]);
		assert.equal(state.closed, true);
	} finally {
		state.component.dispose();
	}
});

test("model filtering preserves cross-field matching, whitespace, order, and picker selection without caching", () => {
	const state = setup();
	state.models.splice(0, state.models.length,
		{ provider: "Vendor", modelId: "zulu", name: "Shared Display", thinkingLevel: "high" },
		{ provider: "Vendor", modelId: "alpha", name: "Shared Display", thinkingLevel: "high" },
		{ provider: "Other", modelId: "shared", name: "Unmatched", thinkingLevel: "off" },
	);
	try {
		const ui = state.component;
		for (const query of ["", " \t\n\u2003 "]) assert.equal(ui["filteredModels"](query), state.models);
		for (const query of ["VENDOR shared HIGH", "  HiGh\tSHARED\nVendor  "]) {
			assert.deepEqual(ui["filteredModels"](query), state.models.slice(0, 2));
		}
		assert.deepEqual(ui["filteredModels"]("vendor ALPHA display HIGH"), [state.models[1]]);
		assert.deepEqual(ui["filteredModels"]("vendor missing"), []);

		ui.handleInput("n");
		ui.handleInput("\u001b[B");
		ui.handleInput("\u001b[B");
		ui.handleInput("\r");
		ui.handleInput("\u001b[B");
		assert.match(ui.render(160).join("\n"), /→ Vendor\/alpha:high/);
		ui.handleInput("  VENDOR   shared HIGH  ");
		assert.match(ui.render(160).join("\n"), /→ Vendor\/zulu:high/);
		ui.handleInput("\u001b[A");
		assert.match(ui.render(160).join("\n"), /→ Vendor\/alpha:high/);
		ui.handleInput("\r");
		assert.equal(ui["form"].model, state.models[1]);

		state.models[0]!.name = "Changed";
		assert.deepEqual(ui["filteredModels"]("vendor shared high"), [state.models[1]]);
		ui.handleInput("\r");
		ui.handleInput("missing");
		ui.handleInput("\r");
		assert.match(ui.render(160).join("\n"), /No matching options/);
		ui.handleInput("\u001b");
		assert.equal(ui["form"].model, state.models[1]);
	} finally {
		state.component.dispose();
	}
});

test("session filtering preserves cross-field matching, whitespace, order, and picker selection without caching", () => {
	const state = setup();
	const base = state.sessions[0]!;
	state.sessions.splice(0, state.sessions.length,
		{ ...base, id: "session-zulu", name: "Security Zulu", cwd: "/tmp/project", firstMessage: "Inspect login", modified: new Date("2026-01-01") },
		{ ...base, id: "session-alpha", name: "Security Alpha", cwd: "/tmp/project", firstMessage: "Inspect login", modified: new Date("2026-01-03") },
		{ ...base, id: "session-other", name: "Storage", allMessagesText: "hidden-history", path: "/tmp/hidden-path.jsonl" },
	);
	try {
		const ui = state.component;
		for (const query of ["", " \t\n\u2003 "]) assert.equal(ui["filteredSessions"](query), state.sessions);
		for (const query of ["SECURITY login PROJECT SESSION", "  SESSION\tproject\nLOGIN  security  "]) {
			assert.deepEqual(ui["filteredSessions"](query), state.sessions.slice(0, 2));
		}
		assert.deepEqual(ui["filteredSessions"]("alpha session-alpha"), [state.sessions[1]]);
		for (const query of ["project missing", "hidden-history", "hidden-path"]) assert.deepEqual(ui["filteredSessions"](query), []);

		ui.handleInput("n");
		ui.handleInput("\r");
		for (let index = 0; index < 4; index++) ui.handleInput("\u001b[B");
		ui.handleInput("\r");
		ui.handleInput("\u001b[B");
		assert.match(ui.render(160).join("\n"), /→ Current · Security Alpha/);
		ui.handleInput("  SECURITY  login PROJECT SESSION  ");
		assert.match(ui.render(160).join("\n"), /→ Current · Security Zulu/);
		ui.handleInput("\u001b[A");
		assert.match(ui.render(160).join("\n"), /→ Current · Security Alpha/);
		ui.handleInput("\r");
		assert.equal(ui["form"].session, state.sessions[1]);
		assert.equal(ui["form"].cwd, "/tmp/project");

		state.sessions[0]!.firstMessage = "Changed";
		assert.deepEqual(ui["filteredSessions"]("security login project session"), [state.sessions[1]]);
		ui.handleInput("\r");
		ui.handleInput("missing");
		ui.handleInput("\r");
		assert.match(ui.render(160).join("\n"), /No matching options/);
		ui.handleInput("\u001b");
		assert.equal(ui["form"].session, state.sessions[1]);
	} finally {
		state.component.dispose();
	}
});

for (const kind of ["model", "session"] as const) test(`${kind} filtering builds search text once per candidate and matches the legacy results`, (t) => {
	const state = setup();
	let reads = 0;
	try {
		const candidates = kind === "model"
			? Array.from({ length: 1000 }, (_, index) => ({
				provider: "Vendor", modelId: `model-${index}`, thinkingLevel: "high" as const,
				get name() { reads++; return "Shared Display"; },
			}))
			: Array.from({ length: 1000 }, (_, index) => ({
				...state.sessions[0]!, id: `session-${index}`, cwd: "/tmp/project",
				get name() { reads++; return "Security review"; },
			}));
		if (kind === "model") state.models.splice(0, state.models.length, ...candidates as RailModelRef[]);
		else state.sessions.splice(0, state.sessions.length, ...candidates as typeof state.sessions);
		const filter = (query: string) => kind === "model" ? state.component["filteredModels"](query) : state.component["filteredSessions"](query);
		const searchText = (candidate: typeof candidates[number]) => kind === "model"
			? `${railModelReference(candidate as RailModelRef)} ${candidate.name ?? ""}`.toLowerCase()
			: [candidate.name, (candidate as typeof state.sessions[number]).firstMessage, (candidate as typeof state.sessions[number]).cwd, (candidate as typeof state.sessions[number]).id].filter(Boolean).join(" ").toLowerCase();
		const query = kind === "model" ? "VENDOR model SHARED HIGH" : "SECURITY auth PROJECT SESSION";
		for (const value of [query, "", " \t\n ", `${query} missing`, `missing ${query}`, `${query} -19`]) {
			const terms = value.toLowerCase().trim().split(/\s+/u).filter(Boolean);
			reads = 0;
			const legacy = terms.length === 0 ? candidates : candidates.filter((candidate) => terms.every((term) => searchText(candidate).includes(term)));
			const legacyReads = reads;
			reads = 0;
			const actual = filter(value);
			const optimizedReads = reads;
			assert.equal(actual.length, legacy.length);
			actual.forEach((candidate, index) => assert.equal(candidate, legacy[index]));
			assert.equal(optimizedReads, terms.length === 0 ? 0 : 1000);
			if (value === query) {
				assert.equal(actual.length, 1000);
				assert.equal(legacyReads, 4000);
				t.diagnostic(`${kind}: 1000 candidates × 4 terms, search-text builds ${legacyReads} → ${optimizedReads}; identical ordered results`);
			}
		}
	} finally {
		state.component.dispose();
	}
});

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
		for (let index = 0; index < 4; index++) ui.handleInput("\u001b[B");
		ui.handleInput("\r");
		if (mode === "exclusive") {
			assert.match(ui.render(100).join("\n"), /Use saved session in place\?/);
			ui.handleInput("y");
		}
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
		dispatch: async (request: any) => {
			request.onAccepted?.();
			return { instance: snapshot.agents[0]!.instance, run: { output: "", stopReason: "error", errorMessage: "HTTP 401" } };
		},
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
		ui.handleInput("\u001b[B");
		ui.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(ui.render(100).join("\n"), /HTTP 401/);
		assert.doesNotMatch(ui.render(100).join("\n"), /Created /);
	} finally {
		state.component.dispose();
	}
});

function startBackgroundCreate(state: ReturnType<typeof setup>, delayedAcceptance = false) {
	const run = Promise.withResolvers<any>();
	const requests: any[] = [];
	const accept = () => {
		state.snapshot.agents[0].phase = "running";
		requests[0].onAccepted();
	};
	state.manager.create = ((request: any) => {
		requests.push(request);
		state.snapshot.agents.unshift({
			...structuredClone(state.snapshot.agents[0]),
			instance: { ...state.snapshot.agents[0]!.instance, agentId: "agt_new", alias: request.alias },
			linkedAliases: [request.alias],
			phase: "starting",
		});
		if (!delayedAcceptance) accept();
		return run.promise;
	}) as typeof state.manager.create;
	const ui = state.component;
	ui.handleInput("n");
	for (let index = 0; index < 5; index++) ui.handleInput("\u001b[B");
	ui.handleInput("\r");
	ui.handleInput("review");
	ui.handleInput("\r");
	ui.handleInput("\u001b[B");
	ui.handleInput("\u001b[B");
	ui.handleInput("\r");
	return { run, requests, accept };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function backgroundContinue(state: ReturnType<typeof setup>) {
	const run = Promise.withResolvers<any>();
	state.manager.continue = (...args: any[]) => {
		state.continuations.push(args);
		return run.promise;
	};
	const accept = () => {
		const target = state.snapshot.agents.find((agent: RailAgentView) => agent.instance.agentId === state.continuations[0][0]);
		target.phase = "running";
		state.continuations[0][3]();
		state.subscribed!();
	};
	return { run, accept };
}

test("Continue composer opens inline, idle is empty, empty submit and Escape never dispatch or mention", async () => {
	const state = setup();
	try {
		state.component.focused = true;
		state.component.handleInput("\r");
		const composer = state.component["control"]!;
		assert.equal(composer.delivery, "continue");
		assert.equal(composer.input.getValue(), "");
		assert.equal(composer.input.focused, true);
		assert.match(state.component.render(100).join("\n"), /Continue auth-review/);
		state.component.handleInput("   ");
		state.component.handleInput("\r");
		await tick();
		assert.match(state.component.render(100).join("\n"), /Message cannot be empty/);
		assert.equal(state.component["control"], composer);
		state.component.handleInput("\u001b");
		assert.equal(state.component["control"], undefined);
		assert.deepEqual(state.continuations, []);
		assert.deepEqual(state.mentions, []);
		assert.equal(state.closed, false);
	} finally { state.component.dispose(); }
});

for (const phase of ["error", "stopped"] as const) test(`Continue ${phase} prefill is editable at the end, focused and visible in narrow short terminals`, () => {
	const state = setup(phase, 15);
	try {
		state.snapshot.agents[0].errorMessage = "STALE ERROR";
		state.component.focused = true;
		state.component.handleInput("\r");
		const composer = state.component["control"]!;
		const prefill = prompt("subagent", "manual_continue");
		assert.equal(composer.input.getValue(), prefill);
		assert.doesNotMatch(prefill, /STALE ERROR|Review authentication/);
		state.component.handleInput(" 继续检查");
		assert.equal(composer.input.getValue(), `${prefill} 继续检查`);
		for (const width of [73, 80]) {
			const lines = state.component.render(width);
			assert.ok(lines.length <= 13);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(lines.join("\n"), /Continue auth-review/);
			assert.match(lines.join("\n"), /cus-resp\/gpt-5.6-sol:xhigh/);
			assert.ok(lines.find((line) => line.includes("Message:"))?.includes(CURSOR_MARKER));
		}
		state.component.focused = false;
		assert.equal(composer.input.focused, false);
		assert.equal(state.component.render(73).some((line) => line.includes(CURSOR_MARKER)), false);
	} finally { state.component.dispose(); }
});

test("Continue rejects active, compacting, retrying and foreign/unknown agents without linking", async () => {
	for (const phase of ["running", "starting", "queued", "in-use-elsewhere", "unknown", "compacting", "retrying"] as const) {
		const state = setup(phase === "compacting" || phase === "retrying" ? "idle" : phase);
		let links = 0;
		state.manager.link = async () => { links++; return state.snapshot.agents[0].instance; };
		if (phase === "compacting") state.snapshot.agents[0].isCompacting = true;
		if (phase === "retrying") state.snapshot.agents[0].retry = { attempt: 1, maxAttempts: 5, nextAt: Date.now() + 10_000, source: "rail", error: "503" };
		try {
			state.component.handleInput("\r");
			await tick();
			assert.equal(state.component["control"], undefined, phase);
			assert.match(state.component.render(160).join("\n"), /ownership|wait|Steer \/ Follow-up/);
			assert.equal(links, 0);
			assert.deepEqual(state.continuations, []);
			assert.deepEqual(state.mentions, []);
		} finally { state.component.dispose(); }
	}
});

for (const rows of [15, 22, 23, 24, 30]) test(`Continue composer fits the overlay at ${rows} rows with multiple agents and retained metadata`, () => {
	const state = setup("error", rows);
	state.snapshot.agents = Array.from({ length: 8 }, (_, index) => ({
		...structuredClone(state.snapshot.agents[0]),
		instance: { ...state.snapshot.agents[0].instance, agentId: `agt_${index}`, alias: `review-${index}`, lastOutput: "Retained final answer with 中文 metadata", fastMode: true },
		linkedAliases: [`review-${index}`],
		errorMessage: "Retained provider error",
		retryCount: 2,
	}));
	state.snapshot.counts.linked = state.snapshot.counts.global = 8;
	try {
		state.component["selectedIndex"] = 4;
		state.component.focused = true;
		state.component.handleInput("\r");
		state.component.handleInput(" 继续检查");
		// Pi clamps maxHeight against the terminal height and the two one-row margins.
		const height = Math.min(Math.floor(rows * 88 / 100), rows - 2);
		for (const search of ["", "project", "no matching rows"]) {
			state.component["searchInput"].setValue(search);
			for (const notice of ["", "Retained startup rejection"]) {
				state.component["notice"] = notice;
				for (const width of [73, Math.floor(73 * 92 / 100)]) {
					const lines = state.component.render(width);
					const screen = lines.slice(0, height);
					assert.ok(screen.find((line) => line.includes("Message:"))?.includes(CURSOR_MARKER), `${rows} rows, ${width} columns, search=${search}: cursor must survive overlay clipping`);
					assert.ok(lines.length <= height, `${rows} rows: ${lines.length} lines exceed the ${height}-line overlay`);
					assert.ok(screen.every((line) => visibleWidth(line) <= width));
					assert.match(screen.join("\n"), /Continue review-4/);
					assert.match(screen.join("\n"), /cus-resp\/gpt-5.6-sol:xhigh/);
					assert.match(screen.join("\n"), /enter send · esc cancel/);
					if (search !== "no matching rows") assert.match(screen.join("\n"), /→ review-4/);
				}
			}
		}
		assert.equal(state.component["control"]?.agentId, "agt_4");
		assert.ok(state.snapshot.agents.every((agent: RailAgentView) => agent.instance.lastOutput && agent.errorMessage));
	} finally { state.component.dispose(); }
});

test("accepted Continue clears its startup notice while the run remains pending", async () => {
	const state = setup();
	const { run, accept } = backgroundContinue(state);
	try {
		state.component.handleInput("\r");
		state.component.handleInput("next task");
		state.component.handleInput("\r");
		await tick();
		assert.match(state.component.render(100).join("\n"), /Starting continuation/);
		accept();
		await tick();
		assert.equal(state.component["control"], undefined);
		assert.equal(state.component["busy"], false);
		assert.match(state.component.render(100).join("\n"), /RUNNING/);
		assert.doesNotMatch(state.component.render(100).join("\n"), /Starting continuation/);
		assert.deepEqual(state.notifications, []);
		run.resolve({ instance: state.snapshot.agents[0].instance, run: { output: "done" } });
		await tick();
		assert.match(state.component.render(100).join("\n"), /finished its continuation: done/);
	} finally { state.component.dispose(); }
});

for (const failed of [false, true]) test(`accepted Continue preserves an immediately settled ${failed ? "failure" : "success"} notice`, async () => {
	const state = setup();
	state.manager.continue = (...args: any[]) => {
		state.continuations.push(args);
		args[3]();
		return failed ? Promise.reject(new Error("HTTP 401")) : Promise.resolve({ instance: state.snapshot.agents[0].instance, run: { output: "done" } });
	};
	try {
		state.component.handleInput("\r");
		state.component.handleInput("next task");
		state.component.handleInput("\r");
		await tick();
		assert.equal(state.component["control"], undefined);
		assert.equal(state.component["busy"], false);
		const message = failed ? "Agent auth-review failed its continuation: HTTP 401" : "Agent auth-review finished its continuation: done";
		assert.equal(state.component["notice"], message);
		assert.ok(state.component.render(100).join("\n").includes(message));
		assert.deepEqual(state.notifications, [{ message, type: failed ? "error" : "info" }]);
	} finally { state.component.dispose(); }
});

test("Continue revalidates a fresh pinned target before submission and retains text on state changes", async () => {
	for (const phase of ["running", "starting", "queued", "in-use-elsewhere", "unknown", "compacting", "retrying", "deleted"] as const) {
		const state = setup();
		try {
			state.component.handleInput("\r");
			state.component.handleInput("my continuation");
			const next = structuredClone(state.snapshot);
			if (phase === "deleted") next.agents = [];
			else if (phase === "compacting") next.agents[0].isCompacting = true;
			else if (phase === "retrying") next.agents[0].retry = { attempt: 1, maxAttempts: 5, source: "pi", error: "503" };
			else next.agents[0].phase = phase;
			state.manager.snapshot = async () => next;
			state.component.handleInput("\r");
			await tick();
			assert.equal(state.component["control"]?.input.getValue(), "my continuation", phase);
			assert.deepEqual(state.continuations, []);
			assert.deepEqual(state.mentions, []);
		} finally { state.component.dispose(); }
	}
});

test("Continue pins original agentId across reordered or empty lists and double Enter dispatches exactly once", async () => {
	const state = setup();
	const { run, accept } = backgroundContinue(state);
	try {
		state.component.handleInput("\r");
		state.component.handleInput("  next task  ");
		state.snapshot.agents.unshift({ ...structuredClone(state.snapshot.agents[0]), instance: { ...state.snapshot.agents[0].instance, agentId: "agt_other", alias: "other" }, linkedAliases: ["other"] });
		state.component["searchInput"].setValue("no matching rows");
		assert.match(state.component.render(100).join("\n"), /Continue auth-review/);
		state.component.handleInput("\r");
		state.component.handleInput("\r");
		await tick();
		assert.equal(state.continuations.length, 1);
		assert.deepEqual(state.continuations[0].slice(0, 3), ["agt_auth", "next task", undefined]);
		assert.equal(typeof state.continuations[0][3], "function");
		assert.equal(state.component["control"]?.input.getValue(), "  next task  ", "delayed acceptance retains the composer");
		state.snapshot.agents[1].phase = "running";
		state.subscribed!();
		await tick();
		assert.equal(state.component["busy"], true, "an unrelated running snapshot is not this dispatch's acceptance");
		assert.equal(state.component["control"]?.input.getValue(), "  next task  ");
		accept();
		await tick();
		assert.equal(state.component["busy"], false, "returns promptly without provider output or completion");
		assert.equal(state.component["control"], undefined);
		state.component.handleInput("\r");
		assert.equal(state.continuations.length, 1);
		assert.deepEqual(state.mentions, []);
		run.resolve({ instance: state.snapshot.agents[1].instance, run: { output: "All\ngood" } });
		await tick();
		assert.deepEqual(state.notifications, [{ message: "Agent auth-review finished its continuation: All good", type: "info" }]);
	} finally { state.component.dispose(); }
});

test("Continue rejection before acceptance preserves editable text and does not notify completion", async () => {
	const state = setup();
	const { run } = backgroundContinue(state);
	try {
		state.component.handleInput("\r");
		state.component.handleInput("my task");
		state.component.handleInput("\r");
		await tick();
		run.reject(new Error("lease unavailable"));
		await tick();
		assert.match(state.component.render(100).join("\n"), /lease unavailable/);
		state.component.handleInput(" edited");
		assert.equal(state.component["control"]?.input.getValue(), "my task edited");
		assert.deepEqual(state.notifications, []);
	} finally { state.component.dispose(); }
});

for (const mode of ["startup", "rpc-startup", "rpc-prompt", "team"] as const) test(`Continue retains text on real broker ${mode} rejection`, async () => {
	const dir = await mkdtemp(join(tmpdir(), "rail-continue-guard-"));
	const store = new FileAgentInstanceStore(dir);
	const roster = new SessionAgentRoster();
	let sends = 0;
	const rpcFixture = fileURLToPath(new URL("../fixtures/fake-pi-rpc.mjs", import.meta.url));
	const rpcFactory = createRpcWorkerFactory({ stateDir: dir, resolveInvocation: (args) => ({ command: process.execPath, args: mode === "rpc-prompt" ? [rpcFixture, ...args] : ["-e", "process.exit(1)"] }) });
	const broker = new SessionBroker({ store, roster, defaultCwd: dir, workerFactory: async (spec) => {
		if (mode === "startup") throw new Error("worker startup failed");
		if (mode === "rpc-startup" || mode === "rpc-prompt") return rpcFactory(spec);
		return {
			sessionId: "team-child", sessionFile: join(dir, "team.jsonl"), stop: async () => undefined,
			send: async () => { sends++; return { output: "must not run", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } }; },
			openTeamMemberV2: async () => ({ runActivation: async () => undefined, terminate: () => undefined, close: async () => undefined }),
		};
	} });
	const state = setup("stopped");
	try {
		if (mode === "team") await broker.openTeamMember({ binding: { version: 2, teamId: "team-test", memberId: "auth-review", epoch: "test" }, model: models[0], cwd: dir, loadout: loadoutFor("auth-review") });
		else {
			const saved = { ...structuredClone(snapshot.agents[0]!.instance), cwd: dir, sessionFile: join(dir, "session.jsonl"), model: mode === "rpc-prompt" ? { ...models[0], modelId: "gpt-5.6-luna" } : models[0] };
			await store.put(saved);
			roster.link(saved.alias, saved.agentId);
		}
		const manager = new RailAgentManager(broker, store, roster, dir);
		state.component["options"].manager = manager;
		state.component["snapshot"] = await manager.snapshot();
		state.component.handleInput("\r");
		const composer = state.component["control"]!;
		assert.ok(composer);
		const text = mode === "rpc-prompt" ? "reject prompt before acceptance" : "keep my continuation";
		composer.input.setValue(text);
		state.component.handleInput("\r");
		for (let attempt = 0; attempt < 100 && state.component["busy"]; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(state.component["busy"], false);
		assert.equal(state.component["control"], composer);
		assert.equal(composer.input.getValue(), text);
		assert.match(state.component.render(160).join("\n"), mode === "team" ? /Team-owned/ : mode === "rpc-startup" ? /exited/ : mode === "rpc-prompt" ? /fixture prompt rejected/ : /worker startup failed/);
		assert.equal(sends, 0);
		assert.deepEqual(state.notifications, []);
		assert.deepEqual(state.mentions, []);
	} finally {
		state.component.dispose();
		await broker.shutdown();
		await rm(dir, { recursive: true, force: true });
	}
});

for (const failed of [false, true]) test(`Continue stays alive after close and reports ${failed ? "failure" : "success"} during normal retry`, async () => {
	const state = setup();
	const { run, accept } = backgroundContinue(state);
	state.component.handleInput("\r");
	state.component.handleInput("next task");
	state.component.handleInput("\r");
	await tick();
	accept();
	await tick();
	state.snapshot.agents[0].retry = { attempt: 1, maxAttempts: 5, nextAt: Date.now() + 10_000, source: "rail", error: "503 temporary" };
	state.subscribed!();
	await tick();
	assert.match(state.component.render(160).join("\n"), /Retrying 1\/5/);
	state.component.handleInput("\u001b");
	assert.equal(state.closed, true);
	state.component.dispose();
	assert.equal(state.continuations[0][2], undefined, "no popup abort signal");
	if (failed) run.reject(new Error("HTTP 401"));
	else run.resolve({ instance: state.snapshot.agents[0].instance, run: { output: "finished" } });
	await tick();
	assert.deepEqual(state.notifications, [{ message: failed ? "Agent auth-review failed its continuation: HTTP 401" : "Agent auth-review finished its continuation: finished", type: failed ? "error" : "info" }]);
});

test("closing during Continue startup does not cancel a dispatched run; stale notify cannot reject unhandled", async () => {
	for (const failed of [false, true]) {
		const state = setup();
		const { run } = backgroundContinue(state);
		state.component.handleInput("\r");
		state.component.handleInput("next task");
		state.component.handleInput("\r");
		await tick();
		state.component.handleInput("\u001b");
		assert.equal(state.closed, true);
		state.component.dispose();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			state.ctx.ui.notify = () => { throw new Error("stale UI"); };
			state.continuations[0][3]();
			if (failed) run.reject(new Error("HTTP 401"));
			else run.resolve({ instance: state.snapshot.agents[0].instance, run: { output: "finished" } });
			await tick();
			await tick();
			assert.deepEqual(unhandled, []);
		} finally { process.off("unhandledRejection", onUnhandled); }
	}
});

test("All Persistent Continue does not link before dispatch; separate i Mention links and closes", async () => {
	const state = setup();
	state.snapshot.agents[0].linkedToCurrentSession = false;
	state.snapshot.agents[0].linkedAliases = [];
	let links = 0;
	state.manager.link = async () => { links++; return state.snapshot.agents[0].instance; };
	try {
		state.component.handleInput("\u001b[C");
		state.component.handleInput("\r");
		assert.equal(state.component["control"]?.agentId, "agt_auth");
		state.component.handleInput("\u001b");
		assert.equal(links, 0);
		state.component.handleInput("i");
		await tick();
		assert.equal(links, 1);
		assert.deepEqual(state.mentions, ["auth-review"]);
		assert.equal(state.closed, true);
		assert.deepEqual(state.continuations, []);
	} finally { state.component.dispose(); }
});

test("Create & Run waits for explicit acceptance and repeated Enter starts only one dispatch", async () => {
	const state = setup();
	const { run, requests, accept } = startBackgroundCreate(state, true);
	try {
		state.component.handleInput("\r");
		await tick();
		assert.equal(requests.length, 1);
		assert.equal(requests[0].onUpdate, undefined, "progress is not used as an acceptance signal");
		assert.equal(typeof requests[0].onAccepted, "function");
		assert.equal(state.component["busy"], true);
		assert.equal(state.component["form"].task, "review");
		accept();
		await tick();
		assert.equal(state.component["busy"], false);
		assert.equal(state.component["form"].task, "");
		run.resolve({ instance: state.snapshot.agents[0].instance, run: { output: "done" } });
		await tick();
		assert.equal(state.notifications.length, 1);
	} finally { state.component.dispose(); }
});

test("Create & Run rejection before acceptance retains its first task and reports only inline", async () => {
	const state = setup();
	const { run } = startBackgroundCreate(state, true);
	try {
		await tick();
		run.reject(new Error("prompt rejected before acceptance"));
		await tick();
		assert.equal(state.component["busy"], false);
		assert.equal(state.component["form"].task, "review");
		assert.equal(state.component["tab"], "create");
		assert.match(state.component.render(100).join("\n"), /prompt rejected before acceptance/);
		assert.deepEqual(state.notifications, []);
	} finally { state.component.dispose(); }
});

for (const action of ["Continue", "Create"] as const) test(`${action} notifies an immediate native error even without a worker acceptance event`, async () => {
	const dir = await mkdtemp(join(tmpdir(), "rail-immediate-error-"));
	const store = new FileAgentInstanceStore(dir);
	const roster = new SessionAgentRoster();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
	let sends = 0;
	const broker = new SessionBroker({ store, roster, defaultCwd: dir, workerFactory: async () => ({
		sessionId: "immediate-session", sessionFile: join(dir, "immediate.jsonl"), stop: async () => undefined,
		send: async () => { sends++; return { output: "", usage, stopReason: "error", errorMessage: "HTTP 401" }; },
	}) });
	const state = setup();
	try {
		if (action === "Continue") await broker.attach({ model: models[0], alias: "auth-review", cwd: dir });
		const manager = new RailAgentManager(broker, store, roster, dir);
		state.component["options"].manager = manager;
		state.component["snapshot"] = await manager.snapshot();
		if (action === "Continue") {
			state.component.handleInput("\r");
			state.component.handleInput("next task");
		} else {
			state.component.handleInput("n");
			state.component["form"].cwd = dir;
			state.component["form"].task = "first task";
			state.component["formIndex"] = state.component["formFields"]().length - 1;
		}
		const alias = action === "Continue" ? "auth-review" : state.component["form"].alias;
		state.component.handleInput("\r");
		state.component.handleInput("\r");
		for (let attempt = 0; attempt < 100 && state.component["busy"]; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(state.component["busy"], false);
		assert.equal(state.component["control"], undefined);
		assert.equal(sends, 1);
		assert.deepEqual(state.notifications, [{ message: `Agent ${alias} failed its ${action === "Continue" ? "continuation" : "first task"}: HTTP 401`, type: "error" }]);
	} finally {
		state.component.dispose();
		await broker.shutdown();
		await rm(dir, { recursive: true, force: true });
	}
});

test("Create & Run returns control while the first task runs and notifies when it finishes", async () => {
	const state = setup();
	const { run, requests } = startBackgroundCreate(state);
	try {
		await tick();
		const screen = state.component.render(100).join("\n");
		assert.match(screen, new RegExp(`Started ${requests[0].alias}`));
		assert.match(screen, new RegExp(`${requests[0].alias}.*RUNNING`));
		assert.deepEqual(state.notifications, []);
		state.component.handleInput("\u001b");
		assert.equal(state.closed, true, "popup is not locked by the first run");

		run.resolve({ instance: state.snapshot.agents[0].instance, run: { output: "All\ngood" } });
		await tick();
		assert.deepEqual(state.notifications, [{ message: `Agent ${requests[0].alias} finished its first task: All good`, type: "info" }]);
	} finally {
		state.component.dispose();
	}
});

test("closing the popup does not abort the background first run", async () => {
	const state = setup();
	const { run, requests } = startBackgroundCreate(state);
	await tick();
	state.component.handleInput("\u001b");
	state.component.dispose();
	assert.equal(requests[0].signal, undefined);
	run.resolve({ instance: state.snapshot.agents[0].instance, run: { output: "" } });
	await tick();
	assert.deepEqual(state.notifications, [{ message: `Agent ${requests[0].alias} finished its first task`, type: "info" }]);
});

test("a throwing notify after a background first run cannot cause an unhandled rejection", async () => {
	const state = setup();
	const { run, requests } = startBackgroundCreate(state);
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
	process.on("unhandledRejection", onUnhandled);
	try {
		await tick();
		state.ctx.ui.notify = () => { throw new Error("stale ctx"); };
		run.reject(new Error("HTTP 401"));
		await tick();
		await tick();
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		state.component.dispose();
	}
	assert.equal(requests.length, 1);
});

test("a failed background first run notifies the error message", async () => {
	const state = setup();
	const { run, requests } = startBackgroundCreate(state);
	try {
		await tick();
		run.reject(new Error("HTTP 401"));
		await tick();
		assert.deepEqual(state.notifications, [{ message: `Agent ${requests[0].alias} failed its first task: HTTP 401`, type: "error" }]);
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
		assert.match(text, /│ 1 idle +│/, "zero counts are omitted");
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

test("running agents show compacting as an activity status while remaining controllable", () => {
	const state = setup("running", 30, true);
	try {
		const text = state.component.render(100).join("\n");
		assert.match(text, /COMPACTING/);
		assert.match(text, /│ 1 running +│/);
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

test("create form exposes Fast and turns it off for an ineligible model", () => {
	const state = setup();
	try {
		state.component.handleInput("n");
		assert.match(state.component.render(100).join("\n"), /Fast/);
		state.component.handleInput("\u001b[B");
		state.component.handleInput("\u001b[B");
		state.component.handleInput("\r");
		for (const char of "deepseek") state.component.handleInput(char);
		state.component.handleInput("\r");
		assert.match(state.component.render(100).join("\n"), /Fast\s+Off/);
	} finally {
		state.component.dispose();
	}
});

test("Shift+F toggles an eligible idle agent and shows unsupported saved policy as inactive", async () => {
	const state = setup();
	try {
		state.component.handleInput("F");
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(state.component.render(100).join("\n"), /FAST/);

		const unsupported = structuredClone(snapshot.agents[0]!.instance) as any;
		unsupported.model = models[1];
		unsupported.fastMode = true;
		state.snapshot.agents[0]!.instance = unsupported;
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(state.component.render(100).join("\n"), /FAST inactive/);
	} finally {
		state.component.dispose();
	}
});

test("Shift+F permits stopped and error agents but rejects unknown ownership", async () => {
	for (const phase of ["stopped", "error"] as const) {
		const state = setup(phase);
		try {
			state.component.handleInput("F");
			await new Promise((resolve) => setImmediate(resolve));
			assert.match(state.component.render(100).join("\n"), /FAST/);
		} finally {
			state.component.dispose();
		}
	}
	const unknown = setup("unknown");
	try {
		unknown.component.handleInput("F");
		assert.match(unknown.component.render(100).join("\n"), /another process|ownership/iu);
	} finally {
		unknown.component.dispose();
	}
});

test("agent phase colors follow the panel state colors: starting blue like running, queued gray like waiting", () => {
	const colorOf = (phase: Parameters<typeof setup>[0], compacting = false) => {
		const state = setup(phase, 30, compacting, (color, text) => `{${color}|${text}}`);
		try {
			return state.component.render(100).join("\n").match(/\{(\w+)\|(?:RUNNING|STARTING|QUEUED|IDLE|ERROR|COMPACTING)\}/u)?.[1];
		} finally {
			state.component.dispose();
		}
	};
	assert.deepEqual(
		[colorOf("running"), colorOf("starting"), colorOf("queued"), colorOf("idle"), colorOf("error"), colorOf("running", true)],
		["border", "border", "muted", "muted", "error", "warning"],
	);
});

test("fast toggle rejects busy and foreign-owned agents", () => {
	for (const phase of ["running", "starting", "queued"] as const) {
		const state = setup(phase);
		try {
			state.component.handleInput("F");
			assert.match(state.component.render(100).join("\n"), /fast|running|pending/iu);
		} finally {
			state.component.dispose();
		}
	}
	const compacting = setup("running", 30, true);
	try {
		compacting.component.handleInput("F");
		assert.match(compacting.component.render(100).join("\n"), /idle or stopped|compacting|fast/iu);
	} finally {
		compacting.component.dispose();
	}
	const foreign = setup("in-use-elsewhere");
	foreign.snapshot.agents[0]!.ownerPid = 1234;
	try {
		foreign.component.handleInput("F");
		assert.match(foreign.component.render(100).join("\n"), /another process|elsewhere/iu);
	} finally {
		foreign.component.dispose();
	}
});

test("exclusive adopt never silently ignores a different Fast selection for an existing agent", async () => {
	const state = setup();
	let linked = 0;
	state.manager.link = async () => { linked += 1; return snapshot.agents[0]!.instance; };
	const component = state.component as any;
	component.form.mode = "adopt";
	component.form.session = {
		path: snapshot.agents[0]!.instance.sessionFile,
		id: "managed",
		cwd: snapshot.agents[0]!.instance.cwd,
		name: "Managed",
	};
	component.form.adoptMode = "exclusive";
	component.form.fastMode = true;
	try {
		await component.submitForm();
		assert.equal(linked, 0);
		assert.match(component.render(100).join("\n"), /already a Rail agent.*Shift\+F/iu);
	} finally {
		component.dispose();
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

test("subscription refresh failures keep the last snapshot, surface the error, and recover on the next success", async () => {
	const state = setup();
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	try {
		state.manager.snapshot = async () => { throw new Error("snapshot unavailable"); };
		state.subscribed!();
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(rejections, []);
		const failed = state.component.render(100).join("\n");
		assert.match(failed, /snapshot unavailable/);
		assert.match(failed, /auth-review/);

		state.manager.snapshot = async () => {
			const next = structuredClone(state.snapshot);
			next.agents[0]!.linkedAliases = ["recovered-agent"];
			return next;
		};
		state.subscribed!();
		await new Promise((resolve) => setImmediate(resolve));

		const recovered = state.component.render(100).join("\n");
		assert.doesNotMatch(recovered, /snapshot unavailable/);
		assert.match(recovered, /recovered-agent/);
	} finally {
		process.off("unhandledRejection", onRejection);
		state.component.dispose();
	}
});

test("background refresh errors do not overwrite operation progress or its completed notice", async () => {
	const state = setup("running");
	let finishControl: () => void = () => undefined;
	state.manager.control = async () => {
		await new Promise<void>((resolve) => { finishControl = resolve; });
		return { instance: state.snapshot.agents[0]!.instance, delivery: "steer" };
	};
	try {
		state.component.handleInput("g");
		state.component.handleInput("Focus on tests");
		state.component.handleInput("\r");
		state.manager.snapshot = async () => { throw new Error("background snapshot failed"); };
		state.subscribed!();
		await new Promise((resolve) => setImmediate(resolve));
		const busy = state.component.render(100).join("\n");
		assert.match(busy, /Sending steer/);
		assert.doesNotMatch(busy, /background snapshot failed/);

		state.manager.snapshot = async () => state.snapshot;
		finishControl();
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(state.component.render(100).join("\n"), /Steer accepted by auth-review/);

		state.manager.snapshot = async () => { throw new Error("background snapshot failed"); };
		state.subscribed!();
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(state.component.render(100).join("\n"), /background snapshot failed/);
		state.manager.snapshot = async () => state.snapshot;
		state.subscribed!();
		await new Promise((resolve) => setImmediate(resolve));
		const recovered = state.component.render(100).join("\n");
		assert.doesNotMatch(recovered, /background snapshot failed/);
		assert.match(recovered, /Steer accepted by auth-review/);
	} finally {
		finishControl();
		state.component.dispose();
	}
});

test("timer-driven refresh failures surface the error while post-dispose ticks stay inert", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const state = setup();
	try {
		state.manager.snapshot = async () => { throw new Error("periodic snapshot failed"); };
		t.mock.timers.tick(1500);
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(state.component.render(100).join("\n"), /periodic snapshot failed/);

		const rendersBeforeDispose = state.renders;
		state.component.dispose();
		t.mock.timers.tick(4500);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(state.renders, rendersBeforeDispose);
	} finally {
		state.component.dispose();
		t.mock.timers.reset();
	}
});

test("dispose stops an in-flight refresh from applying its snapshot or rendering", async () => {
	const state = setup();
	let resolveSnapshot: (value: unknown) => void = () => undefined;
	state.manager.snapshot = () => new Promise((resolve) => { resolveSnapshot = resolve; });
	try {
		const rendersBeforeDispose = state.renders;
		state.subscribed!();
		state.component.dispose();
		assert.equal(state.unsubscribed, true);

		resolveSnapshot({ ...structuredClone(state.snapshot), agents: [] });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(state.renders, rendersBeforeDispose);
		assert.match(state.component.render(100).join("\n"), /auth-review/);

		state.subscribed!();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(state.renders, rendersBeforeDispose);
	} finally {
		state.component.dispose();
	}
});

test("showRailAgentOverlay keeps rejecting on the initial snapshot error without opening the UI", async () => {
	let opened = 0;
	const manager = { snapshot: async () => { throw new Error("initial snapshot failed"); } };
	await assert.rejects(
		showRailAgentOverlay({ ui: { custom: async () => { opened += 1; } } } as any, {
			manager: manager as any,
			models: [],
			currentCwd: "/tmp/project",
			insertMention: () => undefined,
		}),
		/initial snapshot failed/,
	);
	assert.equal(opened, 0);
});

for (const [key, title, method] of [
	["s", "Stop subagent worker?", "stop"],
	["d", "Detach persistent agent?", "detach"],
	["x", "Delete persistent agent permanently?", "delete"],
] as const) test(`${method} asks inline inside the overlay and only y confirms`, async () => {
	const state = setup();
	const calls: string[] = [];
	(state.manager as any)[method] = async () => { calls.push(method); return snapshot.agents[0]!.instance; };
	try {
		for (const cancel of ["n", "\u001b"]) {
			state.component.handleInput(key);
			const text = state.component.render(100).join("\n");
			assert.match(text, new RegExp(title.replace("?", "\\?")));
			assert.match(text, /y confirm · n\/esc cancel/);
			state.component.handleInput(cancel);
			assert.doesNotMatch(state.component.render(100).join("\n"), /y confirm/);
			assert.deepEqual(calls, []);
			assert.equal(state.closed, false);
		}
		state.component.handleInput(key);
		state.component.handleInput("y");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, [method]);
	} finally {
		state.component.dispose();
	}
});

test("every action key stays visible in the help rows at 73 and 80 columns", () => {
	const state = setup();
	try {
		for (const width of [73, 80]) {
			const agentHelp = state.component.render(width).join("\n");
			for (const label of ["↑↓ select", "enter Continue", "i Mention", "/ search", "g steer", "f follow-up", "n new", "s stop", "d detach", "x delete", "m model", "t thinking", "shift+f fast", "esc close"]) {
				assert.ok(agentHelp.includes(label), `${width}: ${label}`);
			}
		}
		state.component.handleInput("n");
		const createHelp = state.component.render(80).join("\n");
		for (const label of ["↑↓ fields", "enter edit/open", "shift+f fast", "switch tabs", "esc close"]) assert.ok(createHelp.includes(label), label);
	} finally {
		state.component.dispose();
	}
});

test("search mode: enter acts on the first match and down keeps the first match selected", async () => {
	const state = setup();
	state.snapshot.agents = ["alpha", "beta"].map((alias) => ({
		...structuredClone(snapshot.agents[0]!),
		instance: { ...structuredClone(snapshot.agents[0]!.instance), alias, agentId: `agt_${alias}` },
		linkedAliases: [alias],
	}));
	try {
		const ui = state.component;
		ui.handleInput("/");
		ui.handleInput("project");
		ui.handleInput("\u001b[B");
		assert.match(ui.render(100).join("\n"), /→ alpha/);
		ui.handleInput("\u001b[B");
		assert.match(ui.render(100).join("\n"), /→ beta/);

		ui.handleInput("/");
		ui.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(ui.render(100).join("\n"), /Continue beta/);
		assert.equal(ui["control"]?.agentId, "agt_beta");
		assert.deepEqual(state.mentions, []);
		assert.equal(state.closed, false);
	} finally {
		state.component.dispose();
	}
});

test("default alias uses the random tail of a time-ordered session id", () => {
	const state = setup();
	const component = state.component as any;
	try {
		const aliases = ["01890a5d-ac96-774b-bcce-b302099a8057", "01890a5d-ac96-774b-bcce-b302099a9999"].map((id) => {
			component.ctx.sessionManager.getSessionId = () => id;
			component.setFormModel(models[0]);
			return component.form.alias;
		});
		assert.deepEqual(aliases, ["gpt-5.6-sol-9a8057", "gpt-5.6-sol-9a9999"]);
	} finally {
		state.component.dispose();
	}
});

test("Shift+F is recognized from modifyOtherKeys and kitty sequences", async () => {
	const state = setup();
	try {
		state.component.handleInput("\u001b[27;2;70~");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(state.snapshot.agents[0]!.instance.fastMode, true);
		state.component.handleInput("\u001b[102;2u");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(state.snapshot.agents[0]!.instance.fastMode, false);
	} finally {
		state.component.dispose();
	}
});

test("Fast can always be turned off in the form even when the model is not eligible", () => {
	const state = setup();
	const component = state.component as any;
	try {
		component.handleInput("n");
		component.form.model = models[1];
		component.form.fastMode = true;
		component.handleInput("F");
		assert.equal(component.form.fastMode, false);
		component.handleInput("F");
		assert.equal(component.form.fastMode, false);
		assert.match(component.render(100).join("\n"), /requires a GPT model/);
	} finally {
		state.component.dispose();
	}
});
