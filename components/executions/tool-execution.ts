import { BashExecutionComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ThemeLike } from "../../config";
import { createPatchLifecycle, resolveNativePiExport } from "../../core/patching";
import { renderExecutionRail } from "./execution-rail";
import {
	EXECUTION_RENDERED_KEY,
	patchExecutionSetExpanded,
	type ExecutionRailPatchStore,
	type RenderableCtor,
} from "./execution-collapse";
import {
	clearRailClickRegistry,
	markRailClickRows,
	patchRailSectionClickHandling,
} from "./rail-click";

const executionRailLifecycle = createPatchLifecycle<Omit<ExecutionRailPatchStore, "active" | "targets">>("execution-rail-patch", () => ({}));
const getExecutionRailPatchStore = () => executionRailLifecycle.state();

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

function patchRender(ctor: RenderableCtor): void {
	executionRailLifecycle.patchMethod(ctor, "render", (original) => function patchedExecutionRender(this: any, width: number): string[] {
		const currentStore = getExecutionRailPatchStore();
		if (!currentStore.active) return original.call(this, width);
		try {
			const rows = renderExecutionRail(this, width, original, currentStore);
			this[EXECUTION_RENDERED_KEY] = true;
			return markRailClickRows(this, rows);
		} catch {
			this[EXECUTION_RENDERED_KEY] = true;
			return original.call(this, width);
		}
	});
}

export async function installExecutionRails(): Promise<void> {
	const theme = await resolveTheme();
	executionRailLifecycle.activate((currentStore) => {
		currentStore.theme = theme;
	});

	for (const ctor of await getExecutionConstructors()) {
		patchExecutionSetExpanded(executionRailLifecycle, ctor);
		patchRender(ctor);
	}
	await patchRailSectionClickHandling(executionRailLifecycle);
}

export function uninstallExecutionRails(): void {
	executionRailLifecycle.deactivate();
	clearRailClickRegistry();
}
