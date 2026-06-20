import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cachedRender } from "../../rail/render-cache";

describe("cachedRender", () => {
	test("reuses cached values when the signature matches", () => {
		const target: Record<symbol, unknown> = {};
		const key = Symbol("cache");
		let calls = 0;

		const first = cachedRender(target, key, "same", () => ({ value: ++calls }));
		const second = cachedRender(target, key, "same", () => ({ value: ++calls }));

		assert.equal(first, second);
		assert.equal(calls, 1);
	});

	test("invalidates the cache when identity checks change", () => {
		const target: Record<symbol, unknown> = {};
		const key = Symbol("cache");
		const refA = {};
		const refB = {};
		let calls = 0;

		const first = cachedRender(target, key, "same", () => ({ value: ++calls }), { ref: refA });
		const second = cachedRender(target, key, "same", () => ({ value: ++calls }), { ref: refA });
		const third = cachedRender(target, key, "same", () => ({ value: ++calls }), { ref: refB });

		assert.equal(first, second);
		assert.notEqual(second, third);
		assert.equal(calls, 2);
	});

	test("invalidates the cache when the signature changes", () => {
		const target: Record<symbol, unknown> = {};
		const key = Symbol("cache");
		let calls = 0;

		cachedRender(target, key, "a", () => ++calls);
		const value = cachedRender(target, key, "b", () => ++calls);

		assert.equal(value, 2);
	});
});
