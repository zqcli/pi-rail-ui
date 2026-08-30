import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	ApplyPatchError,
	applyPatch,
	applyPatchHunks,
	parseApplyPatch,
	resolvePatchPath,
	summarizeApplyPatch,
} from "../../tools/apply-patch";
import { MemoryFs, TEST_CWD } from "../helpers/memory-fs";

async function assertApplyPatchRejects(fn: () => Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(
		fn,
		(error: unknown) => error instanceof ApplyPatchError && error.code === code,
	);
}

describe("apply-patch parsing", () => {
	test("parses and summarizes move headers", () => {
		const input = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@ function main
-old
+new
*** End Patch`;

		const parsed = parseApplyPatch(input);
		assert.equal(parsed.changes.length, 1);
		const change = parsed.changes[0];
		assert.equal(change?.action, "update");
		assert.equal(change?.action === "update" ? change.movePath : undefined, "src/new.ts");
		assert.equal(summarizeApplyPatch(input)[0]?.movePath, "src/new.ts");
	});

	test("rejects malformed add-file lines", () => {
		assert.throws(
			() => parseApplyPatch(`*** Begin Patch
*** Add File: src/new.ts
missing plus
*** End Patch`),
			(error: unknown) => error instanceof ApplyPatchError && error.code === "invalidPatchFormat",
		);
	});

	test("summarizes headers even when full parsing fails", () => {
		const summaries = summarizeApplyPatch(`not a complete patch
*** Update File: old.ts
*** Move to: new.ts
*** Add File: added.ts`);

		assert.deepEqual(summaries, [
			{ action: "update", path: "old.ts", movePath: "new.ts" },
			{ action: "add", path: "added.ts" },
		]);
	});

	test("resolves at-prefixed relative paths against cwd", () => {
		assert.equal(resolvePatchPath("@src/app.ts", TEST_CWD), `${TEST_CWD}/src/app.ts`);
	});
});

describe("applyPatchHunks", () => {
	test("applies anchored replacement hunks", () => {
		const result = applyPatchHunks(
			"function main() {\n\treturn 1;\n}\n",
			[
				{
					header: "function main",
					endOfFile: false,
					lines: [
						{ kind: "context", text: "function main() {" },
						{ kind: "remove", text: "\treturn 1;" },
						{ kind: "add", text: "\treturn 2;" },
						{ kind: "context", text: "}" },
					],
				},
			],
			"src/app.ts",
		);

		assert.equal(result, "function main() {\n\treturn 2;\n}\n");
	});

	test("inserts after a header when the hunk has no old lines", () => {
		const result = applyPatchHunks(
			"one\ntwo\nthree",
			[
				{
					header: "two",
					endOfFile: false,
					lines: [{ kind: "add", text: "inserted" }],
				},
			],
			"src/app.ts",
		);

		assert.equal(result, "one\ntwo\ninserted\nthree");
	});
});

describe("applyPatch filesystem operations", () => {
	test("adds a new file", async () => {
		const fs = new MemoryFs();
		const result = await applyPatch(
			`*** Begin Patch
*** Add File: src/new.ts
+export const value = 1;
+
+console.log(value);
*** End Patch`,
			{ cwd: TEST_CWD, operations: fs.operations },
		);

		assert.equal(fs.get("src/new.ts"), "export const value = 1;\n\nconsole.log(value);");
		assert.equal(result.files[0]?.action, "add");
		assert.ok(result.additions > 0);
	});

	test("updates a file using context lines", async () => {
		const fs = new MemoryFs();
		fs.set("src/app.ts", "function main() {\n\treturn 1;\n}\n");

		await applyPatch(
			`*** Begin Patch
*** Update File: src/app.ts
@@
 function main() {
-\treturn 1;
+\treturn 2;
 }
*** End Patch`,
			{ cwd: TEST_CWD, operations: fs.operations },
		);

		assert.equal(fs.get("src/app.ts"), "function main() {\n\treturn 2;\n}\n");
	});

	test("moves and updates a file", async () => {
		const fs = new MemoryFs();
		fs.set("src/old.ts", "export const name = \"old\";\n");

		await applyPatch(
			`*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-export const name = "old";
+export const name = "new";
*** End Patch`,
			{ cwd: TEST_CWD, operations: fs.operations },
		);

		assert.equal(fs.get("src/old.ts"), undefined);
		assert.equal(fs.get("src/new.ts"), "export const name = \"new\";\n");
	});

	test("deletes a file", async () => {
		const fs = new MemoryFs();
		fs.set("src/delete-me.ts", "remove me\n");

		await applyPatch(
			`*** Begin Patch
*** Delete File: src/delete-me.ts
*** End Patch`,
			{ cwd: TEST_CWD, operations: fs.operations },
		);

		assert.equal(fs.get("src/delete-me.ts"), undefined);
	});

	test("preserves BOM and CRLF line endings", async () => {
		const fs = new MemoryFs();
		fs.set("src/win.txt", "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await applyPatch(
			`*** Begin Patch
*** Update File: src/win.txt
@@
-second
+SECOND
*** End Patch`,
			{ cwd: TEST_CWD, operations: fs.operations },
		);

		assert.equal(fs.get("src/win.txt"), "\uFEFFfirst\r\nSECOND\r\nthird\r\n");
	});

	test("fails when hunk context is missing", async () => {
		const fs = new MemoryFs();
		fs.set("src/app.ts", "const value = 1;\n");

		await assertApplyPatchRejects(
			() =>
				applyPatch(
					`*** Begin Patch
*** Update File: src/app.ts
@@
-missing
+replacement
*** End Patch`,
					{ cwd: TEST_CWD, operations: fs.operations },
				),
			"contextNotFound",
		);
	});

	test("fails when adding an existing file", async () => {
		const fs = new MemoryFs();
		fs.set("src/existing.ts", "already here\n");

		await assertApplyPatchRejects(
			() =>
				applyPatch(
					`*** Begin Patch
*** Add File: src/existing.ts
+new content
*** End Patch`,
					{ cwd: TEST_CWD, operations: fs.operations },
				),
			"fileExists",
		);
	});

	test("fails when a move target already exists", async () => {
		const fs = new MemoryFs();
		fs.set("src/old.ts", "old\n");
		fs.set("src/new.ts", "existing\n");

		await assertApplyPatchRejects(
			() =>
				applyPatch(
					`*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-old
+updated
*** End Patch`,
					{ cwd: TEST_CWD, operations: fs.operations },
				),
			"fileExists",
		);
	});
});
