import type { LatLng } from '@core/models';
import {
  liveStations,
  resolveStation,
  stationCell,
  tideSnapshot,
  TIDE_REFRESH_MS,
} from '@core/infoStrip/tides';
import type { TideSnapshot } from '@core/infoStrip/types';
import { stationKey, type TideStation } from '@core/tides/station';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useMemo, useState } from 'react';

import { useChsStations } from '../hooks/useChs';
import { loadLiveTide } from '../hooks/useLiveTide';

const NONE: Readonly<Record<string, TideSnapshot>> = Object.freeze({});
const NO_STATIONS: readonly TideStation[] = Object.freeze([]);

/**
 * The Tide stations extension's stations with a live gauge, from the same
 * device copy the map's tide layer draws (`useChsStations`: offline after
 * the first load, refreshed weekly when online). Empty while `on` is false.
 */
export function useLiveTideStations(on: boolean): readonly TideStation[] {
  const offline = useSettingsStore((s) => s.offlineOnly);
  const list = useChsStations(on, offline);
  return useMemo(() => (list === null ? NO_STATIONS : liveStations(list.features)), [list]);
}

/**
 * The tide fields' readouts (#695), by their `station` param, only while
 * `on` (a tide field placed AND the extension installed):
 * - "nearest" is resolved from the ~1 km cell you are in (`stationCell`),
 *   so a fix costs one rounding and a memo compare; the O(stations) search
 *   runs when you change cell or the list loads;
 * - each distinct station's level and next high are fetched once, then
 *   every {@link TIDE_REFRESH_MS} (two rate-limited requests per station),
 *   never per tick: the fields compute on the strip's minute clock;
 * - a failed refresh keeps the next high (a prediction) and drops the level
 *   (no longer "now"); offline-only mode fetches nothing.
 */
export function useStripTides(
  on: boolean,
  params: readonly string[],
  here: LatLng | null,
): Readonly<Record<string, TideSnapshot>> {
  const active = on && params.length > 0;
  const stations = useLiveTideStations(active);
  const offline = useSettingsStore((s) => s.offlineOnly);

  const cell = here === null ? null : stationCell(here);
  const cellLat = cell?.latitude ?? null;
  const cellLng = cell?.longitude ?? null;
  const paramsKey = params.join('\n');
  const resolved = useMemo(() => {
    const at =
      cellLat === null || cellLng === null ? null : { latitude: cellLat, longitude: cellLng };
    return (paramsKey === '' ? [] : paramsKey.split('\n')).map(
      (param) => [param, resolveStation(param, stations, at)] as const,
    );
  }, [paramsKey, stations, cellLat, cellLng]);

  // What to fetch: the distinct resolved stations, as one key (the effect re-runs only when it changes).
  const fetchKey = [
    ...new Set(resolved.flatMap(([, s]) => (s === null ? [] : [stationKey(s)]))),
  ].join('\n');
  const byKey = useMemo(() => new Map(stations.map((s) => [stationKey(s), s])), [stations]);

  const [live, setLive] = useState<Readonly<Record<string, TideSnapshot>>>(NONE);
  useEffect(() => {
    if (!active || offline || fetchKey === '') return;
    const controller = new AbortController();
    const timers: ReturnType<typeof setInterval>[] = [];
    for (const key of fetchKey.split('\n')) {
      const station = byKey.get(key);
      if (station === undefined) continue;
      const refresh = () => {
        loadLiveTide(station, controller.signal)
          .then((answer) => {
            if (controller.signal.aborted) return;
            const snap = tideSnapshot(station, answer);
            setLive((prev) => withKey(prev, key, snap));
          })
          .catch(() => {
            if (controller.signal.aborted) return;
            // Offline mid-way: the level is no longer "now"; the next high still is.
            setLive((prev) => {
              const old = prev[key];
              return withKey(prev, key, old === undefined ? null : { ...old, levelM: null });
            });
          });
      };
      refresh();
      timers.push(setInterval(refresh, TIDE_REFRESH_MS));
    }
    return () => {
      controller.abort();
      for (const t of timers) clearInterval(t);
    };
  }, [active, offline, fetchKey, byKey]);

  return useMemo(() => {
    if (!active) return NONE;
    const out: Record<string, TideSnapshot> = {};
    for (const [param, station] of resolved) {
      const snap = station === null ? undefined : live[stationKey(station)];
      // Offline-only mode: no level is "now" any more; the predicted high still holds.
      if (snap !== undefined) out[param] = offline ? { ...snap, levelM: null } : snap;
    }
    return out;
  }, [active, resolved, live, offline]);
}

function withKey(
  prev: Readonly<Record<string, TideSnapshot>>,
  key: string,
  snap: TideSnapshot | null,
): Readonly<Record<string, TideSnapshot>> {
  const next = { ...prev };
  if (snap === null) delete next[key];
  else next[key] = snap;
  return next;
}
