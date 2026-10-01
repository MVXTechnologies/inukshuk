import {
  effectiveTrailViewTab,
  isTrailViewTab,
  TRAIL_VIEW_TAB_LABELS,
  trailViewTabsFor,
} from './trailViewTabs';

describe('trail view tabs', () => {
  it('shows all four tabs for a recording, no Timeline for a route', () => {
    expect(trailViewTabsFor(true)).toEqual(['overview', 'timeline', 'splits', 'notes']);
    expect(trailViewTabsFor(false)).toEqual(['overview', 'splits', 'notes']);
    expect(TRAIL_VIEW_TAB_LABELS.splits).toBe('Splits');
  });

  it('recognises only real tab ids', () => {
    expect(isTrailViewTab('notes')).toBe(true);
    expect(isTrailViewTab('points')).toBe(false);
    expect(isTrailViewTab(3)).toBe(false);
    expect(isTrailViewTab(null)).toBe(false);
  });

  it('reopens the remembered tab, falling back to Overview', () => {
    expect(effectiveTrailViewTab('splits', true)).toBe('splits');
    expect(effectiveTrailViewTab('timeline', true)).toBe('timeline');
    expect(effectiveTrailViewTab('timeline', false)).toBe('overview');
    expect(effectiveTrailViewTab('junk', true)).toBe('overview');
    expect(effectiveTrailViewTab(undefined, false)).toBe('overview');
  });
});
