import { isGapBlock, isLeftGapBlock, LeftGapBlock, unwrapGapBlock } from "../../rail/rail-gap";
import { createStore, restorePrototypePatches, getInteractiveModeConstructors, type PrototypePatchTarget } from "../../core/patching";
import { RailSectionBlock } from "../../rail/rail-section";

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

function shouldGapResourceChild(child: any): boolean {
	return Boolean(child && typeof child.render === "function" && child.constructor?.name !== "Spacer" && !isGapBlock(child));
}

function leftGapBlock(child: any): LeftGapBlock {
	return new RailSectionBlock(child, "resourceStatus");
}

function withGappedResourceChildren<T>(mode: any, renderResources: () => T): T {
	const chatContainer = mode?.chatContainer;
	const originalAddChild = chatContainer?.addChild;
	if (typeof originalAddChild !== "function") return renderResources();

	chatContainer.addChild = function patchedResourceAddChild(this: any, child: any) {
		return originalAddChild.call(this, shouldGapResourceChild(child) ? leftGapBlock(child) : child);
	};
	try {
		return renderResources();
	} finally {
		chatContainer.addChild = originalAddChild;
	}
}

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

function lastRenderableResourceChildIndex(children: any[]): number {
	for (let index = children.length - 1; index >= 0; index--) {
		const child = children[index];
		if (isGapBlock(child) || shouldGapResourceChild(child)) return index;
	}
	return -1;
}

function wrapLastStatusLine(mode: any): void {
	const children = mode?.chatContainer?.children;
	if (!Array.isArray(children) || children.length === 0) return;

	const lastIndex = lastRenderableResourceChildIndex(children);
	if (lastIndex < 0) return;
	const last = children[lastIndex];
	if (isGapBlock(last)) {
		const inner = unwrapGapBlock(last);
		normalizeStatusPaddingForGap(inner);
		if (isLeftGapBlock(last)) {
			mode.lastStatusText = last;
			return;
		}
		const wrapped = leftGapBlock(inner);
		children[lastIndex] = wrapped;
		mode.lastStatusText = wrapped;
		return;
	}
	if (!shouldGapResourceChild(last)) return;

	normalizeStatusPaddingForGap(last);
	const wrapped = leftGapBlock(last);
	children[lastIndex] = wrapped;
	if (mode.lastStatusText === last) mode.lastStatusText = wrapped;
}

function wrapLastCommandOutputChild(mode: any): void {
	const children = mode?.chatContainer?.children;
	if (!Array.isArray(children) || children.length === 0) return;

	const lastIndex = lastRenderableResourceChildIndex(children);
	if (lastIndex < 0) return;
	const last = children[lastIndex];
	if (isGapBlock(last)) {
		const inner = unwrapGapBlock(last);
		normalizeStatusPaddingForGap(inner);
		if (!isLeftGapBlock(last)) children[lastIndex] = leftGapBlock(inner);
		return;
	}
	if (!shouldGapResourceChild(last)) return;
	normalizeStatusPaddingForGap(last);
	children[lastIndex] = leftGapBlock(last);
}

function patchInteractiveMode(ctor: InteractiveModeCtor, store: ResourceStatusRailPatchStore): void {
	if (!ctor?.prototype) return;

	if (!store.targets.some((target) => target.ctor === ctor && target.methodName === "showLoadedResources")) {
		const original = ctor.prototype.showLoadedResources;
		ctor.prototype.showLoadedResources = function patchedShowLoadedResources(this: any, options: any) {
			const currentStore = getResourceStatusRailPatchStore();
			if (!currentStore.active || typeof original !== "function") return original?.call(this, options);
			return withGappedResourceChildren(this, () => original.call(this, options));
		};
		store.targets.push({ ctor, methodName: "showLoadedResources", original });
	}

	if (!store.targets.some((target) => target.ctor === ctor && target.methodName === "showStatus")) {
		const original = ctor.prototype.showStatus;
		ctor.prototype.showStatus = function patchedShowStatus(this: any, message: string) {
			const currentStore = getResourceStatusRailPatchStore();
			if (!currentStore.active || typeof original !== "function") return original?.call(this, message);

			const result = original.call(this, message);
			wrapLastStatusLine(this);
			return result;
		};
		store.targets.push({ ctor, methodName: "showStatus", original });
	}

	for (const methodName of ["showError", "showWarning"] as const) {
		if (store.targets.some((target) => target.ctor === ctor && target.methodName === methodName)) continue;
		const original = ctor.prototype[methodName];
		ctor.prototype[methodName] = function patchedCommandStatusOutput(this: any, message: string) {
			const currentStore = getResourceStatusRailPatchStore();
			if (!currentStore.active || typeof original !== "function") return original?.call(this, message);

			const result = original.call(this, message);
			wrapLastCommandOutputChild(this);
			return result;
		};
		store.targets.push({ ctor, methodName, original });
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
