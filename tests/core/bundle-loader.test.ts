import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bundleCli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const probeExtension = fileURLToPath(new URL("../fixtures/bundle-constructor-probe.ts", import.meta.url));

test("Pi 0.84.4 bundled loader preserves live constructor identity", { timeout: 30_000 }, async (t) => {
	const tempParent = join(process.cwd(), ".tmp");
	await mkdir(tempParent, { recursive: true });
	const tempDir = await mkdtemp(join(tempParent, "pi-bundle-loader-"));
	t.after(() => rm(tempDir, { recursive: true, force: true }));

	const resultPath = join(tempDir, "result.json");
	const child = spawn(process.execPath, [
		bundleCli,
		"--mode", "rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--offline",
		"-e", probeExtension,
	], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HOME: join(tempDir, "home"),
			PI_CODING_AGENT_DIR: join(tempDir, "agent"),
			PI_RAIL_BUNDLE_PROBE_OUTPUT: resultPath,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { stdout += chunk; });
	child.stderr.on("data", (chunk: string) => { stderr += chunk; });
	child.stdin.end(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);

	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	assert.equal(exitCode, 0, stderr);
	assert.match(stdout, /"command":"get_state","success":true/u);
	assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
		tuiMatches: true,
		interactiveMatches: true,
		scrollbarPatched: true,
		copyFeedbackPatched: true,
		sectionClickPatched: true,
		toolRenderPatched: true,
		bashRenderPatched: true,
	});
});