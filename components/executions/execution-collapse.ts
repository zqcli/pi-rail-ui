import { keyHint } from "@earendil-works/pi-coding-agent";
import { railSectionConfig, type ThemeLike } from "../../config";
import { collapseHint, markRailSectionManuallyToggled, wasRailSectionManuallyToggled } from "../../rail/rail-section";
import { padToWidth } from "../../core/utils";

export type ExecutionKind = "bashExecution" | "toolExecution";
export type RenderableCtor = { prototype: { render(width: number): string[]; setExpanded?(expanded: boolean): void } };
export type ExecutionRailPatchStore = {
	active: boolean;
	targets: Array<{ ctor: any; methodName: string; original: any }>;
	theme?: ThemeLike | undefined;
};

export const BASH_PREVIEW_LINES = 20;
export const AUTO_COLLAPSE_RENDERING_KEY = Symbol.for("pi-rail-ui.execution-auto-collapse-rendering");
export const EXECUTION_RENDERED_KEY = Symbol.for("pi-rail-ui.execution-rendered");
export const TOOL_RAIL_CACHE_KEY = Symbol.for("pi-rail-ui.tool-rail-cache");
const AUTO_COLLAPSE_SIGNATURE_KEY = Symbol.for("pi-rail-ui.execution-auto-collapse-signature");

export function bashOutputLines(component: any): string[] {
	if (Array.isArray(component.outputLines)) return component.outputLines;
	const output = component.getOutput?.();
	return typeof output === "string" && output.length > 0 ? output.split("\n") : [];
}

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

export function collapsedPreviewLimit(kind: ExecutionKind): number {
	return railSectionConfig(kind).autoCollapseAfterRows ?? BASH_PREVIEW_LINES;
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

function estimatedExpandedRows(component: any, kind: ExecutionKind): number | undefined {
	if (kind === "bashExecution") {
		const commandRows = lineCount(typeof component.command === "string" ? `$ ${component.command}` : component.getCommand?.());
		const statusRows = component.status === "running" ? 1 : 1;
		return Math.max(1, commandRows) + bashOutputLines(component).length + statusRows;
	}

	if (component?.hasRendererDefinition?.() === true) return undefined;

	try {
		const argsRows = component.args === undefined ? 0 : lineCount(JSON.stringify(component.args, null, 2));
		const outputRows = lineCount(component.getTextOutput?.());
		return 1 + argsRows + outputRows;
	} catch {
		return undefined;
	}
}

function autoCollapseSignature(component: any, kind: ExecutionKind, limit: number): string | undefined {
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

function shouldCollapseByDefault(component: any, kind: ExecutionKind): boolean {
	const names = railSectionConfig(kind).collapseByDefault;
	if (!names?.length) return false;
	const name = typeof component?.toolName === "string" ? component.toolName : undefined;
	return name !== undefined && names.includes(name);
}

export function applyDefaultAutoCollapse(
	component: any,
	kind: ExecutionKind,
	renderExpandedRows: () => string[],
	options: { avoidExpandedRender?: boolean } = {},
): void {
	if (component?.[AUTO_COLLAPSE_RENDERING_KEY] || wasRailSectionManuallyToggled(component)) return;
	const config = railSectionConfig(kind);
	const limit = config.collapsible ? config.autoCollapseAfterRows : undefined;
	const forceCollapse = shouldCollapseByDefault(component, kind);
	if (!limit && !forceCollapse) return;
	if (typeof component?.setExpanded !== "function") return;

	const signature = autoCollapseSignature(component, kind, limit ?? 0);
	const previousAuto = component[AUTO_COLLAPSE_SIGNATURE_KEY] as { signature?: string; result?: any; args?: any } | undefined;
	if (signature && previousAuto?.signature === signature && previousAuto.result === component.result && previousAuto.args === component.args) return;

	if (options.avoidExpandedRender && component.expanded) {
		component[AUTO_COLLAPSE_RENDERING_KEY] = true;
		try {
			// Preserve user/global expansion in simple mode during streaming updates.
			if (signature) component[AUTO_COLLAPSE_SIGNATURE_KEY] = { signature, result: component.result, args: component.args };
		} finally {
			component[AUTO_COLLAPSE_RENDERING_KEY] = false;
		}
		return;
	}

	const estimatedRows = estimatedExpandedRows(component, kind);
	if (estimatedRows !== undefined) {
		component[AUTO_COLLAPSE_RENDERING_KEY] = true;
		try {
			const shouldExpand = !forceCollapse && limit !== undefined && estimatedRows <= limit;
			if (Boolean(component.expanded) !== shouldExpand) component.setExpanded(shouldExpand);
			if (signature) component[AUTO_COLLAPSE_SIGNATURE_KEY] = { signature, result: component.result, args: component.args };
		} finally {
			component[AUTO_COLLAPSE_RENDERING_KEY] = false;
		}
		return;
	}

	if (options.avoidExpandedRender) {
		component[AUTO_COLLAPSE_RENDERING_KEY] = true;
		try {
			// Simple mode should avoid rendering expanded content just to decide
			// collapse state. Keep the current expanded state so a user click during
			// streaming is not immediately folded again by the next partial update.
			if (signature) component[AUTO_COLLAPSE_SIGNATURE_KEY] = { signature, result: component.result, args: component.args };
		} finally {
			component[AUTO_COLLAPSE_RENDERING_KEY] = false;
		}
		return;
	}

	component[AUTO_COLLAPSE_RENDERING_KEY] = true;
	try {
		const expandedRows = withTemporaryExpanded(component, true, renderExpandedRows);
		const shouldExpand = !forceCollapse && limit !== undefined && expandedRows.length <= limit;
		if (Boolean(component.expanded) !== shouldExpand) component.setExpanded(shouldExpand);
		if (signature) component[AUTO_COLLAPSE_SIGNATURE_KEY] = { signature, result: component.result, args: component.args };
	} finally {
		component[AUTO_COLLAPSE_RENDERING_KEY] = false;
	}
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

export function patchExecutionSetExpanded(ctor: RenderableCtor, store: ExecutionRailPatchStore): void {
	if (store.targets.some((target) => target.ctor === ctor && target.methodName === "setExpanded")) return;
	const original = ctor.prototype.setExpanded;
	if (typeof original !== "function") return;
	ctor.prototype.setExpanded = function patchedExecutionSetExpanded(this: any, expanded: boolean): void {
		if (!this?.[AUTO_COLLAPSE_RENDERING_KEY] && this?.[EXECUTION_RENDERED_KEY]) markRailSectionManuallyToggled(this);
		return original.call(this, expanded);
	};
	store.targets.push({ ctor, methodName: "setExpanded", original });
}
