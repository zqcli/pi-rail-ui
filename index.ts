import {
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { TallGrayInputEditor, disableMouseTracking, enableMouseTracking, enterAlternateScreen, exitAlternateScreen, hideAllEditorOverlays } from "./components/editor";
import { createTallGrayFooter } from "./components/footer";
import { installCommandOutputGap, uninstallCommandOutputGap } from "./patches/command-output";
import { CONVERSATION_SCROLL_LAYOUT, EDITOR_MOUSE_TRACKING_ENABLED } from "./config";
import { installConversationScroll, uninstallConversationScroll } from "./chat-view";
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

export default function piRailUi(pi: ExtensionAPI) {
	let enabled = true;
	let mouseEnabled = false;
	let altScreenEnabled = false;

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

	function enableAltScreen() {
		if (altScreenEnabled) return;
		if (!CONVERSATION_SCROLL_LAYOUT.alternateScreen) return;
		enterAlternateScreen();
		altScreenEnabled = true;
	}

	function disableAltScreen() {
		if (!altScreenEnabled) return;
		exitAlternateScreen();
		altScreenEnabled = false;
	}

	function installEditor(ctx: ExtensionContext) {
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
			new TallGrayInputEditor(tui, theme, keybindings, ctx.ui.theme),
		);

		if (EDITOR_MOUSE_TRACKING_ENABLED || CONVERSATION_SCROLL_LAYOUT.enabled) enableMouse();
		else {
			disableMouseTracking();
			mouseEnabled = false;
		}

		if (CONVERSATION_SCROLL_LAYOUT.enabled) enableAltScreen();
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
		disableAltScreen();
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

	pi.on("session_start", async (_event, ctx) => {
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

	pi.on("session_shutdown", async () => {
		hideAllEditorOverlays();
		disableMouse();
		disableAltScreen();
		uninstallThinkingSurface();
		uninstallUserMessageSurface();
		uninstallSettingsMenuSurface();
		uninstallToolExecutionGap();
		uninstallResourceStatusGap();
		uninstallCommandOutputGap();
		uninstallConversationScroll();
		enabled = true;
	});

	process.on("exit", () => {
		if (altScreenEnabled) exitAlternateScreen();
	});

	if (CONVERSATION_SCROLL_LAYOUT.enabled) enableAltScreen();
}
