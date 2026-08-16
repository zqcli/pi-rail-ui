const AGENT_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function isValidAgentAlias(value: string): boolean {
	return AGENT_ALIAS_PATTERN.test(value);
}

export function assertValidAgentAlias(value: string): void {
	if (!isValidAgentAlias(value)) {
		throw new Error("Subagent alias must be 1-64 characters using letters, numbers, dot, underscore, or hyphen");
	}
}