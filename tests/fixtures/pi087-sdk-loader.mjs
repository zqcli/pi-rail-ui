// Drives the SDK extension loader directly against an explicitly provided Pi
// runtime package. Importing by file URL (instead of the bare specifier) keeps
// a repo-local `@earendil-works/pi-coding-agent` from silently resolving when
// this runs against the repository's isolated 0.87.0 install. `discoverAndLoadExtensions` is
// the public entry point for the loader branch the unbundled runtime and
// DefaultResourceLoader use; cwd and agentDir point at isolated temp dirs so
// discovery contributes nothing and the result is exactly the explicit install.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const installIndex = process.env["PI_RAIL_SDK_INDEX"];
const runtimeEntry = process.env["PI_RAIL_SDK_RUNTIME_ENTRY"];
const cwd = process.env["PI_RAIL_SDK_CWD"];
const agentDir = process.env["PI_RAIL_SDK_AGENT_DIR"];
const outputPath = process.env["PI_RAIL_SDK_OUTPUT"];
if (!installIndex || !runtimeEntry || !cwd || !agentDir || !outputPath) {
	throw new Error("PI_RAIL_SDK_INDEX, PI_RAIL_SDK_RUNTIME_ENTRY, PI_RAIL_SDK_CWD, PI_RAIL_SDK_AGENT_DIR and PI_RAIL_SDK_OUTPUT are required");
}

const { discoverAndLoadExtensions } = await import(pathToFileURL(runtimeEntry).href);
const { extensions, errors } = await discoverAndLoadExtensions([installIndex], cwd, agentDir);
writeFileSync(outputPath, JSON.stringify({
	extensionCount: extensions.length,
	errors,
	tools: extensions.flatMap((extension) => [...extension.tools.keys()]).sort(),
	commands: extensions.flatMap((extension) => [...extension.commands.keys()]).sort(),
	events: extensions.flatMap((extension) => [...extension.handlers.keys()]).sort(),
}), "utf8");

process.exit(errors.length === 0 ? 0 : 1);
