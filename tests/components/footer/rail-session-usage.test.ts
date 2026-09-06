import assert from "node:assert/strict";
import { test } from "node:test";
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