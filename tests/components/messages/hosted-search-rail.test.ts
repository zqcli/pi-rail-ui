import assert from "node:assert/strict";
import { before, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	HostedSearchRailBlock,
	hostedSearchBlockForAssistant,
} from "../../../components/messages/hosted-search-rail";
import { stripAnsi } from "../../../core/utils";
import {
	HostedSearchActivity,
	resetHostedSearchActivities,
	setActiveHostedSearchActivity,
} from "../../../openai/hosted-search-activity";
import { resolveRailSection, setRailSectionExpanded } from "../../../rail/rail-section";
import { setRailUiActive } from "../../../rail/rail-section";

const theme = {
	fg: (_name: string, value: string) => value,
	bold: (value: string) => value,
};

before(() => {
	initTheme("dark");
});

test("stays invisible until a real hosted call is observed, then expands while running", () => {
	const owner: any = {};
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna", startedAt: 1000 });
	const block = new HostedSearchRailBlock(activity, theme as any, owner);
	assert.deepEqual(block.render(100), []);

	activity.upsertCall("ws_1", "searching", { type: "search", query: "latest codex commit" });
	const running = stripAnsi(block.render(100).join("\n"));
	assert.match(running, /WEB SEARCH · searching/);
	assert.match(running, /Search: latest codex commit/);
	assert.equal(block.render(100)[0]?.includes("\x1b_pi-rail-click:start:"), false);
});

test("toggles hosted search expansion with a component click, ignoring press and release", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna", startedAt: 1000 });
	activity.upsertCall("ws_1", "completed", { type: "open_page", url: "https://github.com/openai/codex/commits/main" });
	activity.addSource("https://github.com/openai/codex", "OpenAI Codex");
	activity.complete(3000);
	const block = new HostedSearchRailBlock(activity, theme as any, {});
	const click = (type: string) => ({
		type,
		button: "left",
		x: 2,
		y: 0,
		screenX: 2,
		screenY: 0,
		width: 100,
		height: 2,
		shift: false,
		alt: false,
		ctrl: false,
	});

	assert.equal(block.handleMouse(click("press") as any), undefined);
	assert.equal(block.handleMouse(click("release") as any), undefined);
	assert.doesNotMatch(stripAnsi(block.render(100).join("\n")), /Opened:/);

	assert.deepEqual(block.handleMouse(click("click") as any), { handled: true });
	assert.match(stripAnsi(block.render(100).join("\n")), /Opened:/);

	assert.deepEqual(block.handleMouse(click("click") as any), { handled: true });
	assert.doesNotMatch(stripAnsi(block.render(100).join("\n")), /Opened:/);
});

test("auto-collapses completed searches and supports Rail expansion", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna", startedAt: 1000 });
	activity.upsertCall("ws_1", "completed", {
		type: "open_page",
		url: "https://github.com/openai/codex/commits/main",
	});
	activity.addSource("https://github.com/openai/codex", "OpenAI Codex");
	activity.complete(3000);
	const block = new HostedSearchRailBlock(activity, theme as any, {});

	const collapsed = stripAnsi(block.render(100).join("\n"));
	assert.match(collapsed, /WEB SEARCH · completed · 1 call · 2 sources · 2\.0s/);
	assert.match(collapsed, /expand/);
	assert.doesNotMatch(collapsed, /Opened:/);

	const section = resolveRailSection(block);
	assert.ok(section);
	setRailSectionExpanded(section, true);
	const expandedRows = block.render(100);
	const expanded = stripAnsi(expandedRows.join("\n"));
	assert.match(expanded, /Opened:/);
	assert.equal(expandedRows.length >= 4, true);
	assert.equal(expandedRows.join("\n").includes("https://github.com/openai/codex"), true);
});

test("hides with Rail UI and clears a cached block after activity lookup misses", () => {
	const owner: any = {};
	const message = { provider: "custom", model: "gpt", timestamp: 1234 };
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt" });
	activity.associateMessage(message);
	activity.upsertCall("ws_1", "completed", { type: "search", query: "stale" });
	activity.complete();
	setActiveHostedSearchActivity(activity);
	const block = hostedSearchBlockForAssistant(owner, message, theme as any);
	assert.ok(block);
	setRailUiActive(false);
	try {
		assert.deepEqual(block.render(80), []);
	} finally {
		setRailUiActive(true);
	}
	resetHostedSearchActivities();
	assert.equal(hostedSearchBlockForAssistant(owner, message, theme as any), undefined);
});

test("keeps failed searches expanded with the failure reason", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna" });
	activity.upsertCall("ws_1", "in_progress");
	activity.fail("Search backend unavailable");
	const block = new HostedSearchRailBlock(activity, theme as any, {});
	const rendered = stripAnsi(block.render(100).join("\n"));
	assert.match(rendered, /WEB SEARCH · failed/);
	assert.match(rendered, /Error: Search backend unavailable/);
});
