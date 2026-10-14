/**
 * The tide fields' stations (#695): which station a field reads, from the
 * Tide stations extension's own station list, and its live readout as a
 * {@link TideSnapshot}.
 *
 * A field's `station` param is {@link NEAREST_STATION} (the default) or a
 * station's key. Only stations with a live series can say "the level now",
 * so those are the only ones listed or picked. "Nearest" is resolved from a
 * coarse cell of where you are (or the map centre), so a new fix costs a
 * string compare, and the O(stations) search runs only when you change cell.
 *
 * Pure: the platform loads the list and the live series.
 */
import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';
import type { LiveTide } from '@core/tides/live';
import { parseTideStation, stationKey, type TideStation } from '@core/tides/station';

import { fieldDescriptor } from './registry';
import { NEAREST_STATION, type FieldRef, type TideSnapshot } from './types';

/** "Nearest" looks this far, metres: a station farther than that says nothing about your water. */
export const NEAREST_MAX_M = 100_000;
/** The picker lists this many stations, nearest first. */
export const STATIONS_LISTED = 20;
/** How often a station's live level is fetched again, ms (two requests per station). */
export const TIDE_REFRESH_MS = 10 * 60_000;
/** The cell "nearest" is resolved from, degrees (~1 km of latitude). */
export const STATION_CELL_DEG = 0.01;
/** The most distinct stations a strip reads at once (each costs its own requests). */
export const MAX_STRIP_STATIONS = 3;

interface FeatureLike {
  properties?: Readonly<Record<string, unknown>> | null;
  geometry?: { coordinates?: unknown } | null;
}

/** The station list's features → the stations with a live series. */
export function liveStations(features: readonly FeatureLike[]): TideStation[] {
  const out: TideStation[] = [];
  for (const f of features) {
    const c = f.geometry?.coordinates;
    const pt =
      Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number'
        ? ([c[0], c[1]] as const)
        : null;
    const s = parseTideStation(f.properties, pt);
    if (s !== null && s.live !== undefined) out.push(s);
  }
  return out;
}

const distanceTo = (at: LatLng, s: TideStation) =>
  haversineMeters(at, { latitude: s.lat, longitude: s.lng });

/** The stations nearest `at`, nearest first, with their distance. */
export function nearbyStations(
  stations: readonly TideStation[],
  at: LatLng,
  limit = STATIONS_LISTED,
): { station: TideStation; distanceM: number }[] {
  return stations
    .map((station) => ({ station, distanceM: distanceTo(at, station) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

/** The nearest station within `maxM`, or null. O(stations). */
export function nearestStation(
  stations: readonly TideStation[],
  at: LatLng,
  maxM = NEAREST_MAX_M,
): TideStation | null {
  let best: TideStation | null = null;
  let bestM = maxM;
  for (const s of stations) {
    const d = distanceTo(at, s);
    if (d <= bestM) {
      best = s;
      bestM = d;
    }
  }
  return best;
}

/** The cell `at` falls in, as its rounded centre: "nearest" changes only with it. */
export function stationCell(at: LatLng): LatLng {
  const round = (v: number) => Math.round(v / STATION_CELL_DEG) * STATION_CELL_DEG;
  return { latitude: round(at.latitude), longitude: round(at.longitude) };
}

/** The station a `station` param names now, or null (nothing near, or a station gone from the list). */
export function resolveStation(
  param: string,
  stations: readonly TideStation[],
  here: LatLng | null,
): TideStation | null {
  if (param === NEAREST_STATION) return here === null ? null : nearestStation(stations, here);
  return stations.find((s) => stationKey(s) === param) ?? null;
}

/** The distinct `station` params of the placed tide fields, in strip order (at most {@link MAX_STRIP_STATIONS}). */
export function stripStationParams(rows: readonly (readonly FieldRef[])[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const f of row) {
      if (fieldDescriptor(f.field)?.requires !== 'tides') continue;
      const p = f.params.station;
      const param = typeof p === 'string' && p !== '' ? p : NEAREST_STATION;
      if (!out.includes(param) && out.length < MAX_STRIP_STATIONS) out.push(param);
    }
  }
  return out;
}

/** A station's live answer as the strip reads it; null when it says nothing at all. */
export function tideSnapshot(station: TideStation, live: LiveTide): TideSnapshot | null {
  if (live.level === null && live.nextHigh === null) return null;
  return {
    stationName: station.name,
    levelM: live.level?.heightM ?? null,
    trend: live.trend,
    nextHigh:
      live.nextHigh === null ? null : { atMs: live.nextHigh.timeMs, levelM: live.nextHigh.heightM },
  };
}
