export function cachedRender<V>(
	target: any,
	cacheKey: symbol,
	signature: string,
	render: () => V,
	identityChecks?: Record<string, any>,
): V {
	const cache = target[cacheKey] as { signature: string; refs?: Record<string, any>; value: V } | undefined;
	if (cache?.signature === signature) {
		if (!identityChecks || refsMatch(cache.refs, identityChecks)) return cache.value;
	}
	const value = render();
	target[cacheKey] = { signature, refs: identityChecks ? { ...identityChecks } : undefined, value };
	return value;
}

function refsMatch(cached: Record<string, any> | undefined, current: Record<string, any>): boolean {
	if (!cached) return false;
	for (const key in current) {
		if (cached[key] !== current[key]) return false;
	}
	return true;
}
