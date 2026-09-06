import { BashExecutionComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { MouseRegion, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ThemeLike } from "../../config";
import { createPatchLifecycle } from "../../core/patching";
import {
	handleRailSectionClickToggle,
	resolveRailSection,
	canToggleRailSection,
} from "../../rail/rail-section";
import { renderExecutionRail } from "./execution-rail";
import {
	EXECUTION_RENDERED_KEY,
	RAIL_RENDER_CONTENT_OFFSET_KEY,
	RAIL_RENDER_PRESENTATION_KEY,
	TOOL_RAIL_CACHE_KEY,
	patchExecutionSetExpanded,
	type ExecutionRailPatchStore,
	type RenderableCtor,
} from "./execution-collapse";
import { isBashExecution } from "./bash-execution";

type ExecutionRailLifecycleStore = Omit<ExecutionRailPatchStore, "active" | "targets"> & { generation: number };
const executionRailLifecycle = createPatchLifecycle<ExecutionRailLifecycleStore>("execution-rail-patch", () => ({ generation: 0 }));
const getExecutionRailPatchStore = () => executionRailLifecycle.state();

const RAIL_DISPLAY_REFRESH_KEY = Symbol.for("pi-rail-ui.execution-display-refresh");

/**
 * Rail-aware fallback for `ToolExecutionComponent.createResultRegion`.
 *
 * The public `MouseRegion(child, fallback)` contract gives the inner renderer
 * control (links, buttons, custom mouse regions) the first chance to consume a
 * click; only when nothing does does this fallback run. While Rail is active it
 * delegates to the shared section toggle so clickToToggle config and the scoped
 * scroll anchor apply. When Rail is off it restores the native toggle.
 */
function handleExecutionResultRegionClick(owner: any, event: TuiMouseEvent): TuiMouseEventResult | undefined {
	const currentStore = getExecutionRailPatchStore();
	if (!currentStore.active) {
		if (!owner.result || event.type !== "click" || event.button !== "left") return undefined;
		owner.setExpanded(!owner.expanded);
		return { handled: true };
	}
	return handleRailSectionClickToggle(owner, event, true);
}

/**
 * Component-level mouse ownership for execution rails.
 *
 * Renderer tools rendering native rows translate every phase into content space
 * and delegate to the native chain, so child controls (links, buttons, custom
 * mouse regions) stay interactive and the render-time mouse layout matches.
 * Generic text tools, bash, Rail's simple-collapsed preview rows, and the rail
 * surface column itself have no hit-testable native children: a left click is
 * owned by Rail (config-guarded whole-block toggle), while other phases return
 * undefined so Pi's selection/scroll pipeline handles them.
 */
function handleExecutionMouseEvent(
	component: any,
	event: TuiMouseEvent,
	dispatchNative: () => unknown,
): TuiMouseEventResult | undefined {
	const section = resolveRailSection(component);
	const toggleable = Boolean(section && canToggleRailSection(section));
	const rendererBased = component.hasRendererDefinition?.() === true;
	const contentOffset = Number(component[RAIL_RENDER_CONTENT_OFFSET_KEY]) || 0;
	const nativeRows = rendererBased && component[RAIL_RENDER_PRESENTATION_KEY] !== "simple" && event.x >= contentOffset;

	if (!nativeRows) {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (!toggleable) return { handled: true };
		return handleRailSectionClickToggle(component, event, false);
	}

	return dispatchNative() as TuiMouseEventResult | undefined;
}

function patchRender(ctor: RenderableCtor): void {
	executionRailLifecycle.patchMethod(ctor, "render", (original) => function patchedExecutionRender(this: any, width: number): string[] {
		const currentStore = getExecutionRailPatchStore();
		if (!currentStore.active) return original.call(this, width);
		try {
			ensureRailResultRegions(this, currentStore);
			const rows = renderExecutionRail(this, width, original, currentStore);
			this[EXECUTION_RENDERED_KEY] = true;
			return rows;
		} catch {
			this[EXECUTION_RENDERED_KEY] = true;
			return original.call(this, width);
		}
	});
}

/**
 * Rebuild result regions once per install for components that were built before
 * the `createResultRegion` hook was installed, so their regions become
 * Rail-aware without refreshing every frame.
 */
function ensureRailResultRegions(component: any, store: ExecutionRailLifecycleStore): void {
	if (isBashExecution(component)) return;
	if (typeof component.createResultRegion !== "function" || typeof component.updateDisplay !== "function") return;
	if (component[RAIL_DISPLAY_REFRESH_KEY] === store.generation) return;
	try {
		component.updateDisplay();
	} catch {
		// No stamp is written on failure, so the next render retries the refresh.
		return;
	}
	// Drop a stale Rail row cache so a re-enabled instance renders fresh rows
	// instead of returning old cached output whose native mouse layout points at
	// the pre-refresh regions.
	delete component[TOOL_RAIL_CACHE_KEY];
	component[RAIL_DISPLAY_REFRESH_KEY] = store.generation;
}

function patchCreateResultRegion(): void {
	executionRailLifecycle.patchMethod(
		ToolExecutionComponent as unknown as { prototype: any },
		"createResultRegion",
		() => function patchedCreateResultRegion(this: any, child: Component): MouseRegion {
			return new MouseRegion(child, (event: TuiMouseEvent) => handleExecutionResultRegionClick(this, event));
		},
	);
}

function patchHandleMouse(ctor: RenderableCtor): void {
	executionRailLifecycle.patchMethod(ctor, "handleMouse", (original) => function patchedExecutionHandleMouse(this: any, event: TuiMouseEvent): unknown {
		const currentStore = getExecutionRailPatchStore();
		if (!currentStore.active) return original.call(this, event);
		const result = handleExecutionMouseEvent(this, event, () => {
			// Translate the Rail surface inset into content space for every native
			// phase so the native chain matches the render-time mouse layout
			// instead of re-rendering at the full surface width.
			const contentOffset = Number(this[RAIL_RENDER_CONTENT_OFFSET_KEY]) || 0;
			const nativeEvent = contentOffset > 0 && event.x >= contentOffset
				? { ...event, x: event.x - contentOffset, width: Math.max(1, event.width - contentOffset) }
				: event;
			return original.call(this, nativeEvent);
		});
		return result;
	});
}

export async function installExecutionRails(theme: ThemeLike): Promise<void> {
	executionRailLifecycle.activate((currentStore) => {
		currentStore.theme = theme;
		currentStore.generation = (currentStore.generation ?? 0) + 1;
	});

	patchCreateResultRegion();
	for (const ctor of [
		ToolExecutionComponent as unknown as RenderableCtor,
		BashExecutionComponent as unknown as RenderableCtor,
	]) {
		patchExecutionSetExpanded(executionRailLifecycle, ctor);
		patchRender(ctor);
		patchHandleMouse(ctor);
	}
}

export function uninstallExecutionRails(): void {
	executionRailLifecycle.deactivate();
}
