/**
 * GPT family detection shared by native Fast mode, hosted web search,
 * stateless subagent dispatch, and remote compaction.
 *
 * Matching is intentionally provider-independent: custom Responses gateways
 * routinely register GPT models under their own provider id, so eligibility is
 * decided by the model id or display name alone. The `gpt` token must be
 * delimited so ids such as `gpt-5.6-sol` and names such as `GPT 5.6` match
 * while arbitrary substrings do not.
 */
function isGptModelName(value: string | undefined): boolean {
	return !!value && /(^|[^a-z0-9])gpt([^a-z0-9]|$)/iu.test(value);
}

export function isGptModel(model: { id?: string | undefined; name?: string | undefined } | undefined): boolean {
	if (!model) return false;
	return isGptModelName(model.id) || isGptModelName(model.name);
}
