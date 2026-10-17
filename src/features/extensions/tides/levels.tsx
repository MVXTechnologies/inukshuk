/**
 * Tide stations › "Show levels on the map" (#764): each station's water
 * level, trend and next high or low beside its symbol, as a live GeoJSON
 * layer (never in the style: it moves with the camera and the clock).
 *
 * Which stations: those drawn on screen (the tide symbol layers, from z8),
 * picked by `pickLevelStations` (live gauges only below z11; at most 12,
 * nearest the centre). When: on every camera settle (cached series cost
 * nothing) and every 10 min. Their data: `loadTideSeries` (observed every
 * 10 min, predictions daily and kept on the device).
 */
import {
  buildTideLevelLayers,
  CHS_TIDE_LAYER_IDS,
  TIDE_LAYER_IDS,
  TIDE_LEVEL_SOURCE,
} from '@core/map/tideStyle';
import {
  levelFeatures,
  levelReading,
  levelTier,
  LEVELS_REFRESH_MS,
  pickLevelStations,
  stationFeedsOf,
  type LevelFeature,
} from '@core/tides/levels';
import { parseTideStation, stationKey, type TideStation } from '@core/tides/station';
import { loadTideSeries } from '@data/tideSeries';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useSettingsStore } from '@state/settingsStore';
import { teamLabelFont } from '@features/team/map/TeamMapLayers';
import { useEffect, useMemo, useState } from 'react';

import { tideClock } from '../../map/tideClock';
import type { ExtensionMapView, ExtensionOverlayProps } from '../types';

/** The layers whose rendered features are the stations on screen. */
export const LEVEL_QUERY_LAYERS = [TIDE_LAYER_IDS.symbols, CHS_TIDE_LAYER_IDS.symbols];
/** Requests at once (the first view of a coast asks a dozen stations). */
const CONCURRENCY = 3;
/** After a settle, the tiles' symbols need a moment to be drawn before they can be queried. */
const SETTLE_DELAY_MS = 600;

interface FeatureLike {
  properties?: Readonly<Record<string, unknown>> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

/** Rendered features → stations, once each (a station can straddle two tiles). */
export function stationsOnScreen(features: readonly unknown[]): TideStation[] {
  const out = new Map<string, TideStation>();
  for (const raw of features) {
    if (typeof raw !== 'object' || raw === null) continue;
    const f = raw as FeatureLike;
    const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
    const pt =
      Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number'
        ? ([c[0], c[1]] as [number, number])
        : null;
    const s = parseTideStation(f.properties, pt);
    if (s && !out.has(stationKey(s))) out.set(stationKey(s), s);
  }
  return [...out.values()];
}

async function pool<T, R>(items: readonly T[], n: number, run: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export type LevelCollection = { type: 'FeatureCollection'; features: LevelFeature[] };

/**
 * The level labels for the stations on screen, or null while off, below z8,
 * or before anything is known.
 */
export function useTideLevels(
  on: boolean,
  view: ExtensionMapView | null,
  offline: boolean,
  queryRendered: (layers: string[]) => Promise<unknown[]>,
): LevelCollection | null {
  const units = useSettingsStore((s) => s.units);
  const tier = view ? levelTier(view.zoom) : null;
  const [data, setData] = useState<LevelCollection | null>(null);
  const [tick, setTick] = useState(0);
  const active = on && tier !== null;

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), LEVELS_REFRESH_MS);
    return () => clearInterval(id);
  }, [active]);

  useEffect(() => {
    if (!active || view === null || tier === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const features = await queryRendered([...LEVEL_QUERY_LAYERS]).catch(() => []);
        if (cancelled) return;
        const stations = stationsOnScreen(features).map((s) => ({
          station: s,
          lat: s.lat,
          lng: s.lng,
          feeds: stationFeedsOf(s),
        }));
        const picked = pickLevelStations(stations, view.center, tier);
        const results = await pool(picked, CONCURRENCY, (p) =>
          loadTideSeries(p.station, { offline }).then(
            (r) => r.series,
            () => null,
          ),
        );
        if (cancelled) return;
        const now = Date.now();
        const entries = picked.map((p, i) => {
          const series = results[i] ?? null;
          return {
            id: stationKey(p.station),
            lng: p.lng,
            lat: p.lat,
            reading: series ? levelReading(series, now) : null,
          };
        });
        const fc = levelFeatures(entries, units, tideClock);
        console.warn(
          `[tides764] z=${view.zoom.toFixed(2)} tier=${tier} queried=${features.length} stations=${stations.length} picked=${picked.length} series=${results.filter((r) => r !== null).length} labels=${fc.features.length} first=${JSON.stringify(fc.features[0]?.properties ?? null)}`,
        );
        setData(fc);
      })();
    }, SETTLE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, view, tier, tick, offline, units, queryRendered]);

  return active ? data : null;
}

/** The labels' layers over the map (`ExtensionMapModule.Overlay`). */
export function TideLevelsOverlay({
  dark,
  glyphs,
  beforeId,
  view,
  offline,
  queryRendered,
}: ExtensionOverlayProps) {
  const on = useSettingsStore((s) => s.tideLevelsOnMap);
  const data = useTideLevels(on, view, offline, queryRendered);
  const font = teamLabelFont(glyphs);
  const layers = useMemo(() => {
    const stack = teamLabelFont(glyphs);
    return stack === null
      ? []
      : buildTideLevelLayers({ theme: dark ? 'dark' : 'light', font: stack }).map((l) => (
          <Layer
            key={l.id}
            id={l.id}
            beforeId={beforeId}
            type="symbol"
            minzoom={l.minzoom}
            {...(l.maxzoom !== undefined ? { maxzoom: l.maxzoom } : {})}
            filter={l.filter}
            layout={l.layout}
            paint={l.paint}
          />
        ));
  }, [dark, beforeId, glyphs]);
  console.warn(
    `[tides764] overlay on=${on} view=${view === null ? 'null' : view.zoom.toFixed(2)} data=${data === null ? 'null' : data.features.length} glyphs=${glyphs ?? 'none'} font=${font?.join(',') ?? 'null'} beforeId=${beforeId}`,
  );
  if (data === null || font === null) return null;
  return (
    <GeoJSONSource id={TIDE_LEVEL_SOURCE} data={data}>
      {layers}
    </GeoJSONSource>
  );
}
