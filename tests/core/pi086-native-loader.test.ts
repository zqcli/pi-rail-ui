import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	bundledCli,
	cleanup,
	DEEP_IMPORT_FAILURE,
	installProductionCopy,
	REPO_ROOT,
	runChild,
	runtimeEntry,
	type RuntimePackage,
	unbundledCli,
	writeWebSocketRoute,
} from "../helpers/native-loader-harness";

// Regression for the Pi startup failure "Cannot find module
// '@earendil-works/pi-ai/api/constrained-sampling'", reported on 0.86.0 and
// 0.86.1. Pi's native extension loader (jiti) virtualizes only the pi-ai
// root/compat/oauth/providers entrypoints, so any `@earendil-works/pi-ai/api/*`
// or `.../utils/*` deep import in an installed extension cannot resolve. The
// repository's devDependency `node_modules/@earendil-works/pi-ai` masks that
// failure for any file under the repo, and an ancestor `node_modules` masks it
// for `.tmp` too. Every load case therefore runs from a copied, production-only
// layout created under the OS temp directory: source entries plus the `ws`
// runtime dependency, no pi-ai.
//
// The Pi runtime is passed in explicitly rather than derived from the repo, so
// the same cases run against the repo's pinned 0.86.0 devDependency and against
// an explicitly provided 0.86.1 install without the repo copy leaking into the
// run. The default suite never downloads anything.
//
// A generation is never started: children receive only a `get_state` RPC and the
// probe fixtures never call a provider, read credentials, or read user logs.
// PI_OFFLINE/PI_TELEMETRY keep the host offline, and HOME/PI_CODING_AGENT_DIR
// point at the temp dir.

const EXPECTED_TOOLS = ["apply-patch", "subagent"];
const EXPECTED_COMMANDS = [
	"rail-agent",
	"rail-duplicate",
	"rail-oai-compaction",
	"rail-oai-fast",
	"rail-oai-search",
	"rail-session",
	"rail-ui",
];

interface ObservedRegistrations {
	tools: string[];
	activeTools: string[];
	commands: string[];
	provider: { api: string | null; hasStreamSimple: boolean } | null;
}

interface LoadedExtensions {
	extensionCount: number;
	errors: Array<{ path: string; error: string }>;
	tools: string[];
	commands: string[];
	events: string[];
}

function repoRuntime(): RuntimePackage {
	return { packageDir: join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent"), version: "0.86.0" };
}

/** Read the installed version so a mismatched runtime path cannot pass silently. */
async function installedVersion(runtime: RuntimePackage): Promise<string> {
	const { version } = JSON.parse(await readFile(join(runtime.packageDir, "package.json"), "utf8")) as { version: string };
	return version;
}

async function assertRuntimeVersion(runtime: RuntimePackage): Promise<void> {
	assert.equal(await installedVersion(runtime), runtime.version, `runtime at ${runtime.packageDir} must be ${runtime.version}`);
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

/**
 * Create the production-only install under a temp root that contains a space and
 * a non-ASCII character. `t.after` is registered before any copy so a setup
 * failure still removes the root this test created.
 */
async function setupCase(t: TestContext, sourceRoot: string, options: { piAiDecoy?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi native π rail-"));
	t.after(async () => { await cleanup(root); });
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const installation = await installProductionCopy(root, sourceRoot, options);
	await writeWebSocketRoute(agentDir);
	return { root, home, agentDir, installation, index: join(installation, "index.ts") };
}

function extensionArgs(...paths: string[]): string[] {
	return [
		"--mode", "rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--offline",
		...paths.flatMap((path) => ["-e", path]),
	];
}

/** Run the four positive loader/path cases against one Pi runtime + code source. */
async function runPositiveMatrix(t: TestContext, runtime: RuntimePackage, sourceRoot: string): Promise<void> {
	await assertRuntimeVersion(runtime);
	const cases = await setupCase(t, sourceRoot);
	const baseEnv = { HOME: cases.home, PI_CODING_AGENT_DIR: cases.agentDir };

	// Bundled distribution loader: index.ts + observer in one process.
	const bundledObservedPath = join(cases.root, "observed-bundled.json");
	const bundled = await runChild(process.execPath, [
		bundledCli(runtime),
		...extensionArgs(cases.index, join(cases.installation, "tests/fixtures/pi086-registration-observer.ts")),
	], { ...baseEnv, PI_RAIL_REGISTRATION_OUTPUT: bundledObservedPath }, cases.root, 80_000);
	assert.equal(bundled.exitCode, 0, bundled.stderr || bundled.stdout);
	assert.doesNotMatch(bundled.stderr, DEEP_IMPORT_FAILURE, "extension load must not report an unresolved pi-ai deep import");
	assert.doesNotMatch(bundled.stderr, /Failed to load extension/u, "extension load must not report a load failure");
	assert.match(bundled.stdout, /"command":"get_state","success":true/u);
	assert.equal(/agent_start|message_start/u.test(bundled.stdout), false, "the probe must not start a generation");
	const observed = await readJson<ObservedRegistrations>(bundledObservedPath);
	for (const tool of EXPECTED_TOOLS) assert.ok(observed.tools.includes(tool), `tool ${tool} must be registered`);
	assert.ok(observed.activeTools.includes("subagent"), "the subagent tool must be active");
	for (const command of EXPECTED_COMMANDS) assert.ok(observed.commands.includes(command), `command ${command} must be registered`);
	// The WebSocket provider wrapper only appears after session_start handlers ran.
	assert.deepEqual(observed.provider, { api: "openai-responses", hasStreamSimple: true });
	assert.match(bundled.stdout, /rail-oai-fast/u);
	assert.match(bundled.stdout, /rail-oai-search/u);
	assert.match(bundled.stdout, /rail-gpt-compaction/u);

	// Unbundled distribution loader (dist-alias jiti branch).
	const unbundledObservedPath = join(cases.root, "observed-unbundled.json");
	const unbundled = await runChild(process.execPath, [
		unbundledCli(runtime),
		...extensionArgs(cases.index, join(cases.installation, "tests/fixtures/pi086-registration-observer.ts")),
	], { ...baseEnv, PI_RAIL_REGISTRATION_OUTPUT: unbundledObservedPath }, cases.root, 80_000);
	assert.equal(unbundled.exitCode, 0, unbundled.stderr || unbundled.stdout);
	assert.doesNotMatch(unbundled.stderr, DEEP_IMPORT_FAILURE, "unbundled loader must not report an unresolved pi-ai deep import");
	assert.doesNotMatch(unbundled.stderr, /Failed to load extension/u);
	const unbundledObserved = await readJson<ObservedRegistrations>(unbundledObservedPath);
	for (const tool of EXPECTED_TOOLS) assert.ok(unbundledObserved.tools.includes(tool), `tool ${tool} must be registered`);
	for (const command of EXPECTED_COMMANDS) assert.ok(unbundledObserved.commands.includes(command), `command ${command} must be registered`);

	// SDK loader, importing the runtime by explicit path.
	const sdkOutputPath = join(cases.root, "sdk-loader.json");
	const sdk = await runChild(process.execPath, [join(cases.installation, "tests/fixtures/pi086-sdk-loader.mjs")], {
		...baseEnv,
		PI_RAIL_SDK_INDEX: cases.index,
		PI_RAIL_SDK_RUNTIME_ENTRY: runtimeEntry(runtime),
		PI_RAIL_SDK_CWD: cases.root,
		PI_RAIL_SDK_AGENT_DIR: cases.agentDir,
		PI_RAIL_SDK_OUTPUT: sdkOutputPath,
	}, cases.root, 80_000);
	assert.equal(sdk.exitCode, 0, sdk.stderr || sdk.stdout);
	const loaded = await readJson<LoadedExtensions>(sdkOutputPath);
	assert.deepEqual(loaded.errors, [], "the SDK loader must not report extension errors");
	assert.equal(loaded.extensionCount, 1);
	for (const tool of EXPECTED_TOOLS) assert.ok(loaded.tools.includes(tool), `tool ${tool} must be registered`);
	for (const command of EXPECTED_COMMANDS) assert.ok(loaded.commands.includes(command), `command ${command} must be registered`);
	for (const event of ["session_start", "before_provider_request", "session_before_compact"]) {
		assert.ok(loaded.events.includes(event), `hook ${event} must be registered`);
	}

	// Compaction path: in-memory exercise of the openai-responses-shared binding.
	// The fixture forces the reconstruction loop (cached wire has no tools) and the
	// stale-replacement branch (cached wire name matches but declaration differs),
	// so the assertions must observe the converter's own output rather than a
	// passthrough.
	const compactionPath = join(cases.root, "compaction-path.json");
	const compaction = await runChild(process.execPath, [
		bundledCli(runtime),
		...extensionArgs(join(cases.installation, "tests/fixtures/pi086-compaction-path-probe.ts")),
	], { ...baseEnv, PI_RAIL_COMPACTION_PROBE_OUTPUT: compactionPath }, cases.root, 80_000);
	assert.equal(compaction.exitCode, 0, compaction.stderr || compaction.stdout);
	assert.doesNotMatch(compaction.stderr, DEEP_IMPORT_FAILURE);
	const convertedParameters = {
		type: "object",
		required: ["path"],
		properties: { path: { type: "string" }, limit: { type: "number" } },
	};
	assert.deepEqual(await readJson(compactionPath), {
		// Forced reconstruction with strict supported: converter emits a full
		// function tool, converts the optional field, and passes strict:false.
		converted: {
			type: "function",
			name: "read",
			description: "read a file",
			strict: false,
			parameters: convertedParameters,
		},
		// strict mode unsupported: the converter must omit the `strict` key.
		nonStrict: {
			hasStrict: false,
			description: "read a file",
			parameters: convertedParameters,
		},
		// Cached wire had a `read` with a sentinel description and a subset schema;
		// the converter must replace it with the current declaration.
		staleReplaced: {
			description: "read a file",
			parameters: convertedParameters,
		},
		// Negative control: the stable-passthrough branch (cache and transcript
		// declarations equal) leaves the wire sentinel description and subset schema
		// untouched. If a positive case above were accidentally stable — the original
		// fixture defect — it would expose this shape instead of the converted one.
		stablePassthrough: {
			description: "stale wire read",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	});
}

test("Pi 0.86.0 native loaders boot the real installed extension from a production-only layout", { timeout: 120_000 }, async (t) => {
	await runPositiveMatrix(t, repoRuntime(), REPO_ROOT);
});

test("harness sensitivity: a reintroduced pi-ai deep import fails the native load", { timeout: 60_000 }, async (t) => {
	// Proves the production-only copy reproduces the reported failure instead of
	// silently resolving through repo devDependencies.
	const runtime = repoRuntime();
	await assertRuntimeVersion(runtime);
	const cases = await setupCase(t, REPO_ROOT);
	const deepImportPath = join(cases.installation, "deep-import.ts");
	await writeFile(deepImportPath, [
		"import { createGrammarToolInputProperties } from \"@earendil-works/pi-ai/api/constrained-sampling\";",
		"export default function probe(): void { void createGrammarToolInputProperties; }",
		"",
	].join("\n"));
	const result = await runChild(process.execPath, [
		bundledCli(runtime),
		...extensionArgs(deepImportPath),
	], { HOME: cases.home, PI_CODING_AGENT_DIR: cases.agentDir }, cases.root, 30_000);
	assert.notEqual(result.exitCode, 0, "an unresolvable pi-ai deep import must fail the load");
	assert.match(result.stderr, /Cannot find module '@earendil-works\/pi-ai\/api\/constrained-sampling'/u);
});

test("an extension-local decoy @earendil-works/pi-ai is not used in place of the running Pi dependency", { timeout: 120_000 }, async (t) => {
	// A real deployment can leave a stale extension-local pi-ai copy behind. The
	// decoy throws on every entry, so any resolution path that prefers the
	// extension's own copy over the running Pi dependency fails the load.
	const runtime = repoRuntime();
	await assertRuntimeVersion(runtime);
	const cases = await setupCase(t, REPO_ROOT, { piAiDecoy: true });
	const result = await runChild(process.execPath, [
		bundledCli(runtime),
		...extensionArgs(cases.index, join(cases.installation, "tests/fixtures/pi086-registration-observer.ts")),
	], { HOME: cases.home, PI_CODING_AGENT_DIR: cases.agentDir, PI_RAIL_REGISTRATION_OUTPUT: join(cases.root, "observed.json") }, cases.root, 80_000);
	assert.equal(result.exitCode, 0, result.stderr || result.stdout);
	assert.doesNotMatch(result.stderr, /decoy @earendil-works\/pi-ai must not be imported/u);
	assert.doesNotMatch(result.stderr, /Failed to load extension/u);
	const observed = await readJson<ObservedRegistrations>(join(cases.root, "observed.json"));
	for (const tool of EXPECTED_TOOLS) assert.ok(observed.tools.includes(tool), `tool ${tool} must be registered`);
});

// ---------------------------------------------------------------------------
// Opt-in Pi 0.86.1 matrix
// ---------------------------------------------------------------------------
// The default suite never downloads Pi and never touches the repo package files.
// To verify 0.86.1, install it yourself into an isolated temp prefix outside the
// repo and point PI_RAIL_0861_RUNTIME at the package directory:
//
//   npm install --prefix /tmp/pi-0861 --no-save @earendil-works/pi-coding-agent@0.86.1
//   PI_RAIL_0861_RUNTIME=/tmp/pi-0861/node_modules/@earendil-works/pi-coding-agent \
//     npx --no-install tsx --test tests/core/pi086-native-loader.test.ts
//
// The version is read from the package's own package.json and asserted against
// 0.86.1, so a stale repo copy cannot masquerade as the download.

const pi0861RuntimeDir = process.env["PI_RAIL_0861_RUNTIME"];

test("Pi 0.86.1 (opt-in) boots the installed extension on bundle, unbundle, SDK, and compaction paths", { timeout: 180_000, skip: pi0861RuntimeDir ? false : "set PI_RAIL_0861_RUNTIME to an isolated 0.86.1 install" }, async (t) => {
	await runPositiveMatrix(t, { packageDir: pi0861RuntimeDir!, version: "0.86.1" }, REPO_ROOT);
});
