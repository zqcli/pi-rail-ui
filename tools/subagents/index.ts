import * as path from "node:path";
import {
	getAgentDir,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { FileAgentInstanceStore } from "./instance-store";
import { RailAgentManager } from "./agent-manager";
import {
	applySubagentMentionCompletion,
	buildSubagentRosterPrompt,
	extractSubagentMentions,
	handleDirectSubagentControlInput,
	subagentMentionContext,
	subagentMentionSuggestions,
} from "./interaction";
import { availableRailModels, railModelReference } from "./models";
import type { RpcEvent } from "./rpc-worker";
import { runRailAgentManager } from "./rail-agent-manager";
import { SessionBroker } from "./session-broker";
import { SessionAgentRoster } from "./session-links";
import { FileSessionLeaseManager } from "./session-lease";
import { buildParentSessionLabel } from "./session-name";
import { createStatelessAgentRunner } from "./stateless-runner";
import { installStatefulSubagentTool } from "./tool";
import { createRpcWorkerFactory } from "./worker-factory";

interface SubagentRuntime {
	ctx: ExtensionContext;
	broker: SessionBroker;
	roster: SessionAgentRoster;
	store: FileAgentInstanceStore;
	manager: RailAgentManager;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

export function installRailSubagent(pi: ExtensionAPI): void {
	if (Number(process.env["PI_SUBAGENT_DEPTH"] ?? "0") > 0) return;
	const stateDir = path.join(getAgentDir(), "stateful-subagents");
	let runtime: SubagentRuntime | undefined;

	const getRuntime = (): SubagentRuntime => {
		if (!runtime) throw new Error("Persistent subagent runtime is not ready");
		return runtime;
	};

	const handleChildUiRequest = async (
		request: RpcEvent,
		source: { agentId: string; alias: string },
	): Promise<Record<string, unknown> | undefined> => {
		const current = runtime?.ctx;
		if (!current?.hasUI) return { cancelled: true };
		const method = request["method"];
		if (method === "notify") {
			const notifyType = request["notifyType"];
			current.ui.notify(`[${source.alias}] ${String(request["message"] ?? "")}`, notifyType === "warning" || notifyType === "error" ? notifyType : "info");
			return undefined;
		}
		if (method === "setStatus") {
			current.ui.setStatus(`subagent:${source.agentId}:${String(request["statusKey"] ?? "child")}`, request["statusText"] === undefined ? undefined : String(request["statusText"]));
			return undefined;
		}
		if (method === "setWidget") {
			const lines = Array.isArray(request["widgetLines"]) ? request["widgetLines"].map(String) : undefined;
			current.ui.setWidget(
				`subagent:${source.agentId}:${String(request["widgetKey"] ?? "child")}`,
				lines,
				{ placement: request["widgetPlacement"] === "belowEditor" ? "belowEditor" : "aboveEditor" },
			);
			return undefined;
		}
		if (method === "setTitle") {
			current.ui.setTitle(`[${source.alias}] ${String(request["title"] ?? "")}`);
			return undefined;
		}
		if (method === "set_editor_text") {
			current.ui.setEditorText(String(request["text"] ?? ""));
			return undefined;
		}
		if (method === "confirm") {
			return { confirmed: await current.ui.confirm(`[${source.alias}] ${String(request["title"] ?? "Subagent")}`, String(request["message"] ?? "")) };
		}
		if (method === "select") {
			const options = Array.isArray(request["options"]) ? request["options"].map(String) : [];
			const value = await current.ui.select(`[${source.alias}] ${String(request["title"] ?? "Subagent")}`, options);
			return value === undefined ? { cancelled: true } : { value };
		}
		if (method === "input") {
			const value = await current.ui.input(`[${source.alias}] ${String(request["title"] ?? "Subagent")}`, String(request["placeholder"] ?? ""));
			return value === undefined ? { cancelled: true } : { value };
		}
		if (method === "editor") {
			const value = await current.ui.editor(`[${source.alias}] ${String(request["title"] ?? "Subagent")}`, String(request["prefill"] ?? ""));
			return value === undefined ? { cancelled: true } : { value };
		}
		return { cancelled: true };
	};

	installStatefulSubagentTool(pi, {
		broker: () => getRuntime().broker,
		runStateless: createStatelessAgentRunner(),
		getMarkdownTheme,
	});

	const installAutocomplete = (ctx: ExtensionContext) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: unique([...(current.triggerCharacters ?? []), "@"]),
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? "";
				const beforeCursor = line.slice(0, cursorCol);
				const active = runtime;
				// Ordinary file/command completion must not read the agent store or enumerate models.
				if (active && subagentMentionContext(beforeCursor)) {
					const instances = await active.broker.listLinked();
					const models = availableRailModels(ctx);
					const suggestions = subagentMentionSuggestions(
						beforeCursor,
						instances.map((instance) => ({ alias: instance.alias, description: `${railModelReference(instance.model)} · ${instance.lastTask}` })),
						models.map((model) => ({
							reference: railModelReference(model),
							description: model.name ?? model.modelId,
						})),
					);
					if (suggestions) return suggestions;
				}
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return prefix.startsWith("@agent/") || prefix.startsWith("@new/")
					? applySubagentMentionCompletion(lines, cursorLine, cursorCol, item.value, prefix)
					: current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (subagentMentionContext(beforeCursor)) return false;
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	};

	pi.registerCommand("rail-agent", {
		description: "Start, link, and manage Rail persistent model sessions",
		handler: (_args, ctx) => runRailAgentManager(ctx, getRuntime()),
	});

	pi.on("session_start", async (_event, ctx) => {
		if (runtime) await runtime.broker.shutdown();
		const store = new FileAgentInstanceStore(stateDir);
		const roster = new SessionAgentRoster((customType, data) => pi.appendEntry(customType, data));
		roster.restore(ctx.sessionManager.getBranch());
		const broker = new SessionBroker({
			store,
			roster,
			workerFactory: createRpcWorkerFactory({ stateDir, onUiRequest: handleChildUiRequest }),
			defaultCwd: ctx.cwd,
			parentSessionLabel: buildParentSessionLabel(
				ctx.sessionManager.getSessionName(),
				ctx.sessionManager.getSessionId(),
				ctx.cwd,
			),
			aliasLeaseManager: new FileSessionLeaseManager(stateDir),
		});
		const manager = new RailAgentManager(broker, store, roster, stateDir);
		runtime = { ctx, broker, roster, store, manager };
		if (ctx.mode === "tui") installAutocomplete(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!runtime) return;
		runtime.ctx = ctx;
		runtime.roster.restore(ctx.sessionManager.getBranch());
	});

	pi.on("input", async (event, ctx) => {
		const active = runtime;
		return handleDirectSubagentControlInput(
			event,
			ctx,
			active ? (target, request, signal) => active.manager.control(target, request, signal) : undefined,
		);
	});

	pi.on("before_agent_start", async (event) => {
		const active = runtime;
		if (!active) return;
		const mentions = extractSubagentMentions(event.prompt);
		const prompt = buildSubagentRosterPrompt(await active.broker.listLinked(), mentions);
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	pi.on("session_shutdown", async () => {
		const active = runtime;
		runtime = undefined;
		if (active) await active.broker.shutdown();
	});
}

export * from "./identity";
export * from "./agent-manager";
export * from "./instance-store";
export * from "./interaction";
export * from "./model-picker";
export * from "./models";
export * from "./rpc-transport";
export * from "./rpc-worker";
export * from "./rail-agent-manager";
export * from "./rail-agent-overlay";
export * from "./session-broker";
export * from "./session-lease";
export * from "./session-links";
export * from "./session-name";
export * from "./stateless-runner";
export * from "./tool";
export * from "./transcript";
