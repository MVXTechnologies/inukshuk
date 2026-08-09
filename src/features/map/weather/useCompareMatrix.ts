import {
  formatWmsTime,
  getFeatureInfoUrlForLayer,
  parseFeatureInfo,
} from '@core/geo/weatherLayers';
import type { LatLng } from '@core/models';
import {
  burstDelays,
  compareCellKey,
  compareTimesMs,
  runAgeLabel,
} from '@core/weather/modelTimeline';
import {
  WEATHER_MODELS,
  type ModelVariable,
  type WeatherModelId,
} from '@core/weather/weatherModels';
import { useEffect, useState } from 'react';
import { WEATHER_USER_AGENT } from './useWeatherTimeline';

/**
 * Data for the model-comparison table (weather UX M2): the active variable +
 * temperature at one point, per model × 3-hourly step. GeoMet rejects
 * multi-layer GetFeatureInfo (verified live), so this is one small (~600 B)
 * request per cell — paced by a burst-6 / 1 Hz token bucket to stay inside
 * the ~1 req/s usage policy, ordered column-first so every card fills its
 * near-term columns before anyone's far end.
 *
 * Failure is always silent and cell-local: any error (offline, XML
 * ServiceException for an out-of-range time, junk JSON, timeout) settles the
 * cell to null and the table renders "–". Successful values are cached
 * per (layer, time, ~100 m point) at module level, so re-opening the table
 * near the same spot fills instantly with zero requests.
 */

/** Per-request timeout — a hung cell must not hold its skeleton forever. */
const CELL_TIMEOUT_MS = 12_000;
const BURST = 6;
const REFILL_MS = 1_000;

/** Success cache; bounded so long sessions can't grow it unbounded. */
const cellCache = new Map<string, number>();
const CACHE_MAX = 2_000;

export interface CompareMatrix {
  /** The table's valid times (3-hourly, +48 h); null for one initial tick. */
  timesMs: readonly number[] | null;
  /**
   * Cell results keyed by `compareCellKey`: a number = value, null = settled
   * with no value ("–"), absent = still loading (skeleton).
   */
  cells: ReadonlyMap<string, number | null>;
  /** "run 6 h ago" per model, from the first cell's dim_reference_time. */
  runLabels: Partial<Record<WeatherModelId, string>>;
  /** True once every request settled with no value at all (offline hint). */
  allFailed: boolean;
}

interface CellRequest {
  key: string;
  wmsLayer: string;
  modelId: WeatherModelId;
  timeMs: number;
}

/** The GetFeatureInfo layers the table queries per model (active + temp). */
function infoLayers(variable: ModelVariable): { modelId: WeatherModelId; layers: string[] }[] {
  return WEATHER_MODELS.map((m) => ({
    modelId: m.id,
    layers: variable === 'temp' ? [m.info.temp] : [m.info[variable], m.info.temp],
  }));
}

export function useCompareMatrix(at: LatLng, variable: ModelVariable): CompareMatrix {
  const [timesMs, setTimesMs] = useState<readonly number[] | null>(null);
  const [cells, setCells] = useState<ReadonlyMap<string, number | null>>(new Map());
  const [runLabels, setRunLabels] = useState<Partial<Record<WeatherModelId, string>>>({});
  const [settled, setSettled] = useState({ count: 0, successes: 0, total: Infinity });

  // Seed the time grid on the next tick (render must stay pure — no
  // Date.now() there; same idiom as useWeatherTimeline's session seed).
  useEffect(() => {
    const seed = setTimeout(() => setTimesMs(compareTimesMs(Date.now())), 0);
    return () => clearTimeout(seed);
  }, []);

  useEffect(() => {
    if (timesMs === null) return;
    let cancelled = false;

    // Build the request list — cache hits fill immediately, misses queue in
    // column-first order (time, then model, then variable) so all three
    // cards paint their near columns first.
    const warm = new Map<string, number | null>();
    const requests: CellRequest[] = [];
    for (const t of timesMs) {
      for (const { modelId, layers } of infoLayers(variable)) {
        for (const wmsLayer of layers) {
          const key = compareCellKey(wmsLayer, t, at.latitude, at.longitude);
          if (warm.has(key) || requests.some((r) => r.key === key)) continue;
          const hit = cellCache.get(key);
          if (hit !== undefined) warm.set(key, hit);
          else requests.push({ key, wmsLayer, modelId, timeMs: t });
        }
      }
    }
    const seed = setTimeout(() => {
      setCells(warm);
      setSettled({ count: 0, successes: 0, total: requests.length });
    }, 0);

    const delays = burstDelays(requests.length, BURST, REFILL_MS);
    const timers: ReturnType<typeof setTimeout>[] = [seed];
    const controllers: AbortController[] = [];

    requests.forEach((req, i) => {
      const timer = setTimeout(() => {
        const ctl = new AbortController();
        controllers.push(ctl);
        const kill = setTimeout(() => ctl.abort(), CELL_TIMEOUT_MS);
        timers.push(kill);
        void (async () => {
          let value: number | null = null;
          let referenceTime: string | null = null;
          try {
            const res = await fetch(
              getFeatureInfoUrlForLayer(req.wmsLayer, at, formatWmsTime(req.timeMs)),
              { headers: { 'User-Agent': WEATHER_USER_AGENT }, signal: ctl.signal },
            );
            if (res.ok) {
              // Out-of-range times return XML with a JSON info_format —
              // res.json() throws, which lands in the catch: cell = "–".
              const info = parseFeatureInfo(await res.json());
              if (info !== null) {
                value = info.value;
                referenceTime = info.referenceTime;
              }
            }
          } catch {
            // Silent by design: offline, timeout, XML exception → "–".
          }
          clearTimeout(kill);
          if (cancelled) return;
          if (value !== null) {
            cellCache.set(req.key, value);
            if (cellCache.size > CACHE_MAX) cellCache.clear();
          }
          const v = value;
          setCells((prev) => new Map(prev).set(req.key, v));
          if (referenceTime !== null) {
            const label = runAgeLabel(referenceTime, Date.now());
            if (label !== null) {
              setRunLabels((prev) =>
                prev[req.modelId] !== undefined ? prev : { ...prev, [req.modelId]: label },
              );
            }
          }
          setSettled((prev) => ({
            ...prev,
            count: prev.count + 1,
            successes: prev.successes + (v !== null ? 1 : 0),
          }));
        })();
      }, delays[i] ?? 0);
      timers.push(timer);
    });

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      for (const c of controllers) c.abort();
    };
  }, [timesMs, variable, at]);

  return {
    timesMs,
    cells,
    runLabels,
    allFailed: settled.total > 0 && settled.count >= settled.total && settled.successes === 0,
  };
}
