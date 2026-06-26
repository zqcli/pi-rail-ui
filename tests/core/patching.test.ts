import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPatchLifecycle } from "../../core/patching";

describe("PatchLifecycle", () => {
	it("patches methods once and restores originals", () => {
		class Target {
			value(): string {
				return "original";
			}
		}
		const lifecycle = createPatchLifecycle(`test-patch-${Date.now()}-${Math.random()}`, () => ({ label: "test" }));
		const store = lifecycle.activate();

		assert.equal(store.active, true);
		assert.equal(lifecycle.patchMethod(Target, "value", (original) => function patched(this: Target) {
			return `${original.call(this)}+patched`;
		}), true);
		assert.equal(lifecycle.patchMethod(Target, "value", (original) => function patchedAgain(this: Target) {
			return `${original.call(this)}+again`;
		}), false);
		assert.equal(new Target().value(), "original+patched");

		lifecycle.deactivate();
		assert.equal(lifecycle.state().active, false);
		assert.equal(new Target().value(), "original");
	});

	it("keeps feature state behind the lifecycle store", () => {
		const lifecycle = createPatchLifecycle(`test-state-${Date.now()}-${Math.random()}`, () => ({ count: 0 }));
		lifecycle.activate((store) => {
			store.count = 3;
		});
		assert.equal(lifecycle.state().count, 3);

		lifecycle.deactivate((store) => {
			store.count = 0;
		});
		assert.equal(lifecycle.state().count, 0);
	});
});
