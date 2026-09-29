/**
 * Duplicate detection for bulk activity imports: the same activity exported
 * from Strava and from Garmin (or imported twice) has the same start time and
 * nearly the same distance, even though the files differ byte for byte.
 */

export interface ActivityFingerprint {
  /** Epoch ms of the first timed point. */
  startedAt: number;
  distanceM: number;
}

/** Start times within this window are "the same start". */
export const DUPLICATE_START_WINDOW_MS = 60_000;
/** Distances within this fraction (of the longer one) are "the same distance". */
export const DUPLICATE_DISTANCE_TOLERANCE = 0.02;

/** Same start (±60 s) and distance within 2 %? */
export function isSameActivity(a: ActivityFingerprint, b: ActivityFingerprint): boolean {
  if (Math.abs(a.startedAt - b.startedAt) > DUPLICATE_START_WINDOW_MS) return false;
  const longer = Math.max(a.distanceM, b.distanceM);
  return Math.abs(a.distanceM - b.distanceM) <= longer * DUPLICATE_DISTANCE_TOLERANCE;
}

/**
 * Minute-bucketed index of known activities, so checking each of thousands of
 * archive entries against a large library stays cheap. Seed it with the
 * library's tracks and {@link DuplicateIndex.add} each import, so the same
 * activity appearing twice in one archive (or in Strava + Garmin exports picked
 * together) is also caught.
 */
export class DuplicateIndex {
  private readonly buckets = new Map<number, ActivityFingerprint[]>();

  constructor(known: Iterable<ActivityFingerprint> = []) {
    for (const k of known) this.add(k);
  }

  add(fp: ActivityFingerprint): void {
    if (!Number.isFinite(fp.startedAt)) return;
    const key = Math.floor(fp.startedAt / DUPLICATE_START_WINDOW_MS);
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(fp);
    else this.buckets.set(key, [fp]);
  }

  has(fp: ActivityFingerprint): boolean {
    if (!Number.isFinite(fp.startedAt)) return false;
    const key = Math.floor(fp.startedAt / DUPLICATE_START_WINDOW_MS);
    for (const k of [key - 1, key, key + 1]) {
      if (this.buckets.get(k)?.some((known) => isSameActivity(known, fp))) return true;
    }
    return false;
  }
}
