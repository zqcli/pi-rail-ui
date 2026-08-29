import { createPatchLifecycle, getInteractiveModeConstructor } from "../../core/patching";
import { withRailSectionChatChildren, wrapLastRailSectionChatChild } from "./chat-child-rail-injection";

type InteractiveModeCtor = { prototype: any };

const resourceStatusLifecycle = createPatchLifecycle("resource-status-rail-patch", () => ({}));
const getResourceStatusRailPatchStore = () => resourceStatusLifecycle.state();

const STATUS_ORIGINAL_PADDING_X_KEY = Symbol.for("pi-rail-ui.status-original-padding-x");

function normalizeStatusPaddingForGap(statusText: any): void {
	if (typeof statusText?.paddingX !== "number") return;
	if (statusText[STATUS_ORIGINAL_PADDING_X_KEY] === undefined) {
		statusText[STATUS_ORIGINAL_PADDING_X_KEY] = statusText.paddingX;
	}
	if (statusText.paddingX !== 0) {
		statusText.paddingX = 0;
		statusText.invalidate?.();
	}
}

function wrapLastStatusLine(mode: any): void {
	wrapLastRailSectionChatChild(mode, "resourceStatus", {
		normalizeChild: normalizeStatusPaddingForGap,
		assignTo: "lastStatusText",
	});
}

function wrapLastCommandOutputChild(mode: any): void {
	wrapLastRailSectionChatChild(mode, "resourceStatus", { normalizeChild: normalizeStatusPaddingForGap });
}

function patchInteractiveMode(ctor: InteractiveModeCtor): void {
	if (!ctor?.prototype) return;

	resourceStatusLifecycle.patchMethod(ctor, "showLoadedResources", (original) => function patchedShowLoadedResources(this: any, options: any) {
		const currentStore = getResourceStatusRailPatchStore();
		if (!currentStore.active) return original.call(this, options);
		return withRailSectionChatChildren(this, "resourceStatus", () => original.call(this, options), {
			normalizeChild: normalizeStatusPaddingForGap,
		});
	});

	resourceStatusLifecycle.patchMethod(ctor, "showStatus", (original) => function patchedShowStatus(this: any, message: string) {
		const currentStore = getResourceStatusRailPatchStore();
		if (!currentStore.active) return original.call(this, message);

		const result = original.call(this, message);
		wrapLastStatusLine(this);
		return result;
	});

	for (const methodName of ["showError", "showWarning"] as const) {
		resourceStatusLifecycle.patchMethod(ctor, methodName, (original) => function patchedCommandStatusOutput(this: any, message: string) {
			const currentStore = getResourceStatusRailPatchStore();
			if (!currentStore.active) return original.call(this, message);

			const result = original.call(this, message);
			wrapLastCommandOutputChild(this);
			return result;
		});
	}
}

export async function installResourceStatusRail(): Promise<void> {
	resourceStatusLifecycle.activate();
	patchInteractiveMode(await getInteractiveModeConstructor());
}

export function uninstallResourceStatusRail(): void {
	resourceStatusLifecycle.deactivate();
}
