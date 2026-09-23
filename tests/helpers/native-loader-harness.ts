import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Shared harness for the native-loader regression shard. It takes an explicit Pi
// coding-agent package directory instead of deriving the runtime from the repo,
// so the same cases run against the repo's pinned 0.86.0 devDependency and
// against an explicitly provided 0.86.1 install without letting the repo copy
// leak into the run.

export interface RuntimePackage {
	/** Absolute path to an installed `@earendil-works/pi-coding-agent` package. */
	packageDir: string;
	/** Version asserted against the package's own package.json. */
	version: string;
}

export interface ChildResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface RpcSequenceResult extends ChildResult {
	responses: Array<Record<string, unknown>>;
}

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const PRODUCTION_ENTRIES = ["index.ts", "components", "commands", "config", "core", "openai", "rail", "tools"];
export const DEEP_IMPORT_FAILURE = /Cannot find module '@earendil-works\/pi-ai\/(?:api|utils)\//u;

export function bundledCli(runtime: RuntimePackage): string {
	return join(runtime.packageDir, "dist/bundle/cli.js");
}

export function unbundledCli(runtime: RuntimePackage): string {
	return join(runtime.packageDir, "dist/cli.js");
}

export function runtimeEntry(runtime: RuntimePackage): string {
	return join(runtime.packageDir, "dist/index.js");
}

function fixture(name: string): string {
	return join(REPO_ROOT, "tests/fixtures", name);
}

export async function runChild(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<ChildResult> {
	// Drop host/ancestor selectors that would redirect the chosen runtime away
	// from the one under test: PI_PACKAGE_DIR overrides `getPackageDir()` and
	// NODE_PATH adds fallback resolution. This only shapes the child env, never
	// the process environment.
	const inherited = { ...process.env };
	delete inherited["PI_PACKAGE_DIR"];
	delete inherited["NODE_PATH"];

	let child: ChildProcess | undefined;
	let closed: Promise<void> | undefined;
	const killTimer = setTimeout(() => child?.kill("SIGKILL"), timeoutMs);
	try {
		child = spawn(command, args, {
			cwd,
			env: { ...inherited, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SUBAGENT_DEPTH: "0", ...env },
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
		// Only an offline state query; no prompt, so no provider request can run.
		child.stdin!.end(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
		const exitCode = await exited;
		clearTimeout(killTimer);
		await closed;
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(killTimer);
		if (child && child.exitCode === null) {
			child.kill("SIGKILL");
			await Promise.race([closed ?? Promise.resolve(), new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
		}
	}
}

/** Run ordered RPC commands and close stdin only after every expected response. */
export async function runRpcSequence(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
	requests: readonly Record<string, unknown>[],
	timeoutMs: number,
): Promise<RpcSequenceResult> {
	const inherited = { ...process.env };
	delete inherited["PI_PACKAGE_DIR"];
	delete inherited["NODE_PATH"];

	let child: ChildProcess | undefined;
	let closed: Promise<void> | undefined;
	let stdout = "";
	let stderr = "";
	let inputBuffer = "";
	let exitedCode: number | null = null;
	let exitedError: Error | undefined;
	const waiters = new Map<string, { resolve(response: Record<string, unknown>): void; reject(error: Error): void }>();
	const responses: Array<Record<string, unknown>> = [];
	const rejectWaiters = (error: Error) => {
		for (const waiter of waiters.values()) waiter.reject(error);
		waiters.clear();
	};

	const killTimer = setTimeout(() => child?.kill("SIGKILL"), timeoutMs);
	try {
		child = spawn(command, args, {
			cwd,
			env: { ...inherited, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SUBAGENT_DEPTH: "0", ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout!.setEncoding("utf8");
		child.stderr!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => {
			stdout = `${stdout}${chunk}`.slice(-1_000_000);
			inputBuffer += chunk;
			while (true) {
				const newline = inputBuffer.indexOf("\n");
				if (newline < 0) break;
				let line = inputBuffer.slice(0, newline);
				inputBuffer = inputBuffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line) continue;
				let parsed: unknown;
				try { parsed = JSON.parse(line); } catch { continue; }
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				const response = parsed as Record<string, unknown>;
				if (response["type"] !== "response" || typeof response["id"] !== "string") continue;
				const waiter = waiters.get(response["id"]);
				if (!waiter) continue;
				waiters.delete(response["id"]);
				waiter.resolve(response);
			}
		});
		child.stderr!.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_000_000); });
		const exited = new Promise<number | null>((resolve, reject) => {
			child!.once("error", (error) => {
				exitedError = error instanceof Error ? error : new Error(String(error));
				reject(exitedError);
			});
			child!.once("exit", (code) => {
				exitedCode = code;
				rejectWaiters(new Error(`RPC child exited before the expected response (code ${String(code)})`));
				resolve(code);
			});
		});
		closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));

		for (const [index, request] of requests.entries()) {
			const id = typeof request["id"] === "string" ? request["id"] as string : `rpc-${index}`;
			const response = new Promise<Record<string, unknown>>((resolve, reject) => waiters.set(id, { resolve, reject }));
			child.stdin!.write(`${JSON.stringify({ ...request, id })}\n`);
			const value = await response;
			responses.push(value);
			if (value["success"] !== true) throw new Error(`RPC ${String(request["type"])} failed: ${String(value["error"] ?? "unknown error")}`);
		}
		child.stdin!.end();
		await exited;
		await closed;
		return { exitCode: exitedCode, stdout, stderr, responses };
	} catch (error) {
		if (exitedError) throw exitedError;
		throw error;
	} finally {
		clearTimeout(killTimer);
		if (child && child.exitCode === null) {
			rejectWaiters(new Error("RPC child terminated before all commands completed"));
			child.kill("SIGKILL");
			await Promise.race([closed ?? Promise.resolve(), new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
		}
	}
}

/**
 * Copy the extension sources into `root` as a production deployment: source
 * entries, `ui-style.json`, the `ws` runtime dependency, and the probe fixtures.
 * No `@earendil-works/pi-ai` is copied, which is what makes a deep pi-ai import
 * fail like it does for a real user. The runtime is reached by explicit path
 * (`-e` CLI, or PI_RAIL_SDK_RUNTIME_ENTRY), so the copy needs no
 * pi-coding-agent in its own node_modules.
 *
 * With `piAiDecoy`, an extension-local `@earendil-works/pi-ai` whose every entry
 * throws is planted. If any resolution path prefers the extension's own copy
 * over the running Pi dependency, the load fails loudly.
 */
export async function installProductionCopy(root: string, sourceRoot: string, options: { piAiDecoy?: boolean } = {}): Promise<string> {
	const extension = join(root, "pi-rail-ui");
	await mkdir(join(extension, "node_modules"), { recursive: true });
	for (const entry of PRODUCTION_ENTRIES) {
		await cp(join(sourceRoot, entry), join(extension, entry), { recursive: true });
	}
	await cp(join(sourceRoot, "ui-style.json"), join(extension, "ui-style.json"));
	await cp(join(REPO_ROOT, "node_modules/ws"), join(extension, "node_modules/ws"), { recursive: true });
	if (options.piAiDecoy) await writePiAiDecoy(join(extension, "node_modules/@earendil-works/pi-ai"));
	// Probes are copied to the same depth they occupy in the repo (tests/fixtures)
	// so their `../../tools/...` imports resolve inside the install copy too.
	const fixtures = join(extension, "tests/fixtures");
	await mkdir(fixtures, { recursive: true });
	await cp(fixture("pi086-registration-observer.ts"), join(fixtures, "pi086-registration-observer.ts"));
	await cp(fixture("pi086-compaction-path-probe.ts"), join(fixtures, "pi086-compaction-path-probe.ts"));
	await cp(fixture("pi086-sdk-loader.mjs"), join(fixtures, "pi086-sdk-loader.mjs"));
	return extension;
}

async function writePiAiDecoy(packageDir: string): Promise<void> {
	const guard = "throw new Error(\"decoy @earendil-works/pi-ai must not be imported\");\n";
	await mkdir(packageDir, { recursive: true });
	await writeFile(join(packageDir, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-ai",
		version: "0.0.0-decoy",
		type: "module",
		main: "./dist/index.js",
		exports: {
			".": "./dist/index.js",
			"./compat": "./dist/compat.js",
			"./oauth": "./dist/oauth.js",
			"./providers/*": "./dist/providers/*.js",
			"./api/*": "./dist/api/*.js",
			"./utils/*": "./dist/utils/*.js",
		},
	}), "utf8");
	for (const relative of [
		"dist/index.js",
		"dist/compat.js",
		"dist/oauth.js",
		"dist/api/constrained-sampling.js",
		"dist/api/openai-responses-shared.js",
		"dist/api/openai-prompt-cache.js",
		"dist/api/simple-options.js",
		"dist/utils/error-body.js",
		"dist/utils/provider-env.js",
		"dist/utils/transcript.js",
	]) {
		const file = join(packageDir, relative);
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, guard);
	}
}

export async function writeWebSocketRoute(agentDir: string): Promise<void> {
	await mkdir(join(agentDir, "rail-openai-responses-ws"), { recursive: true });
	await writeFile(join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"rail-ws-probe": {
				baseUrl: "https://gateway.example/v1",
				apiKey: "probe-key",
				api: "openai-responses",
				models: [{
					id: "gpt-probe",
					name: "GPT Probe",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4096,
				}],
			},
		},
	}));
	await writeFile(join(agentDir, "rail-openai-responses-ws/settings.json"), JSON.stringify({
		version: 1,
		routes: [{ provider: "rail-ws-probe", endpoint: "wss://gateway.example/v1/responses", models: ["gpt-probe"] }],
	}));
}

export async function cleanup(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}
