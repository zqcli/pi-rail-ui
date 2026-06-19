import { CONVERSATION_SCROLL_LAYOUT } from "../../config";
import { renderedRailSectionRange, resolveRailSection, type RailSectionRange } from "../../rail/rail-section";
import { stripAnsi } from "../../core/utils";
import type { HistoryRenderResult, RenderCache, ScrollState } from "./state";
import { nextHistoryRevision } from "./history-revision";

function renderChild(child: any, width: number): string[] {
	const childLines = child?.render?.(width);
	return Array.isArray(childLines) ? childLines : [];
}

function isPlainContainer(component: any): boolean {
	return component?.constructor?.name === "Container" && Array.isArray(component.children);
}

function historyRenderableChildren(children: any[]): any[] {
	const refs: any[] = [];
	for (let index = 0; index < 2; index++) {
		const child = children[index];
		if (isPlainContainer(child)) {
			for (const nested of child.children) refs.push(nested);
		} else if (child) {
			refs.push(child);
		}
	}
	return refs;
}

function isBlankHistoryLine(line: string | undefined): boolean {
	return stripAnsi(line ?? "").trim().length === 0;
}

function isPlainBlankHistoryLine(line: string | undefined): boolean {
	const value = line ?? "";
	// Background-colored padding rows are visually part of the previous block;
	// only unstyled blank rows should satisfy/collapse inter-section spacing.
	return value.trim().length === 0 && stripAnsi(value) === value;
}

function appendUnsectionedBlankRows(lines: string[], count: number): void {
	for (let index = 0; index < count; index++) lines.push("");
}

function shouldInsertBeforeSpacing(
	historyLines: string[],
	childLines: string[],
	section: ReturnType<typeof resolveRailSection>,
	previousSectionKind: string | undefined,
): boolean {
	if (!section) return false;
	const spacing = section.config.layout.spacing;
	if (spacing.beforeRows <= 0) return false;
	if (spacing.scope === "group" && previousSectionKind === section.kind) return false;
	if (!spacing.collapseAdjacent) return true;
	return !isPlainBlankHistoryLine(historyLines[historyLines.length - 1]) && !isPlainBlankHistoryLine(childLines[0]);
}

function shouldCollapseLeadingBlankRow(
	historyLines: string[],
	childLines: string[],
	section: ReturnType<typeof resolveRailSection>,
): boolean {
	return Boolean(
		section?.config.layout.spacing.collapseAdjacent
		&& isPlainBlankHistoryLine(historyLines[historyLines.length - 1])
		&& isPlainBlankHistoryLine(childLines[0]),
	);
}

type MutableHistoryRender = HistoryRenderResult & { previousSectionKind?: string };

function emptyHistoryRender(historyChildren: any[]): MutableHistoryRender {
	return {
		historyChildRefs: [...historyChildren],
		historyChildEndOffsets: [],
		historyChildPreviousSectionKinds: [],
		historyLines: [],
		historyRailSectionRanges: [],
		previousSectionKind: undefined,
	};
}

function railSectionRangePrefixCount(ranges: RailSectionRange[], lineEnd: number): number {
	let low = 0;
	let high = ranges.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (ranges[mid]!.end <= lineEnd) low = mid + 1;
		else high = mid;
	}
	return low;
}

function cloneHistoryPrefix(cache: RenderCache, historyChildren: any[], childCount: number): MutableHistoryRender {
	const prefixLineEnd = childCount <= 0 ? 0 : cache.historyChildEndOffsets[childCount - 1] ?? 0;
	cache.historyLines.length = prefixLineEnd;
	cache.historyRailSectionRanges.length = railSectionRangePrefixCount(cache.historyRailSectionRanges, prefixLineEnd);
	cache.historyChildEndOffsets.length = childCount;
	cache.historyChildPreviousSectionKinds.length = childCount;
	return {
		historyChildRefs: [...historyChildren],
		historyChildEndOffsets: cache.historyChildEndOffsets,
		historyChildPreviousSectionKinds: cache.historyChildPreviousSectionKinds,
		historyLines: cache.historyLines,
		historyRailSectionRanges: cache.historyRailSectionRanges,
		previousSectionKind: childCount <= 0 ? undefined : cache.historyChildPreviousSectionKinds[childCount - 1],
	};
}

function recordHistoryChild(render: MutableHistoryRender, childIndex: number): void {
	render.historyChildEndOffsets[childIndex] = render.historyLines.length;
	render.historyChildPreviousSectionKinds[childIndex] = render.previousSectionKind;
}

function nestedRailSectionRanges(component: any, width: number, start: number, trimmedLeadingRows = 0): RailSectionRange[] {
	const children = component?.contentContainer?.children;
	if (!Array.isArray(children) || children.length === 0) return [];

	const ranges: RailSectionRange[] = [];
	let offset = 0;
	for (const child of children) {
		const childLines = renderChild(child, width);
		const section = resolveRailSection(child);
		const range = section ? renderedRailSectionRange(start + offset - trimmedLeadingRows, childLines, section) : undefined;
		if (range && range.end > start) ranges.push({ ...range, start: Math.max(start, range.start) });
		offset += childLines.length;
	}
	return ranges;
}

function appendRenderedHistoryChild(render: MutableHistoryRender, component: any, width: number, childIndex: number): void {
	if (!component?.render) {
		recordHistoryChild(render, childIndex);
		return;
	}

	const section = resolveRailSection(component);
	const childLines = component.render(width);
	if (!Array.isArray(childLines)) {
		recordHistoryChild(render, childIndex);
		return;
	}

	if (shouldInsertBeforeSpacing(render.historyLines, childLines, section, render.previousSectionKind)) {
		appendUnsectionedBlankRows(render.historyLines, section!.config.layout.spacing.beforeRows);
	}
	const trimmedLeadingRows = shouldCollapseLeadingBlankRow(render.historyLines, childLines, section) ? 1 : 0;
	const visibleChildLines = trimmedLeadingRows > 0 ? childLines.slice(trimmedLeadingRows) : childLines;
	const start = render.historyLines.length;
	render.historyLines.push(...visibleChildLines);
	const nestedRanges = nestedRailSectionRanges(component, width, start, trimmedLeadingRows);
	if (nestedRanges.length > 0) {
		render.historyRailSectionRanges.push(...nestedRanges);
	} else {
		const range = section ? renderedRailSectionRange(start, visibleChildLines, section) : undefined;
		if (range) render.historyRailSectionRanges.push(range);
	}
	if (section) {
		render.previousSectionKind = section.kind;
		if (section.config.layout.spacing.afterRows > 0) {
			appendUnsectionedBlankRows(render.historyLines, section.config.layout.spacing.afterRows);
		}
	} else if (childLines.length > 0 && !childLines.every(isBlankHistoryLine)) {
		render.previousSectionKind = undefined;
	}
	recordHistoryChild(render, childIndex);
}

function finalizeHistoryRender(render: MutableHistoryRender): HistoryRenderResult {
	return {
		historyChildRefs: render.historyChildRefs,
		historyChildEndOffsets: render.historyChildEndOffsets,
		historyChildPreviousSectionKinds: render.historyChildPreviousSectionKinds,
		historyLines: render.historyLines,
		historyRailSectionRanges: render.historyRailSectionRanges,
	};
}

function renderHistoryChildren(historyChildren: any[], width: number, cache?: RenderCache, reusedPrefixChildCount = 0): HistoryRenderResult {
	const render = cache && reusedPrefixChildCount > 0
		? cloneHistoryPrefix(cache, historyChildren, reusedPrefixChildCount)
		: emptyHistoryRender(historyChildren);
	for (let index = reusedPrefixChildCount; index < historyChildren.length; index++) {
		appendRenderedHistoryChild(render, historyChildren[index], width, index);
	}
	return finalizeHistoryRender(render);
}

export function isInteractiveRoot(tui: any): boolean {
	const children = tui?.children;
	return Array.isArray(children) && children.length >= 8 && Array.isArray(children[5]?.children);
}

function sameRefs(a: any[], b: any[]): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

function commonPrefixLength(a: any[], b: any[]): number {
	const length = Math.min(a.length, b.length);
	let index = 0;
	while (index < length && a[index] === b[index]) index++;
	return index;
}

function canReuseFullHistory(cache: RenderCache | undefined, historyChildren: any[], width: number, state: ScrollState): cache is RenderCache {
	return Boolean(cache && !state.historyDirty && cache.width === width && sameRefs(cache.historyChildRefs, historyChildren));
}

function reusablePrefixChildCount(cache: RenderCache | undefined, historyChildren: any[], width: number, state: ScrollState): number {
	if (!cache || state.historyDirty || cache.width !== width) return 0;
	const commonPrefix = commonPrefixLength(cache.historyChildRefs, historyChildren);
	const tailWindow = CONVERSATION_SCROLL_LAYOUT.historyTailRenderWindow;
	const maxReusablePrefix = Math.max(0, historyChildren.length - tailWindow);
	return Math.min(commonPrefix, maxReusablePrefix, cache.historyChildEndOffsets.length, cache.historyChildPreviousSectionKinds.length);
}

function historyFromCache(cache: RenderCache): HistoryRenderResult {
	return {
		historyChildRefs: cache.historyChildRefs,
		historyChildEndOffsets: cache.historyChildEndOffsets,
		historyChildPreviousSectionKinds: cache.historyChildPreviousSectionKinds,
		historyLines: cache.historyLines,
		historyRailSectionRanges: cache.historyRailSectionRanges,
	};
}

export function getRenderedSections(children: any[], width: number, state: ScrollState): RenderCache {
	const historyChildren = historyRenderableChildren(children);
	const previousCache = state.renderCache;
	const reusedFullHistory = state.preferCachedRender && canReuseFullHistory(previousCache, historyChildren, width, state);
	const history = reusedFullHistory
		? historyFromCache(previousCache)
		: renderHistoryChildren(
			historyChildren,
			width,
			previousCache,
			reusablePrefixChildCount(previousCache, historyChildren, width, state),
		);
	const cache: RenderCache = {
		width,
		historyRevision: nextHistoryRevision(previousCache?.historyRevision, reusedFullHistory),
		children: [...children],
		...history,
		pendingLines: renderChild(children[2], width),
		statusLines: renderChild(children[3], width),
		aboveLines: renderChild(children[4], width),
		editorLines: renderChild(children[5], width),
		belowLines: renderChild(children[6], width),
		footerLines: renderChild(children[7], width),
	};
	state.renderCache = cache;
	state.preferCachedRender = false;
	state.historyDirty = false;
	return cache;
}
