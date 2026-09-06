import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bundleCli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const probeExtension = fileURLToPath(new URL("../fixtures/bundle-constructor-probe.ts", import.meta.url));

test("Pi 0.85.1 bundled loader preserves constructor identity and leaves retired TUI methods unpatched", { timeout: 30_000 }, async (t) => {
	const tempParent = join(process.cwd(), ".tmp");
	await mkdir(tempParent, { recursive: true });
	const tempDir = await mkdtemp(join(tempParent, "pi-bundle-loader-"));
	const resultPath = join(tempDir, "result.json");

	let child: ChildProcess | undefined;
	let closed: Promise<void> | undefined;
	const killTimer = setTimeout(() => child?.kill("SIGKILL"), 20_000);
	t.after(async () => {
		clearTimeout(killTimer);
		if (child && child.exitCode === null) {
			child.kill("SIGKILL");
			await Promise.race([closed ?? Promise.resolve(), new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
		}
		await rm(tempDir, { recursive: true, force: true });
	});

	child = spawn(process.execPath, [
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
	child.stdout!.setEncoding("utf8");
	child.stderr!.setEncoding("utf8");
	child.stdout!.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
	child.stderr!.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_000_000); });

	const exited = new Promise<number | null>((resolve, reject) => {
		child!.once("error", reject);
		child!.once("exit", resolve);
	});
	closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
	child.stdin!.end(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);

	let exitCode: number | null = null;
	try {
		exitCode = await exited;
		clearTimeout(killTimer);
		await closed;
	} finally {
		if (exitCode !== 0) child.kill("SIGKILL");
	}

	assert.equal(exitCode, 0, stderr || stdout);
	assert.match(stdout, /"command":"get_state","success":true/u);
	assert.equal(/agent_start/u.test(stdout), false, "probe must not start a generation");
	assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
		tuiMatches: true,
		interactiveMatches: true,
		retiredTuiMethodsUnchanged: {
			handleSelectionMouseEvent: true,
			handleViewportInput: true,
			applySelection: true,
			handleScrollbarMouseEvent: true,
			doRender: true,
			requestRender: true,
			flash: true,
		},
		toolRenderPatched: true,
		toolHandleMousePatched: true,
		bashRenderPatched: true,
		bashHandleMousePatched: true,
		createResultRegionPatched: true,
		toolRenderRestored: true,
		toolHandleMouseRestored: true,
		bashRenderRestored: true,
		bashHandleMouseRestored: true,
		createResultRegionRestored: true,
	});
});