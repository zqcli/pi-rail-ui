import { BashExecutionComponent, ToolExecutionComponent, keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { railSectionConfig, type ThemeLike } from "../config";
import { renderLinesWithGap } from "../ui/gap";
import { restorePrototypePatches, resolveNativePiExport, type PrototypePatchTarget } from "../patching";
import { markRailSectionManuallyToggled, wasRailSectionManuallyToggled } from "../ui/rail-section";
import { bashExecutionSurfaceForTheme } from "../ui/rail-surface";
import { padToWidth, stripAnsi } from "../utils";

type RenderableCtor = { prototype: { render(width: number): string[]; setExpanded?(expanded: boolean): void } };

type ToolExecutionGapPatchStore = {
	active: boolean;
	targets: PrototypePatchTarget[];
	theme?: ThemeLike;
};

const TOOL_EXECUTION_GAP_PATCH_KEY = Symbol.for("pi-rail-ui.tool-execution-gap-patch");
const BASH_PREVIEW_LINES = 20;
const AUTO_COLLAPSE_RENDERING_KEY = Symbol.for("pi-rail-ui.execution-auto-collapse-rendering");
const EXECUTION_RENDERED_KEY = Symbol.for("pi-rail-ui.execution-rendered");
const BASH_SURFACE_CACHE_KEY = Symbol.for("pi-rail-ui.bash-surface-cache");
const TOOL_GAP_CACHE_KEY = Symbol.for("pi-rail-ui.tool-gap-cache");
const AUTO_COLLAPSE_SIGNATURE_KEY = Symbol.for("pi-rail-ui.execution-auto-collapse-signature");

function getToolExecutionGapPatchStore(): ToolExecutionGapPatchStore {
	const globalStore = globalThis as typeof globalThis & { [TOOL_EXECUTION_GAP_PATCH_KEY]?: Partial<ToolExecutionGapPatchStore> };
	const store = globalStore[TOOL_EXECUTION_GAP_PATCH_KEY] ?? {};
	store.active ??= false;
	store.targets ??= [];
	globalStore[TOOL_EXECUTION_GAP_PATCH_KEY] = store;
	return store as ToolExecutionGapPatchStore;
}

function isBashExecution(component: any): boolean {
	return component?.constructor?.name === "BashExecutionComponent" || typeof component?.getCommand === "function";
}

function shouldApplyGenericToolCollapse(component: any): boolean {
	try {
		return component?.hasRendererDefinition?.() !== true;
	} catch {
		return true;
	}
}

function collapsedExecutionRows(
	component: any,
	kind: "bashExecution" | "toolExecution",
	rows: string[],
	width: number,
	theme: ThemeLike | undefined,
): string[] {
	const config = railSectionConfig(kind);
	const limit = config.collapsible ? config.autoCollapseAfterRows : undefined;
	if (!limit || component.expanded || rows.length <= limit) return rows;
	const hidden = Math.max(0, rows.length - limit);
	const hint = collapseHint(theme, hidden);
	const renderedHint = kind === "toolExecution" ? applyToolHintBackground(component, hint, width) : hint;
	return [...rows.slice(0, limit), renderedHint];
}

function renderToolWithLeftGap(
	component: any,
	width: number,
	originalRender: (width: number) => string[],
	store: ToolExecutionGapPatchStore,
): string[] {
	const kind = "toolExecution";
	const gap = railSectionConfig(kind).layout.leftWindowGapWidth;
	const normalizedGap = Math.max(0, Math.round(gap));
	const innerWidth = normalizedGap <= 0 || width <= normalizedGap + 1 ? width : Math.max(1, width - normalizedGap);
	applyDefaultAutoCollapse(component, kind, () => originalRender.call(component, innerWidth));

	const cacheable = Boolean(component.result && component.isPartial === false && (!Array.isArray(component.imageComponents) || component.imageComponents.length === 0));
	const cache = component[TOOL_GAP_CACHE_KEY] as { width: number; innerWidth: number; expanded: boolean; result: any; args: any; rows: string[] } | undefined;
	if (cacheable && cache?.width === width && cache.innerWidth === innerWidth && cache.expanded === Boolean(component.expanded) && cache.result === component.result && cache.args === component.args) {
		return cache.rows;
	}

	const renderedRows = originalRender.call(component, innerWidth);
	const innerRows = shouldApplyGenericToolCollapse(component)
		? collapsedExecutionRows(component, kind, renderedRows, innerWidth, store.theme)
		: renderedRows;
	const rows = renderLinesWithGap(width, gap, () => innerRows);
	if (cacheable) component[TOOL_GAP_CACHE_KEY] = { width, innerWidth, expanded: Boolean(component.expanded), result: component.result, args: component.args, rows };
	return rows;
}

function renderWithLeftGap(component: any, width: number, originalRender: (width: number) => string[]): string[] {
	const kind = isBashExecution(component) ? "bashExecution" : "toolExecution";
	if (kind === "toolExecution") return renderToolWithLeftGap(component, width, originalRender, getToolExecutionGapPatchStore());
	const gap = railSectionConfig(kind).layout.leftWindowGapWidth;
	return renderLinesWithGap(width, gap, (innerWidth) => {
		applyDefaultAutoCollapse(component, kind, () => originalRender.call(component, innerWidth));
		return originalRender.call(component, innerWidth);
	});
}

function bashOutputLines(component: any): string[] {
	if (Array.isArray(component.outputLines)) return component.outputLines;
	const output = component.getOutput?.();
	return typeof output === "string" && output.length > 0 ? output.split("\n") : [];
}

function fg(theme: ThemeLike | undefined, color: string, value: string): string {
	try {
		return theme?.fg(color, value) ?? value;
	} catch {
		return value;
	}
}

function collapseHint(theme: ThemeLike | undefined, hiddenLineCount: number): string {
	const prefix = fg(theme, "muted", `... (${Math.max(0, hiddenLineCount)} earlier lines,`);
	try {
		return `${prefix} ${keyHint("app.tools.expand", "to expand")})`;
	} catch {
		return `${prefix} ctrl+o to expand)`;
	}
}

function applyToolHintBackground(component: any, hint: string, width: number): string {
	const bg = component?.contentText?.customBgFn;
	return typeof bg === "function" ? bg(padToWidth(hint, width)) : hint;
}

function renderedChildLines(child: any, width: number): string[] {
	const lines = child?.render?.(width);
	return Array.isArray(lines) ? lines : [];
}

function collapsedPreviewLimit(kind: "bashExecution" | "toolExecution"): number {
	return railSectionConfig(kind).autoCollapseAfterRows ?? BASH_PREVIEW_LINES;
}

function lineCount(text: string | undefined): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function estimatedExpandedRows(component: any, kind: "bashExecution" | "toolExecution"): number | undefined {
	if (kind === "bashExecution") {
		const commandRows = lineCount(typeof component.command === "string" ? `$ ${component.command}` : component.getCommand?.());
		const statusRows = component.status === "running" ? 1 : 1;
		return Math.max(1, commandRows) + bashOutputLines(component).length + statusRows;
	}

	try {
		const argsRows = component.args === undefined ? 0 : lineCount(JSON.stringify(component.args, null, 2));
		const outputRows = lineCount(component.getTextOutput?.());
		return 1 + argsRows + outputRows;
	} catch {
		return undefined;
	}
}

function autoCollapseSignature(component: any, kind: "bashExecution" | "toolExecution", limit: number): string | undefined {
	if (kind === "bashExecution") {
		const outputLines = bashOutputLines(component);
		return [
			kind,
			limit,
			component.status ?? "",
			component.exitCode ?? "",
			component.command ?? component.getCommand?.() ?? "",
			outputLines.length,
			outputLines[outputLines.length - 1] ?? "",
		].join("\u001f");
	}
	if (!component.result || component.isPartial !== false) return undefined;
	return [kind, limit, component.toolCallId ?? "", component.toolName ?? ""].join("\u001f");
}

function withTemporaryExpanded<T>(component: any, expanded: boolean, render: () => T): T {
	const previous = Boolean(component.expanded);
	if (previous !== expanded) component.setExpanded?.(expanded);
	try {
		return render();
	} finally {
		if (Boolean(component.expanded) !== previous) component.setExpanded?.(previous);
	}
}

function applyDefaultAutoCollapse(
	component: any,
	kind: "bashExecution" | "toolExecution",
	renderExpandedRows: () => string[],
): void {
	if (component?.[AUTO_COLLAPSE_RENDERING_KEY] || wasRailSectionManuallyToggled(component)) return;
	const config = railSectionConfig(kind);
	const limit = config.collapsible ? config.autoCollapseAfterRows : undefined;
	if (!limit || typeof component?.setExpanded !== "function") return;

	const signature = autoCollapseSignature(component, kind, limit);
	const previousAuto = component[AUTO_COLLAPSE_SIGNATURE_KEY] as { signature?: string; result?: any; args?: any } | undefined;
	if (signature && previousAuto?.signature === signature && previousAuto.result === component.result && previousAuto.args === component.args) return;

	const estimatedRows = estimatedExpandedRows(component, kind);
	if (estimatedRows !== undefined) {
		component[AUTO_COLLAPSE_RENDERING_KEY] = true;
		try {
			const shouldExpand = estimatedRows <= limit;
			if (Boolean(component.expanded) !== shouldExpand) component.setExpanded(shouldExpand);
			if (signature) component[AUTO_COLLAPSE_SIGNATURE_KEY] = { signature, result: component.result, args: component.args };
		} finally {
			component[AUTO_COLLAPSE_RENDERING_KEY] = false;
		}
		return;
	}

	component[AUTO_COLLAPSE_RENDERING_KEY] = true;
	try {
		const expandedRows = withTemporaryExpanded(component, true, renderExpandedRows);
		const shouldExpand = expandedRows.length <= limit;
		if (Boolean(component.expanded) !== shouldExpand) component.setExpanded(shouldExpand);
		if (signature) component[AUTO_COLLAPSE_SIGNATURE_KEY] = { signature, result: component.result, args: component.args };
	} finally {
		component[AUTO_COLLAPSE_RENDERING_KEY] = false;
	}
}

function collapsedBashPreviewRows(component: any, contentWidth: number, theme: ThemeLike | undefined): string[] | undefined {
	if (component.expanded) return undefined;

	const outputLines = bashOutputLines(component);
	const previewLimit = collapsedPreviewLimit("bashExecution");
	const hiddenLineCount = outputLines.length - previewLimit;
	if (hiddenLineCount <= 0) return undefined;

	const children = Array.isArray(component.contentContainer?.children) ? component.contentContainer.children : [];
	const headerLines = renderedChildLines(children[0], contentWidth);
	if (headerLines.length === 0) return undefined;

	const styledOutput = outputLines
		.slice(0, previewLimit)
		.map((line) => fg(theme, "muted", line))
		.join("\n");
	const preview = truncateToVisualLines(styledOutput, previewLimit, contentWidth, 1).visualLines;
	const trailingLines = children
		.slice(2)
		.flatMap((child: any) => renderedChildLines(child, contentWidth))
		.filter((line: string) => !/^\s*\.\.\.\s+\d+\s+more lines/u.test(stripAnsi(line)));

	// Pi's native collapsed bash preview renders the tail rows. Rebuild the
	// collapsed content from children instead of slicing rendered rows, so long
	// command headers remain at the top and the preview starts from output line 1.
	return [...headerLines, "", ...preview, collapseHint(theme, hiddenLineCount), ...trailingLines];
}

function normalizeCollapsedBashPreview(
	component: any,
	lines: string[],
	contentWidth: number,
	theme: ThemeLike | undefined,
): string[] {
	return collapsedBashPreviewRows(component, contentWidth, theme) ?? lines;
}

function bashRenderSignature(component: any, width: number, contentWidth: number): string {
	const outputLines = bashOutputLines(component);
	return [
		width,
		contentWidth,
		component.expanded ? 1 : 0,
		component.status ?? "",
		component.exitCode ?? "",
		component.command ?? component.getCommand?.() ?? "",
		outputLines.length,
		outputLines[0] ?? "",
		outputLines[outputLines.length - 1] ?? "",
		component.truncationResult?.truncated ? 1 : 0,
		component.fullOutputPath ?? "",
		collapsedPreviewLimit("bashExecution"),
	].join("\u001f");
}

function renderBashWithRailSurface(
	component: any,
	width: number,
	originalRender: (width: number) => string[],
	store: ToolExecutionGapPatchStore,
): string[] {
	const surface = bashExecutionSurfaceForTheme(store.theme);
	if (width < surface.minRenderableWidth()) return renderWithLeftGap(component, width, originalRender);
	const contentWidth = surface.contentWidth(width);
	applyDefaultAutoCollapse(component, "bashExecution", () => renderedChildLines(component.contentContainer, contentWidth));

	const signature = bashRenderSignature(component, width, contentWidth);
	const cache = component[BASH_SURFACE_CACHE_KEY] as { signature: string; rows: string[] } | undefined;
	if (cache?.signature === signature) return cache.rows;

	const directPreview = collapsedBashPreviewRows(component, contentWidth, store.theme);
	const lines = directPreview ?? (() => {
		const content = component.contentContainer?.render?.(contentWidth);
		return normalizeCollapsedBashPreview(component, Array.isArray(content) ? content : originalRender.call(component, contentWidth), contentWidth, store.theme);
	})();
	const rows = lines.map((line) => surface.renderSurfaceRow(width, line));
	component[BASH_SURFACE_CACHE_KEY] = { signature, rows };
	return rows;
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

function patchRender(ctor: RenderableCtor, store: ToolExecutionGapPatchStore): void {
	if (store.targets.some((target) => target.ctor === ctor && target.methodName === "render")) return;
	const original = ctor.prototype.render;
	ctor.prototype.render = function patchedExecutionRender(this: any, width: number): string[] {
		const currentStore = getToolExecutionGapPatchStore();
		if (!currentStore.active) return original.call(this, width);
		try {
			const rows = isBashExecution(this) ? renderBashWithRailSurface(this, width, original, currentStore) : renderWithLeftGap(this, width, original);
			this[EXECUTION_RENDERED_KEY] = true;
			return rows;
		} catch {
			this[EXECUTION_RENDERED_KEY] = true;
			return original.call(this, width);
		}
	};
	store.targets.push({ ctor, methodName: "render", original });
}

function patchSetExpanded(ctor: RenderableCtor, store: ToolExecutionGapPatchStore): void {
	if (store.targets.some((target) => target.ctor === ctor && target.methodName === "setExpanded")) return;
	const original = ctor.prototype.setExpanded;
	if (typeof original !== "function") return;
	ctor.prototype.setExpanded = function patchedExecutionSetExpanded(this: any, expanded: boolean): void {
		if (!this?.[AUTO_COLLAPSE_RENDERING_KEY] && this?.[EXECUTION_RENDERED_KEY]) markRailSectionManuallyToggled(this);
		return original.call(this, expanded);
	};
	store.targets.push({ ctor, methodName: "setExpanded", original });
}

export async function installToolExecutionGap(): Promise<void> {
	const store = getToolExecutionGapPatchStore();
	store.active = true;
	store.theme = await resolveTheme();

	for (const ctor of await getExecutionConstructors()) {
		patchSetExpanded(ctor, store);
		patchRender(ctor, store);
	}
}

export function uninstallToolExecutionGap(): void {
	const store = getToolExecutionGapPatchStore();
	store.active = false;
	restorePrototypePatches(store.targets);
	store.targets = [];
}
