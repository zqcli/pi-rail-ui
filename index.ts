import {
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { CONVERSATION_SCROLL_LAYOUT, EDITOR_MOUSE_TRACKING_ENABLED } from "./config";
import { RailEditor, disableMouseTracking, enableMouseTracking, hideAllEditorOverlays, installSelectorOverlay, uninstallSelectorOverlay } from "./components/editor";
import { createRailFooter, setFooterExpanded } from "./components/footer";
import { ensureConversationAlternateScreen, installConversationScroll, installTerminalOutputCoalescing, releaseConversationAlternateScreen, resetConversationScrollState, uninstallConversationScroll, uninstallTerminalOutputCoalescing } from "./components/chat-view";
import { installExecutionRails, uninstallExecutionRails } from "./components/executions";
import { installAssistantMessageRail, uninstallAssistantMessageRail, installCommandOutputRail, uninstallCommandOutputRail, installResourceStatusRail, uninstallResourceStatusRail, installUserMessageRail, refreshUserMessageTimestamps, rememberUserMessageTimestamp, uninstallUserMessageRail } from "./components/messages";
import { setRailUiActive } from "./rail";
import { registerWebFetchTool } from "./tools/web-fetch";

export * from "./config";
export * from "./core/clipboard";
export * from "./core/patching";
export * from "./core/utils";
export * from "./rail";
export * from "./components/editor";
export * from "./components/footer";
export * from "./components/messages";
export * from "./components/executions";
export * from "./components/chat-view";

export default async function piRailUi(pi: ExtensionAPI) {
	registerWebFetchTool(pi);

	let enabled = true;
	let mouseEnabled = false;

	await installTerminalOutputCoalescing();
	await installConversationScroll();
	if (!CONVERSATION_SCROLL_LAYOUT.enabled || !CONVERSATION_SCROLL_LAYOUT.alternateScreen) releaseConversationAlternateScreen();

	function enableMouse() {
		if (mouseEnabled) return;
		enableMouseTracking();
		mouseEnabled = true;
	}

	function disableMouse() {
		if (!mouseEnabled) return;
		disableMouseTracking();
		mouseEnabled = false;
	}

	function installEditor(ctx: ExtensionContext) {
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			ensureConversationAlternateScreen(tui);
			return new RailEditor(tui, theme, keybindings, ctx.ui.theme);
		});

		if (EDITOR_MOUSE_TRACKING_ENABLED || CONVERSATION_SCROLL_LAYOUT.enabled) enableMouse();
		else {
			disableMouseTracking();
			mouseEnabled = false;
		}
	}

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter(createRailFooter(ctx, pi));
	}

	async function install(ctx: ExtensionContext) {
		if (!ctx.hasUI || !enabled) return;
		setRailUiActive(true);
		await installTerminalOutputCoalescing();
		await installConversationScroll();
		installEditor(ctx);
		installFooter(ctx);
		await installAssistantMessageRail(ctx.ui.theme);
		await installUserMessageRail(ctx);
		await installSelectorOverlay(ctx.ui.theme);
		await installExecutionRails();
		await installResourceStatusRail();
		await installCommandOutputRail();
	}

	function uninstall(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		setRailUiActive(false);
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setFooter(undefined);
		hideAllEditorOverlays();
		disableMouse();
		releaseConversationAlternateScreen();
		uninstallAssistantMessageRail();
		uninstallUserMessageRail();
		uninstallSelectorOverlay();
		uninstallExecutionRails();
		uninstallResourceStatusRail();
		uninstallCommandOutputRail();
		uninstallConversationScroll();
		uninstallTerminalOutputCoalescing();
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

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload") setFooterExpanded(false);
		await install(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.hasUI && enabled) {
			installFooter(ctx);
			refreshUserMessageTimestamps(ctx);
		}
	});

	pi.on("message_start", async (event, _ctx) => {
		rememberUserMessageTimestamp(event.message);
	});

	pi.on("message_end", async (event, ctx) => {
		rememberUserMessageTimestamp(event.message);
		if (event.message.role === "assistant" && ctx.hasUI && enabled) {
			installFooter(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI && enabled) installFooter(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (ctx.hasUI && enabled) installFooter(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		if (ctx.hasUI && enabled) installFooter(ctx);
	});

	pi.on("session_shutdown", async (event) => {
		setRailUiActive(false);
		// Keep the app viewport alive across in-process session switches. Pi resets
		// extension UI between shutdown/start; if the TUI render patch is removed in
		// that gap, long resumed histories briefly paint with terminal-native scroll.
		const keepAlternateScreen = event.reason !== "quit";
		const keepConversationScroll = event.reason === "new" || event.reason === "resume" || event.reason === "fork";
		hideAllEditorOverlays();
		disableMouse();
		if (!keepAlternateScreen) releaseConversationAlternateScreen();
		uninstallAssistantMessageRail();
		uninstallUserMessageRail();
		uninstallSelectorOverlay();
		uninstallExecutionRails();
		uninstallResourceStatusRail();
		uninstallCommandOutputRail();
		if (keepConversationScroll) resetConversationScrollState();
		else {
			uninstallConversationScroll({ releaseAlternateScreen: !keepAlternateScreen });
			uninstallTerminalOutputCoalescing();
		}
		enabled = true;
	});

	process.on("exit", () => {
		disableMouseTracking();
		releaseConversationAlternateScreen();
	});

	// Conversation scroll is patched during extension load so startup's first TUI
	// render uses the fixed app viewport. The patched TUI.start() enters the
	// alternate screen after Pi startup logs and before that first render, which
	// prevents native terminal scrollback/scrollbar growth on process startup.
}
