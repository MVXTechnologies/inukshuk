/**
 * Pure half of the Strava activity import: request building for the activity
 * list and streams, total parsing of both responses, and the streams → points
 * conversion. No fetch, no platform APIs — the network half lives in
 * `src/lib/strava.ts`.
 *
 * Strava has no GPX/original-file export for activities in its API (only
 * routes export GPX), so an activity is rebuilt from its streams: `latlng`,
 * `time` (seconds from the start), `altitude` and `heartrate`, fetched with
 * `key_by_type=true` so each stream arrives keyed by name.
 */

import type { TrackPoint } from '@core/models';

export const STRAVA_API_BASE = 'https://www.strava.com/api/v3';

/** Strava's page-size ceiling for the activity list. */
export const STRAVA_ACTIVITIES_PER_PAGE = 100;

/** The streams an import needs, in the `keys` query order. */
export const IMPORT_STREAM_KEYS = ['latlng', 'time', 'altitude', 'heartrate'] as const;

/** One row of the athlete's activity list — just what the importer shows and dedupes on. */
export interface StravaActivitySummary {
  id: number;
  name: string;
  /** `sport_type` (the newer, finer field), falling back to the legacy `type`. */
  sportType: string;
  /** Epoch milliseconds of `start_date` (UTC). */
  startTime: number;
  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  /** False for manual entries and indoor activities: nothing to draw. */
  hasTrack: boolean;
}

export function buildActivitiesUrl(options: {
  page: number;
  perPage?: number;
  /** Only activities that started after this epoch-seconds instant. */
  after?: number;
  /** Only activities that started before this epoch-seconds instant. */
  before?: number;
}): string {
  const params: string[] = [
    `page=${Math.max(1, Math.floor(options.page))}`,
    `per_page=${options.perPage ?? STRAVA_ACTIVITIES_PER_PAGE}`,
  ];
  if (options.after !== undefined) params.push(`after=${Math.floor(options.after)}`);
  if (options.before !== undefined) params.push(`before=${Math.floor(options.before)}`);
  return `${STRAVA_API_BASE}/athlete/activities?${params.join('&')}`;
}

export function buildStreamsUrl(activityId: number): string {
  return `${STRAVA_API_BASE}/activities/${activityId}/streams?keys=${IMPORT_STREAM_KEYS.join(',')}&key_by_type=true`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Parse one page of `GET /athlete/activities`. Rows that lack an id or a
 * parseable start date are dropped rather than failing the page.
 */
export function parseActivitiesPage(json: unknown): StravaActivitySummary[] {
  if (!Array.isArray(json)) return [];
  const out: StravaActivitySummary[] = [];
  for (const item of json) {
    const row = asRecord(item);
    if (!row) continue;
    const id = asFinite(row.id);
    const startTime = typeof row.start_date === 'string' ? Date.parse(row.start_date) : NaN;
    if (id === null || !Number.isFinite(startTime)) continue;
    const sportType =
      (typeof row.sport_type === 'string' && row.sport_type) ||
      (typeof row.type === 'string' && row.type) ||
      'Workout';
    const polyline = asRecord(row.map)?.summary_polyline;
    out.push({
      id,
      name: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : sportType,
      sportType,
      startTime,
      distanceM: asFinite(row.distance) ?? 0,
      movingTimeS: asFinite(row.moving_time) ?? 0,
      elapsedTimeS: asFinite(row.elapsed_time) ?? 0,
      hasTrack:
        row.manual !== true &&
        row.trainer !== true &&
        typeof polyline === 'string' &&
        polyline !== '',
    });
  }
  return out;
}

function streamData(streams: Record<string, unknown>, key: string): unknown[] | null {
  const data = asRecord(streams[key])?.data;
  return Array.isArray(data) ? data : null;
}

/**
 * Rebuild track points from a `key_by_type=true` streams response. `time` is
 * seconds since the activity start, so `startTime` anchors it. Samples with no
 * usable position are skipped (GPS dropouts arrive as missing latlng pairs);
 * altitude/heart rate ride along when their stream is present and aligned.
 */
export function streamsToPoints(json: unknown, startTime: number): TrackPoint[] {
  const streams = asRecord(json);
  if (!streams) return [];
  const latlng = streamData(streams, 'latlng');
  if (!latlng) return [];
  const time = streamData(streams, 'time');
  const altitude = streamData(streams, 'altitude');
  const heartrate = streamData(streams, 'heartrate');

  const points: TrackPoint[] = [];
  for (let i = 0; i < latlng.length; i += 1) {
    const pair = latlng[i];
    if (!Array.isArray(pair)) continue;
    const lat = asFinite(pair[0]);
    const lon = asFinite(pair[1]);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (lat === 0 && lon === 0) continue;
    const offsetS = time ? asFinite(time[i]) : null;
    const point: TrackPoint = {
      latitude: lat,
      longitude: lon,
      time: offsetS === null ? startTime : startTime + offsetS * 1000,
      hasTime: offsetS !== null,
    };
    const ele = altitude ? asFinite(altitude[i]) : null;
    if (ele !== null) point.altitude = ele;
    const hr = heartrate ? asFinite(heartrate[i]) : null;
    if (hr !== null && hr > 0) point.heartRateBpm = hr;
    points.push(point);
  }
  return points;
}

/**
 * Strava `sport_type` → our built-in category id (`@core/library/categories`),
 * or undefined when nothing fits (the trail stays uncategorized).
 */
export function categoryForSportType(sportType: string): string | undefined {
  switch (sportType) {
    case 'Run':
    case 'VirtualRun':
      return 'run';
    case 'TrailRun':
      return 'trail-run';
    case 'Hike':
      return 'hike';
    case 'Walk':
      return 'walk';
    case 'Ride':
    case 'MountainBikeRide':
    case 'GravelRide':
    case 'EBikeRide':
    case 'EMountainBikeRide':
    case 'VirtualRide':
      return 'bike';
    case 'AlpineSki':
    case 'BackcountrySki':
    case 'NordicSki':
    case 'RollerSki':
      return 'ski';
    case 'Snowshoe':
      return 'snowshoe';
    default:
      return undefined;
  }
}

/** Strava's rate-limit headers: `"<15-min>,<daily>"` usage against limit. */
export interface RateLimitState {
  shortUsed: number;
  shortLimit: number;
  dailyUsed: number;
  dailyLimit: number;
}

/**
 * Parse the read-limit headers (`X-ReadRateLimit-*`, falling back to the
 * overall `X-RateLimit-*`). Null when absent or malformed.
 */
export function parseRateLimit(
  header: (name: string) => string | null | undefined,
): RateLimitState | null {
  const usage = header('X-ReadRateLimit-Usage') ?? header('X-RateLimit-Usage');
  const limit = header('X-ReadRateLimit-Limit') ?? header('X-RateLimit-Limit');
  if (!usage || !limit) return null;
  const pair = (text: string): [number, number] | null => {
    const [a, b] = text.split(',').map((v) => Number(v.trim()));
    return a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b)
      ? [a, b]
      : null;
  };
  const used = pair(usage);
  const max = pair(limit);
  if (!used || !max) return null;
  return { shortUsed: used[0], dailyUsed: used[1], shortLimit: max[0], dailyLimit: max[1] };
}

/**
 * How long to wait before the next streams request, in ms: nothing while
 * comfortably under the 15-minute window, until the next quarter-hour
 * boundary when it's nearly spent (Strava resets windows at :00/:15/:30/:45),
 * and `null` (stop for today) when the daily budget is nearly gone.
 */
export function rateLimitDelayMs(state: RateLimitState | null, now: number): number | null {
  if (!state) return 0;
  if (state.dailyUsed >= state.dailyLimit - 2) return null;
  if (state.shortUsed < state.shortLimit - 2) return 0;
  const quarter = 15 * 60_000;
  return quarter - (now % quarter) + 1_000;
}
