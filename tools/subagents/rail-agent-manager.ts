import { SessionManager, type ExtensionCommandContext, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { RailAgentManager } from "./agent-manager";
import { availableRailModels } from "./models";
import { showRailAgentOverlay } from "./rail-agent-overlay";

export interface RailAgentManagerRuntime {
	manager?: RailAgentManager;
}

export interface RailAgentManagerDependencies {
	listSessions?: () => Promise<SessionInfo[]>;
}

function insertMention(ctx: ExtensionCommandContext, alias: string): void {
	const current = ctx.ui.getEditorText();
	const separator = current && !/\s$/u.test(current) ? " " : "";
	ctx.ui.setEditorText(`${current}${separator}@agent/${alias} `);
}

export async function runRailAgentManager(
	ctx: ExtensionCommandContext,
	runtime: RailAgentManagerRuntime,
	dependencies: RailAgentManagerDependencies = {},
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/rail-agent requires the interactive TUI; use the subagent tool (or @agent/<alias>) instead.", "warning");
		return;
	}
	if (!runtime.manager) throw new Error("Rail agent manager runtime is not configured");
	const listSessions = dependencies.listSessions ?? (() => SessionManager.listAll());
	const parentFile = ctx.sessionManager.getSessionFile();
	const models = availableRailModels(ctx);
	return showRailAgentOverlay(ctx, {
		manager: runtime.manager,
		models,
		loadSessions: async () => (await listSessions())
			.filter((session) => session.path !== parentFile)
			.sort((left, right) => right.modified.getTime() - left.modified.getTime())
			.slice(0, 250),
		currentCwd: ctx.cwd,
		insertMention: (alias) => insertMention(ctx, alias),
	});
}
