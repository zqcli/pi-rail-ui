import { BashExecutionComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ThemeLike } from "../../config";
import { createStore, resolveNativePiExport, restorePrototypePatches } from "../../core/patching";
import { renderExecutionRail } from "./execution-rail";
import {
	EXECUTION_RENDERED_KEY,
	patchExecutionSetExpanded,
	type ExecutionRailPatchStore,
	type RenderableCtor,
} from "./execution-collapse";

const getExecutionRailPatchStore = createStore<ExecutionRailPatchStore>("execution-rail-patch", () => ({
	active: false,
	targets: [],
}));

async function resolveTheme(): Promise<ThemeLike | undefined> {
	return resolveNativePiExport<ThemeLike>("./modes/interactive/theme/theme.js", "theme");
}

async function getExecutionConstructors(): Promise<RenderableCtor[]> {
	const ctors: RenderableCtor[] = [
		ToolExecutionComponent as unknown as RenderableCtor,
		BashExecutionComponent as unknown as RenderableCtor,
	];
	const nativeToolCtor = await resolveNativePiExport<RenderableCtor>(
		"./modes/interactive/components/tool-execution.js",
		"ToolExecutionComponent",
	);
	const nativeBashCtor = await resolveNativePiExport<RenderableCtor>(
		"./modes/interactive/components/bash-execution.js",
		"BashExecutionComponent",
	);
	for (const ctor of [nativeToolCtor, nativeBashCtor]) {
		if (ctor && !ctors.includes(ctor)) ctors.push(ctor);
	}
	return ctors;
}

function patchRender(ctor: RenderableCtor, store: ExecutionRailPatchStore): void {
	if (store.targets.some((target) => target.ctor === ctor && target.methodName === "render")) return;
	const original = ctor.prototype.render;
	ctor.prototype.render = function patchedExecutionRender(this: any, width: number): string[] {
		const currentStore = getExecutionRailPatchStore();
		if (!currentStore.active) return original.call(this, width);
		try {
			const rows = renderExecutionRail(this, width, original, currentStore);
			this[EXECUTION_RENDERED_KEY] = true;
			return rows;
		} catch {
			this[EXECUTION_RENDERED_KEY] = true;
			return original.call(this, width);
		}
	};
	store.targets.push({ ctor, methodName: "render", original });
}

export async function installExecutionRails(): Promise<void> {
	const store = getExecutionRailPatchStore();
	store.active = true;
	store.theme = await resolveTheme();

	for (const ctor of await getExecutionConstructors()) {
		patchExecutionSetExpanded(ctor, store);
		patchRender(ctor, store);
	}
}

export function uninstallExecutionRails(): void {
	const store = getExecutionRailPatchStore();
	store.active = false;
	restorePrototypePatches(store.targets);
	store.targets = [];
}
