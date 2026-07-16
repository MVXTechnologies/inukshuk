/**
 * Pure GPS signal-quality classification for the recording HUD.
 *
 * The recorder silently drops bad-accuracy and teleport fixes (see
 * `gpsFilter.ts`), so during weak or lost signal the track simply stops growing
 * while the elapsed timer keeps running — the user has no way to tell recording
 * has effectively stalled. This maps how long it's been since the last ACCEPTED
 * fix (plus that fix's reported accuracy) to a coarse quality level the HUD can
 * turn into a "weak GPS / no signal" warning.
 *
 * Kept pure (no react-native/expo) and unit-tested; the platform layer only
 * feeds it `(lastAcceptedAt, now, lastAccuracyM)`.
 */

export type GpsQuality = 'acquiring' | 'good' | 'weak' | 'lost';

/** No accepted fix for at least this long → signal is considered lost. */
export const GPS_LOST_MS = 20_000;

/** No accepted fix for at least this long (but less than lost) → weak signal. */
export const GPS_WEAK_MS = 8_000;

/**
 * Accepted fixes whose reported horizontal accuracy radius is worse than this
 * read as weak even when they arrive on time. Deliberately tighter than the
 * filter's `MAX_ACCURACY_M` (35 m): fixes between the two still count toward the
 * track but warn the user the position is coarse.
 */
export const GPS_WEAK_ACCURACY_M = 20;

/**
 * Classify current GPS quality from the time of the last accepted fix.
 *
 * - `lastAcceptedAt === null` (no fix accepted yet) → `'acquiring'`.
 * - Stale by `GPS_LOST_MS` or more → `'lost'`.
 * - Stale by `GPS_WEAK_MS` or more, or the last fix's accuracy is worse than
 *   `GPS_WEAK_ACCURACY_M` → `'weak'`.
 * - Otherwise → `'good'`.
 *
 * `now` and `lastAcceptedAt` are epoch milliseconds. A `lastAccuracyM` of null
 * (platform omitted accuracy) never by itself downgrades the level.
 */
export function gpsQualityLevel(
  lastAcceptedAt: number | null,
  now: number,
  lastAccuracyM: number | null,
): GpsQuality {
  if (lastAcceptedAt === null) return 'acquiring';
  const stalenessMs = now - lastAcceptedAt;
  if (stalenessMs >= GPS_LOST_MS) return 'lost';
  if (stalenessMs >= GPS_WEAK_MS) return 'weak';
  if (lastAccuracyM !== null && lastAccuracyM > GPS_WEAK_ACCURACY_M) return 'weak';
  return 'good';
}
