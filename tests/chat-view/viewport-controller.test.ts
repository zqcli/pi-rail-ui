import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConversationViewportController } from "../../components/chat-view/viewport-controller";
import {
	markConversationViewportCachePreferred,
	stateFor,
	type ConversationScrollStore,
} from "../../components/chat-view/state";

function store(): ConversationScrollStore {
	return {
		active: false,
		targets: [],
		states: new WeakMap<object, any>(),
		animationTimers: new Set<ReturnType<typeof setTimeout>>(),
		alternateScreenActive: false,
		clearOnNextOverflowRender: false,
	};
}

describe("ConversationViewportController", () => {
	it("resets timers, state, and overflow clear intent behind one interface", () => {
		const scrollStore = store();
		const tui = {};
		stateFor(tui, scrollStore).offsetFromBottom = 7;
		const timer = setTimeout(() => {}, 1000);
		scrollStore.animationTimers.add(timer);

		new ConversationViewportController(scrollStore).reset({ clearOnNextOverflowRender: true });

		assert.equal(scrollStore.animationTimers.size, 0);
		assert.equal(scrollStore.clearOnNextOverflowRender, true);
		assert.equal(stateFor(tui, scrollStore).offsetFromBottom, 0);
	});

	it("marks cache preference without exposing ScrollState mutation to callers", () => {
		const scrollStore = store();
		const tui = {};

		markConversationViewportCachePreferred(tui, scrollStore);

		assert.equal(stateFor(tui, scrollStore).preferCachedRender, true);
	});
});
