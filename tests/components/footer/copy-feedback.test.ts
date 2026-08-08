import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	clearFooterSelectionNotice,
	routeFullscreenFlash,
} from "../../../components/footer";

describe("fullscreen copy feedback", () => {
	test("routes native Copied flashes to the Rail footer", () => {
		let renders = 0;
		let forwarded = 0;
		const tui = { requestRender: () => renders++ };

		routeFullscreenFlash(tui, "Copied!", 1000, () => forwarded++);

		assert.equal(forwarded, 0);
		assert.equal(renders, 1);
		clearFooterSelectionNotice();
	});

	test("preserves unrelated fullscreen flashes", () => {
		let forwarded = 0;

		routeFullscreenFlash({}, "Saved", undefined, () => forwarded++);

		assert.equal(forwarded, 1);
	});
});