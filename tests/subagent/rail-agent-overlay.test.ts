import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { RailAgentOverlayComponent } from "../../tools/subagents/rail-agent-overlay";
import { RailAgentManager, type RailAgentView } from "../../tools/subagents/agent-manager";
import { railModelReference, type RailModelRef } from "../../tools/subagents/models";

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

function setup(phase: "idle" | "running" | "starting" | "queued" | "stopped" | "error" | "in-use-elsewhere" | "unknown" = "idle", terminalRows = 30, compacting = false) {
	let renders = 0;
	let closed = false;
	const currentSnapshot: any = structuredClone(snapshot);
	currentSnapshot.agents[0]!.phase = phase;
	currentSnapshot.agents[0]!.isCompacting = compacting;
	currentSnapshot.counts.running = phase === "running" ? 1 : 0;
	currentSnapshot.counts.idle = phase === "idle" ? 1 : 0;
	const controls: unknown[] = [];
	const availableModels = structuredClone(models);
	const mentions: string[] = [];
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
			models: availableModels,
			sessions,
			currentCwd: "/tmp/project",
			insertMention: (alias) => { mentions.push(alias); },
		},
		currentSnapshot,
	);
	return { component, controls, manager, models: availableModels, mentions, sessions, snapshot: currentSnapshot, get renders() { return renders; }, get closed() { return closed; } };
}

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
		ui.handleInput("\r");
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

test("running agents show compacting as an activity status while remaining controllable", () => {
	const state = setup("running", 30, true);
	try {
		const text = state.component.render(100).join("\n");
		assert.match(text, /COMPACTING/);
		assert.match(text, /1 running · 0 queued/);
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
