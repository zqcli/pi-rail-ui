import {
	ApplyPatchError,
	applyPatch,
	parseApplyPatch,
	summarizeApplyPatch,
	type ApplyPatchOperations,
} from "../apply-patch";

const CWD = "/repo";

let passed = 0;
let failed = 0;

function missing(path: string): Error & { code?: string } {
	const error = new Error(`Missing file: ${path}`) as Error & { code?: string };
	error.code = "ENOENT";
	return error;
}

class MemoryFs {
	readonly files = new Map<string, string>();

	readonly operations: ApplyPatchOperations = {
		readFile: async (path) => {
			const content = this.files.get(path);
			if (content === undefined) throw missing(path);
			return Buffer.from(content, "utf-8");
		},
		writeFile: async (path, content) => {
			this.files.set(path, content);
		},
		mkdir: async () => {},
		unlink: async (path) => {
			if (!this.files.has(path)) throw missing(path);
			this.files.delete(path);
		},
		rename: async (from, to) => {
			const content = this.files.get(from);
			if (content === undefined) throw missing(from);
			this.files.set(to, content);
			this.files.delete(from);
		},
		access: async (path) => {
			if (!this.files.has(path)) throw missing(path);
		},
	};

	set(path: string, content: string): void {
		this.files.set(`${CWD}/${path}`, content);
	}

	get(path: string): string | undefined {
		return this.files.get(`${CWD}/${path}`);
	}
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
	process.stdout.write(`  ${name} ... `);
	try {
		await fn();
		console.log("PASS");
		passed++;
	} catch (error) {
		console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
		failed++;
	}
}

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
	if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function assertRejects(fn: () => Promise<unknown>, code: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		if (!(error instanceof ApplyPatchError)) throw new Error(`expected ApplyPatchError, got ${error}`);
		assertEqual(error.code, code, "error code");
		return;
	}
	throw new Error("expected rejection");
}

console.log("apply-patch tests\n");

await test("parses and summarizes move headers", () => {
	const input = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@ function main
-old
+new
*** End Patch`;
	const parsed = parseApplyPatch(input);
	assertEqual(parsed.changes.length, 1, "change count");
	const change = parsed.changes[0]!;
	assertEqual(change.action, "update", "action");
	assertEqual(change.action === "update" ? change.movePath : undefined, "src/new.ts", "move path");
	assertEqual(summarizeApplyPatch(input)[0]?.movePath, "src/new.ts", "summary move path");
});

await test("adds a new file", async () => {
	const fs = new MemoryFs();
	const result = await applyPatch(
		`*** Begin Patch
*** Add File: src/new.ts
+export const value = 1;
+
+console.log(value);
*** End Patch`,
		{ cwd: CWD, operations: fs.operations },
	);

	assertEqual(fs.get("src/new.ts"), "export const value = 1;\n\nconsole.log(value);", "file content");
	assertEqual(result.files[0]?.action, "add", "file action");
	assert(result.additions > 0, "result should count additions");
});

await test("updates a file using context lines", async () => {
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
		{ cwd: CWD, operations: fs.operations },
	);

	assertEqual(fs.get("src/app.ts"), "function main() {\n\treturn 2;\n}\n", "updated content");
});

await test("moves and updates a file", async () => {
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
		{ cwd: CWD, operations: fs.operations },
	);

	assertEqual(fs.get("src/old.ts"), undefined, "old path");
	assertEqual(fs.get("src/new.ts"), "export const name = \"new\";\n", "new path content");
});

await test("deletes a file", async () => {
	const fs = new MemoryFs();
	fs.set("src/delete-me.ts", "remove me\n");

	await applyPatch(
		`*** Begin Patch
*** Delete File: src/delete-me.ts
*** End Patch`,
		{ cwd: CWD, operations: fs.operations },
	);

	assertEqual(fs.get("src/delete-me.ts"), undefined, "deleted path");
});

await test("preserves BOM and CRLF line endings", async () => {
	const fs = new MemoryFs();
	fs.set("src/win.txt", "\uFEFFfirst\r\nsecond\r\nthird\r\n");

	await applyPatch(
		`*** Begin Patch
*** Update File: src/win.txt
@@
-second
+SECOND
*** End Patch`,
		{ cwd: CWD, operations: fs.operations },
	);

	assertEqual(fs.get("src/win.txt"), "\uFEFFfirst\r\nSECOND\r\nthird\r\n", "line endings");
});

await test("fails when hunk context is missing", async () => {
	const fs = new MemoryFs();
	fs.set("src/app.ts", "const value = 1;\n");

	await assertRejects(
		() =>
			applyPatch(
				`*** Begin Patch
*** Update File: src/app.ts
@@
-missing
+replacement
*** End Patch`,
				{ cwd: CWD, operations: fs.operations },
			),
		"contextNotFound",
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
