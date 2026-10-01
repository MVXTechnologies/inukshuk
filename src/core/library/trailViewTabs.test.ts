import {
  effectiveTrailViewTab,
  isTrailViewTab,
  TRAIL_VIEW_TAB_LABELS,
  TRAIL_VIEW_TABS,
} from './trailViewTabs';

describe('trail view tabs', () => {
  it('has Overview · Charts · Timeline · Splits', () => {
    expect(TRAIL_VIEW_TABS.map((t) => TRAIL_VIEW_TAB_LABELS[t])).toEqual([
      'Overview',
      'Charts',
      'Timeline',
      'Splits',
    ]);
  });

  it('recognises only real tab ids', () => {
    expect(isTrailViewTab('charts')).toBe(true);
    expect(isTrailViewTab('notes')).toBe(false);
    expect(isTrailViewTab(3)).toBe(false);
  });

  it('reopens the remembered tab; the old Notes tab maps to the Timeline', () => {
    expect(effectiveTrailViewTab('splits')).toBe('splits');
    expect(effectiveTrailViewTab('notes')).toBe('timeline');
    expect(effectiveTrailViewTab('junk')).toBe('overview');
    expect(effectiveTrailViewTab(undefined)).toBe('overview');
  });
});
