import type { TrackSummary } from '@core/models';

import type { HrHistogram, TrailStatsSummary } from './trailSummary';

/**
 * "Effort by heart-rate zone": time spent in Z1–Z5, zones as a share of max
 * heart rate (Z1 50–60 %, Z2 60–70 %, Z3 70–80 %, Z4 80–90 %, Z5 90–100 %).
 * Below 50 % is not an effort zone and is left out; above 100 % counts as Z5
 * (an estimated max is a percentile, so real peaks pass it).
 */

/** Lower bound of each zone, as a fraction of max HR (Z1 … Z5). */
export const ZONE_FLOORS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;

export interface ZoneTime {
  /** 1 … 5. */
  zone: number;
  /** Bpm range at this max HR: [from, to) — Z5's `to` is the max itself. */
  fromBpm: number;
  toBpm: number;
  seconds: number;
  /** Share of the zoned time, 0–1 (0 when nothing is zoned). */
  fraction: number;
}

export interface ZoneBreakdown {
  zones: ZoneTime[];
  /** Total zoned seconds. */
  totalS: number;
}

/** The zone (1–5) of a heart rate at `maxHr`, or 0 below Z1. */
export function zoneOf(bpm: number, maxHr: number): number {
  if (!(maxHr > 0)) return 0;
  const pct = bpm / maxHr;
  let zone = 0;
  for (let z = 0; z < ZONE_FLOORS.length; z++) if (pct >= ZONE_FLOORS[z]!) zone = z + 1;
  return zone;
}

/** Time in each zone over the given trails' histograms. */
export function zoneBreakdown(
  histograms: readonly (HrHistogram | null | undefined)[],
  maxHr: number,
): ZoneBreakdown {
  const seconds = [0, 0, 0, 0, 0];
  for (const h of histograms) {
    if (!h) continue;
    for (let k = 0; k < h.bpm.length; k++) {
      const zone = zoneOf(h.bpm[k]!, maxHr);
      if (zone > 0) seconds[zone - 1]! += h.seconds[k] ?? 0;
    }
  }
  const totalS = seconds.reduce((a, b) => a + b, 0);
  return {
    totalS,
    zones: seconds.map((s, i) => ({
      zone: i + 1,
      fromBpm: Math.round(ZONE_FLOORS[i]! * maxHr),
      toBpm: Math.round((ZONE_FLOORS[i + 1] ?? 1) * maxHr),
      seconds: s,
      fraction: totalS > 0 ? s / totalS : 0,
    })),
  };
}

/** Fewest samples an estimate is made from: below it, no estimate. */
export const MIN_SAMPLES_FOR_ESTIMATE = 300;

/**
 * Max heart rate estimated as the 99th percentile of every heart-rate sample
 * in the given histograms (the caller passes the last 12 months). A
 * percentile, not the maximum, so one strap glitch at 230 bpm doesn't set
 * everyone's zones. Null when there are too few samples to say.
 */
export function estimateMaxHr(
  histograms: readonly (HrHistogram | null | undefined)[],
  percentile = 0.99,
): number | null {
  const counts = new Map<number, number>();
  let total = 0;
  for (const h of histograms) {
    if (!h) continue;
    for (let k = 0; k < h.bpm.length; k++) {
      const c = h.samples[k] ?? 0;
      if (c <= 0) continue;
      counts.set(h.bpm[k]!, (counts.get(h.bpm[k]!) ?? 0) + c);
      total += c;
    }
  }
  if (total < MIN_SAMPLES_FOR_ESTIMATE) return null;
  const rank = Math.ceil(percentile * total);
  let seen = 0;
  for (const bpm of [...counts.keys()].sort((a, b) => a - b)) {
    seen += counts.get(bpm)!;
    if (seen >= rank) return bpm;
  }
  /* istanbul ignore next -- rank ≤ total, so the loop always returns */
  return null;
}

/** Plausible user-entered max heart rates (bpm). */
export const MAX_HR_RANGE = { min: 100, max: 230 } as const;

/** A typed max HR, validated: an integer in {@link MAX_HR_RANGE}, else null. */
export function parseMaxHr(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{2,3}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= MAX_HR_RANGE.min && n <= MAX_HR_RANGE.max ? n : null;
}

/** How far back the max-HR estimate looks. */
export const ESTIMATE_WINDOW_MS = 365 * 24 * 3600 * 1000;

type HrTrack = Pick<TrackSummary, 'id' | 'startedAt'>;

/**
 * The heart-rate histograms of the trails starting in [startMs, endMs) that
 * have heart rate — the trails "Effort by heart-rate zone" counts. Trails
 * whose summary isn't computed yet are skipped.
 */
export function histogramsIn(
  tracks: readonly HrTrack[],
  summaries: ReadonlyMap<string, TrailStatsSummary>,
  startMs: number,
  endMs: number,
): HrHistogram[] {
  const out: HrHistogram[] = [];
  for (const t of tracks) {
    if (t.startedAt < startMs || t.startedAt >= endMs) continue;
    const hr = summaries.get(t.id)?.hr;
    if (hr) out.push(hr);
  }
  return out;
}

/** {@link estimateMaxHr} over every trail of the last 12 months (all activities). */
export function estimateMaxHrForLibrary(
  tracks: readonly HrTrack[],
  summaries: ReadonlyMap<string, TrailStatsSummary>,
  now: number,
): number | null {
  return estimateMaxHr(histogramsIn(tracks, summaries, now - ESTIMATE_WINDOW_MS, now + 1));
}
