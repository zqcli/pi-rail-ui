/**
 * Split a byte budget across items so smaller ones keep their full size and only the largest share
 * what is left (water-filling). Each share is at least `minimum`, even if that overdraws the budget.
 */
export function fairShares(sizes: readonly number[], total: number, minimum = 0): number[] {
	const shares = new Array<number>(sizes.length);
	let remaining = total;
	const bySize = sizes.map((_, index) => index).sort((left, right) => sizes[left]! - sizes[right]!);
	bySize.forEach((index, position) => {
		const share = Math.max(minimum, Math.floor(remaining / (bySize.length - position)));
		shares[index] = share;
		remaining -= Math.min(share, sizes[index]!);
	});
	return shares;
}
