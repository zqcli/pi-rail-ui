process.stdout.write(`${JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "stateless done" }],
		usage: {
			input: 12,
			output: 3,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 17,
			cost: { total: 0.04 },
		},
		stopReason: "stop",
	},
})}\n`);