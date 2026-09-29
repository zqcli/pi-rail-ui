import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installRailKeepAlive, keepAliveLabel, keepAliveStatus } from "../../commands/rail-keep-alive";

export default function probe(pi: ExtensionAPI) {
	pi.registerProvider("rail-ka-local", {
		baseUrl: "http://127.0.0.1:1/no-network",
		apiKey: "local-only",
		api: "openai-responses",
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const headers = options?.headers;
				const payload = await options?.onPayload?.({ model: model.id, input: context.messages }, model);
				await options?.onResponse?.({ status: 200, headers: {} }, model);
				await appendFile(process.env["KA_PROBE_LOG"]!, JSON.stringify({ maxTokens: options?.maxTokens, payload, headers,
					hasPayloadHook: !!options?.onPayload, hasResponseHook: !!options?.onResponse, hasHeadersHook: headers?.["x-ka-probe"] === "yes" }) + "\n");
				const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "local only" }], api: model.api,
					provider: model.provider, model: model.id, stopReason: "stop" as const, timestamp: Date.now(),
					usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			})().catch(() => stream.end());
			return stream;
		},
		models: [{ id: "local", name: "local", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 64 }],
	});
	pi.on("before_provider_headers", ({ headers }) => { headers["x-ka-probe"] = "yes"; });
	// Like Rail's search status: any turn_end handler makes Pi re-project agent messages after the turn.
	pi.on("turn_end", () => {});
	const original = AgentSession.prototype.prompt;
	let live: any;
	let blockCompaction: (() => void) | undefined;
	let enteredCompaction: (() => void) | undefined;
	pi.on("session_before_compact", async () => {
		if (!blockCompaction) return;
		enteredCompaction?.();
		await new Promise<void>((resolve) => { blockCompaction = resolve; });
		return { cancel: true };
	});
	AgentSession.prototype.prompt = function(this: AgentSession, ...args: any[]) {
		live = this;
		return original.apply(this, args as [string]);
	};
	installRailKeepAlive(pi);
	// Registered after Rail's handler: records what the footer shows right after /reload, before any prompt.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "reload" || !process.env["KA_RELOAD_OUTPUT"]) return;
		await writeFile(process.env["KA_RELOAD_OUTPUT"], JSON.stringify({ label: keepAliveLabel(ctx.sessionManager), status: keepAliveStatus(ctx.sessionManager) }));
	});
	pi.registerCommand("ka-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
	pi.registerCommand("ka-name", {
		handler: async (_args, ctx) => {
			const warmer = live?._cacheWarmer;
			const before = warmer?.run;
			live.setSessionName("renamed while idle");
			if (before?.timer) clearTimeout(before.timer);
			if (before) { before.timer = undefined; await warmer.refresh(before); }
			const count = ctx.sessionManager.getEntries().filter((entry) => entry.type === "usage" && entry.kind === "cache_warm").length;
			await writeFile(process.env["KA_PROBE_OUTPUT"]!, JSON.stringify({ count, status: keepAliveStatus(ctx.sessionManager) }));
		},
	});
	pi.registerCommand("ka-compact", {
		handler: async (_args, ctx) => {
			const warmer = live?._cacheWarmer;
			const oldRun = warmer?.run;
			let entered!: () => void;
			const reachedHook = new Promise<void>((resolve) => { entered = resolve; });
			enteredCompaction = entered;
			blockCompaction = () => {};
			const compaction = live.compact();
			try {
				await Promise.race([
					reachedHook,
					compaction.then(() => { throw new Error("compaction finished before before_compact hook"); }, (error: Error) => { throw error; }),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("compaction hook not reached")), 5000)),
				]);
				// Reproduce the old timer callback while compaction is blocked. If the
				// session did not cancel it, native refresh would send a paid request.
				if (oldRun && !oldRun.controller.signal.aborted) {
					if (oldRun.timer) clearTimeout(oldRun.timer);
					oldRun.timer = undefined;
					await warmer.refresh(oldRun);
				}
				const requests = (await readFile(process.env["KA_PROBE_LOG"]!, "utf8")).trim().split("\n").length;
				await writeFile(process.env["KA_PROBE_OUTPUT"]!, JSON.stringify({
					compacting: live.isCompacting, cancelledOldRun: oldRun?.controller.signal.aborted,
					requests, status: keepAliveStatus(ctx.sessionManager),
				}));
			} finally {
				blockCompaction?.();
				blockCompaction = undefined;
				enteredCompaction = undefined;
				await compaction.catch(() => undefined);
			}
		},
	});
	pi.registerCommand("ka-probe", {
		handler: async (_args, ctx) => {
			const warmer = live?._cacheWarmer;
			const before = { captured: Boolean(live && live.sessionManager === ctx.sessionManager),
				bound: warmer?.getMode() === "idle", status: keepAliveStatus(ctx.sessionManager),
				nativeStatus: live?.cacheWarmingStatus };
			if (warmer?.run) {
				clearTimeout(warmer.run.timer);
				warmer.run.timer = undefined;
				await warmer.refresh(warmer.run);
			}
			const entries = ctx.sessionManager.getEntries();
			await writeFile(process.env["KA_PROBE_OUTPUT"]!, JSON.stringify({ ...before,
				usage: entries.filter((entry) => entry.type === "usage" && entry.kind === "cache_warm").length,
				assistant: entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length,
			}));
		},
	});
}
