import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bundleCli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const probeExtension = fileURLToPath(new URL("../fixtures/bundle-native-ui-probe.ts", import.meta.url));
const railPackage = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));

test("Pi 0.85.1 bundled native-UI: editor, chat-tree, and renderer behaviors via public seams", { timeout: 60_000 }, async (t) => {
	const { version } = JSON.parse(await readFile(railPackage, "utf8"));
	assert.equal(version, "0.85.1", "repo-local 0.85.1 bundle expected");

	const tempParent = join(process.cwd(), ".tmp");
	await mkdir(tempParent, { recursive: true });
	const tempDir = await mkdtemp(join(tempParent, "pi-bundle-native-ui-"));
	const resultPath = join(tempDir, "result.json");

	let child: ChildProcess | undefined;
	let closed: Promise<void> | undefined;
	const killTimer = setTimeout(() => child?.kill("SIGKILL"), 45_000);
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
			PI_RAIL_NATIVE_UI_PROBE_OUTPUT: resultPath,
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
	assert.equal(/message_start/u.test(stdout), false, "probe must not start a generation");

	const { results, errors } = JSON.parse(await readFile(resultPath, "utf8"));
	assert.deepEqual(errors, []);

	assert.deepEqual(results["plain-no-gutter"], { cursor: { line: 0, col: 12 } });
	assert.deepEqual(results["scrolled-guttered"], { cursor: { line: 8, col: 14 } });
	assert.deepEqual(results["wide-grapheme"], [
		{ char: "内", cursor: { line: 0, col: 8 } },
		{ char: "🔥", cursor: { line: 0, col: 19 } },
	]);
	assert.deepEqual(results["drag-copy"], {
		copied: "select",
		before: { line: 0, col: 18 },
		after: { line: 0, col: 18 },
		hasSelection: true,
	});
	assert.equal(results["real-autocomplete"].text, "rail-oai-fast");
	assert.deepEqual(results["renderer-tree-open-close"], { states: [true, false], rowMarkers: ["content", "hint"] });
	assert.deepEqual(results["renderer-disabled"], { expanded: true, setValues: [], manuallyToggled: false });

	const phases = (results["custom-control-phases"] as { phaseEvents: Array<{ type: string; x: number; y: number; width: number }>; renderWidth: number; expanded: boolean });
	assert.deepEqual(phases.phaseEvents.map((event) => event.type), ["press", "drag", "release"]);
	assert.equal(phases.expanded, true);
	for (const event of phases.phaseEvents) {
		assert.equal(event.width, phases.renderWidth, "every phase must carry the render-time content width");
		assert.ok(event.x >= 0 && event.x < event.width, `x=${event.x} out of content bounds`);
	}
	assert.equal(phases.phaseEvents[0]!.y, phases.phaseEvents[2]!.y, "press and release share the control row");

	const simple = results["simple-collapsed-hidden"] as { phaseEventsWhileCollapsed: number; toggledOnCollapsedClick: boolean; expandedFinal: boolean };
	assert.equal(simple.phaseEventsWhileCollapsed, 0, "hidden control must not receive press/motion while collapsed");
	assert.equal(simple.toggledOnCollapsedClick, true);
	assert.equal(simple.expandedFinal, true);

	assert.deepEqual(results["follow-end-anchor"], {
		before: { follow: true, top: 4 },
		after: { follow: false, top: 4, expanded: true },
		scrollCalls: [{ top: 4, disableFollow: true }],
	});
	assert.deepEqual(results["assistant-thinking-rail"], { railExpandedVisible: true, nativeHiddenLabel: false, hideThinkingBlock: false });
	assert.deepEqual(results["assistant-thinking-native"], { hiddenLabelVisible: true });
});