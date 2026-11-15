import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ToolCallPreview } from "../../tools/subagents/tool-call-preview";
import { SubagentTranscript } from "../../tools/subagents/transcript";

const marker = "[… earlier text omitted]\n";
const limit = 4000;

function expected(raw: string): string {
	const clean = stripTerminalSequences(raw).replaceAll("\r\n", "\n").replaceAll("\r", "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "").trim();
	if (clean.length <= limit) return clean;
	const tail = clean.slice(-(limit - 28)).replace(/^[\udc00-\udfff]/u, "");
	return marker + tail;
}

function update(transcript: SubagentTranscript, event: Record<string, unknown>): void {
	transcript.ingest({ type: "message_update", assistantMessageEvent: { contentIndex: 0, ...event } });
}

function draftText(transcript: SubagentTranscript, index = 0): string {
	return transcript.snapshot().entries.find((entry) => entry.id.endsWith(`:${index}`) && entry.kind === "tool")?.text ?? "";
}

test("tool argument previews preserve whitespace and normalized CRLF at every chunk boundary", () => {
	const chunks = ["  \t", "{\r", "\n  one:", " ", "  two\r", "three", "\r\x00", "\n\t", "four", " ".repeat(10_000), "\r\n", "tail", "\t "];
	const preview = new ToolCallPreview(limit);
	let raw = "";
	for (const chunk of chunks) {
		raw += chunk;
		assert.equal(preview.append(chunk), expected(raw));
	}
});

test("preview truncation starts only after visible text exceeds the cap and keeps the original tail budget", () => {
	for (const size of [3999, 4000, 4001, 10_000]) {
		const preview = new ToolCallPreview(limit);
		let raw = "x".repeat(size);
		assert.equal(preview.append(raw), expected(raw));
		assert.equal(preview.append(" ".repeat(20_000)), expected(raw));
		raw += " ".repeat(20_000) + "end";
		assert.equal(preview.append("end"), expected(raw));
		raw += "\t tail";
		assert.equal(preview.append("\t tail"), expected(raw));
	}
	const preview = new ToolCallPreview(limit);
	assert.equal(preview.append(" \t\n".repeat(10_000)), "");
	assert.equal(preview.append("short"), "short", "leading whitespace must not cause an omission marker");
});

test("split Unicode pairs and truncation boundaries never expose lone surrogates", () => {
	const raw = `  多字节e\u0301👩‍💻🙂${"abcd🙂".repeat(1000)} done  `;
	const transcript = new SubagentTranscript("task");
	update(transcript, { type: "toolcall_start" });
	for (let index = 0; index < raw.length; index++) {
		update(transcript, { type: "toolcall_delta", delta: raw[index] });
		const text = draftText(transcript);
		assert.ok(text.isWellFormed(), `code unit ${index}`);
		assert.ok(text.length <= limit);
	}
	assert.equal(draftText(transcript), expected(raw));
	const preview = new ToolCallPreview(limit);
	const boundary = `${"a".repeat(40)}🙂${"z".repeat(3971)}`;
	assert.equal(preview.append(boundary), marker + "z".repeat(3971), "drop a cut low surrogate rather than display half a pair");
});

test("supported CSI, OSC and APC sequences stay intact across every split, including ESC-ST and CRLF", () => {
	const raw = "prefix\r\x1b[31m\nred\x1b[0m \x1b]8;;https://example.test/🙂\x1b\\link\x1b]8;;\x07 \x1b_cursor-marker\x1b\\suffix";
	for (let split = 0; split <= raw.length; split++) {
		const preview = new ToolCallPreview(limit);
		preview.append(raw.slice(0, split));
		assert.equal(preview.append(raw.slice(split)), expected(raw), `split ${split}`);
	}
	const preview = new ToolCallPreview(limit);
	let text = "";
	for (const char of raw.split("")) text = preview.append(char);
	assert.equal(text, expected(raw));
	assert.equal(preview.append("\x1b]hidden-secret"), expected(raw), "an unfinished control payload is not displayed");
	assert.equal(preview.append("\x1b"), expected(raw));
	assert.equal(preview.append("\\visible"), `${expected(raw)}visible`);
});

test("draft working storage is bounded even for long whitespace and unterminated controls", () => {
	for (const raw of ["x".repeat(50_000), " ".repeat(50_000), `\x1b]${"secret".repeat(10_000)}`, `\x1b[${"1;".repeat(25_000)}`]) {
		const preview = new ToolCallPreview(limit);
		preview.append("prefix");
		for (let offset = 0; offset < raw.length; offset += 17) preview.append(raw.slice(offset, offset + 17));
		assert.ok(JSON.stringify(preview).length < 9_000, "retained state must not grow with the raw argument length");
	}
});

test("interleaved and start-less tool deltas have independent previews; final arguments remain authoritative and untouched", () => {
	const transcript = new SubagentTranscript("task");
	update(transcript, { type: "toolcall_start" });
	update(transcript, { type: "toolcall_delta", delta: `draft ${"a".repeat(20_000)}\x1b]unfinished` });
	update(transcript, { type: "toolcall_delta", contentIndex: 1, delta: "independent🙂" });
	assert.equal(draftText(transcript, 1), "independent🙂");
	assert.ok(draftText(transcript).length <= limit);
	const args = Object.freeze({ path: "final.txt", content: `real-input-${"🙂payload".repeat(5_000)}-complete` });
	const original = JSON.stringify(args);
	const toolCall = Object.freeze({ type: "toolCall", id: "call", name: "write", arguments: args });
	update(transcript, { type: "toolcall_end", toolCall });
	const finalized = transcript.snapshot().entries.find((entry) => entry.id === "tool:call")!;
	assert.equal(finalized.text, expected(JSON.stringify(args, null, 2)));
	assert.equal(finalized.label, "write");
	assert.ok(!transcript.snapshot().entries.some((entry) => entry.id === "toolDraft:1:0"));
	transcript.ingest(Object.freeze({ type: "tool_execution_start", toolCallId: "call", toolName: "write", args }));
	assert.equal(JSON.stringify(args), original);
	assert.equal(transcript.snapshot().entries.find((entry) => entry.id === "tool:call")!.text, finalized.text);
});

test("message_end promotes a draft even when toolcall_end was not emitted", () => {
	const transcript = new SubagentTranscript("task");
	update(transcript, { type: "toolcall_delta", delta: "stale draft\x1b]unfinished" });
	const call = Object.freeze({ type: "toolCall", id: "fallback", name: "read", arguments: Object.freeze({ path: "final.txt" }) });
	transcript.ingest({ type: "message_end", message: { role: "assistant", content: [call] } });
	const entries = transcript.snapshot().entries.filter((entry) => entry.kind === "tool");
	assert.equal(entries.length, 1);
	assert.equal(entries[0]!.id, "tool:fallback");
	assert.equal(entries[0]!.text, JSON.stringify(call.arguments, null, 2));
	update(transcript, { type: "toolcall_delta", delta: "next message" });
	assert.equal(draftText(transcript), "next message", "unfinished control state must not bleed into the next assistant message");
});


test("authoritative final call and execution previews also truncate on a Unicode boundary", () => {
	const transcript = new SubagentTranscript("task");
	const args = Object.freeze({ content: `${"a".repeat(40)}🙂${"z".repeat(3968)}` });
	const serialized = JSON.stringify(args, null, 2);
	assert.match(serialized.slice(-3972), /^[\udc00-\udfff]/u, "fixture must cut through a surrogate pair");
	update(transcript, { type: "toolcall_end", toolCall: { id: "unicode", name: "write", arguments: args } });
	assert.equal(transcript.snapshot().entries.at(-1)!.text, expected(serialized));
	assert.ok(transcript.snapshot().entries.at(-1)!.text.isWellFormed());
	transcript.ingest({ type: "tool_execution_start", toolCallId: "unicode", toolName: "write", args });
	assert.equal(transcript.snapshot().entries.at(-1)!.text, expected(serialized));
});


test("final promotion coalesces an already-observed execution without a duplicate tool entry", () => {
	const transcript = new SubagentTranscript("task");
	update(transcript, { type: "toolcall_delta", delta: "draft" });
	const call = { type: "toolCall", id: "started", name: "read", arguments: { path: "final.txt" } };
	transcript.ingest({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
	transcript.ingest({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: { content: "done" } });
	transcript.ingest({ type: "message_end", message: { role: "assistant", content: [call] } });
	const calls = transcript.snapshot().entries.filter((entry) => entry.kind === "tool");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.id, "tool:started");
	assert.equal(calls[0]!.status, "completed");
	assert.equal(calls[0]!.text, JSON.stringify(call.arguments, null, 2));
});

test("mixed streams match full cleaning across deterministic random chunk sizes", () => {
	let seed = 12007;
	const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
	const pieces = ["abc🙂", "多字节", " ".repeat(101), "\r\n", "\r", "\n", "\x00", "\x1b[38;5;123m", "\x1b]8;;https://example.test\x1b\\", "\x1b_apc\x07", "\x1bZ", "\t", "尾".repeat(80)];
	for (let sample = 0; sample < 60; sample++) {
		const raw = Array.from({ length: 400 }, () => pieces[random() % pieces.length]!).join("");
		const preview = new ToolCallPreview(limit);
		let text = "";
		for (let offset = 0; offset < raw.length;) {
			const length = 1 + random() % 93;
			text = preview.append(raw.slice(offset, offset + length));
			offset += length;
			assert.ok(text.length <= limit && text.isWellFormed());
		}
		assert.equal(text, expected(raw), `sample ${sample}`);
	}
});
