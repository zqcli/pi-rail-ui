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
	assert.match(lines[0] ?? "", /Running ·/);
	assert.match(view.render(120)[0] ?? "", /cus-resp\/gpt-5\.6-sol:xhigh/);
	assert.match(text, /assistant message 9/);
	assert.doesNotMatch(text, /assistant message 0/);
	assert.match(text, /1\.2k in/);
	assert.match(wideText, /107 cached/);
	assert.match(wideText, /ctx 1\.4k/);
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
	assert.match(expanded, /18\.2k cached/);
	assert.match(expanded, /\$0\.083/);
	assert.doesNotMatch(expanded, /\$0\.0831/);
	assert.match(expanded, /1m/);
	assert.doesNotMatch(expanded, /· stop/);
	assert.match(expanded, /Recent activity[\s\S]*Final answer/);
	assert.match(expanded, /3 turns[\s\S]*final answer line 0/);
	assert.ok(expanded.split("\n").length > 16);
});

test("cost formatting keeps four decimals below one cent and three otherwise", () => {
	const renderCost = (cost: number): string => renderSubagentTranscript([{
		alias: "cost",
		model: "provider/gpt-cost",
		status: "completed",
		output: "done",
		persistent: false,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 1, turns: 1 },
	}], false, theme as any).render(120).join("\n");

	assert.match(renderCost(0.00123), /\$0\.0012/);
	assert.match(renderCost(0.01234), /\$0\.012/);
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
	assert.match(text, /alpha · one-off · provider\/model-a:high/);
	assert.match(text, /beta · persistent · provider\/model-b:xhigh/);
	assert.match(text, /alpha final/);
	assert.match(text, /beta final/);
	const alphaPanel = text.slice(text.indexOf("alpha · one-off"), text.indexOf("beta · persistent"));
	const betaPanel = text.slice(text.indexOf("beta · persistent"));
	assert.doesNotMatch(alphaPanel, /Usage/);
	assert.doesNotMatch(betaPanel, /Usage/);
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

	assert.match(renderDuration(1_000), /<1m/);
	assert.match(renderDuration(59_999), /<1m/);
	assert.match(renderDuration(60_000), /1m/);
	assert.doesNotMatch(renderDuration(60_000), /<1m/);
	assert.match(renderDuration(119_999), /1m/);
	assert.match(renderDuration(120_000), /2m/);
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

	assert.match(collapsed[0]?.trim() ?? "", /^Running · model unavailable/);
	assert.match(collapsed.join("\n"), /Running ·[\s\S]*\(running\.\.\.\)/);
	assert.ok(collapsed.length <= 10);
	assert.ok(expanded.length <= 16);
	assert.match(expanded.join("\n"), /\(running\.\.\.\)/);
});

test("running Tool Call panels show an explicit compacting subphase", () => {
	const text = renderSubagentTranscript([{
		alias: "compacting",
		model: "cus-resp/gpt-5.6-luna:xhigh",
		status: "running",
		output: "",
		persistent: true,
		isCompacting: true,
	}], false, theme as any).render(100).join("\n");

	assert.match(text, /Compacting/);
	assert.doesNotMatch(text, /PRIVATE MODEL SUMMARY/);
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
		"Running · model unavailable",
		"● assistant  working",
	]);
	assert.deepEqual(zeroUsageRows.map((line) => line.trim()), [
		"Running · model unavailable",
		"0 in · 0 out",
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

	const rendered = renderSubagentTranscript(runs, true, theme as any, { sequenceTotal: 2 }).render(120).join("\n");
	const plannerHeader = rendered.indexOf("1/2 · planner · one-off · provider/model-a");
	const reviewerHeader = rendered.indexOf("2/2 · reviewer · persistent · provider/model-b");
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

	const alphaPanel = text.slice(text.indexOf("alpha · one-off"), text.indexOf("beta · persistent"));
	const betaPanel = text.slice(text.indexOf("beta · persistent"));
	assert.match(text, /303 in[\s\S]*Activity/);
	assert.match(alphaPanel, /Activity/);
	assert.match(betaPanel, /Activity/);
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

test("single panels keep the initial task while separating runtime and usage lines", () => {
	const initialTask = "INITIAL SINGLE TASK\nPreserve this complete task in the result panel.\nINITIAL SINGLE TASK END";
	const transcript = new SubagentTranscript(initialTask);
	transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recent activity" }] } });
	const run: SubagentTranscriptRun = {
		alias: "implement-luna",
		model: "cus-resp/gpt-5.6-luna:max",
		status: "running",
		output: "working",
		persistent: true,
		isCompacting: true,
		transcript: transcript.snapshot(),
		usage: { input: 697700, output: 3400, cacheRead: 646100, cacheWrite: 0, cost: 0.42, contextTokens: 358500, turns: 4 },
		durationMs: 60_000,
	};
	const text = renderSubagentTranscript([run], false, theme as any, {
		contextWindows: ["64K"],
		fastModes: ["on"],
	}).render(120).join("\n");

	assert.match(text, /Compacting · cus-resp\/gpt-5\.6-luna:max · ctx 358\.5k · 4 turns · 1m/);
	assert.match(text, /697\.7k in · 3\.4k out · 646\.1k cached/);
	assert.match(text, /INITIAL SINGLE TASK/);
	assert.match(text, /INITIAL SINGLE TASK END/);
	assert.doesNotMatch(text, /Usage|ContextWindow 64K|FAST|SEARCH|implement-luna ·/);
	for (const width of [40, 80, 120]) {
		assert.ok(renderSubagentTranscript([run], false, theme as any, { contextWindows: ["64K"], fastModes: ["on"] }).render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("completed and failed single panels share runtime hierarchy and hide normal stop", () => {
	const transcript = new SubagentTranscript("completed initial task");
	const base: SubagentTranscriptRun = {
		alias: "reviewer",
		model: "provider/gpt-review",
		status: "completed",
		output: "final answer",
		persistent: false,
		transcript: transcript.snapshot(),
		usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0, cost: 0, contextTokens: 1500, turns: 2 },
		durationMs: 1200,
		stopReason: "stop",
	};
	const completed = renderSubagentTranscript([base], true, theme as any, {
		contextWindows: ["64K"],
	}).render(120).join("\n");
	assert.match(completed, /Completed · provider\/gpt-review · ctx 1\.5k · 2 turns · <1m/);
	assert.match(completed, /1k in · 200 out · 500 cached/);
	assert.doesNotMatch(completed, /· stop|Usage|ContextWindow 64K|FAST|SEARCH/);
	assert.match(completed, /completed initial task/);

	const failed = renderSubagentTranscript([{ ...base, status: "failed", output: "provider failed", errorMessage: "provider failed", stopReason: "error" }], false, theme as any, {
		contextWindows: ["64K"],
	}).render(120).join("\n");
	assert.match(failed, /Failed · provider\/gpt-review · ctx 1\.5k · 2 turns · <1m · error/);
	assert.match(failed, /provider failed/);
	assert.doesNotMatch(failed, /Usage|ContextWindow 64K|FAST|SEARCH/);
});

test("failed panels retain a distinct error message beside partial output without duplication", () => {
	const run: SubagentTranscriptRun = {
		alias: "provider-failure",
		model: "provider/gpt-review",
		status: "failed",
		output: "partial answer before failure",
		errorMessage: "provider disconnected after the partial answer",
		persistent: false,
		stopReason: "error",
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 12, turns: 1 },
	};
	const collapsed = renderSubagentTranscript([run], false, theme as any).render(120).join("\n");
	const expanded = renderSubagentTranscript([run], true, theme as any).render(120).join("\n");
	assert.match(collapsed, /partial answer before failure/);
	assert.match(collapsed, /provider disconnected after the partial answer/);
	assert.match(expanded, /partial answer before failure/);
	assert.match(expanded, /provider disconnected after the partial answer/);

	const same = renderSubagentTranscript([{ ...run, output: "same failure", errorMessage: "same failure" }], true, theme as any).render(120).join("\n");
	assert.equal((same.match(/same failure/gu) ?? []).length, 1);
	const errorOnly = renderSubagentTranscript([{ ...run, output: "", errorMessage: "error only" }], true, theme as any).render(120).join("\n");
	assert.equal((errorOnly.match(/error only/gu) ?? []).length, 1);
});

test("grouped panels retain child identity, explicit dispatch policy, and chain sequence", () => {
	const firstTask = "GROUP FIRST INITIAL TASK";
	const secondTask = "GROUP SECOND INITIAL TASK";
	const first = new SubagentTranscript(firstTask);
	const second = new SubagentTranscript(secondTask);
	const runs: SubagentTranscriptRun[] = [
		{ alias: "planner", model: "provider/gpt-plan", status: "completed", output: "plan", persistent: false, step: 1, transcript: first.snapshot(), usage: { input: 1000, output: 100, cacheRead: 200, cacheWrite: 0, cost: 0, contextTokens: 1100, turns: 1 }, durationMs: 1000 },
		{ alias: "reviewer", model: "provider/gpt-review", status: "failed", output: "failed", persistent: true, step: 2, transcript: second.snapshot(), usage: { input: 2000, output: 300, cacheRead: 400, cacheWrite: 0, cost: 0.1, contextTokens: 2300, turns: 2 }, durationMs: 2000, stopReason: "error" },
	];
	const text = renderSubagentTranscript(runs, false, theme as any, {
		durationMs: 3000,
		contextWindows: [undefined, "64K"],
		fastModes: [undefined, "on"],
		sequenceTotal: 2,
	}).render(120).join("\n");

	assert.match(text, /2 model sessions · 1 complete · 0 running · 1 failed/);
	assert.match(text, /3k in · 400 out · 600 cached · \$0\.100 · wall <1m/);
	assert.match(text, /1\/2 · planner · one-off · provider\/gpt-plan/);
	assert.match(text, /2\/2 · reviewer · persistent · provider\/gpt-review · ContextWindow 64K · FAST on · SEARCH on/);
	assert.match(text, /GROUP FIRST INITIAL TASK/);
	assert.match(text, /GROUP SECOND INITIAL TASK/);
	assert.doesNotMatch(text.slice(0, text.indexOf("╭")), /ContextWindow|FAST|SEARCH/);
	assert.doesNotMatch(text, /budget default|agent default|Usage ·/);
	const firstPanelStart = text.indexOf("╭");
	const firstPanelEnd = text.indexOf("╰", firstPanelStart);
	assert.ok(firstPanelStart >= 0 && firstPanelEnd > firstPanelStart);
	const firstPanel = text.slice(firstPanelStart, firstPanelEnd);
	assert.doesNotMatch(firstPanel, /\bin\b|\bout\b|cached|cache write|\$/);
	assert.match(firstPanel, /ctx 1\.1k · 1 turn · <1m/);
	for (const width of [40, 80, 120]) {
		assert.ok(renderSubagentTranscript(runs, false, theme as any, {
			contextWindows: [undefined, "64K"],
			fastModes: [undefined, "on"],
			sequenceTotal: 2,
		}).render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("grouped child panels append the fixed SEARCH on policy while single and control panels stay silent", () => {
	const runs: SubagentTranscriptRun[] = [
		{
			alias: "planner",
			model: "provider/gpt-plan",
			status: "completed",
			output: "plan",
			persistent: false,
			transcript: new SubagentTranscript("first task").snapshot(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
		},
		{
			alias: "reviewer",
			model: "provider/gpt-review",
			status: "running",
			output: "",
			persistent: true,
			transcript: new SubagentTranscript("second task").snapshot(),
			usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
		},
	];
	const options = { contextWindows: ["64K", "128K"], fastModes: ["off", "on"] as const };

	const text = renderSubagentTranscript(runs, false, theme as any, options).render(120).join("\n");
	assert.equal((text.match(/SEARCH on/gu) ?? []).length, 2);
	assert.doesNotMatch(text.slice(0, text.indexOf("╭")), /SEARCH/);
	assert.match(text, /planner · one-off · provider\/gpt-plan · ContextWindow 64K · FAST off · SEARCH on/u);
	assert.match(text, /reviewer · persistent · provider\/gpt-review · ContextWindow 128K · FAST on · SEARCH on/u);

	for (const width of [1, 2, 3, 40, 60, 80, 100, 120]) {
		const lines = renderSubagentTranscript(runs, false, theme as any, options).render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `grouped panel exceeded width ${width}`);
		assert.equal(lines.some((line) => (line.match(/SEARCH on/gu) ?? []).length > 1), false, `SEARCH wrapped at width ${width}`);
	}

	const single = renderSubagentTranscript([{ ...runs[0]!, status: "completed" }], false, theme as any, {
		contextWindows: ["64K"],
		fastModes: ["off"],
	}).render(120).join("\n");
	assert.doesNotMatch(single, /SEARCH/);

	const runningSingle = renderSubagentTranscript([{ ...runs[1]!, status: "running" }], false, theme as any, {
		contextWindows: ["128K"],
		fastModes: ["on"],
	}).render(120).join("\n");
	assert.doesNotMatch(runningSingle, /SEARCH/);

	const control = renderSubagentTranscript([{ ...runs[0]!, status: "accepted", output: "Steer accepted by planner" }], false, theme as any, {
		control: true,
		contextWindows: ["64K"],
		fastModes: ["off"],
	}).render(120).join("\n");
	assert.doesNotMatch(control, /SEARCH/);
});

test("control panels show only delivery status and alias, never control message as initial task", () => {
	const controlMessage = "CONTROL MESSAGE MUST NOT BE INITIAL TASK";
	const run: SubagentTranscriptRun = {
		alias: "auth-review",
		model: "provider/gpt-auth",
		status: "accepted",
		output: "Steer accepted by auth-review",
		persistent: true,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		transcript: new SubagentTranscript(controlMessage).snapshot(),
	};
	const text = renderSubagentTranscript([run], false, theme as any, { control: true }).render(120).join("\n");
	assert.match(text, /accepted · auth-review/);
	assert.match(text, /Steer accepted by auth-review/);
	assert.doesNotMatch(text, /provider\/gpt-auth|persistent|0 in|initial task|CONTROL MESSAGE/);
	for (const width of [1, 40, 80, 120]) assert.ok(renderSubagentTranscript([run], false, theme as any, { control: true }).render(width).every((line) => visibleWidth(line) <= width));
});

test("control panels isolate the acknowledgement or error body from all transcript activity", () => {
	const transcript = new SubagentTranscript("CONTROL INITIAL MUST STAY HIDDEN");
	transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "NON-INITIAL ACTIVITY MUST STAY HIDDEN" }] } });
	const success = renderSubagentTranscript([{
		alias: "auth-review",
		status: "accepted",
		output: "Steer accepted by auth-review",
		persistent: true,
		transcript: transcript.snapshot(),
	}], true, theme as any, { mode: "control" }).render(120).join("\n");
	assert.match(success, /Control acknowledgement/);
	assert.match(success, /Steer accepted by auth-review/);
	assert.doesNotMatch(success, /CONTROL INITIAL|NON-INITIAL ACTIVITY|Recent activity|Activity/);

	const failure = renderSubagentTranscript([{
		alias: "auth-review",
		status: "failed",
		output: "partial control output",
		errorMessage: "control delivery failed",
		persistent: true,
		transcript: transcript.snapshot(),
	}], true, theme as any, { control: true }).render(120).join("\n");
	assert.match(failure, /Control error/);
	assert.match(failure, /control delivery failed/);
	assert.match(failure, /partial control output/);
	assert.doesNotMatch(failure, /CONTROL INITIAL|NON-INITIAL ACTIVITY|Recent activity|Activity/);
});

test("explicit grouped mode keeps one child boxed and shows the chain denominator", () => {
	const run: SubagentTranscriptRun = {
		alias: "only-step",
		model: "provider/model",
		status: "completed",
		output: "done",
		persistent: false,
		step: 1,
		transcript: new SubagentTranscript("task").snapshot(),
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 12, turns: 1 },
	};
	const text = renderSubagentTranscript([run], false, theme as any, { mode: "chain", sequenceTotal: 3 }).render(120).join("\n");
	assert.match(text, /1 model session · 1 complete/);
	assert.match(text, /1\/3 · only-step/);
	assert.match(text, /╭/);
	assert.match(text, /╰/);
});

test("single and grouped headers stay one physical line while initial tasks may wrap", () => {
	const singleTask = "SINGLE INITIAL TASK that must remain complete even when the terminal is narrow";
	const single = {
		alias: "single-alias",
		model: "provider/gpt-single",
		status: "failed" as const,
		output: "failed",
		persistent: true,
		stopReason: "error",
		transcript: new SubagentTranscript(singleTask).snapshot(),
		usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 1200, turns: 2 },
		durationMs: 60_000,
	};
	const grouped = [
		{ alias: "child-one-with-a-very-long-alias", model: "provider/gpt-one-with-a-very-long-model-name", status: "completed" as const, output: "x", persistent: false },
		{ alias: "child-two-with-a-very-long-alias", model: "provider/gpt-two-with-a-very-long-model-name", status: "completed" as const, output: "x", persistent: true },
	];

	for (const width of [1, 2, 3, 40, 80, 120]) {
		const singleLines = renderSubagentTranscript([single], false, theme as any).render(width);
		const initialIndex = singleLines.findIndex((line) => line.includes("›"));
		assert.equal(initialIndex, 2, `single header/usage unexpectedly wrapped at ${width}`);
		assert.ok(singleLines.slice(0, initialIndex).every((line) => visibleWidth(line) <= width));
		assert.match(singleLines.slice(initialIndex).join("").replaceAll(" ", ""), /SINGLEINITIALTASKthatmustremaincompleteevenwhentheterminalisnarrow/);

		const groupedLines = renderSubagentTranscript(grouped, false, theme as any, {
			contextWindows: ["64K", "128K"],
			fastModes: ["on", "on"],
		}).render(width);
		const expectedRows = width >= 3 ? 10 : 6;
		assert.equal(groupedLines.length, expectedRows, `grouped header unexpectedly wrapped at ${width}`);
		assert.ok(groupedLines.every((line) => visibleWidth(line) <= width));
	}
});

test("single usage lines show hosted search counts and omit zero values", () => {
	const runWithSearches = (searches: number | undefined): SubagentTranscriptRun => ({
		alias: "worker",
		model: "provider/gpt-worker",
		status: "completed",
		output: "done",
		persistent: false,
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 12,
			turns: 1,
			...(searches === undefined ? {} : { searches }),
		},
	});
	const usageLineOf = (searches: number | undefined): { text: string; usageLine: string | undefined } => {
		const text = renderSubagentTranscript([runWithSearches(searches)], false, theme as any).render(120).join("\n");
		return { text, usageLine: text.split("\n").find((line) => line.includes(" in ")) };
	};

	const one = usageLineOf(1);
	assert.match(one.usageLine ?? "", /\b1 search\b/u);
	assert.doesNotMatch(one.usageLine ?? "", /\bsearches\b/u);

	const two = usageLineOf(2);
	assert.match(two.usageLine ?? "", /\b2 searches\b/u);

	for (const none of [undefined, 0]) {
		const rendered = usageLineOf(none);
		assert.equal(rendered.usageLine?.trim(), "10 in · 2 out");
		assert.doesNotMatch(rendered.text, /search/u);
	}

	for (const width of [1, 2, 10, 40, 80]) {
		const lines = renderSubagentTranscript([runWithSearches(2)], false, theme as any).render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `single search usage exceeded width ${width}`);
	}
});

test("running single panels show the hosted search count once in the live usage line", () => {
	const transcript = new SubagentTranscript("Search and summarize");
	transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "searching" }] } });
	const run: SubagentTranscriptRun = {
		alias: "worker",
		model: "provider/gpt-worker",
		status: "running",
		output: "searching",
		persistent: false,
		transcript: transcript.snapshot(),
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 12, turns: 1, searches: 3 },
		durationMs: 1500,
	};
	const text = renderSubagentTranscript([run], false, theme as any).render(120).join("\n");

	assert.match(text, /Running · provider\/gpt-worker/);
	const headerLine = text.split("\n")[0] ?? "";
	assert.doesNotMatch(headerLine, /search/u);
	const usageLine = text.split("\n").find((line) => line.includes(" in "));
	assert.equal(usageLine?.trim(), "10 in · 2 out · 3 searches");
	assert.equal((text.match(/3 searches/gu) ?? []).length, 1);
	assert.equal((text.match(/searches/gu) ?? []).length, 1);

	for (const width of [10, 40, 80, 120]) {
		const lines = renderSubagentTranscript([run], false, theme as any).render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `running search usage exceeded width ${width}`);
	}
});

test("grouped aggregate usage sums hosted search counts while child panels stay count-free", () => {
	const runs: SubagentTranscriptRun[] = [
		{
			alias: "worker-a", model: "provider/model-a", status: "completed", output: "alpha", persistent: false,
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 110, turns: 1, searches: 1 },
		},
		{
			alias: "worker-b", model: "provider/model-b", status: "completed", output: "beta", persistent: true,
			usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 220, turns: 1, searches: 2 },
		},
	];
	const text = renderSubagentTranscript(runs, false, theme as any, { mode: "chain" }).render(120).join("\n");
	const aggregateLine = text.split("\n").find((line) => line.includes(" in "));
	assert.match(aggregateLine ?? "", /\b3 searches\b/u);

	const panels = text.split("╭").slice(1).map((chunk) => chunk.split("╰")[0] ?? "");
	assert.equal(panels.length, 2);
	for (const panel of panels) assert.doesNotMatch(panel, /\b\d+ search/u);

	for (const width of [1, 2, 10, 40, 80, 120]) {
		const lines = renderSubagentTranscript(runs, false, theme as any, { mode: "chain" }).render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `grouped search usage exceeded width ${width}`);
	}
});
