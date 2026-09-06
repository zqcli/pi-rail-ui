import { MouseRegion, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { appLeftGutterWidth } from "../config";
import { createPatchLifecycle, getInteractiveModeConstructor } from "../core/patching";
import { withRailSectionScrollAnchor } from "./rail-section";

const GUTTER_WRAPPED_KEY = Symbol.for("pi-rail-ui.gutter-wrapped");
const OSC133_ZONE_PREFIX_RE = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

type GutterRestore = { restore: () => void };

const gutterLifecycle = createPatchLifecycle("rail-gutter-patch", () => ({}));
const installedRestores: GutterRestore[] = [];

/**
 * Layout wrapper that insets a container's content by the configured left
 * gutter. OSC 133 prompt markers stay at the start of the line so Pi's
 * prompt navigation keeps working.
 *
 * Fullscreen mouse input is forwarded to the wrapped component through Pi's
 * public `MouseRegion`, which preserves the exact dispatch target metadata
 * (origin, bounds, focus target) the renderer built. Both the horizontal
 * coordinate and the event width are reduced by the gutter so the wrapped
 * component's own rendered geometry keys match; vertical coordinates are
 * unchanged because the gutter never insets rows vertically.
 *
 * When an `anchor` is provided, the forward dispatch runs inside core's
 * scoped scroll anchor so a section toggle in the subtree stays on screen.
 */
export class GutterContainer implements Component {
	private cached?: { width: number; gutter: number; innerLines: string[]; rows: string[] } | undefined;
	private readonly forward: MouseRegion;

	constructor(
		private readonly inner: any,
		private readonly anchor?: () => void,
	) {
		inner[GUTTER_WRAPPED_KEY] = this;
		(this as any)[GUTTER_WRAPPED_KEY] = this;
		this.forward = new MouseRegion(inner, () => undefined);
	}

	addChild(component: unknown): void {
		this.inner.addChild?.(component);
	}

	removeChild(component: unknown): void {
		this.inner.removeChild?.(component);
	}

	clear(): void {
		this.inner.clear?.();
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const gutter = appLeftGutterWidth(event.width);
		if (gutter <= 0) return withRailSectionScrollAnchor(this.anchor, () => this.forward.handleMouse(event));
		const width = Math.max(1, event.width - gutter);
		if (event.x < gutter || event.y < 0) return undefined;
		return withRailSectionScrollAnchor(this.anchor, () => this.forward.handleMouse({ ...event, x: event.x - gutter, width }));
	}

	render(width: number): string[] {
		const gutter = appLeftGutterWidth(width);
		if (gutter <= 0) return this.inner.render(width);
		const innerWidth = Math.max(1, width - gutter);
		const innerLines = this.inner.render(innerWidth);
		// Inner Rail blocks already reuse their row arrays across scroll frames;
		// skip the per-row prefix pass when the source lines did not change.
		const cached = this.cached;
		if (cached?.width === innerWidth && cached.gutter === gutter && cached.innerLines === innerLines) return cached.rows;

		const prefix = " ".repeat(gutter);
		const rows = innerLines.map((line: string) => {
			if (!line) return line;
			const zones = line.match(OSC133_ZONE_PREFIX_RE)?.[0] ?? "";
			return zones + prefix + line.slice(zones.length);
		});
		this.cached = { width: innerWidth, gutter, innerLines, rows };
		return rows;
	}
}

function wrapAt(host: any, slot: string | number, child: any, anchor?: () => void): void {
	if (!child || typeof child.render !== "function" || child[GUTTER_WRAPPED_KEY]) return;
	const wrapper = new GutterContainer(child, anchor);
	host[slot] = wrapper;
	installedRestores.push({
		restore: () => {
			if (host[slot] === wrapper) host[slot] = child;
			// Drop the inner marker only while it still names this wrapper; a
			// foreign owner that rebound it is left untouched.
			if (child[GUTTER_WRAPPED_KEY] === wrapper) delete child[GUTTER_WRAPPED_KEY];
		},
	});
}

/** Transcript pin closure for document wrappers: keep the current scrollTop (follow detached). */
function transcriptScrollAnchor(mode: any): () => void {
	return () => {
		const view = mode?.transcriptScrollView;
		view?.scrollTo(view.scrollTop, { disableFollow: true });
	};
}

export function installGutterWrappers(mode: any): boolean {
	if (!mode?.fullscreenLayoutRoot) return false;

	// Only transcript messages scroll inside `mode.transcriptScrollView`;
	// dock entries (status, editor, footer) forward mouse input unpinned.
	const anchorForDocument = transcriptScrollAnchor(mode);

	const doc = mode.documentContainer;
	if (doc && Array.isArray(doc.children)) {
		for (let index = 0; index < doc.children.length; index++) wrapAt(doc.children, index, doc.children[index], anchorForDocument);
	}
	for (const entry of mode.fullscreenLayoutRoot.entries ?? []) {
		const stack = entry?.component;
		if (!stack || !Array.isArray(stack.entries)) continue;
		// Dock entries (status, editor, footer) are not part of the transcript;
		// they forward mouse input without a scroll anchor.
		for (const innerEntry of stack.entries) wrapAt(innerEntry, "component", innerEntry.component);
	}
	return installedRestores.length > 0;
}

export function uninstallGutterWrappers(): void {
	for (const { restore } of installedRestores.splice(0)) restore();
}

export async function installGutter(): Promise<void> {
	gutterLifecycle.activate();
	const ctor = await getInteractiveModeConstructor();
	gutterLifecycle.patchMethod(ctor, "renderInitialMessages", (original) => function patchedRenderInitialMessages(this: any, ...args: any[]) {
		const result = original.apply(this, args);
		if (gutterLifecycle.state().active) installGutterWrappers(this);
		return result;
	});
	gutterLifecycle.patchMethod(ctor, "renderSessionEntries", (original) => function patchedRenderSessionEntries(this: any, ...args: any[]) {
		const result = original.apply(this, args);
		if (gutterLifecycle.state().active) installGutterWrappers(this);
		return result;
	});
}

export function uninstallGutter(): void {
	gutterLifecycle.deactivate();
	uninstallGutterWrappers();
}