import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** Scripted provider attacks the real Pi codemode/deferred paths, without a remote model. */
export default function install(pi) {
	for (const [name, exposure] of [
		["allowed_code", "codemode"], ["denied_code", "codemode"],
		["allowed_deferred", "deferred"], ["denied_deferred", "deferred"], ["subagent", "deferred"],
	]) pi.registerTool({
		name, label: name, description: `Loadout probe ${name}`, exposure, parameters: Type.Object({}),
		async execute(_id, _input, _signal, _update, ctx) {
			pi.appendEntry("team-loadout-executed", { name });
			if (name === "allowed_code") {
				const nested = await ctx.executeTool("team", { action: "status" });
				pi.appendEntry("team-loadout-indirect-team", { isError: nested.isError });
			}
			return { content: [{ type: "text", text: name }], details: {} };
		},
	});
	let turn = 0;
	pi.registerProvider("rail-team-loadout", {
		name: "Offline Team loadout probe", baseUrl: "offline://team-loadout", apiKey: "synthetic-local-only", api: "rail-team-loadout-api",
		models: [{ id: "probe", name: "probe", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 }],
		streamSimple(model, context) {
			pi.appendEntry("team-loadout-provider", { turn, declared: getCurrentTools(context.messages).map((tool) => tool.name) });
			const actions = [
				{ name: "codemode", arguments: { code: `
for (const name of ["allowed_code", "denied_code", "allowed_deferred", "denied_deferred", "subagent"]) {
  try { text({ name, result: await tools[name]({}) }); }
  catch (error) { text({ name, error: error.message }); }
}` } },
				{ name: "tool_search", arguments: { query: "denied_deferred", limit: 1 } },
				{ name: "denied_deferred", arguments: {} },
				{ name: "team", arguments: { action: "yield" } },
			];
			const action = actions[turn++];
			if (!action) throw new Error("Unexpected continuation after the Team end intent");
			const message = {
				role: "assistant", content: [{ type: "toolCall", id: `loadout-${turn}`, ...action }],
				api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now(),
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			stream.push({ type: "done", reason: "toolUse", message });
			stream.end(message);
			return stream;
		},
	});
}
