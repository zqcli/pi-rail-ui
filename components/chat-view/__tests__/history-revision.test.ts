import { nextHistoryRevision } from "../history-revision";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
	} catch (e) {
		failed++;
		console.log(`FAIL: ${name}\n  ${e instanceof Error ? e.message : String(e)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

console.log("history revision tests\n");

test("initial recompute starts at revision 1", () => {
	assert(nextHistoryRevision(undefined, false) === 1, "initial recompute should be revision 1");
});

test("full history reuse keeps revision stable", () => {
	assert(nextHistoryRevision(7, true) === 7, "full reuse should keep previous revision");
});

test("partial or full recompute increments revision", () => {
	assert(nextHistoryRevision(7, false) === 8, "recompute should increment previous revision");
});

test("missing previous revision is stable only for full reuse", () => {
	assert(nextHistoryRevision(undefined, true) === 0, "missing previous full reuse should remain zero");
});

setTimeout(() => {
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}, 50);
