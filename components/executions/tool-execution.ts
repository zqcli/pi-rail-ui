import { BashExecutionComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { railSectionConfig, type ThemeLike } from "../../config";
import { createStore, resolveNativePiExport, restorePrototypePatches } from "../../core/patching";
import { renderLinesWithGap } from "../../rail/rail-gap";
import { cachedRender } from "../../rail/render-cache";
import { isBashExecution, renderBashExecutionRail } from "./bash-execution";
import {
	applyDefaultAutoCollapse,
	applyToolHintBackground,
	collapsedExecutionRows,
	collapsedTitleRows,
	executionHiddenLineCount,
	EXECUTION_RENDERED_KEY,
	fg,
	patchExecutionSetExpanded,
	TOOL_RAIL_CACHE_KEY,
	type ExecutionRailPatchStore,
	type RenderableCtor,
} from "./execution-collapse";

const getExecutionRailPatchStore = createStore<ExecutionRailPatchStore>("execution-rail-patch", () => ({
	active: false,
	targets: [],
}));

function shouldApplyGenericToolCollapse(component: any): boolean {
	try {
		return component?.hasRendererDefinition?.() !== true;
	} catch {
		return true;
	}
}

function displayPath(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const home = process.env.HOME;
	return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function formatRange(args: any): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const start = args.offset ?? 1;
	const end = args.limit !== undefined ? start + args.limit - 1 : "";
	return `:${start}${end ? `-${end}` : ""}`;
}

function compactArgs(args: any): string {
	try {
		const text = JSON.stringify(args ?? {});
		return text && text !== "{}" ? text : "...";
	} catch {
		return "...";
	}
}

function toolTitle(component: any, theme: ThemeLike | undefined): string {
	return fg(theme, "toolTitle", String(component?.toolName ?? "tool"));
}

function toolDetail(component: any, theme: ThemeLike | undefined): string {
	const name = String(component?.toolName ?? "tool");
	const args = component?.args ?? {};
	const path = displayPath(args.path ?? args.file_path);
	if (name === "bash") return fg(theme, "toolOutput", `$ ${String(args.command ?? "...")}`);
	if (name === "read" && path) return `${fg(theme, "accent", path)}${formatRange(args)}`;
	if ((name === "write" || name === "edit" || name === "ls") && path) return fg(theme, "accent", path);
	if (name === "grep") return `${fg(theme, "toolOutput", String(args.pattern ?? "..."))}${path ? ` in ${fg(theme, "accent", path)}` : ""}`;
	if (name === "find") return `${fg(theme, "toolOutput", String(args.pattern ?? "..."))}${path ? ` in ${fg(theme, "accent", path)}` : ""}`;
	return fg(theme, "toolOutput", compactArgs(args));
}

function collapsedToolTitleRows(component: any, contentWidth: number, theme: ThemeLike | undefined): string[] {
	const rows = collapsedTitleRows(toolTitle(component, theme), toolDetail(component, theme), executionHiddenLineCount(component, "toolExecution"), theme);
	return rows.map((line) => line ? applyToolHintBackground(component, line, contentWidth, theme) : line);
}

function renderToolExecutionRail(
	component: any,
	width: number,
	originalRender: (width: number) => string[],
	store: ExecutionRailPatchStore,
): string[] {
	const kind = "toolExecution";
	const config = railSectionConfig(kind);
	const gap = config.layout.leftWindowGapWidth;
	const normalizedGap = Math.max(0, Math.round(gap));
	const innerWidth = normalizedGap <= 0 || width <= normalizedGap + 1 ? width : Math.max(1, width - normalizedGap);
	const titleMode = config.collapsedRenderMode === "title";
	applyDefaultAutoCollapse(component, kind, () => originalRender.call(component, innerWidth), { avoidExpandedRender: titleMode });

	if (titleMode && !component.expanded) {
		return renderLinesWithGap(width, gap, () => collapsedToolTitleRows(component, innerWidth, store.theme));
	}

	const cacheable = Boolean(component.result && component.isPartial === false && (!Array.isArray(component.imageComponents) || component.imageComponents.length === 0));
	if (cacheable) {
		const signature = [width, innerWidth, component.expanded ? 1 : 0].join("\u001f");
		return cachedRender(component, TOOL_RAIL_CACHE_KEY, signature, () => {
			const renderedRows = originalRender.call(component, innerWidth);
			const innerRows = shouldApplyGenericToolCollapse(component)
				? collapsedExecutionRows(component, kind, renderedRows, innerWidth, store.theme)
				: renderedRows;
			return renderLinesWithGap(width, gap, () => innerRows);
		}, { result: component.result, args: component.args });
	}

	const renderedRows = originalRender.call(component, innerWidth);
	const innerRows = shouldApplyGenericToolCollapse(component)
		? collapsedExecutionRows(component, kind, renderedRows, innerWidth, store.theme)
		: renderedRows;
	return renderLinesWithGap(width, gap, () => innerRows);
}

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
			const rows = isBashExecution(this)
				? renderBashExecutionRail(this, width, original, currentStore)
				: renderToolExecutionRail(this, width, original, currentStore);
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
