let buffer = "";
let sessionName;
let contextWindow = 128000;

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
				sessionName,
				isStreaming: false,
				model: { provider: "cus-resp", id: "gpt-5.6-luna", contextWindow },
			} });
			continue;
		}
		if (command.type === "get_commands") {
			write({ type: "response", id: command.id, command: "get_commands", success: true, data: {
				commands: [{ name: "rail-context-internal-v1", source: "extension", description: "Rail private context protocol v1" }],
			} });
			continue;
		}
		if (command.type === "set_session_name") {
			sessionName = command.name;
			write({ type: "response", id: command.id, command: "set_session_name", success: true });
			continue;
		}
		if (command.type === "prompt") {
			if (command.message.startsWith("/rail-context-internal-v1 ")) {
				const parts = command.message.trim().split(/\s+/u);
				if (parts[1] === "prepare" && parts[2] !== "omit") contextWindow = Number(parts[2]);
				if (parts[1] === "reset" || (parts[1] === "prepare" && parts[2] === "omit")) contextWindow = 128000;
				write({ type: "response", id: command.id, command: "prompt", success: true });
				continue;
			}
			write({ type: "response", id: command.id, command: "prompt", success: true });
			write({ type: "agent_start" });
			write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fixture done" }] } });
			write({ type: "agent_settled" });
			continue;
		}
		if (command.type === "steer" || command.type === "follow_up") {
			write({ type: "response", id: command.id, command: command.type, success: true });
			continue;
		}
		write({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported" });
	}
});

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
