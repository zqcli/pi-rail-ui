import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getRenderedSections, isInteractiveRoot } from "../../components/chat-view/history-renderer";
import type { ScrollState } from "../../components/chat-view/state";

class Container {
	children: any[];
	constructor(children: any[] = []) {
		this.children = children;
	}
	render(_width: number): string[] {
		return this.children.flatMap((child) => child?.render?.(_width) ?? []);
	}
}

function lineComponent(...lines: string[]) {
	return {
		render(): string[] {
			return lines;
		},
	};
}

function emptyState(): ScrollState {
	return {
		offsetFromBottom: 0,
		interaction: { type: "idle" },
	};
}

describe("history-renderer interactive root layout compatibility", () => {
	test("accepts legacy 8-child roots and reads the editor from the third child from the end", () => {
		const tui = {
			children: [
				new Container([lineComponent("history-a")]),
				new Container([lineComponent("history-b")]),
				lineComponent("pending"),
				lineComponent("status"),
				lineComponent("above"),
				new Container([lineComponent("editor")]),
				lineComponent("below"),
				lineComponent("footer"),
			],
		};

		assert.equal(isInteractiveRoot(tui), true);

		const sections = getRenderedSections(tui.children, 80, emptyState());
		assert.deepEqual(sections.historyLines, ["history-a", "history-b"]);
		assert.deepEqual(sections.pendingLines, ["pending"]);
		assert.deepEqual(sections.statusLines, ["status"]);
		assert.deepEqual(sections.aboveLines, ["above"]);
		assert.deepEqual(sections.editorLines, ["editor"]);
		assert.deepEqual(sections.belowLines, ["below"]);
		assert.deepEqual(sections.footerLines, ["footer"]);
	});

	test("accepts Pi 0.80.3 9-child roots and keeps header/resources/chat in scrollable history", () => {
		const tui = {
			children: [
				new Container([lineComponent("header")]),
				new Container([lineComponent("resources")]),
				new Container([lineComponent("chat-1"), lineComponent("chat-2")]),
				lineComponent("pending"),
				lineComponent("status"),
				new Container([lineComponent("above")]),
				new Container([lineComponent("editor")]),
				new Container([lineComponent("below")]),
				lineComponent("footer"),
			],
		};

		assert.equal(isInteractiveRoot(tui), true);

		const sections = getRenderedSections(tui.children, 80, emptyState());
		assert.deepEqual(sections.historyLines, ["header", "resources", "chat-1", "chat-2"]);
		assert.deepEqual(sections.pendingLines, ["pending"]);
		assert.deepEqual(sections.statusLines, ["status"]);
		assert.deepEqual(sections.aboveLines, ["above"]);
		assert.deepEqual(sections.editorLines, ["editor"]);
		assert.deepEqual(sections.belowLines, ["below"]);
		assert.deepEqual(sections.footerLines, ["footer"]);
	});

	test("rejects roots without an editor container in the third slot from the end", () => {
		const tui = {
			children: [
				new Container([lineComponent("history")]),
				new Container([lineComponent("history")]),
				lineComponent("pending"),
				lineComponent("status"),
				lineComponent("above"),
				lineComponent("not-editor"),
				lineComponent("below"),
				lineComponent("footer"),
			],
		};

		assert.equal(isInteractiveRoot(tui), false);
	});
});