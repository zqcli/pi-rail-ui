import { visibleWidth } from "@earendil-works/pi-tui";
import { railSectionSelectionStartCol, type RailSectionRange } from "../../rail/rail-section";
import { segmenter, stripAnsi, type Position } from "../../core/utils";
import { selectionRange, type ScrollState } from "./state";

type NormalizePosition = (pos: Position) => Position;
type Selection = { anchor: Position; active: Position };

function plainVisibleSlice(line: string, startCol: number, endCol: number): string {
	if (endCol <= startCol) return "";
	let out = "";
	let col = 0;
	for (const segment of segmenter.segment(stripAnsi(line))) {
		const grapheme = segment.segment;
		const width = visibleWidth(grapheme);
		if (width > 0 && col >= startCol && col < endCol) out += grapheme;
		col += width;
	}
	return out;
}

function selectedHistoryLineText(
	line: string,
	startCol: number,
	endCol: number,
	sectionRange: RailSectionRange | undefined,
): string {
	if (!sectionRange) return plainVisibleSlice(line, startCol, endCol).replace(/[ \t]+$/u, "");
	const section = sectionRange.section;
	if (!section.config.selectable) return "";

	let effectiveStart = startCol;
	let effectiveEnd = endCol;
	if (section.config.selection.mode === "contentOnly") {
		const contentStart = railSectionSelectionStartCol(section);
		effectiveStart = Math.max(effectiveStart, contentStart);
		effectiveEnd = Math.max(effectiveEnd, contentStart);
	}
	let text = plainVisibleSlice(line, effectiveStart, effectiveEnd);
	if (section.config.selection.trimRight) text = text.replace(/[ \t]+$/u, "");
	return text;
}

export function selectedHistoryText(
	state: ScrollState,
	sectionRangeAtLine: (line: number) => RailSectionRange | undefined,
): string | undefined {
	const range = selectionRange(state.selection);
	const lines = state.renderCache?.historyLines;
	if (!range || !lines) return undefined;

	const selected: string[] = [];
	for (let lineIndex = range.start.line; lineIndex <= range.end.line; lineIndex++) {
		const line = lines[lineIndex] ?? "";
		const startCol = lineIndex === range.start.line ? range.start.col : 0;
		const endCol = lineIndex === range.end.line ? range.end.col : state.view?.width ?? visibleWidth(stripAnsi(line));
		selected.push(selectedHistoryLineText(line, startCol, endCol, sectionRangeAtLine(lineIndex)));
	}
	return selected.join("\n");
}

function lineVisibleWidth(state: ScrollState, line: number): number {
	return Math.min(state.view?.width ?? 0, visibleWidth(stripAnsi(state.renderCache?.historyLines[line] ?? "")));
}

export function wordSelectionAt(state: ScrollState, pos: Position, normalize: NormalizePosition): Selection | undefined {
	const text = stripAnsi(state.renderCache?.historyLines[pos.line] ?? "");
	if (!text) return undefined;

	const chars = [...segmenter.segment(text)].map((segment) => ({ text: segment.segment, width: visibleWidth(segment.segment) }));
	let col = 0;
	let index = 0;
	for (; index < chars.length; index++) {
		const width = chars[index]!.width;
		if (width > 0 && pos.col < col + width) break;
		col += width;
	}
	if (index >= chars.length || /\s/u.test(chars[index]!.text)) return undefined;

	let startIndex = index;
	let endIndex = index + 1;
	while (startIndex > 0 && !/\s/u.test(chars[startIndex - 1]!.text)) startIndex--;
	while (endIndex < chars.length && !/\s/u.test(chars[endIndex]!.text)) endIndex++;

	const startCol = chars.slice(0, startIndex).reduce((sum, item) => sum + item.width, 0);
	const endCol = chars.slice(0, endIndex).reduce((sum, item) => sum + item.width, 0);
	return {
		anchor: normalize({ line: pos.line, col: startCol }),
		active: normalize({ line: pos.line, col: endCol }),
	};
}

export function lineSelectionAt(state: ScrollState, pos: Position, normalize: NormalizePosition): Selection {
	return {
		anchor: normalize({ line: pos.line, col: 0 }),
		active: normalize({ line: pos.line, col: lineVisibleWidth(state, pos.line) }),
	};
}
