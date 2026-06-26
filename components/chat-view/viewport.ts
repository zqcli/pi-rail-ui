import { TUI } from "@earendil-works/pi-tui";
import { appLeftGutterWidth, CONVERSATION_SCROLL_LAYOUT } from "../../config";
import { getInteractiveModeConstructors, resolveNativeTuiExport } from "../../core/patching";
import { isInteractiveRoot } from "./history-renderer";
import { conversationScrollLifecycle, type TuiCtor } from "./state";
import { conversationViewportController } from "./viewport-controller";

type InteractiveModeCtor = { prototype: any };

function withGlobalLeftGutterOverlayOptions(options: any, width: number): any {
	const gutter = appLeftGutterWidth(width);
	if (gutter <= 0) return options;

	const rawMargin = options?.margin;
	const margin = typeof rawMargin === "number"
		? { top: rawMargin, right: rawMargin, bottom: rawMargin, left: rawMargin }
		: { ...(rawMargin ?? {}) };
	margin.left = Math.max(0, Math.round(margin.left ?? 0)) + gutter;
	return { ...(options ?? {}), margin };
}

export function ensureConversationAlternateScreen(tui?: any): void {
	conversationViewportController.ensureAlternateScreen(tui);
}

export function releaseConversationAlternateScreen(): void {
	conversationViewportController.releaseAlternateScreen();
}

function patchInteractiveMode(ctor: InteractiveModeCtor | undefined): void {
	if (!ctor?.prototype || typeof ctor.prototype.renderInitialMessages !== "function") return;

	conversationScrollLifecycle.patchMethod(
		ctor,
		"renderInitialMessages",
		(originalRenderInitialMessages) => function patchedConversationInitialMessages(this: any, ...args: any[]) {
			const result = originalRenderInitialMessages.apply(this, args);
			conversationViewportController.resetAfterInitialMessages(this.ui);
			return result;
		},
	);
}

function patchTui(ctor: TuiCtor | undefined): void {
	if (!ctor?.prototype) return;

	conversationScrollLifecycle.patchMethod(ctor, "start", (originalStart) => function patchedConversationScrollStart(this: any, ...args: any[]) {
		const result = originalStart.apply(this, args);
		conversationViewportController.ensureAlternateScreen(this);
		return result;
	});

	conversationScrollLifecycle.patchMethod(ctor, "stop", (originalStop) => function patchedConversationScrollStop(this: any, ...args: any[]) {
		try {
			return originalStop.apply(this, args);
		} finally {
			conversationViewportController.releaseAlternateScreen();
		}
	});

	conversationScrollLifecycle.patchMethod(ctor, "render", (originalRender) => function patchedConversationScrollRender(this: any, width: number): string[] {
		return conversationViewportController.render(this, width, originalRender);
	});

	conversationScrollLifecycle.patchMethod(ctor, "showOverlay", (originalShowOverlay) => function patchedGlobalGutterOverlay(this: any, component: any, options?: any) {
		if (!CONVERSATION_SCROLL_LAYOUT.enabled || !isInteractiveRoot(this)) return originalShowOverlay.call(this, component, options);
		return originalShowOverlay.call(this, component, withGlobalLeftGutterOverlayOptions(options, this.terminal?.columns ?? 80));
	});

	conversationScrollLifecycle.patchMethod(ctor, "handleInput", (originalHandleInput) => function patchedConversationScrollInput(this: any, data: string): void {
		return conversationViewportController.handleInput(this, data, originalHandleInput);
	});
}

export async function installConversationScroll(): Promise<void> {
	if (!CONVERSATION_SCROLL_LAYOUT.enabled) return;
	conversationScrollLifecycle.activate();
	patchTui(TUI as unknown as TuiCtor);
	patchTui(await resolveNativeTuiExport<TuiCtor>("TUI"));
	for (const ctor of await getInteractiveModeConstructors()) patchInteractiveMode(ctor);
}

export function resetConversationScrollState(): void {
	conversationViewportController.reset({ clearOnNextOverflowRender: true });
}

export function uninstallConversationScroll(options: { releaseAlternateScreen?: boolean } = {}): void {
	if (options.releaseAlternateScreen !== false) conversationViewportController.releaseAlternateScreen();
	conversationScrollLifecycle.deactivate();
	conversationViewportController.reset();
}
