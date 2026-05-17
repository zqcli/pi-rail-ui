import type { Component } from "@earendil-works/pi-tui";
import { TALL_GRAY_EDITOR_STYLE } from "../config";

const LEFT_GAP_BLOCK_MARKER = Symbol.for("pi-rail-ui.left-gap-block");
const LEGACY_LEFT_GAP_BLOCK_MARKER = Symbol.for("pi-rail-ui.legacy.tall-gray-input.left-gap-block");
// Keep recognizing the old marker so existing chat rows created before /reload
// are not wrapped again by newer patches.
const RIGHT_GAP_BLOCK_MARKER = Symbol.for("pi-rail-ui.right-gap-block");
const LEGACY_RIGHT_GAP_BLOCK_MARKER = Symbol.for("pi-rail-ui.legacy.tall-gray-input.right-gap-block");

type GapBlockLike = Component & { unwrap(): Component };

export function leftGapWidth(): number {
	return Math.max(0, Math.round(TALL_GRAY_EDITOR_STYLE.leftWindowGapWidth));
}

export function renderLinesWithGap(width: number, gap: number, renderInner: (innerWidth: number) => string[]): string[] {
	const normalizedGap = Math.max(0, Math.round(gap));
	if (normalizedGap <= 0 || width <= normalizedGap + 1) return renderInner(width);

	const prefix = " ".repeat(normalizedGap);
	return renderInner(Math.max(1, width - normalizedGap)).map((line) => prefix + line);
}

export function renderLinesWithLeftGap(width: number, renderInner: (innerWidth: number) => string[]): string[] {
	return renderLinesWithGap(width, leftGapWidth(), renderInner);
}

export class LeftGapBlock implements Component {
	readonly [LEFT_GAP_BLOCK_MARKER] = true;

	constructor(private readonly inner: Component, private readonly gapWidth?: number) {}

	setText(text: string): void {
		(this.inner as any).setText?.(text);
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		return renderLinesWithGap(width, this.gapWidth ?? leftGapWidth(), (innerWidth) => this.inner.render(innerWidth));
	}

	unwrap(): Component {
		return this.inner;
	}
}

export function isLeftGapBlock(value: unknown): value is LeftGapBlock {
	return Boolean(
		value &&
			typeof value === "object" &&
			((value as any)[LEFT_GAP_BLOCK_MARKER] === true || (value as any)[LEGACY_LEFT_GAP_BLOCK_MARKER] === true),
	);
}

function isRightGapBlockMarker(value: unknown): value is GapBlockLike {
	return Boolean(
		value &&
			typeof value === "object" &&
			((value as any)[RIGHT_GAP_BLOCK_MARKER] === true || (value as any)[LEGACY_RIGHT_GAP_BLOCK_MARKER] === true),
	);
}

export function isGapBlock(value: unknown): value is GapBlockLike {
	return isLeftGapBlock(value) || isRightGapBlockMarker(value);
}

export function unwrapGapBlock(value: Component): Component {
	let current = value;
	while (isGapBlock(current)) current = current.unwrap();
	return current;
}

export function containsLeftGapBlock(value: unknown): boolean {
	let current = value;
	while (isGapBlock(current)) {
		if (isLeftGapBlock(current)) return true;
		current = current.unwrap();
	}
	return false;
}
