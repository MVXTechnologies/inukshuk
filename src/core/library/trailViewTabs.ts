/**
 * The trail view's tabs (#511, board C2): Overview · Charts · Timeline ·
 * Splits. The last one picked is remembered (settings). Notes live in the
 * Timeline, so every trail — planned routes included — has all four tabs.
 */
export type TrailViewTab = 'overview' | 'charts' | 'timeline' | 'splits';

export const TRAIL_VIEW_TABS: readonly TrailViewTab[] = [
  'overview',
  'charts',
  'timeline',
  'splits',
];

export const DEFAULT_TRAIL_VIEW_TAB: TrailViewTab = 'overview';

export const TRAIL_VIEW_TAB_LABELS: Readonly<Record<TrailViewTab, string>> = {
  overview: 'Overview',
  charts: 'Charts',
  timeline: 'Timeline',
  splits: 'Splits',
};

export function isTrailViewTab(v: unknown): v is TrailViewTab {
  return typeof v === 'string' && (TRAIL_VIEW_TABS as readonly string[]).includes(v);
}

/**
 * A persisted tab, sanitized: the retired Notes tab (first #511 iteration)
 * now lives in the Timeline; anything else unknown opens Overview.
 */
export function effectiveTrailViewTab(saved: unknown): TrailViewTab {
  if (saved === 'notes') return 'timeline';
  return isTrailViewTab(saved) ? saved : DEFAULT_TRAIL_VIEW_TAB;
}
