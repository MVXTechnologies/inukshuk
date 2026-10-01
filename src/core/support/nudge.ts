/**
 * The optional once-a-year "chip in?" card in the Library (#476).
 *
 * Rules, all of which must hold:
 * - the build flag is on (`SUPPORT_NUDGE_ENABLED`, off until the owner says);
 * - at least {@link NUDGE_MIN_OUTINGS} outings were *recorded* with Inukshuk
 *   this calendar year — the card's own sentence ("You recorded N outings
 *   with Inukshuk this year") has to be true and worth saying;
 * - the card was last answered (Support or Not now) at least
 *   {@link NUDGE_INTERVAL_MS} ago, or never.
 *
 * "Recorded" means a trail with no import origin: trails imported from
 * Strava / Apple Health / Health Connect were not recorded with Inukshuk.
 *
 * Pure: no React Native / Expo imports.
 */

export const NUDGE_MIN_OUTINGS = 10;

/** 365 days: at most one nudge per 12 months. */
export const NUDGE_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

/** The only fields the rule reads from a Library trail. */
export interface NudgeTrack {
  startedAt: number;
  origin?: unknown;
}

/** Trails recorded (not imported) with a start in `year` (local calendar year of `now`). */
export function recordedOutingsInYear(tracks: readonly NudgeTrack[], year: number): number {
  let count = 0;
  for (const track of tracks) {
    if (track.origin !== undefined && track.origin !== null) continue;
    if (!Number.isFinite(track.startedAt) || track.startedAt <= 0) continue;
    if (new Date(track.startedAt).getFullYear() === year) count++;
  }
  return count;
}

export interface NudgeInput {
  enabled: boolean;
  tracks: readonly NudgeTrack[];
  now: number;
  /** Epoch ms of the last Support / Not now answer; 0 = never answered. */
  lastAnsweredAt: number;
}

/** The outing count to show, or null when the card must not appear. */
export function supportNudgeCount(input: NudgeInput): number | null {
  if (!input.enabled) return null;
  // A clock set backwards (answered "in the future") must not unlock the card
  // early: treat it as answered just now.
  const since = input.now - Math.min(input.lastAnsweredAt, input.now);
  if (input.lastAnsweredAt > 0 && since < NUDGE_INTERVAL_MS) return null;
  const count = recordedOutingsInYear(input.tracks, new Date(input.now).getFullYear());
  return count >= NUDGE_MIN_OUTINGS ? count : null;
}
