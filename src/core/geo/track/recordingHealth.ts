import { haversineMeters } from '@core/geo/geomath';
import type { TrackPoint } from '@core/models';

/**
 * Pure post-hoc diagnosis of a recording: did the GPS feed actually work?
 *
 * Field report (2.4.x): "the GPS seemed to only work at a couple of steps, so
 * it's mostly straight lines". A track like that has one of two causes the
 * user can fix, and they need different instructions:
 *
 * - **Approximate location.** iOS "Precise: Off" or Android "Approximate"
 *   delivers fixes with a kilometre-scale accuracy radius. The recorder's GPS
 *   filter (`gpsFilter.ts`, 35 m gate) correctly drops every one of them, so
 *   the trail is empty or a handful of points. The recorder counts those drops
 *   (`approximateFixes`) and the permission's accuracy is read at record start
 *   (`preciseLocation`).
 * - **Background delivery stopped.** The OS (Samsung "sleeping apps", battery
 *   optimization, a killed foreground service) stopped location while the
 *   screen was off. The track then has long silent spans in which the user
 *   moved far — drawn as straight lines between the fixes on either side.
 *   `backgroundIntervals` (when the app was not in the foreground) tells a
 *   screen-off gap apart from a tunnel or canyon (`signal-gap`), which no
 *   setting can fix.
 *
 * A silent span alone is not a gap: the recorder's distance filter withholds
 * fixes while the user stands still. Only a span in which the user ALSO moved
 * at least {@link GAP_MIN_DISTANCE_M} counts, and pauses are never gaps.
 */

/** A time span, epoch ms, `from <= to`. */
export interface TimeInterval {
  from: number;
  to: number;
}

/** Fixes whose accuracy radius is at least this are approximate-location fixes,
 * not merely weak ones (tree cover reads tens of metres; approximate, ~1–3 km). */
export const APPROXIMATE_ACCURACY_M = 500;

/** A silent span shorter than this is ordinary fix jitter, never a gap. */
export const GAP_MIN_MS = 90_000;

/** A silent span must also bridge at least this much ground to be a gap. */
export const GAP_MIN_DISTANCE_M = 150;

/** Total screen-off gap time from which a recording is reported as broken
 * (one short blip — a lift, a doze window — is not worth a settings detour). */
export const BACKGROUND_GAP_REPORT_MS = 120_000;

export interface RecordingHealthInput {
  /** Accepted fixes, time-ordered (the saved track's points). */
  points: readonly TrackPoint[];
  /** Pauses (user or auto); a span crossing one is never a gap. */
  pauses: readonly TimeInterval[];
  /** When the app was in the background / the screen was off. */
  backgroundIntervals: readonly TimeInterval[];
  /** Fixes the recorder dropped for an accuracy radius ≥ {@link APPROXIMATE_ACCURACY_M}. */
  approximateFixes: number;
  /** The location permission's precision at record start; null when unknown. */
  preciseLocation: boolean | null;
}

export interface RecordingGap {
  from: number;
  to: number;
  durationMs: number;
  /** Straight-line distance bridged by the gap. */
  distanceM: number;
  /** True when at least half the gap fell while the app was in the background. */
  inBackground: boolean;
}

export type RecordingHealthKind =
  | 'healthy'
  /** Precise location is off: fixes were too coarse to draw a trail. */
  | 'approximate-location'
  /** Location stopped arriving while the screen was off. */
  | 'background-gap'
  /** Fixes stopped while the app was in front (no sky: tunnel, canyon). */
  | 'signal-gap';

export interface RecordingHealth {
  kind: RecordingHealthKind;
  gaps: RecordingGap[];
  /** Summed duration of gaps that fell mostly in the background. */
  backgroundGapMs: number;
  /** Summed duration of the other gaps. */
  signalGapMs: number;
}

function overlapMs(a: TimeInterval, b: TimeInterval): number {
  return Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
}

function crossesPause(span: TimeInterval, pauses: readonly TimeInterval[]): boolean {
  return pauses.some((p) => overlapMs(span, p) > 0 || (p.from >= span.from && p.from <= span.to));
}

/** The silent spans in which the user moved: candidates for straight lines. */
export function findRecordingGaps(
  points: readonly TrackPoint[],
  pauses: readonly TimeInterval[],
  backgroundIntervals: readonly TimeInterval[],
): RecordingGap[] {
  const gaps: RecordingGap[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const next = points[i];
    if (!prev || !next) continue;
    const span = { from: prev.time, to: next.time };
    const durationMs = span.to - span.from;
    if (durationMs < GAP_MIN_MS) continue;
    const distanceM = haversineMeters(prev, next);
    if (distanceM < GAP_MIN_DISTANCE_M) continue;
    if (crossesPause(span, pauses)) continue;
    const backgroundMs = backgroundIntervals.reduce((sum, b) => sum + overlapMs(span, b), 0);
    gaps.push({ ...span, durationMs, distanceM, inBackground: backgroundMs * 2 >= durationMs });
  }
  return gaps;
}

/**
 * Classify a finished (or in-progress) recording. Precedence: approximate
 * location explains everything else (its gaps are dropped coarse fixes), then
 * screen-off gaps (fixable in settings), then signal gaps (informational).
 */
export function analyzeRecordingHealth(input: RecordingHealthInput): RecordingHealth {
  const gaps = findRecordingGaps(input.points, input.pauses, input.backgroundIntervals);
  let backgroundGapMs = 0;
  let signalGapMs = 0;
  for (const g of gaps) {
    if (g.inBackground) backgroundGapMs += g.durationMs;
    else signalGapMs += g.durationMs;
  }
  const approximate =
    input.preciseLocation === false ||
    (input.approximateFixes >= 3 && input.approximateFixes > input.points.length);
  const kind: RecordingHealthKind = approximate
    ? 'approximate-location'
    : backgroundGapMs >= BACKGROUND_GAP_REPORT_MS
      ? 'background-gap'
      : signalGapMs > 0
        ? 'signal-gap'
        : 'healthy';
  return { kind, gaps, backgroundGapMs, signalGapMs };
}

/** "45 s", "12 min", "1 h 05 min" — for user-facing gap durations. */
export function formatGapDuration(ms: number): string {
  if (ms < 59_500) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

/** One-sentence explanation of what went wrong, or null when nothing did. */
export function describeRecordingHealth(health: RecordingHealth): string | null {
  switch (health.kind) {
    case 'approximate-location':
      return 'Precise location is off, so GPS positions were too rough (about 1–3 km) to draw your trail.';
    case 'background-gap':
      return `GPS updates stopped for ${formatGapDuration(health.backgroundGapMs)} while the screen was off, so parts of your trail are straight lines.`;
    case 'signal-gap':
      return `No GPS signal for ${formatGapDuration(health.signalGapMs)} (tunnel, canyon or indoors), so part of your trail is a straight line.`;
    case 'healthy':
      return null;
  }
}

/** True when the user can fix the cause in their phone's settings. */
export function isFixableByUser(kind: RecordingHealthKind): boolean {
  return kind === 'approximate-location' || kind === 'background-gap';
}
