let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline).replace(/\r$/u, "");
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		const command = JSON.parse(line);
		if (command.type === "get_state") {
			write({ type: "response", id: command.id, command: "get_state", success: true, data: {
				sessionId: "fixture-session",
				sessionFile: "/tmp/fixture.jsonl",
				isStreaming: false,
			} });
			continue;
		}
		if (command.type === "prompt") {
			write({ type: "response", id: command.id, command: "prompt", success: true });
			write({ type: "agent_start" });
			write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixture done" }] } });
			write({ type: "agent_settled" });
			continue;
		}
		write({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported" });
	}
});

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
