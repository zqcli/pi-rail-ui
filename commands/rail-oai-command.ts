import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isGptModel } from "../openai/model-eligibility";

/**
 * One shared warning for every `/rail-oai-*` command that can only be enabled on
 * a GPT model. Fast, hosted search, and remote compaction all route through this
 * module so the user sees one message instead of three drifting variants.
 */
export const RAIL_OAI_GPT_ONLY_WARNING = "Cannot enable Rail OpenAI features for the current model: GPT models only.";

/**
 * Rejects a mutating `/rail-oai-*` command before it can open a menu, sync
 * capture, or persist a setting. Returns true when the caller must stop.
 *
 * Callers keep `off`, their usage text, and any runtime request-time gating
 * outside this gate: enabling is GPT-only, disabling is always available.
 */
export function rejectRailOaiCommandForModel(ctx: ExtensionContext): boolean {
	if (isGptModel(ctx.model)) return false;
	if (ctx.hasUI) ctx.ui.notify(RAIL_OAI_GPT_ONLY_WARNING, "warning");
	return true;
}
