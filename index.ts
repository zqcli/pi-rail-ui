import {
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { TallGrayInputEditor, disableMouseTracking, enableMouseTracking, hideAllEditorOverlays } from "./components/editor";
import { createTallGrayFooter, setFooterExpanded } from "./components/footer";
import { installCommandOutputGap, uninstallCommandOutputGap } from "./patches/command-output";
import { CONVERSATION_SCROLL_LAYOUT, EDITOR_MOUSE_TRACKING_ENABLED } from "./config";
import { ensureConversationAlternateScreen, installConversationScroll, releaseConversationAlternateScreen, uninstallConversationScroll } from "./chat-view";
import {
	installThinkingSurface,
	uninstallThinkingSurface,
} from "./patches/message-surfaces";
import {
	installUserMessageSurface,
	refreshUserMessageTimestamps,
	rememberUserMessageTimestamp,
	uninstallUserMessageSurface,
} from "./patches/user-message-surface";
import { installResourceStatusGap, uninstallResourceStatusGap } from "./patches/resource-status";
import { installSettingsMenuSurface, uninstallSettingsMenuSurface } from "./patches/selector-overlays";
import { installToolExecutionGap, uninstallToolExecutionGap } from "./patches/execution-surfaces";

export * from "./ui/slash-autocomplete-overlay";
export * from "./patches/command-output";
export * from "./config";
export * from "./chat-view";
export * from "./components/editor";
export * from "./components/footer";
export * from "./ui/gap";
export * from "./ui/rail-overlay";
export * from "./patches/message-surfaces";
export * from "./patches/user-message-surface";
export * from "./ui/rail-section";
export * from "./patches/resource-status";
export * from "./patches/selector-overlays";
export * from "./ui/rail-surface";
export * from "./patches/execution-surfaces";
export * from "./utils";

export default async function piRailUi(pi: ExtensionAPI) {
	let enabled = true;
	let mouseEnabled = false;

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
			return new TallGrayInputEditor(tui, theme, keybindings, ctx.ui.theme);
		});

		if (EDITOR_MOUSE_TRACKING_ENABLED || CONVERSATION_SCROLL_LAYOUT.enabled) enableMouse();
		else {
			disableMouseTracking();
			mouseEnabled = false;
		}
	}

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter(createTallGrayFooter(ctx, pi));
	}

	async function install(ctx: ExtensionContext) {
		if (!ctx.hasUI || !enabled) return;
		await installConversationScroll();
		installEditor(ctx);
		installFooter(ctx);
		await installThinkingSurface(ctx.ui.theme);
		await installUserMessageSurface(ctx);
		await installSettingsMenuSurface(ctx.ui.theme);
		await installToolExecutionGap();
		await installResourceStatusGap();
		await installCommandOutputGap();
	}

	function uninstall(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setFooter(undefined);
		hideAllEditorOverlays();
		disableMouse();
		releaseConversationAlternateScreen();
		uninstallThinkingSurface();
		uninstallUserMessageSurface();
		uninstallSettingsMenuSurface();
		uninstallToolExecutionGap();
		uninstallResourceStatusGap();
		uninstallCommandOutputGap();
		uninstallConversationScroll();
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

	pi.on("message_end", async (event, _ctx) => {
		rememberUserMessageTimestamp(event.message);
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
		// Keep alternate screen across /reload. Exiting and immediately re-entering
		// clears the terminal while pi-tui still has differential-render state,
		// which can make the editor/footer repaint at stale rows.
		const keepAlternateScreen = event.reason === "reload";
		hideAllEditorOverlays();
		disableMouse();
		if (!keepAlternateScreen) releaseConversationAlternateScreen();
		uninstallThinkingSurface();
		uninstallUserMessageSurface();
		uninstallSettingsMenuSurface();
		uninstallToolExecutionGap();
		uninstallResourceStatusGap();
		uninstallCommandOutputGap();
		uninstallConversationScroll({ releaseAlternateScreen: !keepAlternateScreen });
		enabled = true;
	});

	process.on("exit", () => {
		releaseConversationAlternateScreen();
	});

	// Conversation scroll is patched during extension load so startup's first TUI
	// render uses the fixed app viewport. The patched TUI.start() enters the
	// alternate screen after Pi startup logs and before that first render, which
	// prevents native terminal scrollback/scrollbar growth on process startup.
}
