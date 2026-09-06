import assert from "node:assert/strict";
import { test } from "node:test";
import { type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import {
	appendSubagentTranscriptFailure,
	boundSubagentRunTranscripts,
	SubagentTranscript,
	renderSubagentTranscript,
	type SubagentTranscriptRun,
	type SubagentTranscriptSnapshot,
} from "../../tools/subagents/transcript";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const markdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

test("SubagentTranscript assembles user, thinking, assistant, tool call, and tool result events", () => {
	const transcript = new SubagentTranscript("Inspect authentication");
	transcript.ingest({ type: "message_start", message: { role: "assistant", content: [] } });
	transcript.ingest({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Need inspect files" } });
	transcript.ingest({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "I will inspect auth." } });
	transcript.ingest({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 } });
	transcript.ingest({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{\"path\":\"auth" } });
	assert.match(transcript.snapshot().entries.at(-1)?.text ?? "", /auth/);
	transcript.ingest({
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 2,
			toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "auth.ts" } },
		},
	});
	transcript.ingest({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "auth.ts" } });
	transcript.ingest({
		type: "tool_execution_update",
		toolCallId: "call-1",
		toolName: "read",
		partialResult: { content: [{ type: "text", text: "partial source" }] },
	});
	transcript.ingest({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "read",
		result: { content: [{ type: "text", text: "final source" }] },
		isError: false,
	});
	transcript.ingest({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Need inspect files" },
				{ type: "text", text: "I will inspect auth." },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "auth.ts" } },
			],
		},
	});
	transcript.ingest({
		type: "message_end",
		message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "final source" }], isError: false },
	});
	transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Authentication is correct." }] } });

	const snapshot = transcript.snapshot();
	assert.deepEqual(snapshot.entries.map((entry) => entry.kind), [
		"user",
		"thinking",
		"assistant",
		"tool",
		"toolResult",
		"assistant",
	]);
	assert.equal(snapshot.entries.find((entry) => entry.kind === "tool")?.status, "completed");
	assert.equal(snapshot.entries.find((entry) => entry.kind === "toolResult")?.text, "final source");
	assert.equal(snapshot.entries.at(-1)?.text, "Authentication is correct.");
});

test("initial task bypasses text and row caps while later user and tool activity stays bounded", () => {
	const initialTask = [
		"INITIAL TASK START",
		...Array.from({ length: 24 }, (_, index) => `initial line ${index} ${"i".repeat(180)}`),
		"INITIAL TASK END",
	].join("\n");
	const transcript = new SubagentTranscript(initialTask);
	transcript.ingest({ type: "message_start", message: { role: "user", content: [{ type: "text", text: initialTask }] } });
	transcript.ingest({
		type: "message_end",
		message: { role: "user", content: [{ type: "text", text: `FOLLOW-UP START ${"f".repeat(5000)} FOLLOW-UP END` }] },
	});
	transcript.ingest({
		type: "tool_execution_start",
		toolCallId: "long-tool",
		toolName: "write",
		args: { payload: `TOOL-ARGS-START ${"a".repeat(5000)} TOOL-ARGS-END` },
	});
	transcript.ingest({
		type: "tool_execution_end",
		toolCallId: "long-tool",
		toolName: "write",
		result: { content: [{ type: "text", text: `TOOL-RESULT-START ${"r".repeat(5000)} TOOL-RESULT-END` }] },
		isError: false,
	});

	const snapshot = transcript.snapshot();
	const initial = snapshot.entries.find((entry) => entry.initial);
	const followUp = snapshot.entries.find((entry) => entry.kind === "user" && !entry.initial);
	const tool = snapshot.entries.find((entry) => entry.kind === "tool");
	const toolResult = snapshot.entries.find((entry) => entry.kind === "toolResult");
	assert.equal(initial?.text, initialTask);
	assert.equal(initial?.initial, true);
	assert.equal(snapshot.entries.filter((entry) => entry.kind === "user").length, 2);
	assert.ok(followUp && followUp.text.length <= 4000);
	assert.ok(tool && tool.text.length <= 4000);
	assert.ok(toolResult && toolResult.text.length <= 4000);
	assert.doesNotMatch(followUp?.text ?? "", /FOLLOW-UP START/);
	assert.doesNotMatch(tool?.text ?? "", /TOOL-ARGS-START/);
	assert.doesNotMatch(toolResult?.text ?? "", /TOOL-RESULT-START/);

	const rendered = renderSubagentTranscript([{
		alias: "long-task",
		status: "completed",
		output: "done",
		persistent: false,
		transcript: snapshot,
	}], true, theme as any).render(120).join("\n");
	assert.match(rendered, /INITIAL TASK START/);
	assert.match(rendered, /initial line 23/);
	assert.match(rendered, /INITIAL TASK END/);
	assert.doesNotMatch(rendered, /FOLLOW-UP START/);
	assert.doesNotMatch(rendered, /TOOL-ARGS-START/);
	assert.doesNotMatch(rendered, /TOOL-RESULT-START/);

	const collapsed = renderSubagentTranscript([{
		alias: "long-task",
		status: "completed",
		output: "done",
		persistent: false,
		transcript: snapshot,
	}], false, theme as any).render(120).join("\n");
	assert.match(collapsed, /initial line 23/);
	assert.doesNotMatch(collapsed, /FOLLOW-UP START/);

	const withoutInitial = (text: string): string[] => {
		const lines = text.split("\n");
		const start = lines.findIndex((line) => line.includes("initial task"));
		const end = lines.findIndex((line, index) => index >= start && line.includes("INITIAL TASK END"));
		assert.ok(start >= 0 && end >= start);
		return [...lines.slice(0, start), ...lines.slice(end + 1)];
	};
	const running = {
		alias: "long-task",
		status: "running" as const,
		output: "",
		persistent: false,
		transcript: snapshot,
	};
	assert.ok(withoutInitial(renderSubagentTranscript([running], false, theme as any).render(120).join("\n")).length <= 10);
	assert.ok(withoutInitial(renderSubagentTranscript([running], true, theme as any).render(120).join("\n")).length <= 16);
});

test("a later user message is not reclassified as the initial task", () => {
	const task = `same task ${"x".repeat(5000)}`;
	const transcript = new SubagentTranscript(task);
	transcript.ingest({ type: "message_start", message: { role: "user", content: [{ type: "text", text: task }] } });
	transcript.ingest({ type: "message_start", message: { role: "assistant", content: [] } });
	transcript.ingest({ type: "message_end", message: { role: "user", content: [{ type: "text", text: task }] } });

	const users = transcript.snapshot().entries.filter((entry) => entry.kind === "user");
	assert.equal(users.length, 2);
	assert.equal(users[0]?.initial, true);
	assert.equal(users[1]?.initial, undefined);
	assert.ok((users[1]?.text.length ?? 0) <= 4000);
});

test("SubagentTranscript retains only the latest configured event window", () => {
	const transcript = new SubagentTranscript("task", { maxEntries: 3 });
	for (let index = 0; index < 5; index++) {
		transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] } });
	}

	const snapshot = transcript.snapshot();
	assert.equal(snapshot.entries.length, 4);
	assert.equal(snapshot.entries.filter((entry) => !entry.initial).length, 3);
	assert.equal(snapshot.omittedEntries, 2);
	assert.deepEqual(snapshot.entries.filter((entry) => !entry.initial).map((entry) => entry.text), ["answer 2", "answer 3", "answer 4"]);
});

test("SubagentTranscript surfaces assistant failures even when the model returned no text", () => {
	const transcript = new SubagentTranscript("task");
	transcript.ingest({
		type: "message_end",
		message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed\u001b[31m" },
	});

	const failure = transcript.snapshot().entries.at(-1);
	assert.equal(failure?.id, "assistant:1:error");
	assert.equal(failure?.kind, "assistant");
	assert.equal(failure?.text, "provider failed");
	assert.equal(failure?.status, "failed");
});

test("subagent transcript view keeps a hard row cap and follows the newest activity", () => {
	const transcript: SubagentTranscriptSnapshot = {
		omittedEntries: 4,
		entries: Array.from({ length: 10 }, (_, index) => ({
			id: `assistant-${index}`,
			kind: "assistant" as const,
			text: `assistant message ${index}\nsecond line ${index}`,
			order: index,
		})),
	};
	const view = renderSubagentTranscript([{
		alias: "auth-review",
		status: "running",
		output: "assistant message 9",
		model: "cus-resp/gpt-5.6-sol:xhigh",
		persistent: true,
		transcript,
		usage: { input: 1234, output: 56, cacheRead: 107, cacheWrite: 8, cost: 0.012, contextTokens: 1405, turns: 2 },
		durationMs: 3400,
	}], false, theme as any);
	const lines = view.render(48);
	const text = lines.join("\n");
	const wideText = view.render(120).join("\n");

	assert.ok(lines.length <= 10);
	assert.ok(view.render(120).length <= 10);
	assert.match(lines[0] ?? "", /persistent/);
	assert.match(view.render(120)[0] ?? "", /cus-resp\/gpt-5\.6-sol:xhigh/);
	assert.match(text, /assistant message 9/);
	assert.doesNotMatch(text, /assistant message 0/);
	assert.match(text, /1\.2k in/);
	assert.match(wideText, /107 cache read/);
	assert.match(wideText, /1\.4k context/);
	assert.match(wideText, /2 turns/);
	assert.match(wideText, /\$0\.012/);
	assert.match(wideText, /<1m/);
	assert.match(text, /earlier activity hidden/);
	assert.match(text, /1\.2k in[\s\S]*earlier activity hidden/);
	assert.ok(view.render(10).every((line) => visibleWidth(line) <= 10));
});

test("completed expanded panels show the full final answer and usage metrics", () => {
	const answer = Array.from({ length: 30 }, (_, index) => `final answer line ${index}`).join("\n");
	const transcript = new SubagentTranscript("review authentication");
	transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "authentication reviewed" }] } });
	const run = {
		alias: "auth-review",
		status: "completed" as const,
		output: answer,
		model: "cus-resp/gpt-5.6-sol:xhigh",
		persistent: true,
		transcript: transcript.snapshot(),
		usage: { input: 24812, output: 1946, cacheRead: 18220, cacheWrite: 120, cost: 0.0831, contextTokens: 43112, turns: 3 },
		durationMs: 102800,
		stopReason: "stop",
	};
	const collapsed = renderSubagentTranscript([run], false, theme as any).render(180).join("\n");
	const expanded = renderSubagentTranscript([run], true, theme as any).render(180).join("\n");

	assert.match(collapsed, /expand for full answer/);
	assert.doesNotMatch(collapsed, /final answer line 29/);
	assert.match(expanded, /final answer line 29/);
	assert.match(expanded, /24\.8k in/);
	assert.match(expanded, /18\.2k cache read/);
	assert.match(expanded, /1m/);
	assert.match(expanded, /stop/);
	assert.match(expanded, /Usage ·[\s\S]*Recent activity/);
	assert.match(expanded, /Usage ·[\s\S]*Final answer/);
	assert.match(expanded, /Usage ·[\s\S]*final answer line 0/);
	assert.ok(expanded.split("\n").length > 16);
});

test("expanded completed answers render markdown while collapsed and unsafe terminal output stay literal", () => {
	const output = [
		"# Markdown heading",
		"",
		"A **bold** result with `inline code`.",
		"",
		"- first item",
		"- second item",
		"",
		"```ts",
		"const answer = 42;",
		"```",
	].join("\n");
	const completed = {
		alias: "markdown",
		status: "completed" as const,
		output,
		persistent: false,
	};
	const collapsed = renderSubagentTranscript([completed], false, theme as any, { markdownTheme }).render(100).join("\n");
	const expanded = renderSubagentTranscript([completed], true, theme as any, { markdownTheme }).render(100).join("\n");

	assert.match(collapsed, /# Markdown heading/);
	assert.doesNotMatch(expanded, /# Markdown heading/);
	assert.match(expanded, /Markdown heading/);
	assert.doesNotMatch(expanded, /\*\*bold\*\*/);
	assert.match(expanded, /A bold result with inline code\./);
	assert.match(expanded, /  const answer = 42;/);

	for (const run of [
		{ ...completed, alias: "truncated", outputTruncated: true },
		{ ...completed, alias: "length", stopReason: "length" },
		{ ...completed, alias: "legacy-truncated", output: `${output}\n\n[Final answer truncated in the parent session details.]` },
		{ ...completed, alias: "failed", status: "failed" as const },
		{ ...completed, alias: "control", status: "accepted" as const },
	]) {
		const text = renderSubagentTranscript([run], true, theme as any, { markdownTheme }).render(100).join("\n");
		assert.match(text, /# Markdown heading/);
		assert.match(text, /\*\*bold\*\*/);
	}

	const escaped = renderSubagentTranscript([{
		...completed,
		alias: "escaped",
		output: "\u001b]8;;https://example.com\u0007# Safe heading\u001b]8;;\u0007\n\n**safe**",
	}], true, theme as any, { markdownTheme }).render(100).join("\n");
	assert.doesNotMatch(escaped, /\u001b|\u0007/);
	assert.doesNotMatch(escaped, /# Safe heading/);
	assert.doesNotMatch(escaped, /\*\*safe\*\*/);
});

test("parallel completed child markdown stays cached and within panel width", () => {
	let headingRenders = 0;
	const countingTheme: MarkdownTheme = {
		...markdownTheme,
		heading: (text) => {
			headingRenders++;
			return text;
		},
	};
	const view = renderSubagentTranscript([
		{ alias: "alpha", model: "provider/a", status: "completed", output: "# Alpha\n\n**done**", persistent: false },
		{ alias: "beta", model: "provider/b", status: "failed", output: "# Beta\n\n**failed**", persistent: true },
	], true, theme as any, { markdownTheme: countingTheme });
	const first = view.render(72).join("\n");
	const rendersAfterFirst = headingRenders;
	const secondLines = view.render(72);

	assert.doesNotMatch(first, /# Alpha/);
	assert.doesNotMatch(first, /\*\*done\*\*/);
	assert.match(first, /# Beta/);
	assert.match(first, /\*\*failed\*\*/);
	assert.ok(rendersAfterFirst > 0);
	assert.equal(headingRenders, rendersAfterFirst);
	assert.ok(secondLines.every((line) => visibleWidth(line) <= 72));
	for (const width of [1, 2, 10, 30]) {
		assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
	}

	view.invalidate();
	view.render(72);
	assert.ok(headingRenders > rendersAfterFirst);
});

test("parallel runs render as independent panels with aggregate wall usage", () => {
	const runs = [
		{
			alias: "alpha", model: "provider/model-a:high", status: "completed" as const, output: "alpha final",
			persistent: false, durationMs: 1200,
			usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0, cost: 0.01, contextTokens: 1700, turns: 1 },
		},
		{
			alias: "beta", model: "provider/model-b:xhigh", status: "completed" as const, output: "beta final",
			persistent: true, durationMs: 2400,
			usage: { input: 2000, output: 300, cacheRead: 0, cacheWrite: 100, cost: 0.02, contextTokens: 2400, turns: 2 },
		},
	];
	const text = renderSubagentTranscript(runs, true, theme as any, { durationMs: 2500 }).render(100).join("\n");

	assert.match(text, /2 model sessions · 2 complete/);
	assert.match(text, /3k in/);
	assert.match(text, /wall <1m/);
	assert.match(text, /alpha · stateless · provider\/model-a:high/);
	assert.match(text, /beta · persistent · provider\/model-b:xhigh/);
	assert.match(text, /alpha final/);
	assert.match(text, /beta final/);
	const alphaPanel = text.slice(text.indexOf("alpha · stateless"), text.indexOf("beta · persistent"));
	const betaPanel = text.slice(text.indexOf("beta · persistent"));
	assert.match(alphaPanel, /Usage ·[\s\S]*alpha final/);
	assert.match(betaPanel, /Usage ·[\s\S]*beta final/);
	assert.equal((text.match(/╭/gu) ?? []).length, 2);
	for (const width of [1, 2]) {
		assert.ok(renderSubagentTranscript(runs, false, theme as any).render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("usage elapsed time changes only at minute boundaries", () => {
	const renderDuration = (durationMs: number): string => renderSubagentTranscript([{
		alias: "timer",
		status: "running",
		output: "",
		persistent: false,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
		durationMs,
	}], false, theme as any).render(100).join("\n");

	assert.match(renderDuration(1_000), /Usage · .*<1m/);
	assert.match(renderDuration(59_999), /Usage · .*<1m/);
	assert.match(renderDuration(60_000), /Usage · .*1m/);
	assert.doesNotMatch(renderDuration(60_000), /<1m/);
	assert.match(renderDuration(119_999), /Usage · .*1m/);
	assert.match(renderDuration(120_000), /Usage · .*2m/);
});

test("empty runs render only a zero-summary header within the row cap", () => {
	const header = "0 model sessions · 0 persistent · 0 stateless · 0 complete · 0 running · 0 failed";
	const collapsed = renderSubagentTranscript([], false, theme as any).render(header.length + 10);
	const expanded = renderSubagentTranscript([], true, theme as any).render(header.length + 10);

	assert.deepEqual(collapsed.map((line) => line.trim()), [header]);
	assert.deepEqual(expanded.map((line) => line.trim()), [header]);
	assert.ok(renderSubagentTranscript([], false, theme as any).render(1).every((line) => visibleWidth(line) <= 1));
});

test("single running run without a transcript falls back to its output line", () => {
	const run = {
		alias: "timer",
		status: "running" as const,
		output: "",
		persistent: false,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
		durationMs: 1000,
	};
	const collapsed = renderSubagentTranscript([run], false, theme as any).render(80);
	const expanded = renderSubagentTranscript([run], true, theme as any).render(80);

	assert.match(collapsed[0]?.trim() ?? "", /^… timer · stateless · model unavailable$/);
	assert.match(collapsed.join("\n"), /Usage ·[\s\S]*\(running\.\.\.\)/);
	assert.ok(collapsed.length <= 10);
	assert.ok(expanded.length <= 16);
	assert.match(expanded.join("\n"), /\(running\.\.\.\)/);
});

test("single running fallback hides the usage line when nothing is reportable", () => {
	const plain = { alias: "a", status: "running" as const, output: "working", persistent: false };
	const withZeroUsage = {
		...plain,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
	const noUsageRows = renderSubagentTranscript([plain], false, theme as any).render(80);
	const zeroUsageRows = renderSubagentTranscript([withZeroUsage], false, theme as any).render(80);

	assert.deepEqual(noUsageRows.map((line) => line.trim()), [
		"… a · stateless · model unavailable",
		"● assistant  working",
	]);
	assert.deepEqual(zeroUsageRows.map((line) => line.trim()), [
		"… a · stateless · model unavailable",
		"Usage · 0 in · 0 out",
		"● assistant  working",
	]);
});

test("global retention keeps the newest events across parallel runs, independent of run order", () => {
	const alpha = new SubagentTranscript("alpha");
	const beta = new SubagentTranscript("beta");
	// Global activity order, oldest first: beta 0, beta 1, alpha 0, beta 2, beta 3, alpha 1.
	beta.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "beta 0" }] } });
	beta.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "beta 1" }] } });
	alpha.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "alpha 0" }] } });
	beta.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "beta 2" }] } });
	beta.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "beta 3" }] } });
	alpha.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "alpha 1" }] } });
	const runs: SubagentTranscriptRun[] = [
		{ alias: "alpha", status: "running", output: "", persistent: true, transcript: alpha.snapshot() },
		{ alias: "beta", status: "running", output: "", persistent: false, transcript: beta.snapshot() },
	];
	for (const ordered of [runs, [...runs].reverse()]) {
		const bounded = boundSubagentRunTranscripts(ordered, 3);
		const byAlias = new Map(bounded.map((run) => [run.alias, run]));
		const retained = (alias: string) => byAlias.get(alias)!.transcript!.entries.filter((entry) => !entry.initial).map((entry) => entry.text);
		assert.deepEqual(retained("alpha"), ["alpha 1"]);
		assert.deepEqual(retained("beta"), ["beta 2", "beta 3"]);
		assert.equal(byAlias.get("alpha")!.transcript!.entries.find((entry) => entry.initial)?.text, "alpha");
		assert.equal(byAlias.get("beta")!.transcript!.entries.find((entry) => entry.initial)?.text, "beta");
	}
});

test("grouped child panels keep each run's initial task complete and associated", () => {
	const alphaTask = ["ALPHA INITIAL START", ...Array.from({ length: 24 }, (_, index) => `alpha line ${index} ${"a".repeat(180)}`), "ALPHA INITIAL END"].join("\n");
	const betaTask = ["BETA INITIAL START", ...Array.from({ length: 24 }, (_, index) => `beta line ${index} ${"b".repeat(180)}`), "BETA INITIAL END"].join("\n");
	const alpha = new SubagentTranscript(alphaTask);
	const beta = new SubagentTranscript(betaTask);
	for (let index = 0; index < 18; index++) {
		alpha.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `alpha activity ${index}` }] } });
		beta.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `beta activity ${index}` }] } });
	}
	const runs = [
		{ alias: "planner", model: "provider/model-a", status: "running" as const, output: "", persistent: false, step: 1, transcript: alpha.snapshot() },
		{ alias: "reviewer", model: "provider/model-b", status: "running" as const, output: "", persistent: true, step: 2, transcript: beta.snapshot() },
	];
	const bounded = boundSubagentRunTranscripts(runs);
	assert.equal(bounded[0]?.transcript?.entries.find((entry) => entry.initial)?.text, alphaTask);
	assert.equal(bounded[1]?.transcript?.entries.find((entry) => entry.initial)?.text, betaTask);
	assert.ok(bounded.reduce((total, run) => total + (run.transcript?.entries.filter((entry) => !entry.initial).length ?? 0), 0) <= 18);

	const rendered = renderSubagentTranscript(runs, true, theme as any).render(120).join("\n");
	const plannerHeader = rendered.indexOf("step 1 · planner · stateless · provider/model-a");
	const reviewerHeader = rendered.indexOf("step 2 · reviewer · persistent · provider/model-b");
	assert.ok(plannerHeader >= 0 && plannerHeader < rendered.indexOf("ALPHA INITIAL START"));
	assert.ok(reviewerHeader >= 0 && reviewerHeader < rendered.indexOf("BETA INITIAL START"));
	assert.match(rendered, /ALPHA INITIAL END/);
	assert.match(rendered, /BETA INITIAL END/);
});

test("running parallel child panels show live usage before activity", () => {
	const alpha = new SubagentTranscript("alpha", { maxEntries: 2 });
	alpha.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "alpha old" }] } });
	alpha.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "alpha latest" }] } });
	const beta = new SubagentTranscript("beta");
	beta.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "beta latest" }] } });

	const text = renderSubagentTranscript([
		{
			alias: "alpha", model: "provider/model-a", status: "running", output: "", persistent: false,
			transcript: alpha.snapshot(), usage: { input: 101, output: 11, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 112, turns: 1 }, durationMs: 1200,
		},
		{
			alias: "beta", model: "provider/model-b", status: "running", output: "", persistent: true,
			transcript: beta.snapshot(), usage: { input: 202, output: 22, cacheRead: 20, cacheWrite: 0, cost: 0.02, contextTokens: 244, turns: 1 }, durationMs: 2300,
		},
	], false, theme as any, { durationMs: 2500 }).render(100).join("\n");

	const alphaPanel = text.slice(text.indexOf("alpha · stateless"), text.indexOf("beta · persistent"));
	const betaPanel = text.slice(text.indexOf("beta · persistent"));
	assert.match(alphaPanel, /Usage · 101 in[\s\S]*Activity/);
	assert.match(betaPanel, /Usage · 202 in[\s\S]*Activity/);
});

test("tool calls stay paired with their results when parallel completions and result messages use different orders", () => {
	const transcript = new SubagentTranscript("parallel tools");
	transcript.ingest({ type: "tool_execution_start", toolCallId: "one", toolName: "read", args: { path: "one" } });
	transcript.ingest({ type: "tool_execution_start", toolCallId: "two", toolName: "read", args: { path: "two" } });
	transcript.ingest({ type: "tool_execution_end", toolCallId: "two", toolName: "read", result: { content: [{ type: "text", text: "result two" }] }, isError: false });
	transcript.ingest({ type: "tool_execution_end", toolCallId: "one", toolName: "read", result: { content: [{ type: "text", text: "result one" }] }, isError: false });
	transcript.ingest({ type: "message_end", message: { role: "toolResult", toolCallId: "one", toolName: "read", content: [{ type: "text", text: "result one" }] } });
	transcript.ingest({ type: "message_end", message: { role: "toolResult", toolCallId: "two", toolName: "read", content: [{ type: "text", text: "result two" }] } });

	const view = renderSubagentTranscript([{
		alias: "tools",
		status: "completed",
		output: "done",
		persistent: false,
		transcript: transcript.snapshot(),
	}], true, theme as any);
	const text = view.render(100).join("\n");
	assert.match(text, /"path": "one"[\s\S]*result one/);
	assert.match(text, /result one[\s\S]*"path": "two"/);
	assert.match(text, /"path": "two"[\s\S]*result two/);
});

test("collector pressure evicts complete tool groups instead of orphaning results", () => {
	const transcript = new SubagentTranscript("many tools");
	for (let index = 0; index < 20; index++) {
		transcript.ingest({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "read", args: { path: `${index}` } });
	}
	for (let index = 0; index < 20; index++) {
		transcript.ingest({
			type: "tool_execution_end",
			toolCallId: `call-${index}`,
			toolName: "read",
			result: { content: [{ type: "text", text: `result ${index}` }] },
			isError: false,
		});
	}
	for (let index = 0; index < 20; index++) {
		transcript.ingest({
			type: "message_end",
			message: { role: "toolResult", toolCallId: `call-${index}`, toolName: "read", content: [{ type: "text", text: `result ${index}` }] },
		});
	}

	const entries = transcript.snapshot().entries;
	const results = entries.filter((entry) => entry.kind === "toolResult");
	assert.ok(results.length > 0);
	for (const result of results) {
		assert.equal(entries.some((entry) => entry.kind === "tool" && entry.groupId === result.groupId), true);
	}
});

test("collector eviction uses each group's latest activity instead of insertion order", () => {
	const transcript = new SubagentTranscript("task", { maxEntries: 3 });
	transcript.ingest({ type: "tool_execution_start", toolCallId: "long", toolName: "read", args: { path: "long" } });
	transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "inactive old message" }] } });
	transcript.ingest({ type: "tool_execution_end", toolCallId: "long", toolName: "read", result: { content: [{ type: "text", text: "recent result" }] }, isError: false });
	transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "new message one" }] } });
	transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "new message two" }] } });

	const entries = transcript.snapshot().entries;
	assert.equal(entries.some((entry) => entry.text === "inactive old message"), false);
	assert.equal(entries.some((entry) => entry.text === "recent result"), true);
});

test("appending a failure to a full snapshot evicts complete groups", () => {
	const transcript = new SubagentTranscript("task");
	for (let index = 0; index < 9; index++) {
		transcript.ingest({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "read", args: { path: `${index}` } });
		transcript.ingest({ type: "tool_execution_end", toolCallId: `call-${index}`, toolName: "read", result: { content: [{ type: "text", text: `result ${index}` }] }, isError: false });
	}
	const failed = appendSubagentTranscriptFailure(transcript.snapshot(), "task", "crashed");

	const failedResults = failed.entries.filter((entry) => entry.kind === "toolResult");
	assert.ok(failedResults.length > 0);
	assert.ok(failed.entries.filter((entry) => !entry.initial).length <= 18);
	for (const result of failedResults) {
		assert.equal(failed.entries.some((entry) => entry.kind === "tool" && entry.groupId === result.groupId), true);
	}
	assert.equal(failed.entries.some((entry) => entry.kind === "assistant" && entry.status === "failed" && entry.text === "crashed"), true);
});

test("parallel Tool Call details retain at most 18 transcript events across all children", () => {
	const runs = Array.from({ length: 8 }, (_, runIndex) => {
		const transcript = new SubagentTranscript(`task ${runIndex}`);
		for (let index = 0; index < 18; index++) {
			transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `${runIndex}:${index}` }] } });
		}
		return { alias: `run-${runIndex}`, status: "completed" as const, output: "done", persistent: false, transcript: transcript.snapshot() };
	});

	const bounded = boundSubagentRunTranscripts(runs);
	assert.ok(bounded.reduce((total, run) => total + (run.transcript?.entries.filter((entry) => !entry.initial).length ?? 0), 0) <= 18);
	assert.equal(bounded.reduce((total, run) => total + (run.transcript?.entries.filter((entry) => entry.initial).length ?? 0), 0), 8);
	assert.ok(bounded.reduce((total, run) => total + (run.transcript?.omittedEntries ?? 0), 0) > 0);
});
