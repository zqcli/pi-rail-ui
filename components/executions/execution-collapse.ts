import { keyHint } from "@earendil-works/pi-coding-agent";
import { railSectionConfig, type ThemeLike } from "../../config";
import { collapseHint, markRailSectionManuallyToggled } from "../../rail/rail-section";
import { padToWidth } from "../../core/utils";
import {
	AUTO_COLLAPSE_RENDERING_KEY,
	bashOutputLines,
} from "./execution-presentation-policy";

export type ExecutionKind = "bashExecution" | "toolExecution";
export type RenderableCtor = { prototype: { render(width: number): string[]; setExpanded?(expanded: boolean): void } };
export type ExecutionRailPatchStore = {
	active: boolean;
	theme?: ThemeLike | undefined;
};
export type ExecutionRailPatcher = {
	patchMethod(
		ctor: { prototype: any } | undefined,
		methodName: string,
		patch: (original: (...args: any[]) => any) => (...args: any[]) => any,
	): boolean;
};

export const EXECUTION_RENDERED_KEY = Symbol.for("pi-rail-ui.execution-rendered");
export const TOOL_RAIL_CACHE_KEY = Symbol.for("pi-rail-ui.tool-rail-cache");
export {
	AUTO_COLLAPSE_RENDERING_KEY,
	BASH_PREVIEW_LINES,
	applyDefaultAutoCollapse,
	bashOutputLines,
	collapsedPreviewLimit,
} from "./execution-presentation-policy";

export function fg(theme: ThemeLike | undefined, color: string, value: string): string {
	try {
		return theme?.fg(color, value) ?? value;
	} catch {
		return value;
	}
}

function toolStatusBackgroundName(component: any): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
	if (component?.isPartial !== false) return "toolPendingBg";
	return component?.result?.isError ? "toolErrorBg" : "toolSuccessBg";
}

export function applyToolHintBackground(component: any, hint: string, width: number, theme?: ThemeLike): string {
	const padded = padToWidth(hint, width);
	const themeBg = (theme as any)?.bg;
	if (typeof themeBg === "function") return themeBg.call(theme, toolStatusBackgroundName(component), padded);
	const bg = component?.contentBox?.bgFn ?? component?.contentText?.customBgFn;
	return typeof bg === "function" ? bg(padded) : hint;
}

export function renderedChildLines(child: any, width: number): string[] {
	const lines = child?.render?.(width);
	return Array.isArray(lines) ? lines : [];
}

function lineCount(text: string | undefined): number {
	if (!text) return 0;
	let count = 1;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) count++;
	}
	return count;
}

function stringArgLineCount(value: unknown): number {
	return typeof value === "string" && value.length > 0 ? lineCount(value) : 0;
}

export function executionHiddenLineCount(component: any, kind: ExecutionKind): number {
	if (kind === "bashExecution") return Math.max(0, bashOutputLines(component).length);
	const args = component?.args;
	const textOutputRows = lineCount(component?.getTextOutput?.());
	const contentRows = Math.max(
		stringArgLineCount(args?.content),
		stringArgLineCount(args?.oldText) + stringArgLineCount(args?.newText),
	);
	if (contentRows > 0) return contentRows + textOutputRows;
	const argsRows = args === undefined ? 0 : lineCount(JSON.stringify(args, null, 2));
	return Math.max(0, argsRows + textOutputRows);
}

export function simpleCollapseHint(theme: ThemeLike | undefined, hiddenLineCount: number): string {
	const prefix = theme ? theme.fg("muted", `... (${Math.max(0, hiddenLineCount)} more lines,`) : `... (${Math.max(0, hiddenLineCount)} more lines,`;
	try {
		return `${prefix} ${keyHint("app.tools.expand", "to expand")})`;
	} catch {
		const fallback = theme ? `${theme.fg("dim", "ctrl+o")}${theme.fg("muted", " to expand")}` : "ctrl+o to expand";
		return `${prefix} ${fallback})`;
	}
}

export function collapsedSimpleLine(text: string): string {
	return text.replace(/[\r\n\t\v\f\u2028\u2029]+/gu, " ").replace(/ {2,}/g, " ");
}

export function collapsedSimpleContentRows(
	title: string,
	detail: string,
	hiddenLineCount: number,
	theme: ThemeLike | undefined,
): string[] {
	return [collapsedSimpleLine(title), collapsedSimpleLine(detail), collapsedSimpleLine(simpleCollapseHint(theme, hiddenLineCount))];
}

export function collapsedSimpleRows(
	title: string,
	detail: string,
	hiddenLineCount: number,
	theme: ThemeLike | undefined,
): string[] {
	return ["", ...collapsedSimpleContentRows(title, detail, hiddenLineCount, theme), ""];
}

export function collapsedExecutionRows(
	component: any,
	kind: ExecutionKind,
	rows: string[],
	width: number,
	theme: ThemeLike | undefined,
): string[] {
	const config = railSectionConfig(kind);
	const limit = config.collapsible ? config.autoCollapseAfterRows : undefined;
	if (!limit || component.expanded || rows.length <= limit) return rows;
	const hidden = Math.max(0, rows.length - limit);
	const hint = collapseHint(theme, hidden);
	const renderedHint = kind === "toolExecution" ? applyToolHintBackground(component, hint, width, theme) : hint;
	return [...rows.slice(0, limit), renderedHint];
}

export function patchExecutionSetExpanded(patcher: ExecutionRailPatcher, ctor: RenderableCtor): void {
	patcher.patchMethod(ctor, "setExpanded", (original) => function patchedExecutionSetExpanded(this: any, expanded: boolean): void {
		if (!this?.[AUTO_COLLAPSE_RENDERING_KEY] && this?.[EXECUTION_RENDERED_KEY]) markRailSectionManuallyToggled(this);
		return original.call(this, expanded);
	});
}
