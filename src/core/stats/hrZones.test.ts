import {
  estimateMaxHr,
  estimateMaxHrForLibrary,
  histogramsIn,
  MIN_SAMPLES_FOR_ESTIMATE,
  parseMaxHr,
  zoneBreakdown,
  zoneOf,
} from './hrZones';
import type { TrailStatsSummary } from './trailSummary';

describe('zoneOf', () => {
  it('bins by share of max HR', () => {
    expect(zoneOf(99, 200)).toBe(0);
    expect(zoneOf(100, 200)).toBe(1);
    expect(zoneOf(119, 200)).toBe(1);
    expect(zoneOf(120, 200)).toBe(2);
    expect(zoneOf(140, 200)).toBe(3);
    expect(zoneOf(160, 200)).toBe(4);
    expect(zoneOf(180, 200)).toBe(5);
    expect(zoneOf(210, 200)).toBe(5);
    expect(zoneOf(150, 0)).toBe(0);
  });
});

describe('zoneBreakdown', () => {
  it('sums seconds per zone across trails, with fractions and bpm ranges', () => {
    const b = zoneBreakdown(
      [
        { bpm: [90, 110, 130], seconds: [100, 60, 30], samples: [1, 1, 1] },
        null,
        { bpm: [130, 185], seconds: [30, 120], samples: [1, 1] },
      ],
      200,
    );
    expect(b.totalS).toBe(240);
    expect(b.zones.map((z) => z.seconds)).toEqual([60, 60, 0, 0, 120]);
    expect(b.zones[0]).toMatchObject({ zone: 1, fromBpm: 100, toBpm: 120, fraction: 0.25 });
    expect(b.zones[4]).toMatchObject({ zone: 5, fromBpm: 180, toBpm: 200, fraction: 0.5 });
  });

  it('is all zeros with no data', () => {
    const b = zoneBreakdown([], 190);
    expect(b.totalS).toBe(0);
    expect(b.zones.every((z) => z.fraction === 0)).toBe(true);
  });
});

describe('estimateMaxHr', () => {
  it('takes the 99th percentile of the samples, ignoring a rare spike', () => {
    // 990 samples at 150, 9 at 185, one glitch at 230 — 1000 total.
    const h = { bpm: [150, 185, 230], seconds: [0, 0, 0], samples: [990, 9, 1] };
    expect(estimateMaxHr([h])).toBe(150);
    const h2 = { bpm: [150, 185, 230], seconds: [0, 0, 0], samples: [980, 19, 1] };
    expect(estimateMaxHr([h2])).toBe(185);
  });

  it('merges trails and needs enough samples', () => {
    const few = { bpm: [170], seconds: [0], samples: [MIN_SAMPLES_FOR_ESTIMATE - 1] };
    expect(estimateMaxHr([few, null])).toBeNull();
    expect(estimateMaxHr([few, { bpm: [171], seconds: [0], samples: [1] }])).toBe(170);
    expect(estimateMaxHr([{ bpm: [170], seconds: [0], samples: [0] }])).toBeNull();
  });
});

describe('parseMaxHr', () => {
  it('accepts plausible integers only', () => {
    expect(parseMaxHr(' 186 ')).toBe(186);
    expect(parseMaxHr('99')).toBeNull();
    expect(parseMaxHr('231')).toBeNull();
    expect(parseMaxHr('18.5')).toBeNull();
    expect(parseMaxHr('')).toBeNull();
  });
});

describe('histogramsIn / estimateMaxHrForLibrary', () => {
  const NOW = Date.UTC(2026, 9, 2);
  const DAY = 86_400_000;
  const hr = (bpm: number, n: number): TrailStatsSummary => ({
    v: 1,
    bestDistanceS: [],
    bestClimbS: [],
    hr: { bpm: [bpm], seconds: [n], samples: [n] },
  });
  const tracks = [
    { id: 'recent', startedAt: NOW - 10 * DAY },
    { id: 'old', startedAt: NOW - 400 * DAY },
    { id: 'nohr', startedAt: NOW - DAY },
    { id: 'pending', startedAt: NOW - DAY },
  ];
  const summaries = new Map<string, TrailStatsSummary>([
    ['recent', hr(178, 400)],
    ['old', hr(200, 400)],
    ['nohr', { ...hr(0, 0), hr: null }],
  ]);

  it('keeps the trails in the window that have heart rate', () => {
    expect(histogramsIn(tracks, summaries, NOW - 30 * DAY, NOW)).toEqual([hr(178, 400).hr]);
  });

  it('estimates from the last 12 months only', () => {
    expect(estimateMaxHrForLibrary(tracks, summaries, NOW)).toBe(178);
  });
});
