import { BashExecutionComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ThemeLike } from "../../config";
import { createPatchLifecycle } from "../../core/patching";
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

export async function installExecutionRails(theme: ThemeLike): Promise<void> {
	executionRailLifecycle.activate((currentStore) => {
		currentStore.theme = theme;
	});

	for (const ctor of [
		ToolExecutionComponent as unknown as RenderableCtor,
		BashExecutionComponent as unknown as RenderableCtor,
	]) {
		patchExecutionSetExpanded(executionRailLifecycle, ctor);
		patchRender(ctor);
	}
	await patchRailSectionClickHandling(executionRailLifecycle);
}

export function uninstallExecutionRails(): void {
	executionRailLifecycle.deactivate();
	clearRailClickRegistry();
}
