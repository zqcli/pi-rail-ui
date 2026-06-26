import { createStore, restorePrototypePatches, getInteractiveModeConstructors, patchPrototypeMethod, type PrototypePatchTarget } from "../../core/patching";
import { withRailSectionChatChildren, wrapLastRailSectionChatChild } from "./chat-child-rail-injection";

type InteractiveModeCtor = { prototype: any };

type ResourceStatusRailPatchStore = {
	active: boolean;
	targets: PrototypePatchTarget[];
};

const getResourceStatusRailPatchStore = createStore<ResourceStatusRailPatchStore>("resource-status-rail-patch", () => ({
	active: false,
	targets: [],
}));

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

function patchInteractiveMode(ctor: InteractiveModeCtor, store: ResourceStatusRailPatchStore): void {
	if (!ctor?.prototype) return;

	patchPrototypeMethod(store.targets, ctor, "showLoadedResources", (original) => function patchedShowLoadedResources(this: any, options: any) {
		const currentStore = getResourceStatusRailPatchStore();
		if (!currentStore.active) return original.call(this, options);
		return withRailSectionChatChildren(this, "resourceStatus", () => original.call(this, options), {
			normalizeChild: normalizeStatusPaddingForGap,
		});
	});

	patchPrototypeMethod(store.targets, ctor, "showStatus", (original) => function patchedShowStatus(this: any, message: string) {
		const currentStore = getResourceStatusRailPatchStore();
		if (!currentStore.active) return original.call(this, message);

		const result = original.call(this, message);
		wrapLastStatusLine(this);
		return result;
	});

	for (const methodName of ["showError", "showWarning"] as const) {
		patchPrototypeMethod(store.targets, ctor, methodName, (original) => function patchedCommandStatusOutput(this: any, message: string) {
			const currentStore = getResourceStatusRailPatchStore();
			if (!currentStore.active) return original.call(this, message);

			const result = original.call(this, message);
			wrapLastCommandOutputChild(this);
			return result;
		});
	}
}

export async function installResourceStatusRail(): Promise<void> {
	const store = getResourceStatusRailPatchStore();
	store.active = true;
	for (const ctor of await getInteractiveModeConstructors()) patchInteractiveMode(ctor, store);
}

export function uninstallResourceStatusRail(): void {
	const store = getResourceStatusRailPatchStore();
	store.active = false;
	restorePrototypePatches(store.targets);
}
