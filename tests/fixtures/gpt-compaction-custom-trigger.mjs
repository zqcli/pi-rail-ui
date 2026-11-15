export default function install(pi) {
	pi.registerCommand("gpt-compaction-custom-trigger", {
		description: "Start the compaction integration probe from an idle custom message.",
		handler(args) {
			pi.sendMessage({ customType: "gpt-compaction-probe", content: args, display: false }, { triggerTurn: true });
		},
	});
}
