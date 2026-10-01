import type { LngLat } from '@core/models';
import { haversineM } from '@core/trails/geometry';

/**
 * The elevation profile of the route being drawn (#515): the SAME DEM samples
 * the climb stat and the saved GPX come from (`RouteElevationResult` — the
 * densified line and one elevation per sample), turned into a distance /
 * elevation series to chart, plus the scrub math (finger position → point on
 * the line, elevation and grade there).
 *
 * Pure; coordinates are `[lng, lat]`.
 */

export interface ProfilePoint {
  /** Distance from the route start, metres. */
  distanceM: number;
  elevationM: number;
  at: LngLat;
}

export interface DrawProfile {
  points: ProfilePoint[];
  totalM: number;
  minM: number;
  maxM: number;
}

/**
 * The profile of `samples` (the densified line) with their `elevations`;
 * samples without an elevation still count for distance. Null with fewer than
 * two elevations (nothing to chart).
 */
export function buildDrawProfile(
  samples: readonly LngLat[],
  elevations: readonly (number | undefined)[],
): DrawProfile | null {
  const points: ProfilePoint[] = [];
  let walked = 0;
  let prev: LngLat | undefined;
  let minM = Infinity;
  let maxM = -Infinity;
  samples.forEach((p, i) => {
    if (prev !== undefined) walked += haversineM(prev, p);
    prev = p;
    const e = elevations[i];
    if (e === undefined || !Number.isFinite(e)) return;
    points.push({ distanceM: walked, elevationM: e, at: p });
    if (e < minM) minM = e;
    if (e > maxM) maxM = e;
  });
  if (points.length < 2) return null;
  return { points, totalM: walked, minM, maxM };
}

/** At most `max` points, evenly picked (first and last kept): a chart path, not a GPX. */
export function thinProfile(points: readonly ProfilePoint[], max: number): ProfilePoint[] {
  if (points.length <= max || max < 2) return [...points];
  const out: ProfilePoint[] = [];
  for (let i = 0; i < max; i++) {
    const p = points[Math.round((i * (points.length - 1)) / (max - 1))];
    if (p !== undefined) out.push(p);
  }
  return out;
}

/** SVG paths for a chart `width`×`height`: the line and the area under it (y grows down). */
export function profilePaths(
  profile: DrawProfile,
  width: number,
  height: number,
  { maxPoints = 160, padY = 3 }: { maxPoints?: number; padY?: number } = {},
): { line: string; area: string } {
  const pts = thinProfile(profile.points, maxPoints);
  const span = Math.max(profile.maxM - profile.minM, 1);
  const x = (d: number) => (profile.totalM > 0 ? (d / profile.totalM) * width : 0);
  const y = (e: number) => padY + (1 - (e - profile.minM) / span) * (height - 2 * padY);
  const coords = pts.map((p) => `${x(p.distanceM).toFixed(1)},${y(p.elevationM).toFixed(1)}`);
  const line = `M${coords.join('L')}`;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const area =
    first && last
      ? `${line}L${x(last.distanceM).toFixed(1)},${height}L${x(first.distanceM).toFixed(1)},${height}Z`
      : '';
  return { line, area };
}

export interface ProfileScrubPoint {
  distanceM: number;
  elevationM: number;
  /** Grade around this point, percent (+ climbing in the drawing direction). */
  gradePct: number;
  /** Where it is on the line (the map marker). */
  at: LngLat;
  /** 0..1 position on the chart, for the cursor. */
  ratio: number;
}

/** Half-width of the window the grade is measured over, metres (DEM noise smooths out). */
const GRADE_HALF_WINDOW_M = 50;

/** Index of the last point at or before `d` (binary search; points ascend by distance). */
function indexAt(points: readonly ProfilePoint[], d: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((points[mid]?.distanceM ?? Infinity) <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Linear interpolation of elevation and position at distance `d`. */
function interpolate(points: readonly ProfilePoint[], d: number): ProfilePoint | null {
  const i = indexAt(points, d);
  const a = points[i];
  const b = points[i + 1];
  if (a === undefined) return null;
  if (b === undefined || b.distanceM <= a.distanceM) return a;
  const t = Math.max(0, Math.min(1, (d - a.distanceM) / (b.distanceM - a.distanceM)));
  return {
    distanceM: d,
    elevationM: a.elevationM + (b.elevationM - a.elevationM) * t,
    at: [a.at[0] + (b.at[0] - a.at[0]) * t, a.at[1] + (b.at[1] - a.at[1]) * t],
  };
}

/** The point under a finger at `ratio` (0..1) of the chart width; null for no profile. */
export function scrubProfile(profile: DrawProfile, ratio: number): ProfileScrubPoint | null {
  if (!Number.isFinite(ratio)) return null;
  const r = Math.max(0, Math.min(1, ratio));
  const first = profile.points[0];
  const last = profile.points[profile.points.length - 1];
  if (first === undefined || last === undefined) return null;
  const d = first.distanceM + r * (last.distanceM - first.distanceM);
  const here = interpolate(profile.points, d);
  if (here === null) return null;
  const d0 = Math.max(first.distanceM, d - GRADE_HALF_WINDOW_M);
  const d1 = Math.min(last.distanceM, d + GRADE_HALF_WINDOW_M);
  const a = interpolate(profile.points, d0);
  const b = interpolate(profile.points, d1);
  const gradePct = a && b && d1 > d0 ? ((b.elevationM - a.elevationM) / (d1 - d0)) * 100 : 0;
  return {
    distanceM: here.distanceM,
    elevationM: here.elevationM,
    gradePct,
    at: here.at,
    ratio: profile.totalM > 0 ? here.distanceM / profile.totalM : r,
  };
}
