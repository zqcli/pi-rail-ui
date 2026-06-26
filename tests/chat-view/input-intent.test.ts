import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	parseConversationMouse,
	rememberClickCount,
	type ConversationMouse,
} from "../../components/chat-view/input-intent";
import type { ConversationInteractionEffects } from "../../components/chat-view/interactions";
import type { ScrollState } from "../../components/chat-view/state";

function effectsWithClock(now: () => number): ConversationInteractionEffects {
	return {
		copyToClipboard: async () => {},
		showSelectionNotice: () => {},
		now,
		setTimeout: setTimeout as ConversationInteractionEffects["setTimeout"],
		clearTimeout,
		animationFrameMs: () => 16,
	};
}

describe("conversation input intent", () => {
	test("parses SGR mouse into conversation mouse intents", () => {
		assert.deepEqual(parseConversationMouse("\x1b[<0;3;2M"), { x: 3, y: 2, action: "press" });
		assert.deepEqual(parseConversationMouse("\x1b[<32;3;2M"), { x: 3, y: 2, action: "drag" });
		assert.deepEqual(parseConversationMouse("\x1b[<0;3;2m"), { x: 3, y: 2, action: "release" });
		assert.deepEqual(parseConversationMouse("\x1b[<2;3;2M"), { x: 3, y: 2, action: "copy" });
		assert.equal(parseConversationMouse("\x1b[<64;3;2M"), undefined);
	});

	test("records multi-click state behind the input intent interface", () => {
		let now = 1000;
		const state: ScrollState = { offsetFromBottom: 0, interaction: { type: "idle" } };
		const effects = effectsWithClock(() => now);
		const first: ConversationMouse = { x: 4, y: 2, action: "press" };
		const second: ConversationMouse = { x: 4, y: 2, action: "press" };
		const third: ConversationMouse = { x: 7, y: 2, action: "press" };

		rememberClickCount(state, first, effects);
		now += 100;
		rememberClickCount(state, second, effects);
		now += 100;
		rememberClickCount(state, third, effects);

		assert.equal(first.clickCount, 1);
		assert.equal(second.clickCount, 2);
		assert.equal(third.clickCount, 1);
	});
});
