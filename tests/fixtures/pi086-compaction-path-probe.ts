import { writeFileSync } from "node:fs";
import { normalizeContext, Type, type Api, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { compactionIdentity } from "../../tools/gpt-compaction/model-eligibility";
import { rememberRequestContext, resolveCompactionRequestExtras } from "../../tools/gpt-compaction/request-context";

// Exercises the compaction request path in memory through the same
// `convertResponsesTools` binding that `request-context.ts` obtains from
// `core/pi-ai-internal.ts`. No provider request is made and no user credentials
// are read.
//
// The cases deliberately force the reconstruction loop instead of the
// stable-passthrough branch:
//   - `converted`/`nonStrict`: the cached live payload carries `tools: []` while
//     the transcript declares `read`, so byName is non-empty at the final loop
//     and `convertResponsesTools` must run.
//   - `staleReplaced`: the cached wire has a tool named `read` but with a
//     sentinel description and a subset schema; the current declaration differs,
//     so stable=false and the converter must replace it. If conversion were
//     skipped, the sentinel description would survive and the assertion fails.

function tool(description: string, withLimit: boolean): Tool {
	return {
		name: "read",
		description,
		parameters: Type.Object({
			path: Type.String(),
			...(withLimit ? { limit: Type.Optional(Type.Number()) } : {}),
		}),
	};
}

function modelWith(compat: Model<Api>["compat"]): Model<Api> {
	return {
		provider: "rail-native-probe",
		api: "openai-responses",
		id: "gpt-probe",
		name: "GPT Probe",
		baseUrl: "https://gateway.example/v1",
		reasoning: true,
		input: ["text"],
		contextWindow: 100_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(compat ? { compat } : {}),
	};
}

function transcript(current: Tool): Message[] {
	return normalizeContext({ systemPrompt: "probe prompt", tools: [current], messages: [] }).messages;
}

function firstTool(extras: { tools?: unknown[] } | undefined): Record<string, unknown> {
	return (extras?.tools?.[0] ?? {}) as Record<string, unknown>;
}

export default function pi086CompactionPathProbe(): void {
	const outputPath = process.env["PI_RAIL_COMPACTION_PROBE_OUTPUT"];
	if (!outputPath) throw new Error("PI_RAIL_COMPACTION_PROBE_OUTPUT is required");

	// Forced reconstruction: cached payload declares no tools. `strict: false` is
	// passed by request-context.ts because the synthetic request must not opt into
	// server-inferred strict schemas.
	const strictModel = modelWith({ supportsStrictMode: true });
	const strictIdentity = compactionIdentity(strictModel);
	const current = tool("read a file", true);
	const currentMessages = transcript(current);
	rememberRequestContext({ model: strictModel.id, tools: [] }, strictIdentity, "probe-converted", currentMessages);
	const converted = firstTool(resolveCompactionRequestExtras(strictModel, strictIdentity, "probe-converted", currentMessages));

	// Same forced reconstruction with strict mode unsupported: the converter must
	// omit the `strict` key entirely.
	const nonStrictModel = modelWith({ supportsStrictMode: false });
	const nonStrictIdentity = compactionIdentity(nonStrictModel);
	const nonStrictMessages = transcript(current);
	rememberRequestContext({ model: nonStrictModel.id, tools: [] }, nonStrictIdentity, "probe-non-strict", nonStrictMessages);
	const nonStrict = firstTool(resolveCompactionRequestExtras(nonStrictModel, nonStrictIdentity, "probe-non-strict", nonStrictMessages));

	// Stale wire: the cached live request carried a `read` with an older declaration
	// (path only) and a sentinel wire description; the transcript now declares the
	// richer current tool. previous != current, so stable=false and the converter
	// must replace the sentinel entry. Caching with the old transcript (not the
	// current one) is what makes the declarations differ.
	const staleModel = modelWith({ supportsStrictMode: true });
	const staleIdentity = compactionIdentity(staleModel);
	const staleMessages = transcript(current);
	const oldDeclaration = tool("old declaration", false);
	rememberRequestContext({
		model: staleModel.id,
		tools: [{ type: "function", name: "read", description: "stale wire read", parameters: { type: "object", properties: { path: { type: "string" } } }, strict: false }],
	}, staleIdentity, "probe-stale", transcript(oldDeclaration));
	const staleReplaced = firstTool(resolveCompactionRequestExtras(staleModel, staleIdentity, "probe-stale", staleMessages));

	// Negative control: caching with the *same* current declaration takes
	// the stable-passthrough branch, so the wire sentinel description survives
	// untouched. Asserting this in the test proves the forced-reconstruction cases
	// above cannot be satisfied by passthrough: if they were accidentally stable
	// (the original fixture defect), they would expose this sentinel instead of the
	// converted schema.
	const stableModel = modelWith({ supportsStrictMode: true });
	const stableIdentity = compactionIdentity(stableModel);
	const stableMessages = transcript(current);
	rememberRequestContext({
		model: stableModel.id,
		tools: [{ type: "function", name: "read", description: "stale wire read", parameters: { type: "object", properties: { path: { type: "string" } } }, strict: false }],
	}, stableIdentity, "probe-stable", stableMessages);
	const stablePassthrough = firstTool(resolveCompactionRequestExtras(stableModel, stableIdentity, "probe-stable", stableMessages));

	writeFileSync(outputPath, JSON.stringify({
		converted: {
			type: converted["type"],
			name: converted["name"],
			description: converted["description"],
			strict: converted["strict"],
			parameters: converted["parameters"],
		},
		nonStrict: {
			hasStrict: Object.hasOwn(nonStrict, "strict"),
			description: nonStrict["description"],
			parameters: nonStrict["parameters"],
		},
		staleReplaced: {
			description: staleReplaced["description"],
			parameters: staleReplaced["parameters"],
		},
		stablePassthrough: {
			description: stablePassthrough["description"],
			parameters: stablePassthrough["parameters"],
		},
	}), "utf8");
}
