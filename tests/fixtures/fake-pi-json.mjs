const usage = {
	input: 12,
	output: 3,
	cacheRead: 2,
	cacheWrite: 0,
	totalTokens: 17,
	cost: { total: 0.04 },
};

write({ type: "message_start", message: { role: "assistant", content: [] } });
write({ type: "message_update", usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspect fixture" } });
write({
	type: "message_update",
	usage,
	assistantMessageEvent: {
		type: "toolcall_end",
		contentIndex: 1,
		toolCall: { type: "toolCall", id: "fixture-call", name: "read", arguments: { path: "fixture.ts" } },
	},
});
write({
	type: "message_end",
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Inspect fixture" },
			{ type: "toolCall", id: "fixture-call", name: "read", arguments: { path: "fixture.ts" } },
		],
		stopReason: "toolUse",
	},
});
write({ type: "tool_execution_start", toolCallId: "fixture-call", toolName: "read", args: { path: "fixture.ts" } });
write({
	type: "tool_execution_update",
	toolCallId: "fixture-call",
	toolName: "read",
	args: { path: "fixture.ts" },
	partialResult: { content: [{ type: "text", text: "partial fixture" }] },
});
write({
	type: "tool_execution_end",
	toolCallId: "fixture-call",
	toolName: "read",
	result: { content: [{ type: "text", text: "fixture source" }] },
	isError: false,
});
write({
	type: "message_end",
	message: { role: "toolResult", toolCallId: "fixture-call", toolName: "read", content: [{ type: "text", text: "fixture source" }], isError: false },
});
write({ type: "message_start", message: { role: "assistant", content: [] } });
write({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stateless done" } });
write({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "stateless done" }],
		usage,
		stopReason: "stop",
	},
});

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
