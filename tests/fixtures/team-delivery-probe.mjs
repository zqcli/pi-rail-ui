// Isolated public-API probe: no Team inbox or private agent-loop access.
export default function install(pi) {
	let sent = false;
	pi.on("context", (event) => {
		if (sent) return;
		sent = true;
		const message = {
			customType: "team-delivery-api-probe",
			content: "native-delivery-probe-fact",
			display: false,
			details: { teamId: "probe", memberId: "worker", deliveryId: "probe-delivery" },
		};
		pi.sendMessage(message, { triggerTurn: false });
		return { messages: [...event.messages, { ...message, role: "custom", timestamp: Date.now() }] };
	});
}
