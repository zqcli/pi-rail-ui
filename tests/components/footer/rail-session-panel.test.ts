import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { openRailSessionModal, RailSessionModal } from "../../../components/footer/footer";
import { renderRailSessionContent } from "../../../components/footer/rail-session-presenter";

const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const tools = ["read", "bash", "edit", "write", "apply-patch", "subagent", "subagent_team", "web_search", "grep", "find", "ls", "todo"];

function snapshot(overrides: Record<string, unknown> = {}): any {
	return {
		keepAlive: "KA 50m WAIT (next 19:32:10)",
		keepAliveLabel: "KA 50|45",
		capturedAt: new Date(0),
		state: {
			cwd: "~/Develops/project", cwdShort: "project", branch: "dev", sessionName: "review", idle: true, pending: false,
			modelId: "claude-opus-5.5", modelShort: "claude opus 5.5", provider: "cus-resp", thinking: "high",
			activeTools: tools, allToolCount: 15,
			extensionStatuses: ["GPT compact: native", "FAST inactive", "SEARCH off", "Team: 2 members running"],
			contextTokens: 95_200, contextWindow: 512_000, contextPercent: 18.59, usingSubscription: false,
		},
		session: {
			sessionFile: "/Users/me/.pi/agent/sessions/--Users-me-Develops-project--/2026-09-29T08-56-35-452Z_01a0ec61.jsonl",
			sessionId: "01a0ec61-4f7b-7704-9943-695a9d0ae52a",
			userMessages: 42, assistantMessages: 310, toolCalls: 590, toolResults: 588, totalMessages: 940,
			tokens: { input: 1_200_000, output: 380_000, cacheRead: 88_000_000, cacheWrite: 0, total: 89_580_000 }, cost: 42.3,
		},
		...overrides,
	};
}

test("rail session content lists every active tool, extension status and the full keep-alive state", () => {
	const lines = renderRailSessionContent(snapshot(), theme, 88);
	const text = lines.join("\n");
	for (const tool of tools) assert.match(text, new RegExp(`\\b${tool}\\b`));
	for (const status of snapshot().state.extensionStatuses) assert.ok(text.includes(status), status);
	assert.match(text, /Tools\s+12\/15 active/);
	assert.match(text, /Keep-alive\s+KA 50\|45 · WAIT \(next 19:32:10\) · fees unknown/);
	assert.match(text, /Context\s+█+░+ 18\.6% 95\.2k \/ 512\.0k/);
	assert.match(text, /Model\s+cus-resp\/claude-opus-5\.5 · thinking high/);
	// The session file wraps instead of being cut off.
	assert.ok(text.replace(/\n\s+/g, "").includes(snapshot().session.sessionFile));
	assert.ok(lines.every((line) => visibleWidth(line) <= 88));
});

test("a paused keep-alive names the reason once; wide panels put usage beside the live state", () => {
	const paused = renderRailSessionContent(snapshot({ keepAlive: "KA 50m PAUSED (timer late after sleep)", keepAliveLabel: "KA 50|PAUSED" }), theme, 88).join("\n");
	assert.match(paused, /KA 50\|PAUSED · paused: timer late after sleep/);
	const narrow = renderRailSessionContent(snapshot(), theme, 88);
	const wide = renderRailSessionContent(snapshot(), theme, 116);
	assert.ok(wide.length < narrow.length);
	assert.ok(wide.some((line) => /Model .*User\s+42/.test(line)));
	assert.ok(wide.every((line) => visibleWidth(line) <= 116));
	// Realistic long values keep every fact readable in both layouts.
	const long = snapshot();
	long.state = { ...long.state, provider: "anthropic", modelId: "claude-sonnet-4-5-20250929", thinking: "medium", usingSubscription: true,
		extensionStatuses: [`Team: 3 running: ${"alice, bob, carol, ".repeat(8)}end`, "团队状态：两个成员正在运行，一个等待中"] };
	for (const width of [110, 116, 88, 34]) {
		const lines = renderRailSessionContent(long, theme, width);
		const joined = lines.join("\n");
		const flat = lines.map((line) => line.trim()).join(" ");
		assert.match(flat, /thinking medium/, `width ${width}`);
		assert.match(joined, /Cost\s+\$42\.30 \(sub\)\s+Total/, `width ${width}`);
		assert.match(flat, /carol, end/, `width ${width}`);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
	}
});

test("rail session overlay scrolls to the rows that no longer fit instead of dropping them", () => {
	let closed = false;
	const modal = new RailSessionModal(snapshot(), theme, 26, () => { closed = true; });
	const first = modal.render(92).join("\n");
	assert.equal(modal.render(92).length, 26);
	assert.match(first, /Now/);
	assert.doesNotMatch(first, /Team: 2 members running/);
	assert.match(first, /1-22\/\d+ · ↑↓ PgUp\/PgDn scroll/);
	modal.handleInput("\x1b[F"); // End
	const last = modal.render(92).join("\n");
	assert.match(last, /Team: 2 members running/);
	assert.match(last, /subagent_team/);
	modal.handleInput("\x1b[H"); // Home
	assert.match(modal.render(92).join("\n"), /Rail Session/);
	modal.update(snapshot({ keepAliveLabel: "KA 50|44" }));
	assert.match(modal.render(92).join("\n"), /KA 50\|44/);
	modal.handleInput("q");
	assert.equal(closed, true);
	// The page follows the terminal height on every frame, so shrinking the window never clips rows.
	let rows = 60;
	const resized = new RailSessionModal(snapshot(), theme, () => rows, () => {});
	assert.match(resized.render(92).join("\n"), /Esc\/Enter\/q close/);
	rows = 24;
	assert.equal(resized.render(92).length, 24);
	assert.match(resized.render(92).join("\n"), /1-20\/\d+ · ↑↓/);
});

test("the open panel refreshes each second and stops when closed or when its session goes stale", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let stale = false;
	let collections = 0;
	const ctx: any = {
		mode: "tui", cwd: "/tmp/project", model: { id: "m", provider: "p" }, modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => { if (stale) throw new Error("stale ctx"); collections++; return { tokens: 1, contextWindow: 10, percent: 10 }; },
		isIdle: () => true, hasPendingMessages: () => false,
		sessionManager: { getCwd: () => "/tmp/project", getSessionId: () => "s", getSessionFile: () => undefined, getSessionName: () => undefined, getBranch: () => [], getEntries: () => [] },
		ui: { custom: undefined as any },
	};
	const pi: any = { getThinkingLevel: () => "off", getActiveTools: () => [], getAllTools: () => [] };
	for (const ending of ["closed", "stale"] as const) {
		let renders = 0;
		let close!: () => void;
		let panel: any;
		ctx.ui.custom = (factory: any) => new Promise<void>((resolve) => {
			panel = factory({ requestRender: () => { renders++; } }, theme, undefined, () => { panel.dispose(); resolve(); });
			close = () => panel.handleInput("q");
		});
		stale = false;
		collections = 0;
		const opened = openRailSessionModal(ctx, pi);
		t.mock.timers.tick(3000);
		assert.equal(renders, 3, ending);
		assert.equal(collections, 4, "one snapshot at open plus one per second");
		if (ending === "stale") { stale = true; t.mock.timers.tick(1000); stale = false; }
		else { close(); await opened; }
		t.mock.timers.tick(5000);
		assert.equal(collections, 4, `${ending}: no refresh after the panel ends`);
	}
});
