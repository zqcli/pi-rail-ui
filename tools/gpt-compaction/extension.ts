import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext, estimateTokens, findCutPoint, getAgentDir, sessionEntryToContextMessages, SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	compactionIdentity,
	identitiesMatch,
	modelSupportsRemoteCompaction,
	type CompactionIdentity,
} from "./model-eligibility";
import {
	planContextReplay,
	planPayloadRewrite,
	rebuiltBranchMessages,
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
const installedApis = new WeakSet<object>();

export function gptCompactionExtensionPath(): string {
	return fileURLToPath(new URL("./standalone-extension.ts", import.meta.url));
}

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
	return support.supported ? "GPT compact: remote v2" : `GPT compact: native (inactive — ${support.detail})`;
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

type MutableSessionManager = {
	branch(branchFromId: string): void;
	resetLeaf(): void;
	appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: unknown, fromHook?: boolean, usage?: unknown): string;
	appendMessage(message: unknown): string;
	appendModelChange(provider: string, modelId: string): string;
	appendThinkingLevelChange(thinkingLevel: string): string;
	appendCustomEntry(customType: string, data?: unknown): string;
	appendCustomMessageEntry(customType: string, content: unknown, display: boolean, details?: unknown): string;
	appendSessionInfo(name: string): string;
	appendLabelChange(targetId: string, label: string | undefined): string;
};

function isReplayableTailEntry(entry: SessionEntry): boolean {
	return entry.type === "message"
		|| entry.type === "model_change"
		|| entry.type === "thinking_level_change"
		|| entry.type === "custom"
		|| entry.type === "custom_message"
		|| entry.type === "session_info"
		|| entry.type === "label";
}

function appendTailEntry(manager: MutableSessionManager, entry: SessionEntry): void {
	switch (entry.type) {
		case "message":
			manager.appendMessage(entry.message);
			return;
		case "model_change":
			manager.appendModelChange(entry.provider, entry.modelId);
			return;
		case "thinking_level_change":
			manager.appendThinkingLevelChange(entry.thinkingLevel);
			return;
		case "custom":
			manager.appendCustomEntry(entry.customType, entry.data);
			return;
		case "custom_message":
			manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
			return;
		case "session_info":
			if (entry.name !== undefined) manager.appendSessionInfo(entry.name);
			return;
		case "label":
			manager.appendLabelChange(entry.targetId, entry.label);
			return;
		default:
			throw new Error(`unsupported-live-tail-entry:${entry.type}`);
	}
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
	if (installedApis.has(pi as object)) return;
	installedApis.add(pi as object);
	let mode: GptCompactionMode = readGptCompactionSettings().mode;
	const blockedRequests = new Map<AbortSignal, string>();
	let pendingContextRefresh: { previousMessages: AgentMessage[] } | undefined;
	const syncMode = (): GptCompactionMode => {
		mode = readGptCompactionSettings().mode;
		return mode;
	};
	const repairBeforeDisabling = async (ctx: ExtensionContext): Promise<{ ok: true } | { ok: false; detail: string }> => {
		const branch = ctx.sessionManager.getBranch();
		const checkpoint = resolveSessionCheckpoint(branch);
		if (checkpoint.status !== "remote" && checkpoint.status !== "invalid") return { ok: true };
		const checkpointIndex = branch.findIndex((entry) => entry.id === checkpoint.entry.id);
		if (checkpointIndex < 0) return { ok: false, detail: "checkpoint-boundary-not-found" };
		const originalBranch = branch.slice(0, checkpointIndex);
		const settings = SettingsManager.create(ctx.cwd, getAgentDir()).getCompactionSettings();
		const checkpointFirstKeptIndex = originalBranch.findIndex((entry) => entry.id === checkpoint.entry.firstKeptEntryId);
		const cutPoint = checkpointFirstKeptIndex > 0
			? undefined
			: findCutPoint(originalBranch, 0, originalBranch.length, settings.keepRecentTokens);
		const firstKeptIndex = checkpointFirstKeptIndex > 0 ? checkpointFirstKeptIndex : cutPoint?.firstKeptEntryIndex ?? -1;
		const firstKeptEntry = originalBranch[firstKeptIndex];
		if (!firstKeptEntry?.id) return { ok: false, detail: "no-repair-source" };
		const historyEnd = firstKeptIndex;
		const preparation = {
			firstKeptEntryId: firstKeptEntry.id,
			messagesToSummarize: originalBranch.slice(0, historyEnd).flatMap(sessionEntryToContextMessages),
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: buildSessionContext(originalBranch).messages.reduce((total, message) => total + estimateTokens(message), 0),
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings,
		};
		if (preparation.messagesToSummarize.length === 0) return { ok: false, detail: "no-repair-source" };
		const tail = branch.slice(checkpointIndex + 1);
		if (tail.some((entry) => !isReplayableTailEntry(entry))) return { ok: false, detail: "unsupported-live-tail-entry" };
		const previousMessages = ctx.sessionManager.buildContextEntries().flatMap((entry) => sessionEntryToContextMessages(entry));
		const signal = new AbortController();
		const outcome = await runNativeRepairCompaction({
			event: {
				type: "session_before_compact",
				preparation,
				branchEntries: originalBranch,
				reason: "manual",
				willRetry: false,
				signal: signal.signal,
			},
			ctx,
		});
		if (outcome.outcome !== "success") {
			return outcome.outcome === "aborted"
				? { ok: false, detail: "native-repair-aborted" }
				: { ok: false, detail: outcome.detail ?? outcome.reason };
		}
		try {
			const manager = ctx.sessionManager as typeof ctx.sessionManager & MutableSessionManager;
			if (checkpoint.entry.parentId) manager.branch(checkpoint.entry.parentId);
			else manager.resetLeaf();
			manager.appendCompaction(
				outcome.compaction.summary,
				outcome.compaction.firstKeptEntryId,
				outcome.compaction.tokensBefore,
				outcome.compaction.details,
				false,
				outcome.compaction.usage,
			);
			for (const entry of tail) appendTailEntry(manager, entry);
			pendingContextRefresh = { previousMessages };
			return { ok: true };
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}
	};
	const repairIfUnsafeResume = async (ctx: ExtensionContext): Promise<void> => {
		const branch = ctx.sessionManager.getBranch();
		const checkpoint = resolveSessionCheckpoint(branch);
		if (checkpoint.status !== "remote" && checkpoint.status !== "invalid") return;
		const model = ctx.model;
		if (!model) return;
		const support = modelSupportsRemoteCompaction(model);
		if (mode === "on" && support.supported && checkpoint.status === "remote") {
			const identity = await resolveRuntimeIdentity(ctx);
			if (identity && identitiesMatch(checkpoint.details.consumer, identity)) return;
		}
		const rebuilt = rebuiltBranchMessages(branch);
		if (rebuilt.reduce((total, message) => total + estimateTokens(message), 0) <= model.contextWindow) return;
		const repaired = await repairBeforeDisabling(ctx);
		if (!repaired.ok) ctx.ui.notify(`GPT compaction resume remains fail-closed; native repair failed: ${redactSensitiveText(repaired.detail)}`, "error");
	};

	pi.registerCommand("rail-gpt-compaction", {
		description: "Set GPT Remote Compaction v2 on or off",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [
				{ value: "on", label: "on — enable GPT Remote Compaction v2" },
				{ value: "off", label: "off — use Pi native compaction" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			mode = readGptCompactionSettings().mode;
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
				const selected = await ctx.ui.select(`GPT Remote Compaction v2 — currently ${mode}`, ["on", "off"]);
				if (selected !== "on" && selected !== "off") return;
				selectedMode = selected;
			} else {
				selectedMode = command.mode;
			}

			await ctx.waitForIdle();
			if (selectedMode === "off" && mode === "on") {
				const repaired = await repairBeforeDisabling(ctx);
				if (!repaired.ok) {
					ctx.ui.notify(`GPT Remote Compaction v2 remains on; native repair failed: ${redactSensitiveText(repaired.detail)}`, "error");
					return;
				}
			}
			try {
				const saved = writeGptCompactionMode(selectedMode);
				mode = saved.mode;
				updateStatus(mode, ctx);
				ctx.ui.notify(`GPT Remote Compaction v2 ${mode} (${gptCompactionSettingsScope(saved.path)}).`, "info");
				if (mode === "on") {
					const support = modelSupportsRemoteCompaction(ctx.model);
					if (!support.supported) ctx.ui.notify(`Remote v2 is inactive for the current model: ${support.detail}. Pi will use native compaction.`, "warning");
				}
			} catch (error) {
				ctx.ui.notify(`Could not save GPT compaction settings: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const settings = readGptCompactionSettings();
		mode = settings.mode;
		pendingContextRefresh = undefined;
		clearRequestContextCache(ctx.sessionManager.getSessionId());
		blockedRequests.clear();
		if (settings.warning) ctx.ui.notify(settings.warning, "warning");
		if (mode === "off") await repairIfUnsafeResume(ctx);
		updateStatus(mode, ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		syncMode();
		await repairIfUnsafeResume(ctx);
		updateStatus(mode, ctx);
	});
	pi.on("session_tree", async (_event, ctx) => updateStatus(mode, ctx));
	pi.on("session_compact", async (_event, ctx) => updateStatus(mode, ctx));
	pi.on("session_compact_failed", async (_event, ctx) => updateStatus(mode, ctx));

	pi.on("session_before_compact", async (event, ctx) => {
		syncMode();
		const model = ctx.model;
		const support = modelSupportsRemoteCompaction(model);
		const checkpoint = resolveSessionCheckpoint(event.branchEntries);

		const mustRepairNative = checkpoint.status === "invalid"
			|| (checkpoint.status === "remote" && (mode !== "on" || !support.supported));
		if (mustRepairNative) {
			const outcome = await runNativeRepairCompaction({ event, ctx });
			if (outcome.outcome === "success") return { compaction: outcome.compaction };
			if (outcome.outcome === "aborted") return { cancel: true };
			notifyFailure(ctx, "while repairing native history", outcome.reason, outcome.detail);
			return { cancel: true };
		}

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

		return undefined;
	});

	pi.on("context", async (event, ctx) => {
		syncMode();
		const branchEntries = ctx.sessionManager.getBranch();
		const checkpoint = resolveSessionCheckpoint(branchEntries);
		if (pendingContextRefresh) {
			const previousMessages = pendingContextRefresh.previousMessages;
			const startsWith = (messages: readonly AgentMessage[], prefix: readonly AgentMessage[]): boolean => {
				if (messages.length < prefix.length) return false;
				for (let index = 0; index < prefix.length; index += 1) {
					try {
						if (JSON.stringify(messages[index]) !== JSON.stringify(prefix[index])) return false;
					} catch {
						return false;
					}
				}
				return true;
			};
			const rebuilt = rebuiltBranchMessages(branchEntries);
			if (startsWith(event.messages, previousMessages)) {
				pendingContextRefresh = undefined;
				return { messages: [...rebuilt, ...event.messages.slice(previousMessages.length).map((message) => structuredClone(message))] };
			}
			if (startsWith(event.messages, rebuilt)) pendingContextRefresh = undefined;
			else {
				markBlocked(ctx.signal, "native-repair-context-refresh-failed", blockedRequests);
				ctx.abort();
				return { messages: event.messages };
			}
		}
		if (checkpoint.status !== "remote" && checkpoint.status !== "invalid") return undefined;
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
			syncMode();
			const branchEntries = ctx.sessionManager.getBranch();
			const checkpoint = resolveSessionCheckpoint(branchEntries);
			const model = ctx.model;
			if ((checkpoint.status !== "remote" && checkpoint.status !== "invalid") || !model) {
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
		pendingContextRefresh = undefined;
	});
}
