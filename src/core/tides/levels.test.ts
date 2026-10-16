import { IMPERIAL, METRIC } from '@core/format';
import type { TideExtreme, TideReading } from '@core/weather/tides';

import { TIDE_CATALOG } from './catalog';
import { CHS_SOURCE_INDEX } from './chs';
import {
  ageText,
  classifyHiLo,
  cosineBetween,
  extremesOfCurve,
  interpolate,
  labelWidthPx,
  LEVELS_MAX_STATIONS,
  levelFeatures,
  levelLabel,
  levelReading,
  levelTier,
  niceStep,
  pickLevelStations,
  pillImage,
  predictedAt,
  rateText,
  stationFeeds,
  stationFeedsOf,
  tideGraph,
  trendOf,
  type LevelReading,
  type TideSeries,
} from './levels';

const H = 3_600_000;
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 16, 17, 18); // 13:18 EDT
/** "HH:MM" in UTC: tests don't depend on the machine's zone. */
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** A semidiurnal tide: mean 1.6 m, amplitude 1.35 m, high at +3.57 h. */
const tide = (t: number) => 1.6 + 1.35 * Math.cos((2 * Math.PI * (t / H - 3.57)) / 12.42);
function series(fromH: number, toH: number, stepMin: number, f = tide, base = NOW): TideReading[] {
  const out: TideReading[] = [];
  for (let t = fromH * H; t <= toH * H; t += stepMin * MIN)
    out.push({ timeMs: base + t, heightM: f(t) });
  return out;
}
const HIGH: TideExtreme = { timeMs: NOW + 3.57 * H, heightM: 2.95, kind: 'high' };
const LOW: TideExtreme = { timeMs: NOW + 9.78 * H, heightM: 0.25, kind: 'low' };
const PREV_LOW: TideExtreme = { timeMs: NOW - 2.64 * H, heightM: 0.25, kind: 'low' };

const live: TideSeries = {
  observed: series(-12, 0, 6),
  predicted: series(-12, 48, 30),
  extremes: [PREV_LOW, HIGH, LOW],
};

describe('levelTier: the zoom ladder (8 / 11 / 13)', () => {
  it('nothing below 8, mid to 11, full to 13, rate above', () => {
    expect(levelTier(7.99)).toBeNull();
    expect(levelTier(8)).toBe('mid');
    expect(levelTier(10.9)).toBe('mid');
    expect(levelTier(11)).toBe('full');
    expect(levelTier(12.99)).toBe('full');
    expect(levelTier(13)).toBe('rate');
    expect(levelTier(NaN)).toBeNull();
  });
});

describe('trend', () => {
  it('fits the last 30 min: rising, falling, slack', () => {
    expect(trendOf(series(-1, 0, 6))?.dir).toBe('up');
    const r = trendOf(series(-1, 0, 6))?.rateMPerH ?? 0;
    expect(r).toBeGreaterThan(0.6);
    expect(r).toBeLessThan(0.75);
    expect(trendOf(series(-1, 0, 6, (t) => 2 - t / H))?.dir).toBe('down');
    expect(trendOf(series(-1, 0, 6, (t) => 2 + (0.02 * t) / H))?.dir).toBe('flat');
  });

  it('needs two readings five minutes apart', () => {
    expect(trendOf([])).toBeNull();
    expect(trendOf([{ timeMs: NOW, heightM: 1 }])).toBeNull();
    expect(
      trendOf([
        { timeMs: NOW - MIN, heightM: 1 },
        { timeMs: NOW, heightM: 1.1 },
      ]),
    ).toBeNull();
    expect(
      trendOf([
        { timeMs: NOW - 10 * MIN, heightM: 1 },
        { timeMs: NOW - 10 * MIN, heightM: 1 },
      ]),
    ).toBeNull();
  });
});

describe('interpolation and predictions', () => {
  const pts = [
    { timeMs: 0, heightM: 0 },
    { timeMs: 10, heightM: 1 },
    { timeMs: 20, heightM: 3 },
  ];
  it('is linear inside, null outside, never extrapolated', () => {
    expect(interpolate(pts, 5)).toBeCloseTo(0.5);
    expect(interpolate(pts, 15)).toBeCloseTo(2);
    expect(interpolate(pts, 20)).toBe(3);
    expect(interpolate(pts, -1)).toBeNull();
    expect(interpolate(pts, 21)).toBeNull();
    expect(interpolate([], 0)).toBeNull();
    expect(
      interpolate(
        [
          { timeMs: 0, heightM: 2 },
          { timeMs: 0, heightM: 2 },
        ],
        0,
      ),
    ).toBe(2);
  });

  it('a secondary station (highs and lows only) follows the cosine rule', () => {
    expect(cosineBetween([HIGH, LOW], HIGH.timeMs)).toBeCloseTo(2.95);
    expect(cosineBetween([HIGH, LOW], (HIGH.timeMs + LOW.timeMs) / 2)).toBeCloseTo(1.6);
    expect(cosineBetween([HIGH, LOW], LOW.timeMs + 1)).toBeNull();
    const hilo: TideSeries = { observed: [], predicted: [], extremes: [PREV_LOW, HIGH, LOW] };
    expect(predictedAt(hilo, NOW)).toBeGreaterThan(0.25);
    expect(predictedAt(hilo, NOW)).toBeLessThan(2.95);
  });

  it('finds highs and lows on a curve (plateaus once)', () => {
    const ex = extremesOfCurve(series(-6, 12, 10));
    expect(ex.map((e) => e.kind)).toEqual(['low', 'high', 'low']);
    expect(Math.abs((ex[1]?.timeMs ?? 0) - HIGH.timeMs)).toBeLessThan(10 * MIN);
    const plateau = [1, 2, 2, 2, 1].map((h, i) => ({ timeMs: i, heightM: h }));
    expect(extremesOfCurve(plateau)).toEqual([{ timeMs: 1, heightM: 2, kind: 'high' }]);
  });
});

describe('levelReading: live, old, predicted', () => {
  it('a fresh reading is live with its trend and the next high or low', () => {
    const r = levelReading(live, NOW);
    expect(r?.kind).toBe('live');
    expect(r?.dir).toBe('up');
    expect(r?.next).toBe(HIGH);
    expect(r?.ageMs).toBe(0);
  });

  it('a reading 2 h old is pale with its age, no arrow, the next tide kept', () => {
    const old = { ...live, observed: series(-12, -2, 6) };
    const r = levelReading(old, NOW);
    expect(r).toMatchObject({ kind: 'stale', dir: null, rateMPerH: null, next: HIGH });
    expect(r?.ageMs).toBe(2 * H);
  });

  it('older than 12 h (or no gauge) shows the predicted level and slope', () => {
    const ancient = { ...live, observed: series(-30, -13, 6) };
    const r = levelReading(ancient, NOW);
    expect(r?.kind).toBe('pred');
    expect(r?.heightM).toBeCloseTo(tide(0), 1);
    expect(r?.dir).toBe('up');
    expect(levelReading({ ...live, observed: [] }, NOW)?.kind).toBe('pred');
  });

  it('nothing known → null', () => {
    expect(levelReading({ observed: [], predicted: [], extremes: [] }, NOW)).toBeNull();
  });

  it('ignores readings from the future', () => {
    const r = levelReading({ ...live, observed: series(-1, 2, 6) }, NOW);
    expect(r?.timeMs).toBeLessThanOrEqual(NOW + MIN);
  });
});

describe('the label text', () => {
  const reading: LevelReading = {
    kind: 'live',
    heightM: 1.36,
    timeMs: NOW,
    ageMs: 0,
    dir: 'up',
    rateMPerH: 0.66,
    next: HIGH,
  };

  it('full zoom: value, arrow, · next high with height and time', () => {
    expect(levelLabel(reading, 'full', METRIC, clock)).toEqual({
      value: '1.36 m',
      dir: 'up',
      rest: ` · H 2.95 m ${clock(HIGH.timeMs)}`,
    });
  });

  it('mid zoom (variant B): one decimal and the next tide time only', () => {
    expect(levelLabel(reading, 'mid', METRIC, clock)).toEqual({
      value: '1.4 m',
      dir: 'up',
      rest: ` · H ${clock(HIGH.timeMs)}`,
    });
  });

  it('z13+: the rate joins and the next tide drops to a second line', () => {
    expect(levelLabel(reading, 'rate', METRIC, clock).rest).toBe(
      ` +0.66 m/h\nH 2.95 m ${clock(HIGH.timeMs)}`,
    );
  });

  it('an old reading: age, no arrow, no rate; the next low kept', () => {
    const old = {
      ...reading,
      kind: 'stale' as const,
      ageMs: 2 * H + 5 * MIN,
      dir: null,
      next: LOW,
    };
    expect(levelLabel(old, 'full', METRIC, clock)).toEqual({
      value: '1.36 m',
      dir: 'none',
      rest: ` · 2 h · L 0.25 m ${clock(LOW.timeMs)}`,
    });
    expect(levelLabel(old, 'rate', METRIC, clock).rest).toBe(
      ` · 2 h\nL 0.25 m ${clock(LOW.timeMs)}`,
    );
  });

  it('feet follow the unit setting; a falling rate gets a minus', () => {
    const ft = levelLabel({ ...reading, rateMPerH: -0.3 }, 'rate', IMPERIAL, clock);
    expect(ft.value).toBe('4.46 ft');
    expect(ft.rest).toContain('−0.98 ft/h');
    expect(ft.rest).toContain('H 9.68 ft');
  });

  it('no next tide known: just the level', () => {
    expect(levelLabel({ ...reading, next: null }, 'full', METRIC, clock).rest).toBe('');
    expect(levelLabel({ ...reading, next: null, dir: null }, 'mid', METRIC, clock).dir).toBe(
      'none',
    );
  });

  it('ages and rates read short', () => {
    expect(ageText(2 * H + 59 * MIN)).toBe('2 h');
    expect(ageText(30 * MIN)).toBe('30 min');
    expect(rateText(0, METRIC)).toBe('+0.00 m/h');
  });

  it('picks the nearest pill up (two-line pills for the z13+ form)', () => {
    const full = levelLabel(reading, 'full', METRIC, clock);
    expect(labelWidthPx(full)).toBeGreaterThan(120);
    expect(pillImage(full)).toMatch(/^tide-pill-1-(152|184)$/);
    expect(pillImage(levelLabel(reading, 'rate', METRIC, clock))).toMatch(/^tide-pill-2-/);
    expect(pillImage({ value: 'x'.repeat(80), dir: 'none', rest: '' })).toBe('tide-pill-1-216');
    expect(pillImage({ value: '1 m', dir: 'none', rest: '' })).toBe('tide-pill-1-48');
  });
});

describe('CHS high/low events', () => {
  it('are told apart by their neighbour; fewer than two say nothing', () => {
    const ev = [
      { timeMs: 3, heightM: 0.2 },
      { timeMs: 1, heightM: 0.3 },
      { timeMs: 2, heightM: 4.1 },
    ];
    expect(classifyHiLo(ev).map((e) => [e.timeMs, e.kind])).toEqual([
      [1, 'low'],
      [2, 'high'],
      [3, 'low'],
    ]);
    expect(classifyHiLo([{ timeMs: 1, heightM: 1 }])).toEqual([]);
  });
});

describe('which stations get a request', () => {
  it('reads a station’s feeds from its catalogue source', () => {
    const coopsIndex = TIDE_CATALOG.sources.findIndex((s) => s.key === 'us-coops');
    expect(stationFeedsOf({ source: coopsIndex, kind: 'gauge', live: 'coops' })).toEqual({
      observed: 'coops',
      predicted: 'coops',
    });
    expect(stationFeedsOf({ source: CHS_SOURCE_INDEX, kind: 'ref' })).toEqual({
      observed: null,
      predicted: 'chs',
    });
    expect(stationFeedsOf({ source: 999, kind: 'gauge' })).toEqual({
      observed: null,
      predicted: null,
    });
  });

  const coops = (kind: string, live?: string) =>
    stationFeeds({ sourceKey: 'us-coops', kind, live });
  it('maps each agency to its feeds', () => {
    expect(coops('gauge', 'coops')).toEqual({ observed: 'coops', predicted: 'coops' });
    expect(coops('ref')).toEqual({ observed: null, predicted: 'coops' });
    expect(coops('sec')).toEqual({ observed: null, predicted: 'coops-hilo' });
    expect(coops('hist')).toEqual({ observed: null, predicted: null });
    expect(stationFeeds({ sourceKey: 'no-kartverket', kind: 'gauge', live: 'kv' })).toEqual({
      observed: 'kv',
      predicted: 'kv',
    });
    expect(stationFeeds({ sourceKey: 'ca-chs', kind: 'gauge', live: 'chs' })).toEqual({
      observed: 'chs',
      predicted: 'chs',
    });
    expect(stationFeeds({ sourceKey: 'ca-chs', kind: 'ref' }).predicted).toBe('chs');
    expect(stationFeeds({ sourceKey: 'ca-chs', kind: 'hist' }).predicted).toBeNull();
    expect(stationFeeds({ sourceKey: 'fr-shom', kind: 'gauge' })).toEqual({
      observed: null,
      predicted: null,
    });
  });

  const at = (i: number, feeds: ReturnType<typeof stationFeeds>) => ({
    id: String(i),
    lat: 42 + i * 0.01,
    lng: -71,
    feeds,
  });
  it('mid zoom: live gauges only; z11: any feed; nearest first, at most 12', () => {
    const list = [
      at(3, coops('gauge', 'coops')),
      at(1, coops('ref')),
      at(2, coops('hist')),
      at(0, coops('gauge', 'coops')),
    ];
    expect(pickLevelStations(list, [-71, 42], 'mid').map((s) => s.id)).toEqual(['0', '3']);
    expect(pickLevelStations(list, [-71, 42], 'full').map((s) => s.id)).toEqual(['0', '1', '3']);
    const many = Array.from({ length: 30 }, (_, i) => at(i, coops('gauge', 'coops')));
    const picked = pickLevelStations(many, [-71, 42.15], 'full');
    expect(picked).toHaveLength(LEVELS_MAX_STATIONS);
    expect(picked[0]?.id).toBe('15');
  });
});

describe('levelFeatures', () => {
  it('one feature per known reading, a text per tier', () => {
    const fc = levelFeatures(
      [
        { id: '0:8443970', lng: -71.05, lat: 42.35, reading: levelReading(live, NOW) },
        { id: '0:x', lng: 0, lat: 0, reading: null },
      ],
      METRIC,
      clock,
    );
    expect(fc.features).toHaveLength(1);
    const p = fc.features[0]?.properties;
    expect(fc.features[0]?.geometry.coordinates).toEqual([-71.05, 42.35]);
    expect(p).toMatchObject({ id: '0:8443970', k: 'live', d: 'up' });
    expect(p?.v1).toMatch(/^\d\.\d m$/);
    expect(p?.v2).toMatch(/^\d\.\d\d m$/);
    expect(p?.r1).toBe(` · H ${clock(HIGH.timeMs)}`);
    expect(p?.r3).toContain('\n');
    expect(p?.p3).toMatch(/^tide-pill-2-/);
  });
});

describe('tideGraph', () => {
  it('observed past, the predicted curve, now, the next high and low, a grid', () => {
    const g = tideGraph(live, NOW, METRIC, clock);
    expect(g).not.toBeNull();
    if (!g) return;
    expect(g.observed[0]?.t).toBeCloseTo(-8);
    expect(g.observed[g.observed.length - 1]?.t).toBeCloseTo(0);
    expect(g.predicted[0]?.t).toBeCloseTo(-8);
    expect(g.predicted[g.predicted.length - 1]?.t).toBeCloseTo(16);
    expect(g.now?.t).toBe(0);
    expect(g.marks.map((m) => m.kind)).toEqual(['high', 'low']);
    expect(g.marks[0]?.label).toBe(`High ${clock(HIGH.timeMs)} · 2.95`);
    expect(g.yMin).toBeLessThanOrEqual(0.25);
    expect(g.yMax).toBeGreaterThan(2.95);
    expect(g.yTicks[0]).toBe(g.yMin);
    expect(g.unit).toBe('m');
    expect(g.lastObserved).toBeNull();
    expect(g.xTicks.length).toBeGreaterThanOrEqual(7);
    // Every tick on a whole 3 h of the phone's clock.
    for (const x of g.xTicks) expect(Number(x.label) % 3).toBe(0);
  });

  it('ticks follow the phone zone', () => {
    const g = tideGraph(live, NOW, METRIC, (ms) => clock(ms - 4 * H), -4 * H);
    for (const x of g?.xTicks ?? []) expect(Number(x.label) % 3).toBe(0);
  });

  it('feet: every height in the display unit', () => {
    const g = tideGraph(live, NOW, IMPERIAL, clock);
    expect(g?.unit).toBe('ft');
    expect(Math.max(...(g?.predicted ?? []).map((p) => p.v))).toBeGreaterThan(9);
  });

  it('an old reading: its last point marked, now on the predicted curve', () => {
    const g = tideGraph({ ...live, observed: series(-12, -2, 6) }, NOW, METRIC, clock);
    expect(g?.lastObserved?.t).toBeCloseTo(-2);
    expect(g?.now?.v).toBeCloseTo(tide(0), 1);
  });

  it('predictions only: no observed line; nothing at all → null', () => {
    const g = tideGraph({ ...live, observed: [] }, NOW, METRIC, clock);
    expect(g?.observed).toEqual([]);
    expect(g?.now).not.toBeNull();
    expect(tideGraph({ observed: [], predicted: [], extremes: [] }, NOW, METRIC, clock)).toBeNull();
  });

  it('grid steps stay round', () => {
    expect(niceStep(0.3)).toBe(0.1);
    expect(niceStep(3.2)).toBe(1);
    expect(niceStep(11)).toBe(2.5);
    expect(niceStep(400)).toBe(50);
  });
});
