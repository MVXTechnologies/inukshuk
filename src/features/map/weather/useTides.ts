import {
  currentLevel,
  nearestTideStation,
  nextHighLow,
  parseSeries,
  parseStations,
  stationDataUrl,
  stationsUrl,
  TIDE_OBSERVED_WINDOW_MS,
  TIDE_PREDICTION_WINDOW_MS,
  type TideExtreme,
  type TideStation,
} from '@core/weather/tides';
import type { LatLng } from '@core/models';
import { useEffect, useState } from 'react';
import { WEATHER_USER_AGENT } from './useWeatherFrames';

/**
 * The forecast card's Tides section data (marine M2): nearest CHS IWLS
 * station to the long-pressed point, its current water level (observed
 * `wlo` where the station has a live gauge, predicted `wlp` otherwise) and
 * the next high/low tide from `wlp-hilo`. Request budget per long-press:
 * one session-cached station-list fetch + two series fetches — inside the
 * IWLS 3 req/s / 30 req/min cap.
 *
 * Degradation contract (same as useForecast): tides are a garnish on the
 * forecast card — 'none' hides the section (point far from any station, or
 * the station list unreachable and never cached), 'error' lets marine-mode
 * callers show a "needs a connection" hint. Nothing here ever throws into
 * the card.
 */

export interface TideInfo {
  stationName: string;
  distanceM: number;
  /** Water level right now, metres above chart datum; null when unavailable. */
  level: { heightM: number; timeMs: number; observed: boolean } | null;
  nextHigh: TideExtreme | null;
  nextLow: TideExtreme | null;
}

export interface TidesQuery {
  status: 'loading' | 'ready' | 'none' | 'error';
  tides: TideInfo | null;
}

const LOADING: TidesQuery = { status: 'loading', tides: null };
const NONE: TidesQuery = { status: 'none', tides: null };
const ERROR: TidesQuery = { status: 'error', tides: null };

/**
 * The QUE-region station list barely changes and is ~100 KB — fetch it once
 * per app session and share it across every card open. A failed fetch is NOT
 * cached: the next long-press retries.
 */
let stationsCache: TideStation[] | null = null;

async function loadStations(): Promise<TideStation[]> {
  if (stationsCache !== null) return stationsCache;
  const res = await fetch(stationsUrl(), { headers: { 'User-Agent': WEATHER_USER_AGENT } });
  if (!res.ok) throw new Error(`stations ${res.status}`);
  const parsed = parseStations(await res.json());
  if (parsed.length === 0) throw new Error('empty station list');
  stationsCache = parsed;
  return parsed;
}

async function fetchSeries(
  stationId: string,
  series: 'wlo' | 'wlp' | 'wlp-hilo',
  fromMs: number,
  toMs: number,
): Promise<ReturnType<typeof parseSeries>> {
  const res = await fetch(stationDataUrl(stationId, series, fromMs, toMs), {
    headers: { 'User-Agent': WEATHER_USER_AGENT },
  });
  return res.ok ? parseSeries(await res.json()) : [];
}

function requestKey(at: LatLng, maxDistanceM: number): string {
  return `${at.latitude},${at.longitude}|${maxDistanceM}`;
}

export function useTides(at: LatLng | null, maxDistanceM: number): TidesQuery {
  // Keyed result instead of resetting to 'loading' inside the effect (the
  // react-hooks/set-state-in-effect rule) — same idiom as useForecast.
  const [result, setResult] = useState<{ key: string; query: TidesQuery } | null>(null);

  useEffect(() => {
    if (at === null) return;
    const key = requestKey(at, maxDistanceM);
    let cancelled = false;
    void (async () => {
      try {
        const stations = await loadStations();
        const near = nearestTideStation(stations, at, maxDistanceM);
        if (cancelled) return;
        if (near === null) {
          setResult({ key, query: NONE });
          return;
        }
        const nowMs = Date.now();
        // Observed level where the station has a live gauge; predicted level
        // (a window around now) otherwise — both land in `currentLevel`.
        const observed = near.station.timeSeries.includes('wlo');
        const levelSeries = observed ? ('wlo' as const) : ('wlp' as const);
        const [levels, hilo] = await Promise.all([
          fetchSeries(
            near.station.id,
            levelSeries,
            nowMs - TIDE_OBSERVED_WINDOW_MS,
            // Predictions need a forward window to have a "closest to now".
            observed ? nowMs : nowMs + TIDE_OBSERVED_WINDOW_MS,
          ),
          fetchSeries(near.station.id, 'wlp-hilo', nowMs, nowMs + TIDE_PREDICTION_WINDOW_MS),
        ]);
        if (cancelled) return;
        const level = currentLevel(levels, nowMs);
        const { nextHigh, nextLow } = nextHighLow(hilo, nowMs);
        if (level === null && nextHigh === null && nextLow === null) {
          // Station in range but nothing usable came back (offline mid-way,
          // series outage): marine users get the explicit unavailable hint.
          setResult({ key, query: ERROR });
          return;
        }
        setResult({
          key,
          query: {
            status: 'ready',
            tides: {
              stationName: near.station.name,
              distanceM: near.distanceM,
              level: level !== null ? { ...level, observed } : null,
              nextHigh,
              nextLow,
            },
          },
        });
      } catch {
        // Station list unreachable — most likely fully offline.
        if (!cancelled) setResult({ key, query: ERROR });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [at, maxDistanceM]);

  if (at === null) return LOADING;
  return result !== null && result.key === requestKey(at, maxDistanceM) ? result.query : LOADING;
}
