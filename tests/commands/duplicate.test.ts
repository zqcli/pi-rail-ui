import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { handleDuplicateCommand } from "../../commands/duplicate";

async function makeSessionDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "rail-dup-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function populate(manager: SessionManager): SessionManager {
	const usage = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// Persisting requires at least one assistant message (user-only buffers).
	manager.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "first answer" }],
		api: "openai-responses",
		provider: "cus-resp",
		model: "gpt-5.6-sol",
		usage,
		stopReason: "stop",
		timestamp: 2,
	});
	return manager;
}

async function runDuplicate(manager: SessionManager, sessionDir: string, beforeFiles: Set<string>) {
	const notifications: string[] = [];
	const ctx: any = {
		sessionManager: manager,
		ui: { notify: (text: string) => notifications.push(text) },
	};
	await handleDuplicateCommand(ctx);

	const afterFiles = new Set(await readdir(sessionDir));
	const added = [...afterFiles].find((name) => !beforeFiles.has(name));
	assert.ok(added, `expected a new session file in ${sessionDir}`);
	return { notifications, newFilePath: join(sessionDir, added!), ctx };
}

test("duplicate of a child session creates a sibling under the same original parent", async (t) => {
	const sessionDir = await makeSessionDir(t);
	const cwd = join(sessionDir, "project");

	const rootFile = populate(SessionManager.create(cwd, sessionDir)).getSessionFile()!;
	const source = populate(SessionManager.create(cwd, sessionDir, { parentSession: rootFile }));
	const sourceFile = source.getSessionFile()!;
	const sourceId = source.getSessionId();
	const beforeFiles = new Set(await readdir(sessionDir));
	const sourceContentBefore = await readFile(sourceFile, "utf8");

	const { notifications, newFilePath, ctx } = await runDuplicate(source, sessionDir, beforeFiles);

	const copy = SessionManager.open(newFilePath, sessionDir);
	const copyHeader = copy.getHeader()!;
	assert.notEqual(copyHeader.id, sourceId);
	assert.notEqual(newFilePath, sourceFile);
	// Copy shares the source's parent instead of becoming its child.
	assert.equal(copyHeader.parentSession, rootFile);
	assert.notEqual(copyHeader.parentSession, sourceFile);
	// The full conversation is actually copied (same entry ids and content).
	assert.deepEqual(copy.getEntries(), source.getEntries());
	// The source file is untouched.
	assert.equal(await readFile(sourceFile, "utf8"), sourceContentBefore);
	// The current session is not switched.
	assert.equal(ctx.sessionManager.getSessionFile(), sourceFile);
	assert.equal(ctx.sessionManager.getSessionId(), sourceId);
	assert.match(notifications[0] ?? "", new RegExp(copyHeader.id));
});

test("duplicate of a root session creates another root that is not a child of the source", async (t) => {
	const sessionDir = await makeSessionDir(t);
	const cwd = join(sessionDir, "project");

	const source = populate(SessionManager.create(cwd, sessionDir));
	const sourceFile = source.getSessionFile()!;
	const sourceId = source.getSessionId();
	const beforeFiles = new Set(await readdir(sessionDir));
	const sourceContentBefore = await readFile(sourceFile, "utf8");

	const { newFilePath, ctx } = await runDuplicate(source, sessionDir, beforeFiles);

	const copy = SessionManager.open(newFilePath, sessionDir);
	const copyHeader = copy.getHeader()!;
	assert.equal(source.getHeader()?.parentSession, undefined);
	assert.notEqual(copyHeader.id, sourceId);
	assert.notEqual(newFilePath, sourceFile);
	// A root source has no parent, so the copy stays at the root as well.
	assert.equal(copyHeader.parentSession, undefined);
	assert.deepEqual(copy.getEntries(), source.getEntries());
	assert.equal(await readFile(sourceFile, "utf8"), sourceContentBefore);
	assert.equal(ctx.sessionManager.getSessionFile(), sourceFile);
	assert.equal(ctx.sessionManager.getSessionId(), sourceId);
});