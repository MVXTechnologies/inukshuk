/**
 * The gap a bottom-docked view keeps above the screen's bottom edge, less a
 * margin: how much less than the keyboard's height it must rise to clear it.
 */
export function restGap(bottom: number, screenH: number, margin = 8): number {
  return Math.max(0, screenH - bottom - margin);
}
