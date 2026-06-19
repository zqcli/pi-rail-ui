export function nextHistoryRevision(previousRevision: number | undefined, reusedFullHistory: boolean): number {
	return reusedFullHistory ? (previousRevision ?? 0) : (previousRevision ?? 0) + 1;
}
