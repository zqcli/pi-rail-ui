import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export type RailThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

const THINKING_LEVELS: RailThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface RailModelRef {
	provider: string;
	modelId: string;
	name?: string;
	thinkingLevel?: RailThinkingLevel;
}

export function railModelKey(model: Pick<RailModelRef, "provider" | "modelId">): string {
	return `${model.provider}/${model.modelId}`;
}

export function railModelReference(model: RailModelRef): string {
	const key = railModelKey(model);
	return model.thinkingLevel ? `${key}:${model.thinkingLevel}` : key;
}

export function railModelFromModel(
	model: Model<Api>,
	thinkingLevel?: RailThinkingLevel,
): RailModelRef {
	return {
		provider: model.provider,
		modelId: model.id,
		...(model.name ? { name: model.name } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

export function availableRailModels(ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels" | "thinkingLevel">): RailModelRef[] {
	const available = ctx.modelRegistry.getAvailable();
	const scoped = new Map(ctx.scopedModels.map((item) => [
		railModelKey({ provider: item.model.provider, modelId: item.model.id }),
		item,
	]));
	const ordered: Model<Api>[] = [];
	const seen = new Set<string>();
	const add = (model: Model<Api> | undefined) => {
		if (!model) return;
		const key = railModelKey({ provider: model.provider, modelId: model.id });
		if (seen.has(key)) return;
		seen.add(key);
		ordered.push(model);
	};
	add(ctx.model);
	for (const item of ctx.scopedModels) add(available.find((model) => model.provider === item.model.provider && model.id === item.model.id));
	for (const model of available) add(model);

	const activeModel = ctx.model;
	return ordered.map((model) => {
		if (activeModel?.provider === model.provider && activeModel.id === model.id) {
			return railModelFromModel(model, ctx.thinkingLevel);
		}
		const item = scoped.get(railModelKey({ provider: model.provider, modelId: model.id }));
		return railModelFromModel(model, item?.thinkingLevel);
	});
}

function findModel(reference: string, available: Model<Api>[]): Model<Api> | undefined {
	const canonical = available.find((model) => `${model.provider}/${model.id}` === reference);
	if (canonical) return canonical;
	const byId = available.filter((model) => model.id === reference);
	return byId.length === 1 ? byId[0] : undefined;
}

export function resolveRailModel(
	reference: string | undefined,
	ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels" | "thinkingLevel">,
): RailModelRef {
	if (!reference?.trim()) {
		if (!ctx.model) throw new Error("No Pi model is selected");
		return railModelFromModel(ctx.model, ctx.thinkingLevel);
	}
	const refs = availableRailModels(ctx);
	const available = refs.map((ref) => ctx.modelRegistry.find(ref.provider, ref.modelId) ?? (
		ctx.model?.provider === ref.provider && ctx.model.id === ref.modelId ? ctx.model : undefined
	)).filter((model): model is Model<Api> => model !== undefined);
	const normalized = reference.trim();
	const exact = findModel(normalized, available);
	if (exact) {
		const selected = refs.find((item) => item.provider === exact.provider && item.modelId === exact.id);
		return railModelFromModel(exact, selected?.thinkingLevel);
	}
	const separator = normalized.lastIndexOf(":");
	const suffix = separator >= 0 ? normalized.slice(separator + 1) as RailThinkingLevel : undefined;
	const thinkingLevel = suffix && THINKING_LEVELS.includes(suffix) ? suffix : undefined;
	const parsedModel = thinkingLevel ? findModel(normalized.slice(0, separator), available) : undefined;
	if (!parsedModel) {
		const choices = available.slice(0, 12).map((model) => `${model.provider}/${model.id}`).join(", ");
		throw new Error(`Unknown Pi model: ${reference}. Available: ${choices || "none"}`);
	}
	return railModelFromModel(parsedModel, thinkingLevel);
}
