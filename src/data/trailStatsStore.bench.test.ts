import { buildGpx, parseGpx } from '@core/geo/gpx';
import { scanGpxActivity } from '@core/geo/gpx/scanActivity';
import type { TrackPoint, TrackSummary } from '@core/models';
import { estimateMaxHrForLibrary, histogramsIn, zoneBreakdown } from '@core/stats/hrZones';
import {
  comparisonLine,
  periodBars,
  periodWindow,
  statsTracks,
  totalsIn,
  type StatsPeriod,
} from '@core/stats/periods';
import { biggestRecords, fastestRecords, type RecordFamily } from '@core/stats/records';
import { weekStreaks } from '@core/stats/streaks';
import { M_PER_DEG_LAT } from '@core/stats/testTracks';
import { summarizeTrail } from '@core/stats/trailSummary';
import { yearReview } from '@core/stats/yearReview';

import { TrailStatsStore, type TrailStatsIO } from './trailStatsStore';

jest.mock('./storage', () => ({}));

/**
 * Logbook statistics at the owner's scale: 400 one-hour 1 Hz activities with
 * altitude and heart rate (≈1.4 M points). Opt-in — `STATS_BENCH=1 npx jest
 * trailStatsStore.bench` — so CI never pays for it; it prints the timings.
 */
const run = process.env.STATS_BENCH ? describe : describe.skip;

const N_TRAILS = 400;
const N_POINTS = 3600;
const CATEGORIES = ['run', 'run', 'bike', 'hike', 'ski'];

function activity(seed: number, start: number): TrackPoint[] {
  const out: TrackPoint[] = [];
  let lat = 46.8;
  let alt = 50;
  let hr = 120;
  for (let k = 0; k < N_POINTS; k++) {
    const v = 2.5 + Math.sin((k + seed) / 300);
    lat += v / M_PER_DEG_LAT;
    alt += Math.sin((k + seed * 7) / 120) * 0.8;
    hr = Math.min(195, Math.max(95, hr + Math.sin((k + seed) / 50) * 2));
    out.push({
      latitude: lat,
      longitude: -71.2 + Math.sin(k / 500) * 0.001,
      altitude: alt,
      time: start + k * 1000,
      heartRateBpm: Math.round(hr),
    });
  }
  return out;
}

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;

run('Logbook statistics bench (400 activities)', () => {
  const now = Date.UTC(2026, 9, 2, 12);
  const library: TrackSummary[] = Array.from({ length: N_TRAILS }, (_, i) => ({
    id: `t${i}`,
    name: `Activity ${i}`,
    startedAt: now - i * 2.2 * 86_400_000,
    fileUri: `tracks/t${i}.gpx`,
    category: CATEGORIES[i % CATEGORIES.length],
    stats: {
      distanceM: 8000 + (i % 13) * 900,
      ascentM: 80 + (i % 7) * 40,
      descentM: 80,
      durationS: 3600,
      movingTimeS: 3400,
      avgSpeedMps: 2.6,
      maxSpeedMps: 4,
      maxAltitudeM: 100 + (i % 11) * 30,
      pointCount: N_POINTS,
    },
  }));
  const lines: string[] = [];
  afterAll(() => {
    console.log(`\n${lines.join('\n')}\n`);
  });

  it('times every stage', async () => {
    // 1. One activity's GPX: the fast scan vs the full parse.
    const pts = activity(1, now);
    const xml = buildGpx({ points: pts, metadata: { name: 'bench' } });
    let t0 = performance.now();
    for (let i = 0; i < 10; i++) scanGpxActivity(xml);
    const scanMs = ms(t0) / 10;
    t0 = performance.now();
    for (let i = 0; i < 3; i++) parseGpx(xml);
    const parseMs = ms(t0) / 3;
    lines.push(
      `GPX of ${N_POINTS} pts (${Math.round(xml.length / 1024)} KB): scan ${scanMs.toFixed(1)} ms, full parse ${parseMs.toFixed(1)} ms`,
    );

    // 2. summarizeTrail alone, every activity.
    const points = Array.from({ length: 8 }, (_, i) => activity(i, now));
    t0 = performance.now();
    for (let i = 0; i < N_TRAILS; i++) summarizeTrail(points[i % points.length]!);
    const summarizeMs = ms(t0);
    lines.push(
      `summarizeTrail × ${N_TRAILS}: ${summarizeMs} ms (${(summarizeMs / N_TRAILS).toFixed(2)} ms each)`,
    );

    // 3. The backfill end to end (scan + summarise + batched writes), and the
    // longest stretch the JS thread is held between two yields.
    let text: string | null = null;
    const io: TrailStatsIO = {
      read: async () => text,
      write: (t) => {
        text = t;
      },
    };
    let lastYield = performance.now();
    let longest = 0;
    const store = new TrailStatsStore({
      io,
      loadPoints: async () => scanGpxActivity(xml),
      clock: {
        yieldToUi: async () => {
          longest = Math.max(longest, performance.now() - lastYield);
          await Promise.resolve();
          lastYield = performance.now();
        },
      },
    });
    t0 = performance.now();
    store.sync(library);
    await store.whenIdle();
    const backfillMs = ms(t0);
    lines.push(
      `backfill ${N_TRAILS} trails: ${backfillMs} ms total, longest step between yields ${longest.toFixed(1)} ms, ${store.stats.writes} writes`,
    );
    lines.push(`cache file: ${Math.round(text!.length / 1024)} KB`);

    // 4. A warm launch: reopening the cache.
    const reopened = new TrailStatsStore({ io, loadPoints: async () => null });
    t0 = performance.now();
    reopened.sync(library);
    await reopened.whenIdle();
    lines.push(
      `reopen cache (parse + validate ${N_TRAILS}): ${ms(t0)} ms, loads ${reopened.stats.loads}`,
    );

    // 5. Opening Statistics / Records / Year in review: every aggregation.
    const summaries = reopened.summaries();
    t0 = performance.now();
    const performed = statsTracks(library, null);
    const estimate = estimateMaxHrForLibrary(performed, summaries, now) ?? 190;
    for (const activityId of [null, 'run', 'bike', 'hike']) {
      const shown = statsTracks(performed, activityId);
      for (const period of ['week', 'month', 'year', 'all'] as StatsPeriod[]) {
        const w = periodWindow(period, now);
        totalsIn(shown, w);
        comparisonLine(shown, period, now);
        periodBars(shown, period, now);
        zoneBreakdown(histogramsIn(shown, summaries, w.startMs, w.endMs), estimate);
      }
      weekStreaks(
        shown.map((t) => t.startedAt),
        now,
      );
    }
    const statsMs = ms(t0);
    t0 = performance.now();
    for (const family of ['run', 'hike', 'bike'] as RecordFamily[]) {
      fastestRecords(family, library, summaries, now);
      biggestRecords(family, library, now);
    }
    const recordsMs = ms(t0);
    t0 = performance.now();
    yearReview(performed, 2026, 'distance');
    yearReview(performed, 2025, 'time');
    const yearMs = ms(t0);
    lines.push(
      `Statistics, all 16 activity×period views: ${statsMs} ms; records (3 tabs): ${recordsMs} ms; year in review ×2: ${yearMs} ms`,
    );
    expect(summaries.size).toBe(N_TRAILS);
  }, 120_000);
});
