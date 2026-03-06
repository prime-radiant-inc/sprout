/** Determine context pressure bar color based on usage percentage. */
export function pressureColor(percent: number): string {
	if (percent >= 85) return "var(--color-error)";
	if (percent >= 60) return "var(--color-warning)";
	return "var(--color-success)";
}
