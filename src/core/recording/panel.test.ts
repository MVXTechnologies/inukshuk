import {
  collapsePanel,
  cycleHeroField,
  DEFAULT_HERO_FIELDS,
  EXPANDED_FIELDS,
  expandPanel,
  HERO_FIELD_ORDER,
  INITIAL_PANEL_STATE,
  panelAfterSwipe,
  SWIPE_DISTANCE_DP,
  SWIPE_VELOCITY_DPS,
  type HeroField,
} from './panel';

describe('panel states (decision 3)', () => {
  it('opens as the strip', () => {
    expect(INITIAL_PANEL_STATE).toBe('strip');
  });

  it('expands mini → strip → expanded and stops there', () => {
    expect(expandPanel('mini')).toBe('strip');
    expect(expandPanel('strip')).toBe('expanded');
    expect(expandPanel('expanded')).toBe('expanded');
  });

  it('collapses expanded → strip → mini and stops there', () => {
    expect(collapsePanel('expanded')).toBe('strip');
    expect(collapsePanel('strip')).toBe('mini');
    expect(collapsePanel('mini')).toBe('mini');
  });
});

describe('panelAfterSwipe', () => {
  it('expands on a swipe up past the distance threshold', () => {
    expect(panelAfterSwipe('mini', { dy: -SWIPE_DISTANCE_DP, vy: 0 })).toBe('strip');
    expect(panelAfterSwipe('strip', { dy: -120, vy: -50 })).toBe('expanded');
  });

  it('collapses on a swipe down past the distance threshold', () => {
    expect(panelAfterSwipe('expanded', { dy: SWIPE_DISTANCE_DP, vy: 0 })).toBe('strip');
    expect(panelAfterSwipe('strip', { dy: 90, vy: 0 })).toBe('mini');
  });

  it('counts a short fast flick', () => {
    expect(panelAfterSwipe('strip', { dy: -10, vy: -SWIPE_VELOCITY_DPS })).toBe('expanded');
    expect(panelAfterSwipe('strip', { dy: 10, vy: SWIPE_VELOCITY_DPS })).toBe('mini');
  });

  it('snaps back on a short slow drag', () => {
    expect(panelAfterSwipe('strip', { dy: -20, vy: -100 })).toBe('strip');
    expect(panelAfterSwipe('strip', { dy: 20, vy: 100 })).toBe('strip');
  });

  it('ignores a contradictory gesture (dragged up, flung down)', () => {
    expect(panelAfterSwipe('strip', { dy: -80, vy: 900 })).toBe('strip');
  });
});

describe('hero fields', () => {
  it('defaults to Time · Distance · Gain', () => {
    expect(DEFAULT_HERO_FIELDS).toEqual(['time', 'distance', 'gain']);
  });

  it('lists every field exactly once in the cycle', () => {
    expect(new Set(HERO_FIELD_ORDER).size).toBe(HERO_FIELD_ORDER.length);
    for (const f of [...DEFAULT_HERO_FIELDS, ...EXPANDED_FIELDS]) {
      expect(HERO_FIELD_ORDER).toContain(f);
    }
  });

  it('steps a slot to the next field no other slot shows', () => {
    // gain → speed (next in order, free)
    expect(cycleHeroField(DEFAULT_HERO_FIELDS, 2)).toEqual(['time', 'distance', 'speed']);
    // time → distance is taken, gain is taken, so speed
    expect(cycleHeroField(DEFAULT_HERO_FIELDS, 0)).toEqual(['speed', 'distance', 'gain']);
  });

  it('wraps around the end of the order', () => {
    expect(cycleHeroField(['sunset', 'distance', 'gain'], 0)).toEqual(['time', 'distance', 'gain']);
  });

  it('never shows the same field twice', () => {
    let fields: HeroField[] = [...DEFAULT_HERO_FIELDS];
    for (let i = 0; i < 30; i++) {
      fields = cycleHeroField(fields, i % 3);
      expect(new Set(fields).size).toBe(3);
    }
  });

  it('leaves the fields alone for a slot out of range', () => {
    expect(cycleHeroField(DEFAULT_HERO_FIELDS, 5)).toEqual([...DEFAULT_HERO_FIELDS]);
  });
});
