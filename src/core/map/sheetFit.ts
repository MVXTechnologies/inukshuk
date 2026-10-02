/**
 * How tall a sheet's scrolling body may be so its last row stays reachable.
 *
 * The map's dropdown sheets (Overlays) hang below the control rail. Capped at
 * a share of the WINDOW, a long sheet ran past the bottom of the map area —
 * behind the tab bar on a real phone — so the last rows ("Live layers") could
 * never be scrolled into view. The body is capped at the space between its own
 * top and the map area's bottom (both in window coordinates), less a margin.
 */
export function sheetBodyMaxHeight(input: {
  windowHeight: number;
  /** Share of the window the body may use at most. */
  maxShare: number;
  /** Window y of the map area's bottom edge (above the tab bar), when measured. */
  areaBottom: number | null;
  /** Window y of the body's top edge, when measured. */
  bodyTop: number | null;
  /** Gap kept above the area's bottom. */
  margin?: number;
  /** Never shrink below this, however cramped. */
  floor?: number;
}): number {
  const { windowHeight, maxShare, areaBottom, bodyTop, margin = 12, floor = 120 } = input;
  const byShare = windowHeight * maxShare;
  if (areaBottom === null || bodyTop === null) return byShare;
  const room = areaBottom - bodyTop - margin;
  return Math.max(floor, Math.min(byShare, room));
}
