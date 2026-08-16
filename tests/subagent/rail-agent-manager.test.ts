import assert from "node:assert/strict";
import { test } from "node:test";
import installStatefulSubagent from "../../subagent/index";
import { runRailAgentManager } from "../../subagent/rail-agent-manager";
import { filterSessions } from "../../subagent/session-picker";
import type { AgentConfig } from "../../subagent/agents";

const reviewer: AgentConfig = {
	name: "reviewer",
	description: "Review code",
	systemPrompt: "Review carefully.",
	source: "user",
	filePath: "/tmp/reviewer.md",
};

test("standalone extension exposes only the Rail-namespaced slash command", () => {
	const commands: string[] = [];
	installStatefulSubagent({
		registerTool: () => undefined,
		registerCommand: (name: string) => { commands.push(name); },
		on: () => undefined,
		appendEntry: () => undefined,
	} as any);

	assert.deepEqual(commands, ["rail-agent"]);
});

test("safe session linking uses progressive disclosure and defaults to fork", async () => {
	const selectTitles: string[] = [];
	let editorText = "";
	let confirmations = 0;
	let inputs = 0;
	const attached: any[] = [];
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
		ui: {
			select: async (title: string, options: string[]) => {
				selectTitles.push(title);
				if (title === "Rail agents") return options.find((option) => option.startsWith("Link saved session"));
				return options[0];
			},
			input: async () => { inputs++; return ""; },
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
		discoverProfiles: () => ({ agents: [reviewer], projectAgentsDir: null }),
	});

	assert.deepEqual(selectTitles, ["Rail agents", "Saved Pi session", "Agent profile"]);
	assert.equal(confirmations, 0);
	assert.equal(inputs, 0);
	assert.equal(attached.length, 1);
	assert.deepEqual(attached[0].session, { mode: "fork", path: "/tmp/saved.jsonl" });
	assert.match(attached[0].alias, /^reviewer-/);
	assert.equal(editorText, `@agent/${attached[0].alias} `);
});

test("starting a persistent agent defers creation until the user submits a task", async () => {
	let editorText = "";
	const attached: any[] = [];
	const ctx = {
		cwd: "/tmp/project", hasUI: true, isProjectTrusted: () => true,
		ui: {
			select: async (title: string, options: string[]) => title === "Rail agents" ? options.find((item) => item.startsWith("Start persistent")) : options[0],
			confirm: async () => true,
			notify: () => undefined,
			setStatus: () => undefined,
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
	} as any, { discoverProfiles: () => ({ agents: [reviewer], projectAgentsDir: null }) });

	assert.equal(attached.length, 0);
	assert.equal(editorText, "@new/reviewer ");
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

test("TUI session linking uses a centered searchable overlay", async () => {
	const session = {
		path: "/tmp/saved.jsonl", id: "saved-session", cwd: "/tmp/project",
		created: new Date(), modified: new Date(), messageCount: 1,
		firstMessage: "Review auth", allMessagesText: "Review auth",
	};
	let overlayOptions: any;
	const attached: any[] = [];
	const ctx = {
		mode: "tui", cwd: "/tmp/project", hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionFile: () => "/tmp/current.jsonl" },
		ui: {
			select: async (title: string, options: string[]) => title === "Rail agents" ? options.find((item) => item.startsWith("Link saved session")) : options[0],
			custom: async (_factory: unknown, options: unknown) => { overlayOptions = options; return session; },
			input: async () => "review-session",
			confirm: async () => true,
			notify: () => undefined,
			setStatus: () => undefined,
			getEditorText: () => "",
			setEditorText: () => undefined,
		},
	};
	await runRailAgentManager(ctx as any, {
		broker: { listLinked: async () => [], attach: async (request: any) => { attached.push(request); return { alias: request.alias, agentId: "agt_1" }; } },
		roster: { link: () => undefined },
		store: { list: async () => [] },
	} as any, {
		listSessions: async () => [session],
		discoverProfiles: () => ({ agents: [reviewer], projectAgentsDir: null }),
	});

	assert.equal(overlayOptions.overlay, true);
	assert.equal(overlayOptions.overlayOptions.anchor, "center");
	assert.equal(attached[0].session.mode, "fork");
});
