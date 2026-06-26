import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	RAIL_EDITOR_HEIGHT,
	RAIL_EDITOR_SURFACE_STYLE,
	RAIL_EDITOR_STYLE,
	RAIL_THINKING_STYLE,
	RAIL_USER_MESSAGE_STYLE,
	RAIL_BASH_EXECUTION_STYLE,
	BASH_EXECUTION_RAIL_COLOR,
	THINKING_RAIL_COLOR,
	railAnsiForTheme,
	railSectionConfig,
	type EditorHeightPolicy,
	type RailSectionKind,
	type RailSurfaceStyle,
	type ThemeLike,
} from "../config";
import { isRailUiActive } from "./rail-section";
import {
	SGR_RESET,
	SGR_RESET_RE,
	applyColumnHighlight,
	padToWidth,
} from "../core/utils";
import { cachedRailRows, type RailRowsCache } from "./surface-primitives";

export type { EditorHeightPolicy, EditorSurfaceStyle, RailSurfaceStyle } from "../config";

export class EditorSurfaceRenderer {
	readonly style: RailSurfaceStyle;
	private readonly contentStart: number;
	private readonly transparentGap: string;
	private readonly completionPrefix: string;
	private readonly _rowPrefix: string;
	private readonly _rowSuffix: string;
	private rowCache = new Map<string, string>();

	constructor(
		style: RailSurfaceStyle = RAIL_EDITOR_STYLE,
		private readonly heightPolicy?: EditorHeightPolicy,
	) {
		this.style = style;
		this.contentStart = style.leftBorderWidth + style.borderContentGapWidth;
		this.transparentGap = " ".repeat(style.borderContentGapWidth);
		this.completionPrefix = " ".repeat(this.contentStart);
		this._rowPrefix = `${style.rail}${style.leftBorder}${style.reset}${this.transparentGap}${style.background}`;
		this._rowSuffix = style.reset;
	}

	minRenderableWidth(): number {
		return this.contentStart + 4;
	}

	contentStartCol(): number {
		return this.contentStart;
	}

	contentWidth(width: number): number {
		return Math.max(1, width - this.contentStart);
	}

	targetInputHeight(bodyRows: number, terminalRows: number): number {
		const policy = this.heightPolicy;
		if (!policy) return Math.max(1, bodyRows);
		const responsiveMax = Math.max(policy.minHeight, Math.min(policy.maxHeight, Math.floor(terminalRows * policy.maxHeightRatio)));
		return Math.max(policy.minHeight, Math.min(responsiveMax, bodyRows));
	}

	renderSurfaceRow(width: number, content = ""): string {
		const key = `${width}\u001f${content}`;
		const cached = this.rowCache.get(key);
		if (cached !== undefined) {
			// LRU touch: re-insert so frequently rendered rows survive eviction.
			this.rowCache.delete(key);
			this.rowCache.set(key, cached);
			return cached;
		}
		const targetWidth = Math.max(0, width - this.contentStart);
		const contentWidth = visibleWidth(content);
		const rawFitted = contentWidth <= targetWidth ? content + " ".repeat(targetWidth - contentWidth) : padToWidth(content, targetWidth);
		const fitted = this.restoreSurfaceAfterResets(rawFitted);
		const row = `${this._rowPrefix}${fitted}${this._rowSuffix}`;
		this.rowCache.set(key, row);
		if (this.rowCache.size > 2048) {
			const oldestKey = this.rowCache.keys().next().value;
			if (oldestKey !== undefined) this.rowCache.delete(oldestKey);
		}
		return row;
	}

	renderCompletion(width: number, line: string): string {
		return this.completionPrefix + padToWidth(line, Math.max(0, width - this.contentStart));
	}

	highlightColumns(line: string, startCol: number, endCol: number): string {
		return applyColumnHighlight(line, startCol, endCol, this.style.selection, this.style.reset);
	}

	private restoreSurfaceAfterResets(text: string): string {
		if (!this.style.background || !text.includes(SGR_RESET)) return text;
		return text.replace(SGR_RESET_RE, `${this.style.reset}${this.style.background}`);
	}
}

export const railEditorSurface = new EditorSurfaceRenderer(RAIL_EDITOR_STYLE, RAIL_EDITOR_HEIGHT);
export const railThinkingSurface = new EditorSurfaceRenderer(RAIL_THINKING_STYLE);
export const railUserMessageSurface = new EditorSurfaceRenderer(RAIL_USER_MESSAGE_STYLE);

export function railSectionSurfaceStyle(kind: RailSectionKind, theme?: ThemeLike): RailSurfaceStyle {
	const config = railSectionConfig(kind);
	const rail = config.style.railEnabled
		? (theme ? railAnsiForTheme(theme, config.style.rail) : undefined) ?? config.style.rail.ansi ?? ""
		: "";
	return {
		...RAIL_EDITOR_SURFACE_STYLE,
		leftBorder: config.style.railEnabled ? config.layout.leftBorder : "",
		leftBorderWidth: config.style.railEnabled ? config.layout.leftBorderWidth : 0,
		borderContentGapWidth: config.style.railEnabled ? config.layout.borderContentGapWidth : 0,
		background: config.style.background,
		rail,
	};
}

export function railSectionSurfaceForTheme(kind: RailSectionKind, theme?: ThemeLike): EditorSurfaceRenderer {
	return new EditorSurfaceRenderer(railSectionSurfaceStyle(kind, theme));
}

export const railSelectorOutputSurface = railSectionSurfaceForTheme("selectorOutput");

export function selectorOutputSurfaceForTheme(theme: ThemeLike | undefined): EditorSurfaceRenderer {
	return railSectionSurfaceForTheme("selectorOutput", theme);
}

export function thinkingSurfaceForTheme(theme: ThemeLike): EditorSurfaceRenderer {
	return new EditorSurfaceRenderer({
		...RAIL_THINKING_STYLE,
		rail: railAnsiForTheme(theme, THINKING_RAIL_COLOR) ?? RAIL_THINKING_STYLE.rail,
	});
}

let _bashSurfaceCache: { theme: ThemeLike | undefined; surface: EditorSurfaceRenderer } | undefined;

export function bashExecutionSurfaceForTheme(theme: ThemeLike | undefined): EditorSurfaceRenderer {
	const cached = _bashSurfaceCache;
	if (cached !== undefined && cached.theme === theme) return cached.surface;
	let rail = RAIL_BASH_EXECUTION_STYLE.rail;
	try {
		if (theme) rail = railAnsiForTheme(theme, BASH_EXECUTION_RAIL_COLOR) ?? rail;
	} catch {
		// Theme may not be initialized in isolated tests; keep the static fallback.
	}
	const surface = new EditorSurfaceRenderer({
		...RAIL_BASH_EXECUTION_STYLE,
		rail,
	});
	_bashSurfaceCache = { theme, surface };
	return surface;
}

export class SurfaceRailBlock implements Component {
	private cached?: RailRowsCache | undefined;

	constructor(
		private readonly inner: Component,
		private readonly surface: EditorSurfaceRenderer = railThinkingSurface,
	) {}

	invalidate(): void {
		this.cached = undefined;
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		if (!isRailUiActive() || width < this.surface.minRenderableWidth()) return this.inner.render(width);
		const innerLines = this.inner.render(this.surface.contentWidth(width));
		const result = cachedRailRows(this.cached, width, innerLines, () => innerLines.map((line) => this.surface.renderSurfaceRow(width, line)));
		this.cached = result.cache;
		return result.rows;
	}
}

export class ThinkingRailBlock extends SurfaceRailBlock {}

export class SurfaceContentInsetBlock implements Component {
	private cached?: RailRowsCache | undefined;

	constructor(
		private readonly inner: Component,
		private readonly surface: EditorSurfaceRenderer = railThinkingSurface,
	) {}

	invalidate(): void {
		this.cached = undefined;
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		if (!isRailUiActive()) return this.inner.render(width);
		const inset = this.surface.contentStartCol();
		if (inset <= 0 || width <= inset + 1) return this.inner.render(width);

		const innerWidth = Math.max(1, width - inset);
		const innerLines = this.inner.render(innerWidth);
		const prefix = " ".repeat(inset);
		const result = cachedRailRows(this.cached, width, innerLines, () => innerLines.map((line) => prefix + padToWidth(line, innerWidth)));
		this.cached = result.cache;
		return result.rows;
	}
}
