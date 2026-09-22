import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { estimateTokens, findCutPoint, getAgentDir, sessionEntryToContextMessages, SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	compactionIdentity,
	identitiesMatch,
	modelSupportsRemoteCompaction,
	type CompactionIdentity,
} from "./model-eligibility";
import { isGptModel } from "../../openai/model-eligibility";
import {
	planContextReplay,
	planPayloadRewrite,
	rebuiltBranchMessages,
	rememberLiveRequestContext,
	runNativeRepairCompaction,
	runRemoteCompaction,
} from "./core";
import { resolveCompactionAuth } from "./auth";
import { isRailCompactionEntry, materializeRailFreeProjection, rebuildNativeHistoryPrefix } from "./history";
import { clearRequestContextCache } from "./request-context";
import { rejectRailOaiCommandForModel } from "../../commands/rail-oai-command";
import { getGptCompactionDetails, isGptCompactionSummaryText, resolveSessionCheckpoint } from "./types";
import {
	gptCompactionSettingsScope,
	parseGptCompactionCommand,
	readGptCompactionSettings,
	writeGptCompactionMode,
	type GptCompactionMode,
} from "./settings";

const STATUS_KEY = "rail-gpt-compaction";
const MISSING_AUTH_FINGERPRINT = "missing-auth";
const INSTALL_EVENT = "rail-gpt-compaction:install";

type InstallClaim = { claimed: boolean };

function claimSharedInstall(pi: ExtensionAPI): boolean {
	const claim: InstallClaim = { claimed: false };
	pi.events.emit(INSTALL_EVENT, claim);
	if (claim.claimed) return false;
	pi.events.on(INSTALL_EVENT, (data) => {
		if (data && typeof data === "object" && "claimed" in data) (data as InstallClaim).claimed = true;
	});
	return true;
}

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
	// Non-GPT models use native compaction even while the global switch is on.
	if (!isGptModel(ctx.model)) return "GPT compact: native";
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

type PendingNativeRepair = {
	manager: SessionManager;
	sessionId: string;
	originalLeafId: string | null;
	expectedLeafId: string | null;
	branch: SessionEntry[];
	restoreBeforeSummary: boolean;
	preparation: SessionBeforeCompactEvent["preparation"];
	cancelled: boolean;
};

function nativeRepairPreparation(
	branch: SessionEntry[],
	settings: SessionBeforeCompactEvent["preparation"]["settings"],
): SessionBeforeCompactEvent["preparation"] | undefined {
	// Use the 0.87 canonical projection before choosing a repair boundary. This
	// applies context_edit omission/replacement and removes opaque Rail entries;
	// choosing a cut from raw entries would resurrect an aborted response.
	const projectedBranch = materializeRailFreeProjection(branch);
	if (projectedBranch.length === 0) return undefined;
	// Preserve the opaque checkpoint's logical prefix. Native repair must choose
	// an anchor from the tail after the newest Rail checkpoint; otherwise a small
	// keepRecentTokens budget would retain an old response and fail to summarize
	// the whole pre-checkpoint interval.
	const railIndex = branch.findLastIndex((entry) => isRailCompactionEntry(entry));
	const rawAdmissionStart = railIndex >= 0 ? railIndex + 1 : 0;
	const admissionStartId = branch[rawAdmissionStart]?.id;
	const projectedAdmissionStart = admissionStartId
		? projectedBranch.findIndex((entry) => entry.id === admissionStartId)
		: projectedBranch.length;
	const cut = findCutPoint(projectedBranch, Math.max(0, projectedAdmissionStart), projectedBranch.length, settings.keepRecentTokens);
	let firstKeptIndex = cut.firstKeptEntryIndex;
	const calls = new Set<string>();
	for (let index = firstKeptIndex; index < projectedBranch.length; index += 1) {
		const entry = projectedBranch[index]!;
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role === "assistant") {
				for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
			} else if (message.role === "toolResult" && !calls.has(message.toolCallId)) {
				// Summarize crossing results rather than retain orphaned results.
				firstKeptIndex = index + 1;
				calls.clear();
			}
		}
	}
	const firstKeptEntry = projectedBranch[firstKeptIndex];
	if (!firstKeptEntry) return undefined;
	const rawCutIndex = branch.findIndex((entry) => entry.id === firstKeptEntry.id);
	if (rawCutIndex < 0) return undefined;
	const prefix = rebuildNativeHistoryPrefix(branch, rawCutIndex);
	if (!prefix?.messages.length) return undefined;
	return {
		firstKeptEntryId: firstKeptEntry.id,
		messagesToSummarize: prefix.messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: rebuiltBranchMessages(branch).reduce((total, message) => total + estimateTokens(message), 0),
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings,
	};
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
	if (!claimSharedInstall(pi)) return;
	let mode: GptCompactionMode = readGptCompactionSettings().mode;
	const blockedRequests = new Map<AbortSignal, string>();
	let pendingNativeRepair: PendingNativeRepair | undefined;
	const syncMode = (): GptCompactionMode => {
		mode = readGptCompactionSettings().mode;
		return mode;
	};
	const repairBeforeDisabling = async (ctx: ExtensionContext): Promise<{ ok: true } | { ok: false; detail: string }> => {
		if (pendingNativeRepair) return { ok: false, detail: "native-repair-already-running" };
		const branch = ctx.sessionManager.getBranch();
		const checkpoint = resolveSessionCheckpoint(branch);
		if (checkpoint.status !== "remote" && checkpoint.status !== "invalid") return { ok: true };
		const manager = ctx.sessionManager as unknown as SessionManager;
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getCompactionSettings(ctx.model);
		const checkpointIndex = branch.findIndex((entry) => entry.id === checkpoint.entry.id);
		const originalBranch = branch.slice(0, checkpointIndex);
		const hasTail = checkpointIndex + 1 < branch.length;
		// A checkpoint-only leaf has no append-only anchor. Keep the original
		// sibling-native repair without replaying or duplicating any entries, but
		// choose the sibling boundary from Pi's canonical projected messages.
		const keptIndex = originalBranch.findIndex((entry) => entry.id === checkpoint.entry.firstKeptEntryId);
		const projectedOriginal = materializeRailFreeProjection(originalBranch);
		const projectedKeptIndex = projectedOriginal.findIndex((entry) => entry.id === checkpoint.entry.firstKeptEntryId);
		const projectedSiblingCut = projectedKeptIndex > 0 ? projectedKeptIndex
			: findCutPoint(projectedOriginal, 0, projectedOriginal.length, settings.keepRecentTokens).firstKeptEntryIndex;
		const siblingAnchor = projectedOriginal[projectedSiblingCut];
		const siblingCut = siblingAnchor ? originalBranch.findIndex((entry) => entry.id === siblingAnchor.id) : -1;
		// Removing only the newest checkpoint can leave older opaque markers in
		// the sibling's retained span. Summarize through those markers instead.
		const siblingHasOpaqueHistory = originalBranch.slice(siblingCut).some((entry) => entry.type === "compaction"
			&& (getGptCompactionDetails(entry) || isGptCompactionSummaryText(entry.summary)));
		const preparation = hasTail ? nativeRepairPreparation(branch, settings)
			: siblingHasOpaqueHistory ? nativeRepairPreparation(originalBranch, settings)
				: siblingAnchor && siblingCut >= 0 ? {
					firstKeptEntryId: siblingAnchor.id,
					messagesToSummarize: rebuildNativeHistoryPrefix(originalBranch, siblingCut)?.messages ?? [],
					turnPrefixMessages: [], isSplitTurn: false,
					tokensBefore: rebuiltBranchMessages(originalBranch).reduce((total, message) => total + estimateTokens(message), 0),
					fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() }, settings,
				} : undefined;
		if (!preparation?.messagesToSummarize.length) return { ok: false, detail: "no-safe-native-repair-boundary" };
		// Match Pi's admission cut: either a history prefix or a split-turn
		// prefix must contain conversation, not just system state/compactions.
		const projectedBranch = materializeRailFreeProjection(branch);
		const admissionSourceId = keptIndex >= 0 ? originalBranch[keptIndex]?.id : branch[checkpointIndex + 1]?.id;
		const admissionStart = admissionSourceId ? projectedBranch.findIndex((entry) => entry.id === admissionSourceId) : -1;
		const admissionCut = admissionStart >= 0
			? findCutPoint(projectedBranch, admissionStart, projectedBranch.length, settings.keepRecentTokens)
			: { firstKeptEntryIndex: 0 };
		const admitsOriginal = hasTail && admissionStart >= 0 && projectedBranch.slice(admissionStart, admissionCut.firstKeptEntryIndex)
			.some((entry) => entry.type !== "compaction"
				&& sessionEntryToContextMessages(entry).some((message) => message.role !== "system"));
		const repair: PendingNativeRepair = {
			manager,
			sessionId: manager.getSessionId(),
			originalLeafId: manager.getLeafId(),
			expectedLeafId: admitsOriginal ? manager.getLeafId() : checkpoint.entry.parentId,
			branch: hasTail ? branch : originalBranch,
			restoreBeforeSummary: hasTail,
			preparation,
			cancelled: false,
		};
		try {
			// Only borrow the source branch when native admission would reject the
			// current leaf. No entries are appended until after our hook restores it.
			if (!admitsOriginal) {
				if (repair.expectedLeafId) manager.branch(repair.expectedLeafId);
				else manager.resetLeaf();
			}
			pendingNativeRepair = repair;
			const result = await new Promise<{ ok: true } | { ok: false; detail: string }>((resolve) => {
				try {
					ctx.compact({
						onComplete: () => resolve({ ok: true }),
						onError: (error) => resolve({ ok: false, detail: error.message }),
					});
				} catch (error) {
					resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
				}
			});
			if (!result.ok || repair.cancelled || manager.getSessionId() !== repair.sessionId) {
				return result.ok ? { ok: false, detail: "native-repair-session-changed" } : result;
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		} finally {
			// Never clobber an externally selected leaf or a successful new checkpoint.
			if (manager.getSessionId() === repair.sessionId && manager.getLeafId() === repair.expectedLeafId) {
				if (repair.originalLeafId) manager.branch(repair.originalLeafId);
				else manager.resetLeaf();
			}
			if (pendingNativeRepair === repair) pendingNativeRepair = undefined;
		}
	};
	const estimateDispatchTokens = (ctx: ExtensionContext, messages: readonly AgentMessage[], prompt?: string, images?: readonly ImageContent[]): number => {
		const activeTools = new Set(pi.getActiveTools());
		const toolTokens = pi.getAllTools()
			.filter((tool) => activeTools.has(tool.name))
			.reduce((total, tool) => total + Math.ceil(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines }).length / 4), 0);
		const promptTokens = prompt === undefined ? 0 : estimateTokens({ role: "user", content: [{ type: "text", text: prompt }, ...(images ?? [])], timestamp: 0 });
		return Math.ceil(ctx.getSystemPrompt().length / 4) + toolTokens + messages.reduce((total, message) => total + estimateTokens(message), 0) + promptTokens;
	};
	const repairIfUnsafeResume = async (ctx: ExtensionContext, prompt?: string, images?: readonly ImageContent[]): Promise<boolean> => {
		const branch = ctx.sessionManager.getBranch();
		const checkpoint = resolveSessionCheckpoint(branch);
		if (checkpoint.status !== "remote" && checkpoint.status !== "invalid") return true;
		const model = ctx.model;
		if (!model) return true;
		const support = modelSupportsRemoteCompaction(model);
		if (mode === "on" && support.supported && checkpoint.status === "remote") {
			const identity = await resolveRuntimeIdentity(ctx);
			if (identity && identitiesMatch(checkpoint.details.consumer, identity)) return true;
		}
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getCompactionSettings(ctx.model);
		const rebuilt = rebuiltBranchMessages(branch);
		const outputBudget = Math.max(settings.reserveTokens, model.maxTokens ?? 0);
		const available = model.contextWindow - outputBudget - 256;
		if (estimateDispatchTokens(ctx, rebuilt, prompt, images) <= available) return true;
		const repaired = await repairBeforeDisabling(ctx);
		if (!repaired.ok) {
			ctx.ui.notify(`GPT compaction resume remains fail-closed; native repair failed: ${redactSensitiveText(repaired.detail)}`, "error");
			return false;
		}
		return true;
	};

	pi.registerCommand("rail-oai-compaction", {
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
			// The no-arg menu and `on` are GPT-only. `off` stays available so the
			// global switch and its repair safety can always be used. Reject before
			// opening the menu so an ineligible model cannot reach the writer.
			const enabling = command.operation === "menu" || command.mode === "on";
			if (enabling && rejectRailOaiCommandForModel(ctx)) return;
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
			// Re-check after the menu and idle wait: a model switch during either
			// window must not let an `on` write through on an ineligible model.
			if (selectedMode === "on" && rejectRailOaiCommandForModel(ctx)) return;
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
		clearRequestContextCache(ctx.sessionManager.getSessionId());
		blockedRequests.clear();
		if (settings.warning) ctx.ui.notify(settings.warning, "warning");
		await repairIfUnsafeResume(ctx);
		updateStatus(mode, ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		syncMode();
		if (pendingNativeRepair) {
			pendingNativeRepair.cancelled = true;
			ctx.abort();
		}
		await repairIfUnsafeResume(ctx);
		updateStatus(mode, ctx);
	});
	pi.on("session_tree", async (_event, ctx) => updateStatus(mode, ctx));
	pi.on("session_compact", async (_event, ctx) => updateStatus(mode, ctx));
	pi.on("session_compact_failed", async (_event, ctx) => updateStatus(mode, ctx));
	pi.on("before_agent_start", async (event, ctx) => {
		syncMode();
		await repairIfUnsafeResume(ctx, event.prompt, event.images);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		syncMode();
		const pendingRepair = pendingNativeRepair;
		if (pendingRepair) {
			if (pendingRepair.cancelled || event.signal.aborted
				|| pendingRepair.manager.getSessionId() !== pendingRepair.sessionId
				|| pendingRepair.manager.getLeafId() !== pendingRepair.expectedLeafId) return { cancel: true };
			if (pendingRepair.restoreBeforeSummary) {
				if (pendingRepair.originalLeafId) pendingRepair.manager.branch(pendingRepair.originalLeafId);
				else pendingRepair.manager.resetLeaf();
				pendingRepair.expectedLeafId = pendingRepair.originalLeafId;
			}
			const outcome = await runNativeRepairCompaction({
				event: { ...event, branchEntries: pendingRepair.branch, preparation: pendingRepair.preparation },
				ctx,
			});
			if (pendingRepair.cancelled || pendingRepair.manager.getSessionId() !== pendingRepair.sessionId
				|| pendingRepair.manager.getLeafId() !== pendingRepair.expectedLeafId) return { cancel: true };
			if (outcome.outcome === "success") return { compaction: outcome.compaction };
			if (outcome.outcome === "aborted") return { cancel: true };
			notifyFailure(ctx, "while repairing native history", outcome.reason, outcome.detail);
			return { cancel: true };
		}
		const model = ctx.model;
		const support = modelSupportsRemoteCompaction(model);
		const checkpoint = resolveSessionCheckpoint(event.branchEntries);

		const mustRepairNative = checkpoint.status === "invalid"
			|| (checkpoint.status === "remote" && (mode !== "on" || !support.supported));
		if (mustRepairNative) {
			const preparation = nativeRepairPreparation(event.branchEntries, event.preparation.settings);
			if (!preparation) {
				notifyFailure(ctx, "while repairing native history", "no-safe-native-repair-boundary");
				return { cancel: true };
			}
			const outcome = await runNativeRepairCompaction({ event: { ...event, preparation }, ctx });
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

	pi.on("context_with_system", async (event, ctx) => {
		syncMode();
		const branchEntries = ctx.sessionManager.getBranch();
		const checkpoint = resolveSessionCheckpoint(branchEntries);
		if (checkpoint.status !== "remote" && checkpoint.status !== "invalid") return undefined;
		const support = modelSupportsRemoteCompaction(ctx.model);
		const identity = support.supported ? await resolveRuntimeIdentity(ctx) : safeIdentity(ctx);
		// Pi 0.87 has already applied ContextEditEntry edits in this canonical
		// projection. Keep it as the live prefix when merging transient messages.
		const storedMessages = ctx.sessionManager.buildSessionProjection().messages;
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
		if (pendingNativeRepair) pendingNativeRepair.cancelled = true;
	});
}
