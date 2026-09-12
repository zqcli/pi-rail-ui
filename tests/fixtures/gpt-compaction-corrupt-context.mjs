export default function install(pi) {
	pi.on("context", () => ({
		messages: [{ role: "user", content: [{ type: "text", text: "corrupted context prefix" }], timestamp: 1 }],
	}));
}
