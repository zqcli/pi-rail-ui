import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import {
	compactionIdentity,
	modelSupportsRemoteCompaction,
	type CompactionIdentity,
} from "./model-eligibility";
import {
	planContextReplay,
	planPayloadRewrite,
	rememberLiveRequestContext,
	runNativeRepairCompaction,
	runRemoteCompaction,
} from "./core";
import { resolveCompactionAuth } from "./auth";
import { clearRequestContextCache } from "./request-context";
import { resolveSessionCheckpoint } from "./types";
import {
	gptCompactionSettingsScope,
	parseGptCompactionCommand,
	readGptCompactionSettings,
	writeGptCompactionMode,
	type GptCompactionMode,
} from "./settings";

const STATUS_KEY = "rail-gpt-compaction";
const MISSING_AUTH_FINGERPRINT = "missing-auth";

function safeIdentity(ctx: ExtensionContext): CompactionIdentity | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	return { ...compactionIdentity(model), authFingerprint: MISSING_AUTH_FINGERPRINT };
}

async function resolveRuntimeIdentity(ctx: ExtensionContext): Promise<CompactionIdentity | undefined> {
	const model = ctx.model;
	if (!model) return undefined;
	const auth = await resolveCompactionAuth(ctx, model);
	return auth.ok ? auth.identity : safeIdentity(ctx);
}

function statusText(mode: GptCompactionMode, ctx: ExtensionContext): string {
	if (mode === "off") return "GPT compact: native";
	const support = modelSupportsRemoteCompaction(ctx.model);
	return support.supported ? "GPT compact: remote v2" : "GPT compact: native (inactive)";
}

function updateStatus(mode: GptCompactionMode, ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, statusText(mode, ctx));
}

function notifyFailure(ctx: ExtensionContext, operation: string, reason: string, detail?: string): void {
	const suffix = detail ? `: ${redactSensitiveText(detail)}` : `: ${reason.replaceAll("-", " ")}`;
	ctx.ui.notify(`GPT remote compaction ${operation} failed${suffix}`, "error");
}

function redactSensitiveText(text: string): string {
	return text
		.replace(/\b(Bearer)\s+[^\s,;]+/giu, "$1 [redacted]")
		.replace(/("?(?:encrypted_content|authorization|api[_-]?key|access[_-]?token)"?\s*:\s*")([^"\\]*)(")/giu, "$1[redacted]$3")
		.replace(/((?:encrypted[_ ]content|api\s*key|access\s*token|authorization)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
		.slice(0, 500);
}

function blockedProviderPayload(payload: unknown, reason: string): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { rail_compaction_blocked: true, reason };
	}
	return {
		...(payload as Record<string, unknown>),
		// This is intentionally not a valid Responses input item. The active
		// request is also aborted, so a provider cannot receive the opaque marker
		// when a hook failure is swallowed by Pi.
		input: [{ type: "rail_compaction_blocked", reason }],
	};
}

function markBlocked(signal: AbortSignal | undefined, reason: string, blocked: Map<AbortSignal, string>): void {
	if (signal) blocked.set(signal, reason);
}

/** Install Rail's GPT-only remote compaction seam in every Pi run mode. */
export function installGptCompaction(pi: ExtensionAPI): void {
	let mode: GptCompactionMode = readGptCompactionSettings().mode;
	const blockedRequests = new Map<AbortSignal, string>();

	pi.registerCommand("rail-gpt-compaction", {
		description: "Set GPT Remote Compaction v2 on or off",
		handler: async (args, ctx) => {
			const command = (() => {
				try {
					return parseGptCompactionCommand(args);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
					return undefined;
				}
			})();
			if (!command) return;
			let selectedMode: GptCompactionMode;

			if (command.operation === "menu") {
				const settings = readGptCompactionSettings();
				mode = settings.mode;
				ctx.ui.notify(`GPT Remote Compaction v2 is ${mode} (${gptCompactionSettingsScope(settings.path)}).`, "info");
				if (!ctx.hasUI) {
					updateStatus(mode, ctx);
					return;
				}
				const selected = await ctx.ui.select("GPT Remote Compaction v2", ["on", "off"]);
				if (selected !== "on" && selected !== "off") return;
				selectedMode = selected;
			} else {
				selectedMode = command.mode;
			}

			await ctx.waitForIdle();
			try {
				const saved = writeGptCompactionMode(selectedMode);
				mode = saved.mode;
				updateStatus(mode, ctx);
				ctx.ui.notify(`GPT Remote Compaction v2 ${mode} (${gptCompactionSettingsScope(saved.path)}).`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not save GPT compaction settings: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const settings = readGptCompactionSettings();
		mode = settings.mode;
		clearRequestContextCache(ctx.sessionManager.getSessionId());
		blockedRequests.clear();
		if (settings.warning) ctx.ui.notify(settings.warning, "warning");
		updateStatus(mode, ctx);
	});

	pi.on("model_select", async (_event, ctx) => updateStatus(mode, ctx));
	pi.on("session_tree", async (_event, ctx) => updateStatus(mode, ctx));
	pi.on("session_compact", async (_event, ctx) => updateStatus(mode, ctx));
	pi.on("session_compact_failed", async (_event, ctx) => updateStatus(mode, ctx));

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		const support = modelSupportsRemoteCompaction(model);
		const checkpoint = resolveSessionCheckpoint(event.branchEntries);

		if (mode === "on" && support.supported) {
			const outcome = await runRemoteCompaction({ event, ctx });
			if (outcome.outcome === "success") return { compaction: outcome.compaction };
			if (outcome.outcome === "aborted") return { cancel: true };
			notifyFailure(ctx, "before it could be installed", outcome.reason, outcome.detail);
			// Pi's extension runner swallows handler exceptions. Cancelling here is
			// the only safe way to prevent the native summarizer from seeing a
			// provider-bound checkpoint after a remote failure.
			return { cancel: true };
		}

		if (checkpoint.status === "remote" || checkpoint.status === "invalid") {
			const outcome = await runNativeRepairCompaction({ event, ctx });
			if (outcome.outcome === "success") return { compaction: outcome.compaction };
			if (outcome.outcome === "aborted") return { cancel: true };
			notifyFailure(ctx, "while repairing native history", outcome.reason, outcome.detail);
			return { cancel: true };
		}
		return undefined;
	});

	pi.on("context", async (event, ctx) => {
		const branchEntries = ctx.sessionManager.getBranch();
		if (resolveSessionCheckpoint(branchEntries).status !== "remote") return undefined;
		const support = modelSupportsRemoteCompaction(ctx.model);
		const identity = support.supported ? await resolveRuntimeIdentity(ctx) : safeIdentity(ctx);
		const storedMessages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
		const decision = planContextReplay({
			ctx,
			branchEntries,
			remoteEnabled: mode === "on" && support.supported && identity?.authFingerprint !== MISSING_AUTH_FINGERPRINT,
			...(identity ? { identity } : {}),
			messages: event.messages,
			storedMessages,
		});
		if (decision.action === "replace") return { messages: decision.messages };
		if (decision.action === "abort") {
			markBlocked(ctx.signal, decision.reason, blockedRequests);
			ctx.abort();
		}
		return { messages: event.messages };
	});

	pi.on("before_provider_request", async (event, ctx) => {
		try {
			const branchEntries = ctx.sessionManager.getBranch();
			const checkpoint = resolveSessionCheckpoint(branchEntries);
			const model = ctx.model;
			if (checkpoint.status !== "remote" || !model) {
				rememberLiveRequestContext(ctx, event.payload);
				return undefined;
			}
			const support = modelSupportsRemoteCompaction(model);
			const identity = support.supported ? await resolveRuntimeIdentity(ctx) : safeIdentity(ctx);
			const signalReason = ctx.signal ? blockedRequests.get(ctx.signal) : undefined;
			const decision = planPayloadRewrite({
				ctx,
				branchEntries,
				payload: event.payload,
				remoteEnabled: mode === "on" && support.supported && identity?.authFingerprint !== MISSING_AUTH_FINGERPRINT,
				...(identity ? { identity } : {}),
			});
			if (signalReason || decision.action === "fail") {
				const reason = signalReason ?? (decision.action === "fail" ? decision.reason : "checkpoint-replay-failed");
				markBlocked(ctx.signal, reason, blockedRequests);
				ctx.abort();
				return blockedProviderPayload(event.payload, reason);
			}
			const nextPayload = decision.action === "rewrite" ? decision.payload : event.payload;
			rememberLiveRequestContext(ctx, nextPayload);
			return decision.action === "rewrite" ? nextPayload : undefined;
		} catch (error) {
			const reason = "provider-replay-hook-failed";
			markBlocked(ctx.signal, reason, blockedRequests);
			ctx.abort();
			ctx.ui.notify(`GPT compaction request blocked: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`, "error");
			return blockedProviderPayload(event.payload, reason);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.signal) blockedRequests.delete(ctx.signal);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.signal) blockedRequests.delete(ctx.signal);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		clearRequestContextCache(ctx.sessionManager.getSessionId());
		blockedRequests.clear();
	});
}
