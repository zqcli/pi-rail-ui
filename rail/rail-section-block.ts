import type { Component } from "@earendil-works/pi-tui";
import { RAIL_EDITOR_STYLE, type RailSectionKind } from "../config";
import { padToWidth } from "../core/utils";
import { cachedRailRows, type RailRowsCache } from "./surface-primitives";
import {
	defineRailSection,
	isRailUiActive,
	railSectionConfigWithOverrides,
	type RailSectionOverrides,
} from "./rail-section";

export class RailSectionBlock implements Component {
	private readonly config;
	private cached?: RailRowsCache | undefined;

	constructor(private readonly inner: Component, kind: RailSectionKind, overrides?: RailSectionOverrides) {
		this.config = railSectionConfigWithOverrides(kind, overrides);
		defineRailSection(this, kind, overrides, inner);
	}

	setText(text: string): void {
		(this.inner as any).setText?.(text);
		this.cached = undefined;
	}

	unwrap(): Component {
		return this.inner;
	}

	invalidate(): void {
		this.cached = undefined;
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		if (!isRailUiActive()) return this.inner.render(width);
		const layout = this.config.layout;
		const railAnsi = this.config.style.rail.ansi ?? "";
		const hasRail = this.config.style.railEnabled && railAnsi.length > 0 && layout.leftBorderWidth > 0;
		const hasBackground = this.config.style.background.length > 0;
		if (!hasRail && !hasBackground) return this.inner.render(width);

		const contentStart = hasRail ? layout.leftBorderWidth + layout.borderContentGapWidth : 0;
		if (width <= contentStart + 1) return this.inner.render(width);

		const innerWidth = Math.max(1, width - contentStart);
		const innerLines = this.inner.render(innerWidth);

		const border = hasRail ? `${railAnsi}${layout.leftBorder}${RAIL_EDITOR_STYLE.reset}` : "";
		const borderGap = hasRail ? " ".repeat(layout.borderContentGapWidth) : "";
		const result = cachedRailRows(this.cached, width, innerLines, () => innerLines.map((line) => {
			const content = `${this.config.style.background}${padToWidth(line, innerWidth)}${RAIL_EDITOR_STYLE.reset}`;
			return `${border}${borderGap}${content}`;
		}));
		this.cached = result.cache;
		return result.rows;
	}
}
