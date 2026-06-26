import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripAnsi } from "../../../core/utils";
import { railSelectorOutputSurface } from "../../../rail/rail-surface";
import {
	renderSelectorOverlaySnapshot,
	type ModelSelectorSnapshot,
} from "../../../components/editor/selector-overlay-presenter";
import {
	renderSelectorSurface,
	showSelectorOverlay,
	type SelectorOverlayRenderStore,
} from "../../../components/editor/selector-overlay-renderer";

const theme = {
	fg(_name: string, value: string) {
		return value;
	},
	bold(value: string) {
		return value;
	},
};

function store(): SelectorOverlayRenderStore {
	return { handles: new Set(), theme: theme as any, surface: railSelectorOutputSurface };
}

describe("selector overlay renderer", () => {
	test("renders model selector rows through the selector snapshot interface", () => {
		const snapshot: ModelSelectorSnapshot = {
			kind: "model",
			scope: "scoped",
			hasScopedModels: true,
			scopeHint: "scope hint",
			search: { text: "gpt", render: () => ["> gpt"] },
			items: [
				{ id: "gpt-5", provider: "openai", name: "GPT 5", current: true },
			],
			selectedIndex: 0,
			errorMessage: "",
		};

		const rows = renderSelectorOverlaySnapshot(snapshot, 60, theme as any);
		const text = stripAnsi(rows.join("\n"));

		assert.match(text, /Scope:/);
		assert.match(text, /gpt-5/);
		assert.match(text, /GPT 5/);
	});

	test("renders selector surfaces through one patch seam", () => {
		const instance = {
			scope: "scoped",
			scopedModels: ["gpt-5"],
			getScopeHintText: () => "scope hint",
			searchInput: { getText: () => "gpt", render: () => ["> gpt"] },
			filteredModels: [
				{ id: "gpt-5", provider: "openai", model: { id: "gpt-5", provider: "openai", name: "GPT 5" } },
			],
			selectedIndex: 0,
			currentModel: { id: "gpt-5", provider: "openai" },
			filterModels() {},
		};

		const rows = renderSelectorSurface(instance, 72, () => ["fallback"], store());
		const text = stripAnsi(rows.join("\n"));

		assert.match(text, /Scope:/);
		assert.match(text, /gpt-5/);
		assert.doesNotMatch(text, /fallback/);
	});

	test("shows a rail overlay panel and restores editor focus on done", () => {
		let focused: any;
		let requested = false;
		let hidden = false;
		let capturedPanel: any;
		const handle = { hide: () => { hidden = true; } };
		const renderable = {
			searchInput: { render: () => ["search"] },
			filteredModels: [],
			filterModels() {},
		};
		const editor = { render: () => ["one", "two"], hideSlashOverlay() {} };
		const editorContainer = {
			children: [editor],
			clear() {
				this.children.length = 0;
			},
			addChild(child: any) {
				this.children.push(child);
			},
		};
		const instance = {
			editor,
			editorContainer,
			ui: {
				terminal: { columns: 80, rows: 24 },
				setFocus(target: any) {
					focused = target;
				},
				requestRender() {
					requested = true;
				},
				showOverlay(panel: any, options: any) {
					capturedPanel = { panel, options };
					return handle;
				},
			},
		};
		const currentStore = store();
		let overlayDone: (() => void) | undefined;

		showSelectorOverlay(instance, (done) => {
			overlayDone = done;
			return { component: renderable as any, focus: renderable };
		}, currentStore);

		assert.equal(currentStore.handles.has(handle as any), true);
		assert.equal(capturedPanel.options.anchor, "bottom-left");
		assert.deepEqual(capturedPanel.options.margin, { bottom: 3 });
		overlayDone?.();
		assert.equal(hidden, true);
		assert.equal(focused, editor);
		assert.equal(requested, true);
		assert.equal(currentStore.handles.size, 0);
	});

	test("keeps selector overlay rows live after model selector loads items", () => {
		let capturedPanel: any;
		const renderable = {
			scope: "all",
			searchInput: { getText: () => "", render: () => ["> "] },
			filteredModels: [] as any[],
			selectedIndex: 0,
			filterModels() {},
		};
		const instance = {
			editor: { render: () => ["editor"], hideSlashOverlay() {} },
			editorContainer: { children: [], clear() {}, addChild() {} },
			ui: {
				terminal: { columns: 80, rows: 24 },
				setFocus() {},
				requestRender() {},
				showOverlay(panel: any, options: any) {
					capturedPanel = { panel, options };
					return { hide() {} };
				},
			},
		};

		showSelectorOverlay(instance, () => ({ component: renderable as any, focus: renderable }), store());

		renderable.filteredModels = [
			{ id: "gpt-5", provider: "openai", model: { id: "gpt-5", provider: "openai", name: "GPT 5" } },
		];
		const text = stripAnsi(capturedPanel.panel.render(72).join("\n"));

		assert.match(text, /gpt-5/);
		assert.match(text, /GPT 5/);
		assert.doesNotMatch(text, /No matching models/);
	});

	test("keeps selector overlay rows live as scoped model selection moves", () => {
		let capturedPanel: any;
		const renderable = {
			searchInput: { getText: () => "", render: () => ["> "] },
			modelsById: new Map([
				["openai/alpha", { id: "alpha", provider: "openai", name: "Alpha" }],
				["openai/beta", { id: "beta", provider: "openai", name: "Beta" }],
			]),
			filteredItems: [
				{ fullId: "openai/alpha", model: { id: "alpha", provider: "openai", name: "Alpha" }, enabled: true },
				{ fullId: "openai/beta", model: { id: "beta", provider: "openai", name: "Beta" }, enabled: true },
			],
			selectedIndex: 0,
			maxVisible: 8,
			enabledIds: null,
			getFooterText: () => "footer",
		};
		const instance = {
			editor: { render: () => ["editor"], hideSlashOverlay() {} },
			editorContainer: { children: [], clear() {}, addChild() {} },
			ui: {
				terminal: { columns: 80, rows: 24 },
				setFocus() {},
				requestRender() {},
				showOverlay(panel: any, options: any) {
					capturedPanel = { panel, options };
					return { hide() {} };
				},
			},
		};

		showSelectorOverlay(instance, () => ({ component: renderable as any, focus: renderable }), store());
		assert.match(stripAnsi(capturedPanel.panel.render(72).join("\n")), /Model Name: Alpha/);

		renderable.selectedIndex = 1;
		assert.match(stripAnsi(capturedPanel.panel.render(72).join("\n")), /Model Name: Beta/);
	});
});
