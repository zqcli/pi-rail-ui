process.stdout.write(`${JSON.stringify({
	type: "tool_execution_start",
	toolCallId: "slow-call",
	toolName: "read",
	args: { path: "slow.ts" },
})}\n${JSON.stringify({
	type: "message_update",
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
})}\n`);
setInterval(() => {}, 1000);
