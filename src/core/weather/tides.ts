import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';

/**
 * CHS IWLS tides & water levels (marine M2). The Canadian Hydrographic
 * Service's Integrated Water Level System API (`api-iwls.dfo-mpo.gc.ca`) is
 * public and key-free: station metadata plus per-station time series —
 * `wlo` observed water level, `wlp` predictions, `wlp-hilo` high/low tide
 * events. Usage cap is 3 req/s / 30 req/min: the tide card makes at most
 * one station-list fetch (cached for the session) + two series fetches per
 * long-press, well under it.
 *
 * Same discipline as `forecast.ts`: parsers are total — any JSON in, a
 * usable view model (or null/empty) out. Network junk must never crash the
 * forecast card the Tides section rides in.
 *
 * Endpoints verified live 2026-08-08:
 * - GET /api/v1/stations?chs-region-code=QUE → [{ id, code, officialName,
 *   latitude, longitude, operating, timeSeries: [{ code, ... }] }]
 * - GET /api/v1/stations/{id}/data?time-series-code=wlo&from=ISO&to=ISO →
 *   [{ eventDate, qcFlagCode, value }]
 */

export const IWLS_API_URL = 'https://api-iwls.dfo-mpo.gc.ca/api/v1';

/** Credit line for IWLS data (Open Government Licence – Canada). */
export const CHS_TIDES_ATTRIBUTION = 'Tides: Fisheries and Oceans Canada (CHS IWLS)';

/**
 * "Near water" gate: without a marine layer on, the Tides section only shows
 * when the nearest tide station is within this range — a long-press in the
 * woods 100 km from the river must not grow a Tides section.
 */
export const TIDE_NEARBY_MAX_M = 25_000;

/**
 * With a marine layer active the user is explicitly in boat mode — allow a
 * farther station, but still bounded so mid-continent taps stay tide-free.
 */
export const TIDE_MARINE_MAX_M = 100_000;

/** Observed level lookback window (wlo is minute-cadence; 3 h is generous). */
export const TIDE_OBSERVED_WINDOW_MS = 3 * 3_600_000;

/** Prediction lookahead: 36 h always spans the next high AND low tide. */
export const TIDE_PREDICTION_WINDOW_MS = 36 * 3_600_000;

/** An observed level older than this is stale — show nothing instead. */
export const TIDE_LEVEL_MAX_AGE_MS = 90 * 60_000;

/** Series the tide card reads. */
export type TideSeriesCode = 'wlo' | 'wlp' | 'wlp-hilo';

export interface TideStation {
  /** IWLS station id (hex string) — the key for data queries. */
  id: string;
  /** CHS station code, e.g. "03248". */
  code: string;
  /** Official station name, e.g. "Vieux-Québec". */
  name: string;
  position: LatLng;
  /** Whether the station currently operates a live gauge. */
  operating: boolean;
  /** Offered time-series codes (wlo/wlp/wlp-hilo/...). */
  timeSeries: readonly string[];
}

/** Station list for a CHS region (QUE = the St. Lawrence system). */
export function stationsUrl(regionCode = 'QUE'): string {
  return `${IWLS_API_URL}/stations?chs-region-code=${encodeURIComponent(regionCode)}`;
}

/** Time-series data query for one station, epoch-ms window, ISO in the URL. */
export function stationDataUrl(
  stationId: string,
  series: TideSeriesCode,
  fromMs: number,
  toMs: number,
): string {
  const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const params = [
    `time-series-code=${encodeURIComponent(series)}`,
    `from=${encodeURIComponent(iso(fromMs))}`,
    `to=${encodeURIComponent(iso(toMs))}`,
  ];
  return `${IWLS_API_URL}/stations/${encodeURIComponent(stationId)}/data?${params.join('&')}`;
}

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse the /stations response; unusable entries are dropped, never thrown. */
export function parseStations(json: unknown): TideStation[] {
  if (!Array.isArray(json)) return [];
  const out: TideStation[] = [];
  for (const s of json) {
    if (!isRecord(s)) continue;
    const id = typeof s.id === 'string' && s.id !== '' ? s.id : null;
    const name = typeof s.officialName === 'string' && s.officialName !== '' ? s.officialName : null;
    const latitude = finite(s.latitude);
    const longitude = finite(s.longitude);
    if (id === null || name === null || latitude === null || longitude === null) continue;
    const timeSeries = Array.isArray(s.timeSeries)
      ? s.timeSeries
          .map((t: unknown) => (isRecord(t) && typeof t.code === 'string' ? t.code : null))
          .filter((c): c is string => c !== null)
      : [];
    out.push({
      id,
      code: typeof s.code === 'string' ? s.code : '',
      name,
      position: { latitude, longitude },
      operating: s.operating === true,
      timeSeries,
    });
  }
  return out;
}

export interface NearestTideStation {
  station: TideStation;
  distanceM: number;
}

/**
 * The nearest station that can actually feed the tide card — it must offer
 * high/low predictions (`wlp-hilo`, the section's spine; many entries in the
 * list are decommissioned wharves with no series at all). Null when none is
 * within `maxDistanceM`.
 */
export function nearestTideStation(
  stations: readonly TideStation[],
  at: LatLng,
  maxDistanceM: number,
): NearestTideStation | null {
  let best: NearestTideStation | null = null;
  for (const station of stations) {
    if (!station.timeSeries.includes('wlp-hilo')) continue;
    const distanceM = haversineMeters(at, station.position);
    if (distanceM > maxDistanceM) continue;
    if (best === null || distanceM < best.distanceM) best = { station, distanceM };
  }
  return best;
}

/** One reading of a water-level series (metres above chart datum). */
export interface TideReading {
  timeMs: number;
  heightM: number;
}

/** Parse a station data response into a time-sorted reading list. */
export function parseSeries(json: unknown): TideReading[] {
  if (!Array.isArray(json)) return [];
  const out: TideReading[] = [];
  for (const r of json) {
    if (!isRecord(r)) continue;
    const heightM = finite(r.value);
    const timeMs = typeof r.eventDate === 'string' ? Date.parse(r.eventDate) : NaN;
    if (heightM === null || !Number.isFinite(timeMs)) continue;
    out.push({ timeMs, heightM });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/**
 * The reading closest in time to `nowMs`, or null when the nearest one is
 * more than `maxAgeMs` away — an hours-stale "current" level is worse than
 * none. Works for observed series (readings end near now) and for prediction
 * series fetched around now alike.
 */
export function currentLevel(
  readings: readonly TideReading[],
  nowMs: number,
  maxAgeMs = TIDE_LEVEL_MAX_AGE_MS,
): TideReading | null {
  let best: TideReading | null = null;
  for (const r of readings) {
    if (best === null || Math.abs(r.timeMs - nowMs) < Math.abs(best.timeMs - nowMs)) best = r;
  }
  return best !== null && Math.abs(best.timeMs - nowMs) <= maxAgeMs ? best : null;
}

/** A high or low tide event. */
export interface TideExtreme {
  timeMs: number;
  heightM: number;
  kind: 'high' | 'low';
}

/**
 * Classify `wlp-hilo` events (alternating extremes, no kind flag in the API)
 * and return the next high and next low after `nowMs`. Each event is judged
 * against its neighbour: higher than the next (or, for the last event, the
 * previous) means high tide. Needs at least two events to tell them apart —
 * with fewer, returns nulls and the card just omits the line.
 */
export function nextHighLow(
  events: readonly TideReading[],
  nowMs: number,
): { nextHigh: TideExtreme | null; nextLow: TideExtreme | null } {
  const sorted = [...events].sort((a, b) => a.timeMs - b.timeMs);
  let nextHigh: TideExtreme | null = null;
  let nextLow: TideExtreme | null = null;
  if (sorted.length < 2) return { nextHigh, nextLow };
  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    const neighbour = i + 1 < sorted.length ? sorted[i + 1] : sorted[i - 1];
    if (event === undefined || neighbour === undefined) continue;
    if (event.timeMs <= nowMs) continue;
    const kind: TideExtreme['kind'] = event.heightM > neighbour.heightM ? 'high' : 'low';
    if (kind === 'high' && nextHigh === null) {
      nextHigh = { timeMs: event.timeMs, heightM: event.heightM, kind };
    }
    if (kind === 'low' && nextLow === null) {
      nextLow = { timeMs: event.timeMs, heightM: event.heightM, kind };
    }
    if (nextHigh !== null && nextLow !== null) break;
  }
  return { nextHigh, nextLow };
}
