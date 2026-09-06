import {
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { RailEditor } from "./components/editor";
import { createRailFooter, openRailSessionModal, setTurnEndTime, setTurnStartTime } from "./components/footer";
import { handleDuplicateCommand } from "./commands/duplicate";
import { installRailFast } from "./commands/rail-fast";
import { installRailOaiSearch } from "./commands/rail-oai-search";
import { installExecutionRails, uninstallExecutionRails } from "./components/executions";
import { installAssistantMessageRail, uninstallAssistantMessageRail, installCommandOutputRail, uninstallCommandOutputRail, installResourceStatusRail, uninstallResourceStatusRail, installUserMessageRail, refreshUserMessageTimestamps, rememberUserMessageTimestamp, uninstallUserMessageRail } from "./components/messages";
import { setRailUiActive } from "./rail";
import { installGutter, uninstallGutter } from "./rail/gutter";
import { installApplyPatchTool, installRailSubagent } from "./tools";

export * from "./config";
export * from "./core/patching";
export * from "./core/utils";
export * from "./rail";
export * from "./tools";
export * from "./components/editor";
export * from "./components/footer";
export * from "./components/messages";
export * from "./components/executions";

export default async function piRailUi(pi: ExtensionAPI) {
	let enabled = true;

	installApplyPatchTool(pi);
	installRailFast(pi);
	installRailOaiSearch(pi);

	function installEditor(ctx: ExtensionContext) {
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			return new RailEditor(tui, theme, keybindings, ctx.ui.theme);
		});

	}

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter(createRailFooter(ctx, pi));
	}

	async function install(ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || !enabled) return;
		setRailUiActive(true);
		installEditor(ctx);
		installFooter(ctx);
		await installGutter();
		await installAssistantMessageRail(ctx.ui.theme);
		await installUserMessageRail(ctx);
		await installExecutionRails(ctx.ui.theme);
		await installResourceStatusRail();
		await installCommandOutputRail();
	}

	function uninstall(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		setRailUiActive(false);
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setFooter(undefined);
		uninstallGutter();
		uninstallAssistantMessageRail();
		uninstallUserMessageRail();
		uninstallExecutionRails();
		uninstallResourceStatusRail();
		uninstallCommandOutputRail();
	}

	pi.registerCommand("rail-ui", {
		description: "Toggle Pi rail UI",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				await install(ctx);
				ctx.ui.notify("Pi rail UI enabled", "info");
			} else {
				uninstall(ctx);
				ctx.ui.notify("Pi rail UI disabled", "info");
			}
		},
	});

	pi.registerCommand("rail-duplicate", {
		description: "Duplicate current session as a sibling (same parent)",
		handler: async (_args, ctx) => {
			await handleDuplicateCommand(ctx);
		},
	});

	pi.registerCommand("rail-session", {
		description: "Show Pi rail session details",
		handler: async (_args, ctx) => {
			await openRailSessionModal(ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await install(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		setTurnStartTime(Date.now());
		if (ctx.mode === "tui" && enabled) {
			installFooter(ctx);
			refreshUserMessageTimestamps(ctx);
		}
	});

	pi.on("message_start", async (event, _ctx) => {
		rememberUserMessageTimestamp(event.message);
	});

	pi.on("message_end", async (event, ctx) => {
		rememberUserMessageTimestamp(event.message);
		if (event.message.role === "assistant" && ctx.mode === "tui" && enabled) {
			installFooter(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		setTurnEndTime();
		if (ctx.mode === "tui" && enabled) installFooter(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (ctx.mode === "tui" && enabled) installFooter(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		if (ctx.mode === "tui" && enabled) installFooter(ctx);
	});

	pi.on("session_shutdown", async (_event) => {
		setRailUiActive(false);
		// Pi owns session replacement, terminal input, and renderer cleanup. Rail
		// only tears down its style and narrow interaction patches.
		uninstallGutter();
		uninstallAssistantMessageRail();
		uninstallUserMessageRail();
		uninstallExecutionRails();
		uninstallResourceStatusRail();
		uninstallCommandOutputRail();
		enabled = true;
	});

	// Keep the subagent runtime independent from /rail-ui while preserving Rail's
	// UI-first session lifecycle ordering.
	installRailSubagent(pi);

	// Pi owns the conversation viewport, alternate screen, scrollbars, selection,
	// and renderer lifecycle. Rail only supplies components and visual surfaces.
}
