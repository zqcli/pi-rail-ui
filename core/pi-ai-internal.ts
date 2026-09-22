import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

/**
 * Pi's extension loader only aliases the public `@earendil-works/pi-ai`
 * entrypoints. jiti prefix-rewrites a deep specifier such as
 * `@earendil-works/pi-ai/api/openai-responses-shared` onto the aliased
 * `compat.js`, which cannot resolve, and the compiled Node bundle exposes no
 * such subpaths either. The stateless internals Rail needs are therefore loaded
 * from the pi-ai dist directory installed for the running Pi.
 *
 * Resolution anchors on `getPackageDir()` (which honors `PI_PACKAGE_DIR`) and
 * asks Node for its standard module search paths, so pnpm links, hoisted and
 * nested installs, and Windows global prefixes are covered without a hand-rolled
 * layout walk. The extension's own `node_modules` is not part of that search, so
 * only the pi-ai shipped with the running Pi can be selected.
 *
 * Only stateless modules belong here. pi-ai's provider registry and event-stream
 * classes must keep coming from the public `@earendil-works/pi-ai` entrypoint so
 * the extension and host share a single instance.
 */

const PI_AI_PACKAGE = "@earendil-works/pi-ai";
const PI_AI_SCOPE = join("@earendil-works", "pi-ai");
const DIST_ENTRY = "index.js";

function resolvePiAiDistDir(): string {
	// pi-ai's `exports` map is `import`-only, so `require.resolve(specifier)`
	// cannot resolve it; `resolve.paths` still reports the standard node_modules
	// search directories for the specifier, anchored at the Pi package.
	const require = createRequire(pathToFileURL(join(getPackageDir(), "package.json")));
	for (const searchPath of require.resolve.paths(PI_AI_PACKAGE) ?? []) {
		const distDir = join(searchPath, PI_AI_SCOPE, "dist");
		if (existsSync(join(distDir, DIST_ENTRY))) return distDir;
	}
	throw new Error(
		"pi-rail: cannot locate the @earendil-works/pi-ai installation bundled with the running Pi; "
		+ "deep pi-ai internals are required and are unavailable in single-file Pi binaries",
	);
}

const piAiDistDir = resolvePiAiDistDir();

async function importPiAiDistModule<T>(relativePath: string): Promise<T> {
	const file = join(piAiDistDir, relativePath);
	if (!existsSync(file)) {
		throw new Error(`pi-rail: @earendil-works/pi-ai/dist/${relativePath} is missing from the running Pi installation`);
	}
	return (await import(pathToFileURL(file).href)) as T;
}

export const responsesShared = await importPiAiDistModule<typeof import("@earendil-works/pi-ai/api/openai-responses-shared")>("api/openai-responses-shared.js");
export const constrainedSampling = await importPiAiDistModule<typeof import("@earendil-works/pi-ai/api/constrained-sampling")>("api/constrained-sampling.js");
export const promptCache = await importPiAiDistModule<typeof import("@earendil-works/pi-ai/api/openai-prompt-cache")>("api/openai-prompt-cache.js");
export const simpleOptions = await importPiAiDistModule<typeof import("@earendil-works/pi-ai/api/simple-options")>("api/simple-options.js");
export const providerErrors = await importPiAiDistModule<typeof import("@earendil-works/pi-ai/utils/error-body")>("utils/error-body.js");
export const providerEnv = await importPiAiDistModule<typeof import("@earendil-works/pi-ai/utils/provider-env")>("utils/provider-env.js");
