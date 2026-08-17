import { appLeftGutterWidth } from "../../config";

const GUTTER_WRAPPED_KEY = Symbol.for("pi-rail-ui.gutter-wrapped");

type MousePositionEditor = {
	moveCursorToMousePosition(localRow: number, localCol: number): boolean;
};

function nestedComponents(component: any): any[] {
	const nested = [component?.inner];
	if (Array.isArray(component?.children)) nested.push(...component.children);
	if (Array.isArray(component?.entries)) nested.push(...component.entries.map((entry: any) => entry?.component));
	return nested.filter(Boolean);
}

function componentContains(component: any, target: any, seen = new Set<any>()): boolean {
	if (!component || seen.has(component)) return false;
	if (component === target) return true;
	seen.add(component);
	return nestedComponents(component).some((child) => componentContains(child, target, seen));
}

function findEditorBox(box: any, editor: MousePositionEditor): any | undefined {
	for (const child of box?.children ?? []) {
		const match = findEditorBox(child, editor);
		if (match) return match;
	}
	return componentContains(box?.component, editor) ? box : undefined;
}

function componentInsetBeforeTarget(component: any, target: any, width: number, seen = new Set<any>()): number | undefined {
	if (!component || seen.has(component)) return undefined;
	if (component === target) return 0;
	seen.add(component);

	for (const child of nestedComponents(component)) {
		if (!componentContains(child, target)) continue;
		const gutter = component?.[GUTTER_WRAPPED_KEY] === component ? appLeftGutterWidth(width) : 0;
		const nested = componentInsetBeforeTarget(child, target, Math.max(1, width - gutter), seen);
		return nested === undefined ? gutter : gutter + nested;
	}
	return undefined;
}

function pointInsideBox(box: any, x: number, y: number): boolean {
	const left = Math.max(box.rect?.x ?? 0, box.clip?.x ?? 0);
	const top = Math.max(box.rect?.y ?? 0, box.clip?.y ?? 0);
	const right = Math.min(
		(box.rect?.x ?? 0) + (box.rect?.width ?? 0),
		(box.clip?.x ?? 0) + (box.clip?.width ?? 0),
	);
	const bottom = Math.min(
		(box.rect?.y ?? 0) + (box.rect?.height ?? 0),
		(box.clip?.y ?? 0) + (box.clip?.height ?? 0),
	);
	return x >= left && x < right && y >= top && y < bottom;
}

export function positionRailEditorCursor(tui: any, event: any): boolean {
	if (event?.release || (event?.button & 32) !== 0 || (event?.button & 3) !== 0) return false;
	if (tui.hasOverlay?.()) return false;

	const editor = tui.getFocusedComponent?.() as MousePositionEditor | undefined;
	if (!editor || typeof editor.moveCursorToMousePosition !== "function") return false;
	const box = findEditorBox(tui.currentLayout?.root, editor);
	if (!box || !pointInsideBox(box, event.x, event.y)) return false;

	const inset = componentInsetBeforeTarget(box.component, editor, box.rect?.width ?? 0) ?? 0;
	const moved = editor.moveCursorToMousePosition(
		event.y - (box.rect?.y ?? 0),
		event.x - (box.rect?.x ?? 0) - inset,
	);
	if (!moved) return false;
	return true;
}