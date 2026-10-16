import { IMPERIAL, METRIC } from '@core/format/units';
import { NO_SLOPE_FILTER } from '@core/geo/terrainAnalysis';
import {
  ALL_ASPECTS,
  altitudeFromSlider,
  altitudeLabel,
  altitudeScaleLabels,
  altitudeSlider,
  altitudeSliderValue,
  aspectSelected,
  aspectSelectionLabel,
  DEFAULT_SLOPE_FILTER,
  sanitizeSlopeFilter,
  showSlopeLegend,
  slopeLegendText,
  slopeRowHint,
  slopeSettingsAreDefault,
  steepnessShort,
  toggleAllAspects,
  toggleAspect,
} from './slopeSettings';

const NNW = (1 << 7) | (1 << 0) | (1 << 1); // NW · N · NE
const NBSP = ' ';

describe('defaults and sanitizing', () => {
  it('defaults to all 8 aspects and no altitude filter', () => {
    expect(DEFAULT_SLOPE_FILTER).toEqual({ aspectMask: 0xff, minAltM: null, maxAltM: null });
    expect(DEFAULT_SLOPE_FILTER).toBe(NO_SLOPE_FILTER);
  });

  it('keeps good fields, repairs bad ones one by one', () => {
    expect(sanitizeSlopeFilter({ aspectMask: NNW, minAltM: 800, maxAltM: 1150 })).toEqual({
      aspectMask: NNW,
      minAltM: 800,
      maxAltM: 1150,
    });
    expect(sanitizeSlopeFilter({ aspectMask: 300, minAltM: 'x', maxAltM: 1150 })).toEqual({
      aspectMask: ALL_ASPECTS,
      minAltM: null,
      maxAltM: 1150,
    });
    expect(sanitizeSlopeFilter({ aspectMask: 1.5, minAltM: 99999, maxAltM: null })).toEqual(
      DEFAULT_SLOPE_FILTER,
    );
    expect(sanitizeSlopeFilter({ aspectMask: 0, minAltM: 1200, maxAltM: 900 })).toEqual({
      aspectMask: 0,
      minAltM: 900,
      maxAltM: 1200,
    });
    for (const junk of [null, 'on', 3, [], undefined]) {
      expect(sanitizeSlopeFilter(junk)).toEqual(DEFAULT_SLOPE_FILTER);
    }
  });
});

describe('aspect rose', () => {
  it('toggles one petal, and the hub toggles all/none', () => {
    expect(aspectSelected(NNW, 7)).toBe(true);
    expect(aspectSelected(NNW, 4)).toBe(false);
    expect(toggleAspect(NNW, 0)).toBe((1 << 7) | (1 << 1));
    expect(toggleAspect(toggleAspect(NNW, 4), 4)).toBe(NNW);
    expect(toggleAllAspects(ALL_ASPECTS)).toBe(0);
    expect(toggleAllAspects(NNW)).toBe(ALL_ASPECTS);
    expect(toggleAllAspects(0)).toBe(ALL_ASPECTS);
  });

  it('reads a contiguous arc clockwise from its start', () => {
    expect(aspectSelectionLabel(ALL_ASPECTS)).toBe('All aspects');
    expect(aspectSelectionLabel(0)).toBe('No aspect');
    expect(aspectSelectionLabel(NNW)).toBe('NW · N · NE');
    expect(aspectSelectionLabel((1 << 6) | (1 << 7) | 1)).toBe('W · NW · N');
    expect(aspectSelectionLabel(1 | (1 << 4))).toBe('N · S');
    expect(aspectSelectionLabel(1 << 3)).toBe('SE');
  });
});

describe('hint and legend', () => {
  it('summarises the Slope row as in the mockup', () => {
    expect(slopeRowHint(27, 90, DEFAULT_SLOPE_FILTER, METRIC)).toBe('All aspects · 27–90°');
    expect(slopeRowHint(30, 90, { aspectMask: NNW, minAltM: 800, maxAltM: 1150 }, METRIC)).toBe(
      `NW · N · NE · 30–90° · 800–1${NBSP}150 m`,
    );
    expect(slopeRowHint(30, 90, { aspectMask: NNW, minAltM: 800, maxAltM: null }, METRIC)).toBe(
      'NW · N · NE · 30–90° · 800 m+',
    );
  });

  it('words altitude bounds: open top is "+", open bottom starts at 0, feet when set', () => {
    expect(altitudeLabel(DEFAULT_SLOPE_FILTER, METRIC)).toBe('');
    expect(altitudeLabel({ aspectMask: 0xff, minAltM: 800, maxAltM: null }, METRIC)).toBe('800 m+');
    expect(altitudeLabel({ aspectMask: 0xff, minAltM: null, maxAltM: 1150 }, METRIC)).toBe(
      `0–1${NBSP}150 m`,
    );
    expect(altitudeLabel({ aspectMask: 0xff, minAltM: 800, maxAltM: 1150 }, IMPERIAL)).toBe(
      `2${NBSP}625–3${NBSP}773 ft`,
    );
  });

  it('legend chip: bold aspects, quiet steepness and altitude', () => {
    expect(steepnessShort(30, 90)).toBe('≥30°');
    expect(steepnessShort(30, 45)).toBe('30–45°');
    expect(
      slopeLegendText(30, 90, { aspectMask: NNW, minAltM: 800, maxAltM: null }, METRIC),
    ).toEqual({ title: 'NW · N · NE', detail: '≥30° · 800 m+' });
    // No altitude filter: altitude is left out, never "0 m+" or "Any altitude".
    expect(
      slopeLegendText(30, 90, { aspectMask: NNW, minAltM: null, maxAltM: null }, METRIC),
    ).toEqual({ title: 'NW · N · NE', detail: '≥30°' });
    expect(slopeRowHint(30, 90, { aspectMask: NNW, minAltM: null, maxAltM: null }, METRIC)).toBe(
      'NW · N · NE · 30–90°',
    );
  });

  it('shows the legend only while slope is on and a filter is active', () => {
    expect(showSlopeLegend(true, DEFAULT_SLOPE_FILTER)).toBe(false);
    expect(showSlopeLegend(true, { ...DEFAULT_SLOPE_FILTER, aspectMask: NNW })).toBe(true);
    expect(showSlopeLegend(true, { ...DEFAULT_SLOPE_FILTER, minAltM: 500 })).toBe(true);
    expect(showSlopeLegend(false, { ...DEFAULT_SLOPE_FILTER, aspectMask: NNW })).toBe(false);
  });

  it('knows when Reset has nothing to do', () => {
    expect(slopeSettingsAreDefault(27, 90, DEFAULT_SLOPE_FILTER)).toBe(true);
    expect(slopeSettingsAreDefault(30, 90, DEFAULT_SLOPE_FILTER)).toBe(false);
    expect(slopeSettingsAreDefault(27, 90, { ...DEFAULT_SLOPE_FILTER, maxAltM: 900 })).toBe(false);
  });
});

describe('altitude slider (the scale never caps the user)', () => {
  it('runs 0 → highest ground rounded UP to the next 500 m', () => {
    const s = altitudeSlider(DEFAULT_SLOPE_FILTER, { minM: 310, maxM: 1154 }, METRIC);
    expect(s).toEqual({ min: 0, max: 1500, lo: 0, hi: 1500, step: 10 });
    expect(altitudeSlider(DEFAULT_SLOPE_FILTER, { minM: 0, maxM: 1500 }, METRIC).max).toBe(1500);
    expect(altitudeSlider(DEFAULT_SLOPE_FILTER, { minM: 0, maxM: 1500.2 }, METRIC).max).toBe(2000);
  });

  it('is never below 500 m (flat or unknown ground)', () => {
    expect(altitudeSlider(DEFAULT_SLOPE_FILTER, { minM: 2, maxM: 40 }, METRIC).max).toBe(500);
    expect(altitudeSlider(DEFAULT_SLOPE_FILTER, null, METRIC).max).toBe(500);
    expect(altitudeSlider(DEFAULT_SLOPE_FILTER, { minM: -20, maxM: -5 }, METRIC).max).toBe(500);
  });

  it('in feet: rounds up to the next 1 500 ft, at least 1 500 ft, steps 50 ft', () => {
    // 1 154 m = 3 786 ft → 4 500 ft.
    expect(altitudeSlider(DEFAULT_SLOPE_FILTER, { minM: 0, maxM: 1154 }, IMPERIAL)).toEqual({
      min: 0,
      max: 4500,
      lo: 0,
      hi: 4500,
      step: 50,
    });
    expect(altitudeSlider(DEFAULT_SLOPE_FILTER, { minM: 0, maxM: 100 }, IMPERIAL).max).toBe(1500);
  });

  it('"+" extends the scale by 500 m (1 500 ft) per tap', () => {
    const area = { minM: 0, maxM: 1154 };
    expect(altitudeSlider(DEFAULT_SLOPE_FILTER, area, METRIC, 1).max).toBe(2000);
    expect(altitudeSlider(DEFAULT_SLOPE_FILTER, area, METRIC, 3).max).toBe(3000);
    expect(altitudeSlider(DEFAULT_SLOPE_FILTER, area, IMPERIAL, 2).max).toBe(7500);
  });

  it('never shrinks below a selected value', () => {
    // Set out on an extended scale, then the view moved to low ground.
    const f = { aspectMask: 0xff, minAltM: 800, maxAltM: 1800 };
    const s = altitudeSlider(f, { minM: 0, maxM: 300 }, METRIC);
    expect(s.max).toBe(2000);
    expect(s.hi).toBe(1800);
    expect(s.lo).toBe(800);
    // A bound exactly on a chunk keeps room above it (else it would read "and above").
    expect(altitudeSlider({ ...f, maxAltM: 1500 }, { minM: 0, maxM: 1000 }, METRIC).max).toBe(2000);
    // An extended scale already holding the bound does not jump after it is set.
    expect(altitudeSlider(f, { minM: 0, maxM: 1154 }, METRIC, 1).max).toBe(2000);
  });

  it('the top end is open: "800 m+", stored as no upper limit; 0 is no lower limit', () => {
    const s = altitudeSlider(DEFAULT_SLOPE_FILTER, { minM: 0, maxM: 1154 }, METRIC);
    expect(altitudeSliderValue(0, s.max, s.max, METRIC)).toBe('Any altitude');
    expect(altitudeSliderValue(0, 1150, s.max, METRIC)).toBe(`0–1${NBSP}150 m`);
    expect(altitudeSliderValue(800, s.max, s.max, METRIC)).toBe('800 m+');
    expect(altitudeSliderValue(800, 1150, s.max, METRIC)).toBe(`800–1${NBSP}150 m`);
    expect(altitudeScaleLabels(s.max, METRIC)).toEqual(['0', `1${NBSP}500 m+`]);
    expect(altitudeFromSlider(800, s.max, s, METRIC)).toEqual({ minAltM: 800, maxAltM: null });
    expect(altitudeFromSlider(0, 1150, s, METRIC)).toEqual({ minAltM: null, maxAltM: 1150 });
    expect(altitudeFromSlider(0, s.max, s, METRIC)).toEqual({ minAltM: null, maxAltM: null });
  });

  it('stores metres whatever the unit system', () => {
    const s = altitudeSlider(DEFAULT_SLOPE_FILTER, { minM: 0, maxM: 1154 }, IMPERIAL);
    expect(altitudeFromSlider(2600, 3800, s, IMPERIAL)).toEqual({
      minAltM: 792.5,
      maxAltM: 1158.2,
    });
    // …and reads them back in feet.
    const back = altitudeSlider(
      { aspectMask: 0xff, minAltM: 792.5, maxAltM: 1158.2 },
      { minM: 0, maxM: 1154 },
      IMPERIAL,
    );
    expect([back.lo, back.hi]).toEqual([2600, 3800]);
  });
});
