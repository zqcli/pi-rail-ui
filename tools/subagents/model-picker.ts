import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { availableRailModels, railModelReference, type RailModelRef } from "./models";

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
	const labels = models.map(modelLabel);
	const selected = await ctx.ui.select("Pi model", labels);
	return selected ? models[labels.indexOf(selected)] : undefined;
}
