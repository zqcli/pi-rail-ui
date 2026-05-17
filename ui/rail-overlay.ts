import type { Component } from "@earendil-works/pi-tui";
import { SLASH_COMMAND_LAYOUT } from "../config";
import { padToWidth } from "../utils";
import { EditorSurfaceRenderer, tallGraySelectorOutputSurface } from "./rail-surface";

export type RailOverlayBodyRenderer = (contentWidth: number) => string[];

export type RailOverlayRenderOptions = {
	surface?: EditorSurfaceRenderer;
	textGapWidth?: number;
	maxRows?: number | (() => number);
};

export type RailOverlayPanelOptions = RailOverlayRenderOptions & {
	renderBody: RailOverlayBodyRenderer;
	focusTarget?: any;
	invalidateTarget?: Component;
};

function resolvedMaxRows(maxRows: RailOverlayRenderOptions["maxRows"]): number {
	const raw = typeof maxRows === "function" ? maxRows() : maxRows;
	return Math.max(1, Math.round(raw ?? Number.MAX_SAFE_INTEGER));
}

export function renderRailOverlayRows(
	width: number,
	renderBody: RailOverlayBodyRenderer,
	options: RailOverlayRenderOptions = {},
): string[] {
	const surface = options.surface ?? tallGraySelectorOutputSurface;
	if (width < surface.minRenderableWidth()) return [];

	const contentWidth = surface.contentWidth(width);
	const textGapWidth = Math.max(0, Math.round(options.textGapWidth ?? SLASH_COMMAND_LAYOUT.textGapWidth));
	const bodyWidth = Math.max(1, contentWidth - textGapWidth);
	const textGap = " ".repeat(textGapWidth);
	const maxRows = resolvedMaxRows(options.maxRows);
	let rows: string[];
	try {
		rows = renderBody(bodyWidth);
	} catch {
		return [];
	}
	return rows
		.slice(0, maxRows)
		.map((line) => surface.renderSurfaceRow(width, textGap + padToWidth(line, bodyWidth)));
}

export class RailOverlayPanel implements Component {
	private _focused = false;
	private readonly surface: EditorSurfaceRenderer;
	private readonly textGapWidth: number;

	constructor(private readonly options: RailOverlayPanelOptions) {
		this.surface = options.surface ?? tallGraySelectorOutputSurface;
		this.textGapWidth = Math.max(0, Math.round(options.textGapWidth ?? SLASH_COMMAND_LAYOUT.textGapWidth));
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.options.focusTarget && "focused" in this.options.focusTarget) this.options.focusTarget.focused = value;
	}

	render(width: number): string[] {
		return renderRailOverlayRows(width, this.options.renderBody, {
			surface: this.surface,
			textGapWidth: this.textGapWidth,
			maxRows: this.options.maxRows,
		});
	}

	handleInput(data: string): void {
		this.options.focusTarget?.handleInput?.(data);
	}

	invalidate(): void {
		this.options.invalidateTarget?.invalidate?.();
		this.options.focusTarget?.invalidate?.();
	}
}
