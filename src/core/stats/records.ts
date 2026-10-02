import { isPerformedActivity } from '@core/dashboard/aggregate';
import type { TrackSummary } from '@core/models';

import { EFFORT_CLIMBS_M, EFFORT_DISTANCES_M, type TrailStatsSummary } from './trailSummary';

/**
 * Personal records: the fastest stretches (from each trail's cached summary)
 * and the biggest outings (from the library index), per activity family.
 */

export type RecordFamily = 'run' | 'hike' | 'bike';

/** The categories each records tab draws from. */
export const FAMILY_CATEGORIES: Record<RecordFamily, readonly string[]> = {
  run: ['run', 'trail-run'],
  hike: ['hike', 'walk', 'snowshoe'],
  bike: ['bike'],
};

/** A record set this recently wears a "NEW" badge. */
export const NEW_RECORD_MS = 14 * 24 * 3600 * 1000;

export type RecordKind = 'time' | 'distance' | 'climb' | 'duration' | 'altitude';

export interface RecordRow {
  key: string;
  label: string;
  kind: RecordKind;
  /** Seconds (time, duration) or metres (distance, climb, altitude); null: no record yet. */
  value: number | null;
  trackId?: string;
  trackName?: string;
  startedAt?: number;
  isNew: boolean;
  /** What the empty row says ("No run long enough yet"). */
  emptyText: string;
}

type RecordTrack = Pick<TrackSummary, 'id' | 'name' | 'startedAt' | 'category' | 'plan' | 'stats'>;

/** Whether a trail belongs to a records tab. */
export function inFamily(
  t: Pick<TrackSummary, 'category' | 'plan'>,
  family: RecordFamily,
): boolean {
  return (
    isPerformedActivity(t) &&
    t.category !== undefined &&
    FAMILY_CATEGORIES[family].includes(t.category)
  );
}

interface Target {
  key: string;
  label: string;
  /** Index into the summary's bestDistanceS / bestClimbS. */
  index: number;
  climb: boolean;
}

function distanceIndex(m: number): number {
  return EFFORT_DISTANCES_M.indexOf(m as (typeof EFFORT_DISTANCES_M)[number]);
}

function climbIndex(m: number): number {
  return EFFORT_CLIMBS_M.indexOf(m as (typeof EFFORT_CLIMBS_M)[number]);
}

const FASTEST: Record<RecordFamily, Target[]> = {
  run: [
    { key: '1k', label: '1 km', index: distanceIndex(1000), climb: false },
    { key: '5k', label: '5 km', index: distanceIndex(5000), climb: false },
    { key: '10k', label: '10 km', index: distanceIndex(10000), climb: false },
    { key: 'half', label: 'Half marathon', index: distanceIndex(21097.5), climb: false },
    { key: 'marathon', label: 'Marathon', index: distanceIndex(42195), climb: false },
  ],
  bike: [
    { key: '5k', label: '5 km', index: distanceIndex(5000), climb: false },
    { key: '20k', label: '20 km', index: distanceIndex(20000), climb: false },
    { key: '40k', label: '40 km', index: distanceIndex(40000), climb: false },
  ],
  hike: [
    { key: 'c100', label: '100 m climb', index: climbIndex(100), climb: true },
    { key: 'c500', label: '500 m climb', index: climbIndex(500), climb: true },
    { key: 'c1000', label: '1000 m climb', index: climbIndex(1000), climb: true },
  ],
};

const FASTEST_EMPTY: Record<RecordFamily, string> = {
  run: 'No run long enough yet',
  bike: 'No ride long enough yet',
  hike: 'No climb that big yet',
};

const BIGGEST_EMPTY: Record<RecordFamily, string> = {
  run: 'No run yet',
  bike: 'No ride yet',
  hike: 'No hike yet',
};

function row(
  base: Omit<RecordRow, 'isNew' | 'value'>,
  best: { value: number; track: RecordTrack } | null,
  now: number,
): RecordRow {
  if (best === null) return { ...base, value: null, isNew: false };
  return {
    ...base,
    value: best.value,
    trackId: best.track.id,
    trackName: best.track.name,
    startedAt: best.track.startedAt,
    isNew: best.track.startedAt <= now && now - best.track.startedAt <= NEW_RECORD_MS,
  };
}

/** Oldest first, so on a tie the record stays with whoever set it first. */
function chronological<T extends RecordTrack>(tracks: readonly T[], family: RecordFamily): T[] {
  return tracks.filter((t) => inFamily(t, family)).sort((a, b) => a.startedAt - b.startedAt);
}

/** "Fastest": the best stretch of each target distance (or climb) over the family's trails. */
export function fastestRecords(
  family: RecordFamily,
  tracks: readonly RecordTrack[],
  summaries: ReadonlyMap<string, TrailStatsSummary>,
  now: number,
): RecordRow[] {
  const mine = chronological(tracks, family);
  return FASTEST[family].map((target) => {
    let best: { value: number; track: RecordTrack } | null = null;
    for (const t of mine) {
      const s = summaries.get(t.id);
      const v = s ? (target.climb ? s.bestClimbS : s.bestDistanceS)[target.index] : null;
      if (typeof v === 'number' && v > 0 && (best === null || v < best.value)) {
        best = { value: v, track: t };
      }
    }
    return row(
      { key: target.key, label: target.label, kind: 'time', emptyText: FASTEST_EMPTY[family] },
      best,
      now,
    );
  });
}

/** "Biggest outings": longest, biggest climb, longest moving time, highest point. */
export function biggestRecords(
  family: RecordFamily,
  tracks: readonly RecordTrack[],
  now: number,
): RecordRow[] {
  const mine = chronological(tracks, family);
  const pick = (read: (t: RecordTrack) => number | undefined) => {
    let best: { value: number; track: RecordTrack } | null = null;
    for (const t of mine) {
      const v = read(t);
      if (
        typeof v === 'number' &&
        Number.isFinite(v) &&
        v > 0 &&
        (best === null || v > best.value)
      ) {
        best = { value: v, track: t };
      }
    }
    return best;
  };
  const empty = BIGGEST_EMPTY[family];
  return [
    row(
      { key: 'longest', label: 'Longest', kind: 'distance', emptyText: empty },
      pick((t) => t.stats?.distanceM),
      now,
    ),
    row(
      { key: 'climb', label: 'Biggest climb', kind: 'climb', emptyText: empty },
      pick((t) => t.stats?.ascentM),
      now,
    ),
    row(
      { key: 'moving', label: 'Longest moving time', kind: 'duration', emptyText: empty },
      pick((t) => t.stats?.movingTimeS),
      now,
    ),
    row(
      { key: 'highest', label: 'Highest point', kind: 'altitude', emptyText: empty },
      pick((t) => t.stats?.maxAltitudeM),
      now,
    ),
  ];
}
