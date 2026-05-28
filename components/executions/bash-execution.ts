import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { railSectionConfig, type ThemeLike } from "../../config";
import { padToWidth, stripAnsi } from "../../core/utils";
import { collapseHint } from "../../rail/rail-section";
import { bashExecutionSurfaceForTheme } from "../../rail/rail-surface";
import { cachedRender } from "../../rail/render-cache";
import {
	applyDefaultAutoCollapse,
	bashOutputLines,
	collapsedPreviewLimit,
	collapsedSimpleRows,
	executionHiddenLineCount,
	fg,
	renderedChildLines,
	type ExecutionRailPatchStore,
} from "./execution-collapse";

const BASH_SURFACE_CACHE_KEY = Symbol.for("pi-rail-ui.bash-surface-cache");

export function isBashExecution(component: any): boolean {
	return component?.constructor?.name === "BashExecutionComponent" || typeof component?.getCommand === "function";
}

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

export function renderBashExecutionRail(
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

	if (simpleMode && !component.expanded) {
		return collapsedBashSimpleRows(component, store.theme).map((line) => line ? surface.renderSurfaceRow(width, line) : line);
	}

	const signature = bashRenderSignature(component, width, contentWidth);
	return cachedRender(component, BASH_SURFACE_CACHE_KEY, signature, () => {
		const directPreview = collapsedBashPreviewRows(component, contentWidth, store.theme);
		const lines = directPreview ?? (() => {
			const content = component.contentContainer?.render?.(contentWidth);
			return normalizeCollapsedBashPreview(component, Array.isArray(content) ? content : originalRender.call(component, contentWidth), contentWidth, store.theme);
		})();
		return lines.map((line) => surface.renderSurfaceRow(width, line));
	});
}
