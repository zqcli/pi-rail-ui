import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRailFooter } from "../../../components/footer/footer";
import { collectRailSessionSnapshot, formatNum } from "../../../components/footer/footer-session-snapshot";
import { stripAnsi } from "../../../core/utils";
import { createFooterFixture, footerAssistant, footerUsage } from "../../helpers/footer-session";

test("warm footer renders never copy entries, rebuild context or scan the unused session name", (t) => {
	const h = createFooterFixture(2500);
	const footer = createRailFooter(h.ctx, h.pi)({ requestRender() {} }, undefined, h.footerData);
	t.after(() => footer.dispose());
	const entries = t.mock.method(h.state.manager, "getEntries");
	const branch = t.mock.method(h.state.manager, "getBranch");
	const projection = t.mock.method(h.state.manager, "buildSessionProjection");
	const context = t.mock.method(h.ctx, "getContextUsage");
	const names = t.mock.method(h.state.manager, "getSessionName");
	footer.render(160);
	const calls = [entries, branch, projection, context].map((fn) => fn.mock.callCount());
	for (let frame = 0; frame < 100; frame++) {
		footer.invalidate();
		footer.render(frame % 2 ? 80 : 160);
	}
	assert.deepEqual([entries, branch, projection, context].map((fn) => fn.mock.callCount()), calls);
	assert.equal(context.mock.callCount(), 1);
	assert.equal(names.mock.callCount(), 0);
	// Live values still refresh even though history did not change.
	h.state.idle = false;
	h.state.pending = true;
	h.state.thinking = "high";
	h.state.branch = "new-branch";
	assert.match(stripAnsi(footer.render(200)[0]!), /new-branch.*high.*queued/);
});

test("native append, branch navigation, off-branch usage and compaction invalidate cached stats", (t) => {
	const h = createFooterFixture(2);
	const manager = h.state.manager;
	const footer = createRailFooter(h.ctx, h.pi)({ requestRender() {} }, undefined, h.footerData);
	t.after(() => footer.dispose());
	const context = t.mock.method(h.ctx, "getContextUsage");
	let reads = 0;
	const verify = () => {
		const line = stripAnsi(footer.render(200)[0]!);
		assert.equal(context.mock.callCount(), ++reads);
		const snapshot = collectRailSessionSnapshot(h.ctx, h.pi);
		reads++;
		assert.ok(line.includes(`↑${formatNum(snapshot.session.tokens.input)}`), line);
		const percent = snapshot.state.contextPercent;
		assert.ok(line.includes(`ctx ${percent == null ? "?" : `${percent.toFixed(2)}%`}`), line);
		footer.render(200);
		assert.equal(context.mock.callCount(), reads, "the next render hits the cache");
		return line;
	};
	verify();
	const first = manager.getEntries()[0]!.id;
	const last = manager.getLeafId()!;
	manager.branch(first);
	verify(); // Same total entry count, different active branch/context.
	manager.branch(last);
	verify();
	manager.appendUsage("cache_warm", "footer-fixture", "fixture", footerUsage);
	manager.branch(last);
	verify(); // Same leaf, but whole-session spend increased on another branch.
	manager.appendMessage(footerAssistant(100));
	verify();
	manager.appendCompaction("Summary", first, 10_000, undefined, false, footerUsage);
	assert.match(verify(), /ctx \?/);
	manager.appendMessage(footerAssistant(1));
	assert.doesNotMatch(verify(), /ctx \?/);
	manager.appendContextEdit(first, { content: [{ type: "text", text: "Revised user request" }] });
	verify();
});

test("manager identity, session id, model replacement and in-place context-window changes miss", (t) => {
	const h = createFooterFixture(1);
	const footer = createRailFooter(h.ctx, h.pi)({ requestRender() {} }, undefined, h.footerData);
	t.after(() => footer.dispose());
	const context = t.mock.method(h.ctx, "getContextUsage");
	// Keep independent key values fixed to prove each key is checked.
	t.mock.method(h.state.manager, "getLeafId", () => "same-leaf");
	t.mock.method(h.state.manager, "getSessionId", () => "same-session");
	footer.render(200);
	h.state.model = { ...h.state.model!, id: "different-model" };
	footer.render(200);
	assert.equal(context.mock.callCount(), 2);
	h.state.model.contextWindow /= 2;
	assert.match(stripAnsi(footer.render(200)[0]!), /ctx 0\.20%/);
	assert.equal(context.mock.callCount(), 3);
	t.mock.method(h.state.manager, "getSessionId", () => "new-session");
	footer.render(200);
	assert.equal(context.mock.callCount(), 4);
	const replacement = createFooterFixture(1).state.manager;
	t.mock.method(replacement, "getLeafId", () => "same-leaf");
	t.mock.method(replacement, "getSessionId", () => "new-session");
	h.state.manager = replacement;
	footer.render(200);
	assert.equal(context.mock.callCount(), 5);
	h.state.manager = SessionManager.inMemory();
	h.state.model = undefined;
	assert.match(stripAnsi(footer.render(200)[0]!), /no model.*ctx \?/);
	footer.render(200);
	assert.equal(context.mock.callCount(), 6, "undefined context usage is cacheable");
});

test("an adapter without cheap entry count stays fresh instead of inventing a cache hit", (t) => {
	const h = createFooterFixture(1);
	Object.defineProperty(h.state.manager, "getEntryCount", { value: undefined });
	const footer = createRailFooter(h.ctx, h.pi)({ requestRender() {} }, undefined, h.footerData);
	t.after(() => footer.dispose());
	const context = t.mock.method(h.ctx, "getContextUsage");
	footer.render(200);
	h.state.manager.appendMessage(footerAssistant(100));
	assert.match(stripAnsi(footer.render(200)[0]!), /ctx 0\.42%/);
	footer.render(200);
	assert.equal(context.mock.callCount(), 3);
});

test("virtual-model context stays live when routed physical limits change without a new entry", (t) => {
	const h = createFooterFixture(1);
	h.state.model = { ...h.state.model!, api: "pi-virtual" };
	let contextWindow = 100_000;
	const context = t.mock.method(h.ctx, "getContextUsage", () => ({ tokens: 1000, contextWindow, percent: 100_000 / contextWindow }));
	const entries = t.mock.method(h.state.manager, "getEntries");
	const footer = createRailFooter(h.ctx, h.pi)({ requestRender() {} }, undefined, h.footerData);
	t.after(() => footer.dispose());
	assert.match(stripAnsi(footer.render(200)[0]!), /ctx 1\.00%/);
	contextWindow = 50_000;
	assert.match(stripAnsi(footer.render(200)[0]!), /ctx 2\.00%/);
	assert.equal(context.mock.callCount(), 2);
	assert.equal(entries.mock.callCount(), 1, "whole-session usage can still be cached");
});
