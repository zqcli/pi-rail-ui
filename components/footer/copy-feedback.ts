import { createPatchLifecycle, resolveNativeTuiExport } from "../../core/patching";
import { clearFooterSelectionNotice, showFooterSelectionNotice } from "./footer";

type FlashConstructor = {
	prototype: {
		flash(message: string, durationMs?: number): void;
	};
};

const copyFeedbackLifecycle = createPatchLifecycle("footer-copy-feedback-patch", () => ({}));

export function routeFullscreenFlash(
	tui: any,
	message: string,
	durationMs: number | undefined,
	forward: () => void,
): void {
	if (message.trim().toLowerCase() !== "copied!") {
		forward();
		return;
	}
	showFooterSelectionNotice(tui, durationMs ?? 1000);
}

export async function installFooterCopyFeedback(): Promise<void> {
	copyFeedbackLifecycle.activate();
	const ctor = await resolveNativeTuiExport<FlashConstructor>("TuiAltScreen");
	copyFeedbackLifecycle.patchMethod(ctor, "flash", (original) => function patchedFullscreenFlash(
		this: any,
		message: string,
		durationMs?: number,
	): void {
		if (!copyFeedbackLifecycle.state().active) return original.call(this, message, durationMs);
		routeFullscreenFlash(this, message, durationMs, () => original.call(this, message, durationMs));
	});
}

export function uninstallFooterCopyFeedback(): void {
	copyFeedbackLifecycle.deactivate();
	clearFooterSelectionNotice();
}