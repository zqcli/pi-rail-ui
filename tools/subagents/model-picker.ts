import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { availableRailModels, railModelReference, type RailModelRef } from "./models";
import { pickSearchableOverlay } from "./searchable-picker";

function modelLabel(model: RailModelRef): string {
	const reference = railModelReference(model);
	const name = model.name ? stripTerminalSequences(model.name) : undefined;
	return name && name !== model.modelId ? `${reference} — ${name}` : reference;
}

export async function pickRailModel(ctx: ExtensionCommandContext): Promise<RailModelRef | undefined> {
	const models = availableRailModels(ctx);
	if (models.length === 0) {
		ctx.ui.notify("No Pi models are available", "warning");
		return undefined;
	}
	if (ctx.mode !== "tui") {
		const labels = models.map(modelLabel);
		const selected = await ctx.ui.select("Pi model", labels);
		return selected ? models[labels.indexOf(selected)] : undefined;
	}
	return pickSearchableOverlay(ctx, {
		title: "Select Pi model",
		items: models.map((model) => ({
			value: model,
			label: modelLabel(model),
			searchText: `${railModelReference(model)} ${model.name ? stripTerminalSequences(model.name) : ""}`.toLowerCase(),
		})),
		emptyText: "No matching models",
		actionLabel: "select",
	});
}
