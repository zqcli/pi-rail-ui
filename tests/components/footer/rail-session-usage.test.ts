import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import {
	collectFooterUsageStats,
	collectRailSessionSnapshot,
} from "../../../components/footer/footer-session-snapshot";
import { renderRailSessionContent } from "../../../components/footer/rail-session-presenter";

type EntryLike = Record<string, any>;

function snapshotContext(entries: EntryLike[]) {
	return {
		cwd: "/tmp/project",
		model: { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionId: () => "session-usage-test",
			getSessionFile: () => "/tmp/project/session-usage.jsonl",
			getSessionName: () => undefined,
			getBranch: () => entries,
			getEntries: () => entries,
		},
	};
}

const pi: any = {
	getThinkingLevel: () => "xhigh",
	getActiveTools: () => [],
	getAllTools: () => [],
};

const theme: any = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function assistantEntry(id: string): EntryLike {
	return {
		type: "message",
		id,
		parentId: id === "m1" ? null : "m1",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `answer ${id}` }],
			api: "openai-responses",
			provider: "cus-resp",
			model: "gpt-5.6-sol",
			usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, totalTokens: 180, cost: { total: 0.5 } },
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function summaryEntry(type: "compaction" | "branch_summary", id: string, withUsage: boolean): EntryLike {
	const base = type === "compaction"
		? { firstKeptEntryId: "m2", tokensBefore: 10, summary: "earlier context" }
		: { fromId: "m1", summary: "abandoned branch" };
	return {
		type,
		id,
		parentId: "m1",
		timestamp: "2026-01-01T00:00:01.000Z",
		...base,
		...(withUsage
			? { usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 300, cost: { total: 1 } } }
			: {}),
	};
}

test("session token and cost totals include compaction and branch summary LLM spend", () => {
	const entries = [
		assistantEntry("m1"),
		summaryEntry("compaction", "c1", true),
		{ ...summaryEntry("branch_summary", "b1", true), usage: { input: 50, output: 25, cacheRead: 0, cacheWrite: 0, totalTokens: 75, cost: { total: 0.25 } } },
	];
	const ctx: any = snapshotContext(entries);

	const snapshot = collectRailSessionSnapshot(ctx, pi);
	assert.deepEqual(snapshot.session.tokens, {
		input: 350,
		output: 175,
		cacheRead: 25,
		cacheWrite: 5,
		total: 555,
	});
	assert.equal(snapshot.session.cost, 1.75);
	// Summary entries are not conversation messages.
	assert.equal(snapshot.session.assistantMessages, 1);
	assert.equal(snapshot.session.totalMessages, 1);

	// The same totals drive the compact footer line.
	assert.deepEqual(collectFooterUsageStats(ctx), {
		inputTokens: 350,
		outputTokens: 175,
		cacheReadTokens: 25,
		cacheWriteTokens: 5,
		cost: 1.75,
	});

	const rendered = renderRailSessionContent(snapshot, theme, 80).join("\n");
	assert.match(rendered, /Tokens/);
});

test("summary entries without usage keep message-only totals (legacy compatibility)", () => {
	const entries = [
		assistantEntry("m1"),
		summaryEntry("compaction", "c1", false),
		summaryEntry("branch_summary", "b1", false),
	];
	const stats = collectFooterUsageStats(snapshotContext(entries) as any);
	assert.deepEqual(stats, {
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 25,
		cacheWriteTokens: 5,
		cost: 0.5,
	});
});

test("official standalone usage entries add spend without changing message or context counts", () => {
	const manager = SessionManager.inMemory("/tmp/project");
	const usage: Usage = {
		input: 2, output: 3, cacheRead: 100, cacheWrite: 5, totalTokens: 110,
		cost: { input: 0, output: 0, cacheRead: 0.125, cacheWrite: 0, total: 0.125 },
	};
	manager.appendUsage("cache_warm", "anthropic", "fixture", usage);
	manager.appendUsage("future_operation", "anthropic", "fixture", usage);
	const entries = [
		assistantEntry("m1"),
		...manager.getEntries(),
		summaryEntry("compaction", "c1", true),
		summaryEntry("branch_summary", "b1", false),
		{ type: "message", message: { role: "toolResult", usage } },
	];
	const ctx = snapshotContext(entries) as any;
	assert.deepEqual(collectFooterUsageStats(ctx), {
		inputTokens: 306, outputTokens: 159, cacheReadTokens: 325, cacheWriteTokens: 20, cost: 1.875,
	});
	const snapshot = collectRailSessionSnapshot(ctx, pi);
	assert.equal(snapshot.session.tokens.total, 810);
	assert.equal(snapshot.session.cost, 1.875);
	assert.equal(snapshot.session.assistantMessages, 1);
	assert.equal(snapshot.session.toolResults, 1);
	assert.equal(snapshot.session.totalMessages, 2);
	assert.equal(snapshot.state.contextTokens, 0);
	assert.deepEqual(manager.buildSessionContext().messages, []);
});

test("standalone spend uses the whole session rather than only the active branch", () => {
	const manager = SessionManager.inMemory("/tmp/project");
	const usage: Usage = {
		input: 2, output: 3, cacheRead: 100, cacheWrite: 5, totalTokens: 110,
		cost: { input: 0, output: 0, cacheRead: 0.125, cacheWrite: 0, total: 0.125 },
	};
	manager.appendUsage("cache_warm", "anthropic", "fixture", usage);
	manager.resetLeaf();
	manager.appendUsage("unknown_kind", "anthropic", "fixture", usage);
	assert.equal(manager.getBranch().length, 1);
	const ctx = {
		...snapshotContext([]),
		sessionManager: manager,
		getContextUsage: () => ({ tokens: 42, contextWindow: 100_000, percent: 0.042 }),
	} as any;
	const snapshot = collectRailSessionSnapshot(ctx, pi);
	assert.equal(snapshot.session.tokens.total, 220);
	assert.equal(snapshot.session.cost, 0.25);
	assert.equal(snapshot.session.totalMessages, 0);
	assert.equal(snapshot.state.contextTokens, 42);
	assert.equal(snapshot.state.contextPercent, 0.042);
	assert.deepEqual(collectFooterUsageStats(ctx), {
		inputTokens: 4, outputTokens: 6, cacheReadTokens: 200, cacheWriteTokens: 10, cost: 0.25,
	});
});
