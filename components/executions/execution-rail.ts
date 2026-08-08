import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { railSectionConfig, type ThemeLike } from "../../config";
import { stripAnsi } from "../../core/utils";
import { collapseHint } from "../../rail/rail-section";
import { cachedRender } from "../../rail/render-cache";
import { bashExecutionSurfaceForTheme } from "../../rail/rail-surface";
import { isBashExecution } from "./bash-execution";
import {
	applyDefaultAutoCollapse,
	applyToolHintBackground,
	bashOutputLines,
	collapsedExecutionRows,
	collapsedPreviewLimit,
	collapsedSimpleRows,
	executionHiddenLineCount,
	fg,
	renderedChildLines,
	TOOL_RAIL_CACHE_KEY,
	type ExecutionRailPatchStore,
} from "./execution-collapse";

const BASH_SURFACE_CACHE_KEY = Symbol.for("pi-rail-ui.bash-surface-cache");
const TOOL_COLLAPSED_CONTENT_PADDING = 1;

function renderBashWithoutSurface(component: any, width: number, originalRender: (width: number) => string[]): string[] {
	applyDefaultAutoCollapse(component, "bashExecution", () => originalRender.call(component, width));
	return originalRender.call(component, width);
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

function collapsedBashSimpleRows(component: any, theme: ThemeLike | undefined): string[] {
	const command = String(component.command ?? component.getCommand?.() ?? "...");
	return collapsedSimpleRows(
		fg(theme, "bashMode", "bash"),
		fg(theme, "bashMode", `$ ${command}`),
		executionHiddenLineCount(component, "bashExecution"),
		theme,
	);
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

function renderBashExecutionRail(
	component: any,
	width: number,
	originalRender: (width: number) => string[],
	store: ExecutionRailPatchStore,
): string[] {
	const surface = bashExecutionSurfaceForTheme(store.theme);
	if (width < surface.minRenderableWidth()) return renderBashWithoutSurface(component, width, originalRender);
	const contentWidth = surface.contentWidth(width);
	const simpleMode = railSectionConfig("bashExecution").collapsedRenderMode === "simple";
	applyDefaultAutoCollapse(component, "bashExecution", () => renderedChildLines(component.contentContainer, contentWidth), { avoidExpandedRender: simpleMode });
	const signature = bashRenderSignature(component, width, contentWidth);

	if (simpleMode && !component.expanded) {
		return cachedRender(component, BASH_SURFACE_CACHE_KEY, signature, () =>
			collapsedBashSimpleRows(component, store.theme).map((line) => line ? surface.renderSurfaceRow(width, line) : line),
		);
	}

	return cachedRender(component, BASH_SURFACE_CACHE_KEY, signature, () => {
		const directPreview = collapsedBashPreviewRows(component, contentWidth, store.theme);
		const lines = directPreview ?? (() => {
			const content = component.contentContainer?.render?.(contentWidth);
			return normalizeCollapsedBashPreview(component, Array.isArray(content) ? content : originalRender.call(component, contentWidth), contentWidth, store.theme);
		})();
		return lines.map((line) => surface.renderSurfaceRow(width, line));
	});
}

function shouldApplyGenericToolCollapse(component: any): boolean {
	try {
		return component?.hasRendererDefinition?.() !== true;
	} catch {
		return true;
	}
}

function displayPath(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const home = process.env["HOME"];
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

function collapsedToolSimpleRows(component: any, contentWidth: number, theme: ThemeLike | undefined): string[] {
	const rows = collapsedSimpleRows(toolTitle(component, theme), toolDetail(component, theme), executionHiddenLineCount(component, "toolExecution"), theme);
	const contentPadding = " ".repeat(TOOL_COLLAPSED_CONTENT_PADDING);
	return rows.map((line) => line ? applyToolHintBackground(component, `${contentPadding}${line}`, contentWidth, theme) : line);
}

function renderToolExecutionRail(
	component: any,
	width: number,
	originalRender: (width: number) => string[],
	store: ExecutionRailPatchStore,
): string[] {
	const kind = "toolExecution";
	const config = railSectionConfig(kind);
	const simpleMode = config.collapsedRenderMode === "simple";
	applyDefaultAutoCollapse(component, kind, () => originalRender.call(component, width), { avoidExpandedRender: simpleMode });
	const cacheable = Boolean(component.result && component.isPartial === false && (!Array.isArray(component.imageComponents) || component.imageComponents.length === 0));
	if (cacheable) {
		const signature = [width, component.expanded ? 1 : 0, simpleMode ? 1 : 0].join("\u001f");
		return cachedRender(component, TOOL_RAIL_CACHE_KEY, signature, () => {
			if (simpleMode && !component.expanded) return collapsedToolSimpleRows(component, width, store.theme);
			const renderedRows = originalRender.call(component, width);
			return shouldApplyGenericToolCollapse(component)
				? collapsedExecutionRows(component, kind, renderedRows, width, store.theme)
				: renderedRows;
		}, { result: component.result, args: component.args });
	}

	if (simpleMode && !component.expanded) {
		return collapsedToolSimpleRows(component, width, store.theme);
	}

	const renderedRows = originalRender.call(component, width);
	return shouldApplyGenericToolCollapse(component)
		? collapsedExecutionRows(component, kind, renderedRows, width, store.theme)
		: renderedRows;
}

export function renderExecutionRail(
	component: any,
	width: number,
	originalRender: (width: number) => string[],
	store: ExecutionRailPatchStore,
): string[] {
	return isBashExecution(component)
		? renderBashExecutionRail(component, width, originalRender, store)
		: renderToolExecutionRail(component, width, originalRender, store);
}
