export type RailRowsCache = {
	width: number;
	innerLines: readonly string[];
	rows: string[];
};

export function cachedRailRows(
	cache: RailRowsCache | undefined,
	width: number,
	innerLines: readonly string[],
	renderRows: () => string[],
): { cache: RailRowsCache; rows: string[] } {
	if (cache?.width === width && cache.innerLines === innerLines) {
		return { cache, rows: cache.rows };
	}
	const rows = renderRows();
	return { cache: { width, innerLines, rows }, rows };
}
