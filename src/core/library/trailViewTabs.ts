/**
 * The trail view's tabs (#511): Overview · Timeline · Splits · Notes. The
 * last one picked is remembered (settings), and an untimed trail (a planned
 * route) has no Timeline — there is no "when" to tell.
 */
export type TrailViewTab = 'overview' | 'timeline' | 'splits' | 'notes';

export const TRAIL_VIEW_TABS: readonly TrailViewTab[] = ['overview', 'timeline', 'splits', 'notes'];

export const DEFAULT_TRAIL_VIEW_TAB: TrailViewTab = 'overview';

export const TRAIL_VIEW_TAB_LABELS: Readonly<Record<TrailViewTab, string>> = {
  overview: 'Overview',
  timeline: 'Timeline',
  splits: 'Splits',
  notes: 'Notes',
};

export function isTrailViewTab(v: unknown): v is TrailViewTab {
  return typeof v === 'string' && (TRAIL_VIEW_TABS as readonly string[]).includes(v);
}

/** The tabs a trail shows: no Timeline without timestamps. */
export function trailViewTabsFor(timed: boolean): TrailViewTab[] {
  return TRAIL_VIEW_TABS.filter((t) => timed || t !== 'timeline');
}

/** The remembered tab when this trail has it, else Overview. */
export function effectiveTrailViewTab(saved: unknown, timed: boolean): TrailViewTab {
  return isTrailViewTab(saved) && trailViewTabsFor(timed).includes(saved)
    ? saved
    : DEFAULT_TRAIL_VIEW_TAB;
}
