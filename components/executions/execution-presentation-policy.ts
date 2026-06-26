import { railSectionConfig } from "../../config";
import { wasRailSectionManuallyToggled } from "../../rail/rail-section";
import type { ExecutionKind } from "./execution-collapse";

export const BASH_PREVIEW_LINES = 20;
export const AUTO_COLLAPSE_RENDERING_KEY = Symbol.for("pi-rail-ui.execution-auto-collapse-rendering");
const AUTO_COLLAPSE_SIGNATURE_KEY = Symbol.for("pi-rail-ui.execution-auto-collapse-signature");

export function bashOutputLines(component: any): string[] {
	if (Array.isArray(component.outputLines)) return component.outputLines;
	const output = component.getOutput?.();
	return typeof output === "string" && output.length > 0 ? output.split("\n") : [];
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

function estimatedExpandedRows(component: any, kind: ExecutionKind): number | undefined {
	if (kind === "bashExecution") {
		const commandRows = lineCount(typeof component.command === "string" ? `$ ${component.command}` : component.getCommand?.());
		return Math.max(1, commandRows) + bashOutputLines(component).length + 1;
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

function rememberAutoCollapseSignature(component: any, signature: string | undefined): void {
	if (signature) component[AUTO_COLLAPSE_SIGNATURE_KEY] = { signature, result: component.result, args: component.args };
}

function alreadyAppliedAutoCollapse(component: any, signature: string | undefined): boolean {
	const previousAuto = component[AUTO_COLLAPSE_SIGNATURE_KEY] as { signature?: string; result?: any; args?: any } | undefined;
	return Boolean(signature && previousAuto?.signature === signature && previousAuto.result === component.result && previousAuto.args === component.args);
}

function withAutoCollapseGuard(component: any, apply: () => void): void {
	component[AUTO_COLLAPSE_RENDERING_KEY] = true;
	try {
		apply();
	} finally {
		component[AUTO_COLLAPSE_RENDERING_KEY] = false;
	}
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
	if (alreadyAppliedAutoCollapse(component, signature)) return;

	const estimatedRows = estimatedExpandedRows(component, kind);
	if (estimatedRows !== undefined) {
		withAutoCollapseGuard(component, () => {
			const shouldExpand = !forceCollapse && limit !== undefined && estimatedRows <= limit;
			if (Boolean(component.expanded) !== shouldExpand) component.setExpanded(shouldExpand);
			rememberAutoCollapseSignature(component, signature);
		});
		return;
	}

	if (options.avoidExpandedRender) {
		withAutoCollapseGuard(component, () => {
			// Avoid rendering expanded content only to decide collapse state. Preserve
			// the current expanded state so user/global expansion is not folded again.
			rememberAutoCollapseSignature(component, signature);
		});
		return;
	}

	withAutoCollapseGuard(component, () => {
		const expandedRows = withTemporaryExpanded(component, true, renderExpandedRows);
		const shouldExpand = !forceCollapse && limit !== undefined && expandedRows.length <= limit;
		if (Boolean(component.expanded) !== shouldExpand) component.setExpanded(shouldExpand);
		rememberAutoCollapseSignature(component, signature);
	});
}
