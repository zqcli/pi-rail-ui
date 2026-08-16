import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import {
	applyTextColor,
	railAnsiForTheme,
	railSectionConfig,
	TOOL_EXECUTION_TEXT_STYLE,
	type ThemeLike,
	type ToolExecutionState,
} from "../../config";
import { stripAnsi } from "../../core/utils";
import { collapseHint } from "../../rail/rail-section";
import { cachedRender } from "../../rail/render-cache";
import { bashExecutionSurfaceForTheme, toolExecutionSurfaceForState } from "../../rail/rail-surface";
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
const TOOL_BACKGROUND_SGR_RE = /\x1b\[(?:4[0-9]|10[0-7]|48(?:(?:;|:)[0-9]*)+)m/g;

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

function toolExecutionState(component: any): ToolExecutionState {
	if (component?.isPartial !== false) return "pending";
	return component?.result?.isError ? "error" : "success";
}

function isImageLineLike(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

function restyleNativeToolForegrounds(line: string, theme?: ThemeLike): string {
	if (!theme) return line;
	for (const [sourceKey, target] of [
		["toolTitle", TOOL_EXECUTION_TEXT_STYLE.title],
		["toolOutput", TOOL_EXECUTION_TEXT_STYLE.output],
	] as const) {
		const source = railAnsiForTheme(theme, { themeKey: sourceKey });
		const replacement = railAnsiForTheme(theme, target);
		if (source && replacement && source !== replacement) line = line.replaceAll(source, replacement);
	}
	return line;
}

function renderToolSurfaceRows(component: any, rows: string[], width: number, theme?: ThemeLike): string[] {
	const surface = toolExecutionSurfaceForState(toolExecutionState(component));
	return rows.map((line) => {
		if (!line || isImageLineLike(line)) return line;
		const foregroundStyled = restyleNativeToolForegrounds(line, theme);
		return surface.renderSurfaceRow(width, foregroundStyled.replace(TOOL_BACKGROUND_SGR_RE, ""));
	});
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
	return applyTextColor(theme, TOOL_EXECUTION_TEXT_STYLE.title, String(component?.toolName ?? "tool"));
}

function toolDetail(component: any, theme: ThemeLike | undefined): string {
	const name = String(component?.toolName ?? "tool");
	const args = component?.args ?? {};
	const path = displayPath(args.path ?? args.file_path);
	const output = (value: string) => applyTextColor(theme, TOOL_EXECUTION_TEXT_STYLE.output, value);
	if (name === "bash") return output(`$ ${String(args.command ?? "...")}`);
	if (name === "read" && path) return output(`${path}${formatRange(args)}`);
	if ((name === "write" || name === "edit" || name === "ls") && path) return output(path);
	if (name === "grep") return output(`${String(args.pattern ?? "...")}${path ? ` in ${path}` : ""}`);
	if (name === "find") return output(`${String(args.pattern ?? "...")}${path ? ` in ${path}` : ""}`);
	return output(compactArgs(args));
}

function collapsedToolSimpleRows(component: any, contentWidth: number, theme: ThemeLike | undefined): string[] {
	const rows = collapsedSimpleRows(toolTitle(component, theme), toolDetail(component, theme), executionHiddenLineCount(component, "toolExecution"), theme);
	const mutedSource = theme ? railAnsiForTheme(theme, { themeKey: "muted" }) : undefined;
	const mutedTarget = theme ? railAnsiForTheme(theme, TOOL_EXECUTION_TEXT_STYLE.muted) : undefined;
	if (mutedSource && mutedTarget && mutedSource !== mutedTarget) {
		const hintIndex = rows.length - 2;
		if (hintIndex > 0) rows[hintIndex] = (rows[hintIndex] ?? "").replaceAll(mutedSource, mutedTarget);
	}
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
	const surface = toolExecutionSurfaceForState(toolExecutionState(component));
	if (width < surface.minRenderableWidth()) return originalRender.call(component, width);
	const contentWidth = surface.contentWidth(width);
	const simpleMode = config.collapsedRenderMode === "simple";
	applyDefaultAutoCollapse(component, kind, () => originalRender.call(component, contentWidth), { avoidExpandedRender: simpleMode });
	const cacheable = Boolean(component.result && component.isPartial === false && (!Array.isArray(component.imageComponents) || component.imageComponents.length === 0));
	if (cacheable) {
		const signature = [width, toolExecutionState(component), component.expanded ? 1 : 0, simpleMode ? 1 : 0].join("\u001f");
		return cachedRender(component, TOOL_RAIL_CACHE_KEY, signature, () => {
			const renderedRows = simpleMode && !component.expanded
				? collapsedToolSimpleRows(component, contentWidth, store.theme)
				: originalRender.call(component, contentWidth);
			const collapsedRows = simpleMode && !component.expanded || !shouldApplyGenericToolCollapse(component)
				? renderedRows
				: collapsedExecutionRows(component, kind, renderedRows, contentWidth, store.theme);
			return renderToolSurfaceRows(component, collapsedRows, width, store.theme);
		}, { result: component.result, args: component.args });
	}

	if (simpleMode && !component.expanded) {
		return renderToolSurfaceRows(component, collapsedToolSimpleRows(component, contentWidth, store.theme), width, store.theme);
	}

	const renderedRows = originalRender.call(component, contentWidth);
	const collapsedRows = shouldApplyGenericToolCollapse(component)
		? collapsedExecutionRows(component, kind, renderedRows, contentWidth, store.theme)
		: renderedRows;
	return renderToolSurfaceRows(component, collapsedRows, width, store.theme);
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
