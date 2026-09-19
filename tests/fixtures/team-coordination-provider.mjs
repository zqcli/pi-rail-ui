import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Deterministic offline model: exercise the real Pi loop and RPC processes,
// not the quality of an external model's coordination decisions.
export default function install(pi) {
	let turns = 0;
	let coordinatorStep = 0;
	let memberStep = 0;
	const observedEvents = new Map();
	let latestSnapshot;
	const call = (args) => [{ type: "toolCall", id: `team-${turns}`, name: "team", arguments: args }];
	const answer = (text) => [{ type: "text", text }];
	if (process.env.TEAM_E2E_SCENARIO === "compaction") pi.on("session_before_compact", (event, ctx) => {
		pi.appendEntry("team-e2e-compaction", { contextWindow: ctx.model?.contextWindow });
		return { compaction: { summary: "TEAM_MEMBER_B1 completed the assigned work.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
	});
	function handshake(member, text, messages) {
		for (const message of messages) {
			if (message.role === "toolResult" && message.isError) throw new Error("Handshake tool call failed");
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part.type !== "text") continue;
				let reply;
				try { reply = JSON.parse(part.text.replace(/^Team checkpoint data: /u, "")); } catch { continue; }
				if (reply?.ok !== true) continue;
				for (const event of [...(reply.events ?? []), ...(reply.snapshot?.events ?? [])]) observedEvents.set(event.seq, event);
				if (reply.snapshot && (!latestSnapshot || reply.snapshot.seq >= latestSnapshot.seq)) latestSnapshot = reply.snapshot;
			}
		}
		const seen = (predicate) => [...observedEvents.values()].some(predicate);
		const received = (from, marker) => seen((event) => event.from === from && event.message?.startsWith(marker));
		const waitMessage = () => call({ action: "wait", to: null, message: null, command: null, wait: { kind: "message", member: null, afterSeq: 0 } });
		const report = (message, wait = null) => call({ action: "report", to: "A", message, command: null, wait });
		if (member !== "A") {
			if (memberStep === 0) { memberStep++; return report(`${member}_READY`, { kind: "message", member: null, afterSeq: 0 }); }
			if (member === "B2") {
				if (!received("A", "B2_RELEASE")) throw new Error("B2 resumed without release");
				if (memberStep++ === 1) return report("B2_FINISHING");
				return answer("B2 result");
			}
			if (!received("A", "B1_RESUMED_DIRECTION")) throw new Error("B1 resumed without direction");
			if (memberStep === 1) { memberStep++; return report("B1_RESUMED"); }
			if (memberStep === 2) { memberStep++; return call({ action: "wait", to: null, message: null, command: null, wait: { kind: "member", member: "B2", afterSeq: null } }); }
			if (!latestSnapshot?.members.some((m) => m.id === "B2" && m.state === "completed" && m.output === "B2 result")) throw new Error("B1 did not receive B2 native result");
			if (memberStep++ === 3) return report("B1_OBSERVED_B2_TERMINAL");
			return answer("B1 result: observed B2 completed");
		}
		if (latestSnapshot?.members.some((m) => m.state === "failed" || m.state === "cancelled")) throw new Error("Handshake member failed");
		if (text.includes("All workers have settled.")) {
			if (!text.includes("B1 result: observed B2 completed") || !text.includes("B2 result")) throw new Error("Missing final results");
			return answer("HANDSHAKE_FINAL: ready, paused, redirected, resumed, B2 released, both workers settled");
		}
		if (coordinatorStep === 0) {
			if (!received("B1", "B1_READY") || !received("B2", "B2_READY")) return waitMessage();
			coordinatorStep++; return call({ action: "control", to: "B1", command: "pause" });
		}
		if (coordinatorStep === 1) {
			if (!seen((event) => event.member === "B1" && event.state === "paused")) return waitMessage();
			coordinatorStep++; return call({ action: "control", to: "B1", command: "redirect", message: "B1_RESUMED_DIRECTION" });
		}
		if (coordinatorStep === 2) { coordinatorStep++; return call({ action: "control", to: "B1", command: "resume" }); }
		if (coordinatorStep === 3) {
			if (!received("B1", "B1_RESUMED") || !seen((event) => event.member === "B1" && event.state === "waiting" && event.message === "waiting for member B2")) return waitMessage();
			coordinatorStep++; return call({ action: "send", to: "B2", message: "B2_RELEASE" });
		}
		if (coordinatorStep === 4) { coordinatorStep++; return call({ action: "finish", to: null, message: null, command: null, wait: null }); }
		return answer("HANDSHAKE_COORDINATOR_READY");
	}
	function choose(member, text, messages) {
		if (process.env.TEAM_E2E_SCENARIO === "report-handshake") return handshake(member, text, messages);
		if (["retry", "compaction"].includes(process.env.TEAM_E2E_SCENARIO)) {
			if (member !== "A") return answer(`${member} result`);
			if (!text.includes("All workers have settled.")) return answer("EARLY_COORDINATOR_OUTPUT");
			if (!text.includes("B1 result")) throw new Error("Missing settled worker result");
			return answer("LIFECYCLE_FINAL: B1 has settled");
		}
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
			if (!member || ++turns > (process.env.TEAM_E2E_SCENARIO === "report-handshake" ? 20 : 12)) throw new Error("Unexpected team model turn/polling");
			const retry = process.env.TEAM_E2E_SCENARIO === "retry" && member === "B1" && turns === 1;
			const input = process.env.TEAM_E2E_SCENARIO === "compaction" && member === "B1" && turns === 1 ? 60000 : 1;
			const content = retry ? [] : text.includes("VERIFY_NATIVE_WINDOW") ? answer(`window=${model.contextWindow}`) : choose(member, text, context.messages);
			const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
				usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				...(retry ? { errorMessage: "429 rate limit exceeded" } : {}),
				stopReason: options?.signal?.aborted ? "aborted" : retry ? "error" : content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
			pi.appendEntry("team-e2e-turn", { member, turn: turns });
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			stream.push(retry ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		},
	});
}
