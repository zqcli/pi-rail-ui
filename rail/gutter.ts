import type { Component } from "@earendil-works/pi-tui";
import { appLeftGutterWidth } from "../config";
import { createPatchLifecycle, getInteractiveModeConstructors } from "../core/patching";

const GUTTER_WRAPPED_KEY = Symbol.for("pi-rail-ui.gutter-wrapped");
const OSC133_ZONE_PREFIX_RE = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

type GutterRestore = { restore: () => void };

const gutterLifecycle = createPatchLifecycle("rail-gutter-patch", () => ({}));
const installedRestores: GutterRestore[] = [];

/**
 * Layout wrapper that insets a container's content by the configured left
 * gutter. OSC 133 prompt markers stay at the start of the line so Pi's
 * prompt navigation keeps working.
 */
export class GutterContainer implements Component {
	private cached?: { width: number; gutter: number; innerLines: string[]; rows: string[] } | undefined;

	constructor(private readonly inner: any) {
		inner[GUTTER_WRAPPED_KEY] = this;
		(this as any)[GUTTER_WRAPPED_KEY] = this;
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

function wrapAt(host: any, slot: string | number, child: any): void {
	if (!child || typeof child.render !== "function" || child[GUTTER_WRAPPED_KEY]) return;
	const wrapper = new GutterContainer(child);
	host[slot] = wrapper;
	installedRestores.push({
		restore: () => {
			if (host[slot] === wrapper) host[slot] = child;
		},
	});
}

export function installGutterWrappers(mode: any): boolean {
	if (!mode?.fullscreenLayoutRoot) return false;

	const doc = mode.documentContainer;
	if (doc && Array.isArray(doc.children)) {
		for (let index = 0; index < doc.children.length; index++) wrapAt(doc.children, index, doc.children[index]);
	}
	for (const entry of mode.fullscreenLayoutRoot.entries ?? []) {
		const stack = entry?.component;
		if (!stack || !Array.isArray(stack.entries)) continue;
		for (const innerEntry of stack.entries) wrapAt(innerEntry, "component", innerEntry.component);
	}
	return installedRestores.length > 0;
}

export function uninstallGutterWrappers(): void {
	for (const { restore } of installedRestores.splice(0)) restore();
}

export async function installGutter(): Promise<void> {
	gutterLifecycle.activate();
	for (const ctor of await getInteractiveModeConstructors()) {
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
}

export function uninstallGutter(): void {
	gutterLifecycle.deactivate();
	uninstallGutterWrappers();
}
