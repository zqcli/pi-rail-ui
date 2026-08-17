import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	appendSubagentTranscriptFailure,
	boundSubagentRunTranscripts,
	SubagentTranscript,
	renderSubagentTranscript,
	type SubagentTranscriptSnapshot,
} from "../../subagent/transcript";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
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

test("SubagentTranscript retains only the latest configured event window", () => {
	const transcript = new SubagentTranscript("task", { maxEntries: 3 });
	for (let index = 0; index < 5; index++) {
		transcript.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] } });
	}

	const snapshot = transcript.snapshot();
	assert.equal(snapshot.entries.length, 3);
	assert.equal(snapshot.omittedEntries, 3);
	assert.deepEqual(snapshot.entries.map((entry) => entry.text), ["answer 2", "answer 3", "answer 4"]);
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
		persistent: true,
		transcript,
	}], false, theme as any);
	const lines = view.render(48);

	assert.ok(lines.length <= 10);
	assert.match(lines[0] ?? "", /persistent/);
	assert.match(lines.join("\n"), /assistant message 9/);
	assert.doesNotMatch(lines.join("\n"), /assistant message 0/);
	assert.match(lines.join("\n"), /earlier activity hidden/);
	assert.ok(view.render(10).every((line) => visibleWidth(line) <= 10));
});

test("parallel transcript ordering follows global activity rather than child creation time", () => {
	const alpha = new SubagentTranscript("alpha");
	const beta = new SubagentTranscript("beta");
	for (let index = 0; index < 6; index++) {
		beta.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `beta ${index}` }] } });
	}
	alpha.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "alpha newest" }] } });

	const view = renderSubagentTranscript([
		{ alias: "alpha", status: "running", output: "", persistent: false, transcript: alpha.snapshot() },
		{ alias: "beta", status: "running", output: "", persistent: false, transcript: beta.snapshot() },
	], false, theme as any);
	const text = view.render(48).join("\n");
	assert.match(text, /alpha newest/);
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
	assert.ok(text.indexOf('"path": "one"') < text.indexOf("result one"));
	assert.ok(text.indexOf("result one") < text.indexOf('"path": "two"'));
	assert.ok(text.indexOf('"path": "two"') < text.indexOf("result two"));
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
	for (const result of entries.filter((entry) => entry.kind === "toolResult")) {
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

	assert.ok(failed.entries.length <= 18);
	for (const result of failed.entries.filter((entry) => entry.kind === "toolResult")) {
		assert.equal(failed.entries.some((entry) => entry.kind === "tool" && entry.groupId === result.groupId), true);
	}
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
	assert.ok(bounded.reduce((total, run) => total + (run.transcript?.entries.length ?? 0), 0) <= 18);
	assert.ok(bounded.reduce((total, run) => total + (run.transcript?.omittedEntries ?? 0), 0) > 0);
});
