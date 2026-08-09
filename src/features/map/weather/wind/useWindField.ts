import { createWindField, type WindField } from '@core/weather/windField';
import { parseFloat32Tiff } from '@core/weather/windTiff';
import {
  wcsCoverageUrl,
  WIND_COVERAGES,
  windFieldCacheKey,
  type WindBbox,
} from '@core/weather/windCoverage';
import type { WeatherModelId } from '@core/weather/weatherModels';
import { useEffect, useState } from 'react';
import { WEATHER_USER_AGENT } from '../useWeatherTimeline';

/**
 * Fetch + cache the wind vector field for (model, bbox, TIME) — weather M3.
 * One frame = 3 WCS GetCoverage requests (speed, direction, gust; ~11 KB
 * each for a viewport subset). Scrubbing TIME flows through `timeIso`
 * (already trailing-throttled by useWeatherTimeline), aborting any stale
 * in-flight fetch. Failures are silent by design: speed/dir failing (or
 * parsing as XML — GeoMet's out-of-range answer) settles the field to null
 * and the overlay degrades to the gradient drape; a gust failure degrades
 * to gust-less particles.
 *
 * Cache: module-level LRU per cache key, so scrub round-trips and model
 * flips re-fill instantly with zero requests (weather stays online-only —
 * the cache is a session courtesy, never persisted).
 */

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_MAX = 16;
const fieldCache = new Map<string, WindField>();

export interface WindFieldState {
  /** The current field, or null (loading with nothing cached / failed). */
  field: WindField | null;
  /** The cache key the field belongs to (staleness checks in the caller). */
  key: string | null;
}

async function fetchGrid(
  url: string,
  signal: AbortSignal,
): Promise<ReturnType<typeof parseFloat32Tiff>> {
  const res = await fetch(url, { headers: { 'User-Agent': WEATHER_USER_AGENT }, signal });
  if (!res.ok) return null;
  return parseFloat32Tiff(new Uint8Array(await res.arrayBuffer()));
}

export function useWindField(
  active: boolean,
  model: WeatherModelId,
  bbox: WindBbox | null,
  timeIso: string | undefined,
): WindFieldState {
  const [state, setState] = useState<WindFieldState>({ field: null, key: null });

  useEffect(() => {
    if (!active || bbox === null) return;
    const key = windFieldCacheKey(model, bbox, timeIso);
    const cached = fieldCache.get(key);
    if (cached !== undefined) {
      // Refresh LRU order and publish synchronously-cached data on a tick.
      fieldCache.delete(key);
      fieldCache.set(key, cached);
      const t = setTimeout(() => setState({ field: cached, key }), 0);
      return () => clearTimeout(t);
    }
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let cancelled = false;
    void (async () => {
      let field: WindField | null = null;
      try {
        const ids = WIND_COVERAGES[model];
        const [speed, dir, gust] = await Promise.all([
          fetchGrid(wcsCoverageUrl(ids.speed, bbox, timeIso), ctl.signal),
          fetchGrid(wcsCoverageUrl(ids.dir, bbox, timeIso), ctl.signal),
          ids.gust === null
            ? Promise.resolve(null)
            : fetchGrid(wcsCoverageUrl(ids.gust, bbox, timeIso), ctl.signal).catch(() => null),
        ]);
        if (speed !== null && dir !== null) field = createWindField(speed, dir, gust);
      } catch {
        // Offline / aborted / host unreachable: gradient-only, no errors.
      }
      clearTimeout(kill);
      if (cancelled) return;
      if (field !== null) {
        fieldCache.set(key, field);
        if (fieldCache.size > CACHE_MAX) {
          const oldest = fieldCache.keys().next().value;
          if (oldest !== undefined) fieldCache.delete(oldest);
        }
        setState({ field, key });
      } else {
        // Settle to "no particles" rather than animating a stale time's
        // wind. A retry happens naturally when model/bbox/TIME next change —
        // never in a loop (the effect's deps are unchanged by this set).
        setState({ field: null, key });
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(kill);
      ctl.abort();
    };
  }, [active, model, bbox, timeIso]);

  return state;
}
