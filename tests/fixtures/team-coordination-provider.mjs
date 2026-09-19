import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Deterministic offline model: exercise the real Pi loop and RPC processes,
// not the quality of an external model's coordination decisions.
export default function install(pi) {
	let turns = 0;
	let coordinatorStep = 0;
	const call = (args) => [{ type: "toolCall", id: `team-${turns}`, name: "team", arguments: args }];
	const answer = (text) => [{ type: "text", text }];
	function choose(member, text) {
		if (process.env.TEAM_E2E_SCENARIO === "cancel") return call({ action: "wait", wait: { kind: "message" } });
		if (process.env.TEAM_E2E_SCENARIO === "control") {
			if (member !== "A") {
				if (member === "B1" && !text.includes("CORRECTED_DIRECTION")) return call({ action: "report", message: "B1 needs direction", wait: { kind: "message" } });
				return answer(`${member} result${member === "B1" ? ": CORRECTED_DIRECTION" : ""}`);
			}
			if (text.includes("All workers have settled.")) {
				if (!text.includes("B1 result: CORRECTED_DIRECTION")) throw new Error("Missing corrected result");
				return answer("CONTROL_FINAL: corrected B1 and completed B2");
			}
			if (coordinatorStep === 0) { coordinatorStep++; return call({ action: "control", to: "B1", command: "pause" }); }
			if (coordinatorStep === 1) {
				if (!text.includes("paused")) return call({ action: "wait", wait: { kind: "message" } });
				coordinatorStep++; return call({ action: "control", to: "B1", command: "redirect", message: "CORRECTED_DIRECTION" });
			}
			if (coordinatorStep === 2) { coordinatorStep++; return call({ action: "control", to: "B1", command: "resume" }); }
			if (coordinatorStep === 3) { coordinatorStep++; return call({ action: "wait", wait: { kind: "workers" } }); }
			return answer("CONTROL_COORDINATOR_READY");
		}
		if (member === "A") {
			if (text.includes("All workers have settled.")) {
				for (let i = 1; i <= 8; i++) if (!text.includes(`B${i} result`)) throw new Error(`Missing B${i} from final summary prompt`);
				return answer("TEAM_FINAL: all eight workers, including B1 and B8, have settled.");
			}
			if (coordinatorStep === 0) {
				if (!text.includes("B1 needs B8")) return call({ action: "wait", wait: { kind: "message" } });
				coordinatorStep++; return call({ action: "send", to: "B8", message: "B1_WAIT_CONFIRMED" });
			}
			return answer("EARLY_COORDINATOR_OUTPUT");
		}
		if (member === "B1" && turns === 1) return call({ action: "report", message: "B1 needs B8", wait: { kind: "member", member: "B8" } });
		if (member === "B2" && turns === 1) return call({ action: "send", to: "B1", message: "B2 peer evidence" });
		if (member === "B8" && !text.includes("B1_WAIT_CONFIRMED")) return call({ action: "wait", wait: { kind: "message" } });
		if (member === "B8" && !text.includes("B2 result")) return call({ action: "wait", wait: { kind: "member", member: "B2" } });
		if (member === "B1" && (!text.includes("B8 result") || !text.includes("B2 peer evidence"))) throw new Error("B1 resumed without its dependency and peer message");
		return answer(`${member} result${member === "B1" ? ": consumed B8 result and B2 peer evidence" : ""}`);
	}
	pi.registerProvider("rail-team-e2e", {
		name: "Team offline integration", baseUrl: "offline://team-e2e", apiKey: "synthetic-only", api: "rail-team-e2e-api",
		models: [{ id: "probe", name: "Team probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple(model, context, options) {
			const text = JSON.stringify(context.messages);
			const member = text.match(/TEAM_MEMBER_(A|B[1-8])/u)?.[1];
			if (!member || ++turns > 12) throw new Error("Unexpected team model turn/polling");
			const content = choose(member, text);
			const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: options?.signal?.aborted ? "aborted" : content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
			pi.appendEntry("team-e2e-turn", { member, turn: turns });
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		},
	});
}
