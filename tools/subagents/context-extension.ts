import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_COMMAND,
	CONTEXT_PROTOCOL_FLAG,
	CONTEXT_PROTOCOL_VERSION,
	CONTEXT_WINDOW_FLAG,
	formatContextProtocolError,
	parseContextWindowFlag,
	validateContextWindowReserve,
} from "./context-window";

type PiModel = NonNullable<ExtensionContext["model"]>;

interface ActiveOverride {
	provider: string;
	id: string;
	model: PiModel;
	original: number;
	applied: number;
}

function currentModel(ctx: ExtensionContext): PiModel {
	if (!ctx.model) throw new Error("Rail context protocol requires an active Pi model");
	return ctx.model;
}

function sameModelKey(left: PiModel | ActiveOverride, right: PiModel | ActiveOverride): boolean {
	return left.provider === right.provider && left.id === right.id;
}

function modelWindow(model: PiModel): number {
	if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
		throw new Error(`Rail context protocol could not resolve a safe current contextWindow for ${model.provider}/${model.id}`);
	}
	return model.contextWindow;
}

function setModelWindow(model: PiModel, value: number): void {
	model.contextWindow = value;
	if (model.contextWindow !== value) throw new Error("Rail context protocol could not apply its owned model field");
}

function restoreOwnedModel(active: ActiveOverride): void {
	if (active.model.contextWindow !== active.applied) {
		throw new Error("Rail context protocol override was changed before cleanup");
	}
	setModelWindow(active.model, active.original);
}

function applyToCurrent(ctx: ExtensionContext, value: number, previous?: ActiveOverride): ActiveOverride {
	const model = currentModel(ctx);
	if (previous) {
		if (!sameModelKey(model, previous)) throw new Error("Rail context protocol model changed before the next dispatch");
		restoreOwnedModel(previous);
	}
	const original = modelWindow(model);
	setModelWindow(model, value);
	return { provider: model.provider, id: model.id, model, original, applied: value };
}

function ensureCurrentOverride(ctx: ExtensionContext, active: ActiveOverride): ActiveOverride {
	const model = currentModel(ctx);
	if (model === active.model) {
		if (model.contextWindow !== active.applied) throw new Error("Rail context protocol override was changed before provider dispatch");
		return active;
	}
	if (!sameModelKey(model, active)) throw new Error("Rail context protocol model changed before provider dispatch");
	// Pi can replace the selected model object while keeping the same provider/id.
	// Restore the object we changed and take ownership of the native replacement.
	restoreOwnedModel(active);
	const original = modelWindow(model);
	setModelWindow(model, active.applied);
	return { provider: model.provider, id: model.id, model, original, applied: active.applied };
}

function resolvedReserve(ctx: ExtensionContext): { enabled: boolean; reserveTokens: number } {
	return SettingsManager.create(ctx.cwd, getAgentDir()).getCompactionSettings();
}

function parseCommand(args: string): { operation: "prepare" | "reset"; value?: number } {
	const parts = args.trim().split(/\s+/u).filter(Boolean);
	if (parts.length === 1 && parts[0] === "reset") return { operation: "reset" };
	if (parts.length === 2 && parts[0] === "prepare") {
		if (parts[1] === "omit") return { operation: "prepare" };
		const value = parseContextWindowFlag(parts[1]);
		if (value === undefined) throw new Error("Rail context prepare requires a budget or omit");
		return { operation: "prepare", value };
	}
	throw new Error("Rail context command requires prepare <decimal|omit> or reset");
}

export default function installRailContextExtension(pi: ExtensionAPI): void {
	pi.registerFlag(CONTEXT_WINDOW_FLAG, {
		description: "Rail child-local context budget",
		type: "string",
	});
	pi.registerFlag(CONTEXT_PROTOCOL_FLAG, {
		description: `Rail child context protocol version ${CONTEXT_PROTOCOL_VERSION}`,
		type: "string",
	});

	let active: ActiveOverride | undefined;
	let settledOverride: ActiveOverride | undefined;
	let protocolReady = false;
	let protocolFailure: string | undefined;

	const reportFailure = (error: unknown): string => {
		const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim();
		const message = formatContextProtocolError(detail || "unknown context protocol failure");
		if (!protocolFailure) {
			protocolFailure = message;
			console.error(message);
		}
		return message;
	};

	const abortWithFailure = (ctx: ExtensionContext, error: unknown): string => {
		const message = reportFailure(error);
		ctx.abort();
		return message;
	};

	const applyStartupBudget = (_event: unknown, ctx: ExtensionContext): void => {
		protocolReady = pi.getFlag(CONTEXT_PROTOCOL_FLAG) === CONTEXT_PROTOCOL_VERSION;
		const raw = pi.getFlag(CONTEXT_WINDOW_FLAG);
		if (raw === undefined) return;
		try {
			if (!protocolReady) throw new Error(`Rail context protocol flag --${CONTEXT_PROTOCOL_FLAG}=${CONTEXT_PROTOCOL_VERSION} is required`);
			const value = parseContextWindowFlag(raw);
			if (value === undefined) throw new Error("Rail context startup budget is missing");
			const settings = resolvedReserve(ctx);
			validateContextWindowReserve(value, settings.reserveTokens, settings.enabled);
			active = applyToCurrent(ctx, value, active);
		} catch (error) {
			reportFailure(error);
		}
	};

	pi.on("session_start", applyStartupBudget);

	pi.on("input", (_event, ctx) => {
		if (protocolFailure) return { action: "handled" as const };
		if (!active) return undefined;
		try {
			active = ensureCurrentOverride(ctx, active);
		} catch (error) {
			abortWithFailure(ctx, error);
			if (active && active.model.contextWindow === active.original) active = undefined;
			return { action: "handled" as const };
		}
		return undefined;
	});

	const guardProviderTurn = (_event: unknown, ctx: ExtensionContext): void => {
		if (protocolFailure) {
			ctx.abort();
			return;
		}
		if (!active) return;
		try {
			active = ensureCurrentOverride(ctx, active);
		} catch (error) {
			const message = abortWithFailure(ctx, error);
			if (active && active.model.contextWindow === active.original) active = undefined;
			throw new Error(message);
		}
	};

	pi.on("before_agent_start", guardProviderTurn);
	pi.on("turn_end", guardProviderTurn);
	pi.on("turn_start", guardProviderTurn);

	pi.on("model_select", (_event, ctx) => {
		if (!active) return;
		let failure: unknown = new Error("Rail context protocol cannot change model during an active contextWindow override");
		try {
			restoreOwnedModel(active);
		} catch (error) {
			failure = error;
		} finally {
			active = undefined;
		}
		abortWithFailure(ctx, failure);
	});

	pi.registerCommand(CONTEXT_COMMAND, {
		description: `Rail private context protocol v${CONTEXT_PROTOCOL_VERSION}`,
		handler: async (args, ctx): Promise<void> => {
			try {
				if (!protocolReady) throw new Error(`Rail context protocol flag --${CONTEXT_PROTOCOL_FLAG}=${CONTEXT_PROTOCOL_VERSION} is required`);
				if (protocolFailure) throw new Error(protocolFailure);
				const command = parseCommand(args);
				if (command.operation === "reset" || command.value === undefined) {
					if (active) {
						restoreOwnedModel(active);
						active = undefined;
					}
					if (settledOverride) {
						const model = currentModel(ctx);
						if (!sameModelKey(model, settledOverride)) throw new Error("Rail context protocol model changed before cleanup confirmation");
						if (model === settledOverride.model && model.contextWindow !== settledOverride.original) {
							throw new Error("Rail context protocol restored model field was changed before cleanup confirmation");
						}
						modelWindow(model);
						settledOverride = undefined;
					}
					return;
				}
				const settings = resolvedReserve(ctx);
				validateContextWindowReserve(command.value, settings.reserveTokens, settings.enabled);
				active = applyToCurrent(ctx, command.value, active);
			} catch (error) {
				throw new Error(formatContextProtocolError(error instanceof Error ? error.message : String(error)));
			}
		},
	});

	pi.on("agent_settled", (_event, _ctx) => {
		if (protocolFailure) throw new Error(protocolFailure);
		if (!active) return;
		try {
			restoreOwnedModel(active);
			settledOverride = active;
			active = undefined;
		} catch (error) {
			throw new Error(reportFailure(error));
		}
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		if (!active) return;
		try {
			restoreOwnedModel(active);
		} catch (error) {
			reportFailure(error);
		} finally {
			active = undefined;
		}
	});
}
