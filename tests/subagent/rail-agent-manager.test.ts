import assert from "node:assert/strict";
import { test } from "node:test";
import { installRailSubagent } from "../../tools/subagents";
import { runRailAgentManager } from "../../tools/subagents/rail-agent-manager";
import { filterSessions } from "../../tools/subagents/session-picker";

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
	const selectTitles: string[] = [];
	let editorText = "";
	let confirmations = 0;
	const attached: any[] = [];
	const ctx = {
		...modelContext(),
		cwd: "/tmp/project",
		hasUI: true,
		sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
		ui: {
			select: async (title: string, options: string[]) => {
				selectTitles.push(title);
				if (title === "Rail agents") return options.find((option) => option.startsWith("Link saved session"));
				return options[0];
			},
			confirm: async () => { confirmations++; return true; },
			notify: () => undefined,
			setStatus: () => undefined,
			getEditorText: () => editorText,
			setEditorText: (value: string) => { editorText = value; },
		},
	};
	const runtime = {
		broker: {
			listLinked: async () => [],
			attach: async (request: any) => {
				attached.push(request);
				return { alias: request.alias, agentId: "agt_linked" };
			},
		},
		roster: { link: () => undefined },
		store: { list: async () => [] },
	};

	await runRailAgentManager(ctx as any, runtime as any, {
		listSessions: async () => [{
			path: "/tmp/saved.jsonl",
			id: "saved-session",
			cwd: "/tmp/project",
			created: new Date("2026-01-01"),
			modified: new Date("2026-01-02"),
			messageCount: 4,
			firstMessage: "Review auth",
			allMessagesText: "Review auth",
		}],
	});

	assert.deepEqual(selectTitles, ["Rail agents", "Saved Pi session", "Pi model"]);
	assert.equal(confirmations, 0);
	assert.equal(attached.length, 1);
	assert.deepEqual(attached[0].model, {
		provider: "cus-resp",
		modelId: "gpt-5.6-sol",
		name: "GPT 5.6 Sol",
		thinkingLevel: "xhigh",
	});
	assert.deepEqual(attached[0].session, { mode: "fork", path: "/tmp/saved.jsonl" });
	assert.match(attached[0].alias, /^gpt-5\.6-sol-/);
	assert.equal(editorText, `@agent/${attached[0].alias} `);
});

test("starting a persistent session selects a model and defers creation until task submission", async () => {
	let editorText = "";
	const attached: any[] = [];
	const ctx = {
		...modelContext(),
		cwd: "/tmp/project", hasUI: true,
		ui: {
			select: async (title: string, options: string[]) => title === "Rail agents" ? options.find((item) => item.startsWith("Start persistent")) : options[0],
			notify: () => undefined,
			getEditorText: () => editorText,
			setEditorText: (value: string) => { editorText = value; },
		},
	};
	await runRailAgentManager(ctx as any, {
		broker: {
			listLinked: async () => [],
			attach: async (request: any) => { attached.push(request); return { alias: request.alias, agentId: "agt_1" }; },
		},
		roster: { link: () => undefined },
		store: { list: async () => [] },
	} as any);

	assert.equal(attached.length, 0);
	assert.equal(editorText, "@new/cus-resp/gpt-5.6-sol:xhigh ");
});

test("session popup search matches words across title, message, project, and id", () => {
	const sessions = [
		{
			path: "/tmp/auth.jsonl", id: "session-auth", cwd: "/tmp/project", name: "Security review",
			created: new Date(), modified: new Date(), messageCount: 1,
			firstMessage: "Inspect login races", allMessagesText: "Inspect login races",
		},
		{
			path: "/tmp/db.jsonl", id: "session-db", cwd: "/tmp/database", name: "Storage",
			created: new Date(), modified: new Date(), messageCount: 1,
			firstMessage: "Tune indexes", allMessagesText: "Tune indexes",
		},
	];

	assert.deepEqual(filterSessions(sessions, "security login").map((item) => item.id), ["session-auth"]);
	assert.deepEqual(filterSessions(sessions, "database indexes").map((item) => item.id), ["session-db"]);
});

test("TUI management uses one centered unified overlay", async () => {
	const session = {
		path: "/tmp/saved.jsonl", id: "saved-session", cwd: "/tmp/project",
		created: new Date(), modified: new Date(), messageCount: 1,
		firstMessage: "Review auth", allMessagesText: "Review auth",
	};
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
	} as any, { listSessions: async () => { listSessionCalls++; return [session]; } });

	assert.equal(overlayOptions.length, 1);
	assert.equal(overlayOptions[0].overlay, true);
	assert.equal(overlayOptions[0].overlayOptions.anchor, "center");
	assert.equal(overlayOptions[0].overlayOptions.width, "92%");
	assert.equal(listSessionCalls, 0);
});
