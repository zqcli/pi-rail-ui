import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { appLeftGutterWidth, SLASH_COMMAND_LAYOUT, RAIL_EDITOR_HEIGHT, type ThemeLike } from "../../config";
import { RailOverlayPanel, renderRailOverlayRows, type RailOverlayBodyRenderer } from "../../rail/rail-overlay";
import { cachedRender } from "../../rail/render-cache";
import type { EditorSurfaceRenderer } from "../../rail/rail-surface";
import { selectorOverlayPresentationFor } from "./selector-overlay-presenter";

export type SelectorFactory = (done: () => void) => { component: Component; focus: any };

export type SelectorOverlayRenderStore = {
	handles: Set<OverlayHandle>;
	theme?: ThemeLike | undefined;
	surface: EditorSurfaceRenderer;
};

const SELECTOR_SURFACE_CACHE_KEY = Symbol.for("pi-rail-ui.selector-surface-cache");

function cachedSelectorRows(instance: any, signature: string, renderRows: () => string[]): string[] {
	return cachedRender(instance, SELECTOR_SURFACE_CACHE_KEY, signature, renderRows);
}

export function renderSelectorSurface(
	instance: any,
	width: number,
	originalRender: (width: number) => string[],
	store: SelectorOverlayRenderStore,
): string[] {
	try {
		if (width < store.surface.minRenderableWidth()) return originalRender.call(instance, width);
		const presentation = selectorOverlayPresentationFor(instance, store.theme);
		if (!presentation) return originalRender.call(instance, width);
		return cachedSelectorRows(instance, presentation.signature(width), () => renderRailOverlayRows(width, presentation.renderBody, {
			surface: store.surface,
			textGapWidth: SLASH_COMMAND_LAYOUT.textGapWidth,
		}));
	} catch {
		return originalRender.call(instance, width);
	}
}

function selectorBodyRenderer(component: any, store: SelectorOverlayRenderStore): RailOverlayBodyRenderer | undefined {
	if (!selectorOverlayPresentationFor(component, store.theme)) return undefined;
	return (contentWidth) => selectorOverlayPresentationFor(component, store.theme)?.renderBody(contentWidth) ?? [];
}

function renderedEditorRows(instance: any, width: number): number {
	try {
		const rows = instance.editor?.render?.(width);
		if (Array.isArray(rows) && rows.length > 0) return rows.length;
	} catch {
		// Fall back to the configured default height when the editor cannot be rendered here.
	}
	return RAIL_EDITOR_HEIGHT.minHeight;
}

function ensureEditorInContainer(instance: any): void {
	const container = instance.editorContainer;
	if (!container || !instance.editor) return;
	if (Array.isArray(container.children) && container.children.includes(instance.editor)) return;
	container.clear?.();
	container.addChild?.(instance.editor);
}

export function showSelectorOverlay(instance: any, create: SelectorFactory, store: SelectorOverlayRenderStore): void {
	let handle: OverlayHandle | undefined;
	const done = () => {
		handle?.hide();
		if (handle) store.handles.delete(handle);
		handle = undefined;
		ensureEditorInContainer(instance);
		instance.ui?.setFocus?.(instance.editor);
		instance.ui?.requestRender?.();
	};

	const { component, focus } = create(done);
	const renderBody = selectorBodyRenderer(component, store);
	if (!renderBody) {
		instance.editorContainer?.clear?.();
		instance.editorContainer?.addChild?.(component);
		instance.ui?.setFocus?.(focus);
		instance.ui?.requestRender?.();
		return;
	}

	ensureEditorInContainer(instance);
	instance.editor?.hideSlashOverlay?.();
	const terminal = instance.ui?.terminal;
	const width = Math.max(1, terminal?.columns ?? 80);
	const leftGutterWidth = appLeftGutterWidth(width);
	const contentWidth = Math.max(1, width - leftGutterWidth);
	const bottomMargin = renderedEditorRows(instance, contentWidth) + SLASH_COMMAND_LAYOUT.bottomReservedRows;
	const panel = new RailOverlayPanel({
		renderBody,
		focusTarget: focus,
		invalidateTarget: component,
		maxRows: () => Math.max(1, (terminal?.rows ?? 24) - bottomMargin),
		surface: store.surface,
		textGapWidth: SLASH_COMMAND_LAYOUT.textGapWidth,
	});
	handle = instance.ui.showOverlay(panel, {
		width: "100%",
		anchor: "bottom-left",
		margin: { bottom: bottomMargin },
	});
	if (handle) store.handles.add(handle);
}
