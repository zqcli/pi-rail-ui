import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { createRailFooter } from "../../components/footer/footer";
import { createFooterFixture } from "../helpers/footer-session";

// Run both implementations against the exact same native fixture in one process.
// Usage: node --expose-gc --import tsx tests/benchmarks/footer.bench.ts BASELINE_ROOT [CANDIDATE_ROOT]
const [beforeRoot, afterRoot = "."] = process.argv.slice(2);
assert.ok(beforeRoot, "Provide the baseline checkout root");
assert.equal(readFileSync(resolve(beforeRoot, "package-lock.json"), "utf8"), readFileSync(resolve(afterRoot, "package-lock.json"), "utf8"));
const load = async (root: string): Promise<typeof createRailFooter> =>
	(await import(pathToFileURL(resolve(root, "components/footer/footer.ts")).href)).createRailFooter;
const factories = [await load(beforeRoot), await load(afterRoot)];
const width = 160;
const samples = 9;
const warmup = 30;
const results: object[] = [];

function summary(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return { medianMs: sorted[4], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: values };
}

for (const [turns, compacted] of [[25, false], [250, false], [2500, false], [2500, true]] as const) {
	const h = createFooterFixture(turns, compacted);
	const manager = h.state.manager;
	const entries = manager.getEntries();
	const leaf = manager.getLeafId()!;
	const previous = entries.at(-5)!.id;
	const components = factories.map((factory) => factory!(h.ctx, h.pi)({ requestRender() {} }, undefined, h.footerData));
	const make = (side: number) => factories[side]!(h.ctx, h.pi)({ requestRender() {} }, undefined, h.footerData);
	assert.deepEqual(components[0]!.render(width), components[1]!.render(width));
	for (const phase of ["warm-hit", "leaf-change", "cold-render"] as const) {
		const iterations = phase === "warm-hit" ? 250 : 24;
		const times: number[][] = [[], []];
		const run = (side: number, count: number) => {
			let last: string[] = [];
			for (let frame = 0; frame < count; frame++) {
				if (phase === "leaf-change") manager.branch(frame % 2 ? leaf : previous);
				const footer = phase === "cold-render" ? make(side) : components[side]!;
				footer.invalidate();
				last = footer.render(width);
				if (phase === "cold-render") footer.dispose();
			}
			return last;
		};
		for (const side of [0, 1]) run(side, warmup);
		for (let sample = 0; sample < samples; sample++) {
			const outputs: string[][] = [];
			for (const side of sample % 2 ? [1, 0] : [0, 1]) {
				globalThis.gc?.();
				const start = performance.now();
				outputs[side] = run(side, iterations);
				times[side]!.push((performance.now() - start) / iterations);
			}
			assert.deepEqual(outputs[0], outputs[1], `${turns} turns, ${phase}`);
		}
		results.push({ entries: entries.length, compacted, phase, iterations, before: summary(times[0]!), after: summary(times[1]!) });
	}
	for (const footer of components) footer.dispose();
}

// Count history work separately, so instrumentation cannot distort timing.
const historyReads = factories.map((factory) => {
	const h = createFooterFixture(2500);
	const counts = { entries: 0, branch: 0, projection: 0, context: 0, sessionName: 0 };
	for (const [method, key] of [["getEntries", "entries"], ["getBranch", "branch"], ["buildSessionProjection", "projection"], ["getSessionName", "sessionName"]] as const) {
		const original = h.state.manager[method].bind(h.state.manager);
		Object.defineProperty(h.state.manager, method, { value: (...args: unknown[]) => { counts[key]++; return Reflect.apply(original, undefined, args); } });
	}
	const originalContext = h.ctx.getContextUsage;
	h.ctx.getContextUsage = () => { counts.context++; return originalContext(); };
	const footer = factory!(h.ctx, h.pi)({ requestRender() {} }, undefined, h.footerData);
	footer.render(width);
	for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
	for (let frame = 0; frame < 100; frame++) { footer.invalidate(); footer.render(width); }
	footer.dispose();
	return counts;
});

console.log(JSON.stringify({
	node: process.version, pi: VERSION, cpu: cpus()[0]?.model, width, samples, warmup,
	gcBetweenSamples: Boolean(globalThis.gc), historyReadsPer100WarmRenders: historyReads, results,
}, null, 2));
