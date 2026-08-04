import { parseGpx } from '@core/geo/gpx';
import { cellAt } from '@core/heat/grid';
import { buildHeatIndex, trailsNear, type HeatTrackInput } from '@core/heat/heatIndex';
import { qualifiesForHeat } from '@core/heat/qualify';
import { traceCells, type CellTrace } from '@core/heat/trace';
import { categoryColor } from '@core/library/categories';
import type { TrackPoint, TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import { useLibraryStore } from '@state/libraryStore';
import { mapColors } from '@ui/theme';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { useEffect, useMemo, useRef, useState } from 'react';

/** Properties carried by each rendered trail line (data-driven styling). */
export interface HeatLineProperties {
  trackId: string;
  categoryId: string;
  color: string;
}

export interface TrackHeat {
  /** One thin LineString per shown trail, category-coloured — no run
   * splitting, no hot/cold distinction (that lives in the heatmap layer now). */
  lines: FeatureCollection<LineString, HeatLineProperties> | null;
  /** Sampled points from every qualifying trail in the library (see
   * `qualifiesForHeat`) — global, independent of visibility mode/folder
   * filters/activeTrackIds — feeding the native `heatmap` layer's density
   * shading. Bounded to a few thousand features regardless of how many/long
   * the qualifying trails are — see `HEAT_POINT_TARGET`. */
  heatPoints: FeatureCollection<Point, Record<string, never>> | null;
  /** Tap lookup: all trails around the point + whether the spot is hot. Hot
   * detection (and the trackIds returned for a hot spot) is global, same as
   * `heatPoints`; a non-hot tap still falls back to the shown trails only,
   * matching trace-visibility rules for plain single-trail tap-to-inspect. */
  heatAt: (lngLat: { lng: number; lat: number }) => { trackIds: string[]; hot: boolean };
  /** Line geometry for an arbitrary trackId, looked up from whatever's been
   * loaded regardless of shown/qualifying membership — lets the map draw a
   * focused-trail highlight even when its trace is hidden. Null until that
   * trail's GPX is loaded, or if the id is unknown. */
  lineFor: (trackId: string) => Feature<LineString, HeatLineProperties> | null;
}

interface CacheEntry {
  points: TrackPoint[];
  trace: CellTrace;
}

// Cache key: mirrors useTrackOverlays' cacheKey — a trim "overwrite" rewrites
// the GPX under the same id, and a stale cached trace would keep drawing the
// old geometry (and old cell footprint) until app restart. Point count +
// distance change on any edit.
const cacheKey = (t: TrackSummary): string => `${t.id}|${t.stats.pointCount}|${t.stats.distanceM}`;

/** Target ceiling for the combined heatmap point source, across every
 * qualifying trail in the library — keeps the native heatmap layer's feature
 * count bounded (and thus render cost flat) regardless of how many/long the
 * trails are. */
const HEAT_POINT_TARGET = 3000;

/**
 * Combines shown trails' GPX into a plain per-trail LineString collection —
 * one thin, category-coloured line per shown trail, no run splitting or
 * hot/cold shading — obeying the existing visibility rules (trace rendering
 * is unchanged). Separately, combines EVERY qualifying trail in the library
 * (`allTrackIds`, filtered by `qualifiesForHeat` — not just the shown ones)
 * into (a) a sampled-point collection feeding a native MapLibre `heatmap`
 * layer and (b) the hot/tap index: "if heatmap is selected, it shouldn't
 * need the trace to be shown — just use ALL the traces in the database to
 * produce the heatmap, and still allow clickability of the heatmap." A
 * non-hot tap still falls back to the shown-trails tap index, so plain
 * single-trail tap-to-inspect keeps obeying trace-visibility rules exactly
 * as before.
 *
 * Per-track GPX parse + cell trace is cached by id + stats (like
 * `useTrackOverlays`), so toggling a trail back on (or the heatmap toggle
 * itself) is instant once loaded; an edited trail (new point count/distance)
 * reloads. The GPX-load effect loads the union of `shownTrackIds` and
 * `allTrackIds` — the caller decides how large `allTrackIds` is (e.g. only
 * widening it to the whole library while the heatmap toggle is actually on),
 * so memory stays bounded to what's actually needed; the derived
 * `lines`/`heatPoints`/indexes are `useMemo`'d over `[cache, tracks,
 * shownTrackIds, allTrackIds, customCategories]` — neither recomputes on
 * camera state or unrelated re-renders (e.g. GPS ticks), so their object
 * identity is stable across those.
 */
export function useTrackHeat(
  tracks: readonly TrackSummary[],
  shownTrackIds: readonly string[],
  allTrackIds: readonly string[],
): TrackHeat {
  const customCategories = useLibraryStore((s) => s.customCategories);

  const [cache, setCache] = useState<Record<string, CacheEntry | null>>({});
  const reqIdRef = useRef(0);

  const key = `${shownTrackIds.join('|')}~${allTrackIds.join('|')}`;

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    let cancelled = false;
    const loadIds = Array.from(new Set([...shownTrackIds, ...allTrackIds]));
    (async () => {
      for (const id of loadIds) {
        if (cancelled || reqId !== reqIdRef.current) return;
        const t = tracks.find((x) => x.id === id);
        if (!t) continue;
        const ck = cacheKey(t);
        if (cache[ck] !== undefined) continue;
        try {
          const gpx = await storage.readFileText(t.fileUri);
          const { points } = parseGpx(gpx);
          if (cancelled || reqId !== reqIdRef.current) return;
          const trace = traceCells(points);
          setCache((c) => ({ ...c, [ck]: { points, trace } }));
        } catch {
          if (cancelled || reqId !== reqIdRef.current) return;
          setCache((c) => ({ ...c, [ck]: null }));
        }
        // Yield between tracks so a large load set doesn't block touches,
        // and gives an abandoned request (trail list / heatmap toggle
        // changed mid-load) a checkpoint to bail at.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tracks]);

  // The host (MapScreen) re-renders on GPS ticks and camera moves, neither of
  // which changes the heat data — memoizing against the actual inputs (the
  // GPX cache, the track list, the shown/all id sets and the custom-category
  // palette) keeps `lines`/`heatPoints` referentially stable across that
  // churn, so MapLibre's GeoJSONSources don't re-diff/re-upload geometry
  // every frame, and avoids re-walking every point of every trail per render.
  const { lines, heatPoints, tapIndex, heatIndex, lineFor } = useMemo(() => {
    // Shown-only: lines + the tap index backing plain single-trail
    // tap-to-inspect. This is "trace rendering" territory, so it keeps
    // obeying the existing visibility rules (mode/folder filters/
    // activeTrackIds) unchanged.
    const tapInputs: HeatTrackInput[] = [];
    const shownBuilt: { id: string; categoryId: string; points: TrackPoint[]; color: string }[] =
      [];
    for (const id of shownTrackIds) {
      const t = tracks.find((x) => x.id === id);
      if (!t) continue;
      const entry = cache[cacheKey(t)];
      if (!entry) continue;

      const categoryId = t.category ?? 'uncategorized';
      const color = categoryColor(t.category, customCategories) ?? mapColors.trackOverlay;
      shownBuilt.push({ id, categoryId, points: entry.points, color });
      // The tap index covers every rendered trail — navigation included —
      // so any visible trail is inspectable, not just qualifying ones.
      tapInputs.push({ id, categoryId, dilated: entry.trace.dilated });
    }

    // All-qualifying (see qualifiesForHeat): heat density + hot/tap
    // indexing, global and independent of trace visibility — "if heatmap is
    // selected, it shouldn't need the trace to be shown". Driven by
    // `allTrackIds`, which the caller widens to the whole library only while
    // the heatmap is actually on.
    const heatInputs: HeatTrackInput[] = [];
    const qualifyingBuilt: { id: string; points: TrackPoint[] }[] = [];
    for (const id of allTrackIds) {
      const t = tracks.find((x) => x.id === id);
      if (!t || !qualifiesForHeat(t)) continue;
      const entry = cache[cacheKey(t)];
      if (!entry) continue;

      const categoryId = t.category ?? 'uncategorized';
      heatInputs.push({ id, categoryId, dilated: entry.trace.dilated });
      qualifyingBuilt.push({ id, points: entry.points });
    }

    const tapIdx = buildHeatIndex(tapInputs);
    const heatIdx = buildHeatIndex(heatInputs);

    // Lines: one whole-trail LineString per shown trail, no run splitting.
    let linesColl: FeatureCollection<LineString, HeatLineProperties> | null = null;
    if (shownBuilt.length > 0) {
      const features: Feature<LineString, HeatLineProperties>[] = [];
      for (const b of shownBuilt) {
        if (b.points.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: b.points.map((p) => [p.longitude, p.latitude]),
          },
          properties: { trackId: b.id, categoryId: b.categoryId, color: b.color },
        });
      }
      linesColl = { type: 'FeatureCollection', features };
    }

    // Heat points: sampled from every qualifying trail (global), stepped so
    // the combined feature count stays near HEAT_POINT_TARGET regardless of
    // how many/long those trails are.
    let pointsColl: FeatureCollection<Point, Record<string, never>> | null = null;
    if (qualifyingBuilt.length > 0) {
      const totalPoints = qualifyingBuilt.reduce((sum, b) => sum + b.points.length, 0);
      const step = Math.max(1, Math.ceil(totalPoints / HEAT_POINT_TARGET));
      const features: Feature<Point, Record<string, never>>[] = [];
      for (const b of qualifyingBuilt) {
        for (let i = 0; i < b.points.length; i += step) {
          const p = b.points[i];
          if (!p) continue;
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
            properties: {},
          });
        }
      }
      pointsColl = { type: 'FeatureCollection', features };
    }

    // Arbitrary-id line lookup, independent of shown/qualifying membership —
    // backs the focused-trail highlight even when the trail's trace is
    // hidden (a hot-spot carousel selection can point at a globally-
    // qualifying trail outside shownTrackIds). Returns null until that
    // trail's GPX is loaded (see the load effect above) or if it's genuinely
    // unknown.
    const lineFor = (trackId: string): Feature<LineString, HeatLineProperties> | null => {
      const t = tracks.find((x) => x.id === trackId);
      if (!t) return null;
      const entry = cache[cacheKey(t)];
      if (!entry || entry.points.length < 2) return null;
      const categoryId = t.category ?? 'uncategorized';
      const color = categoryColor(t.category, customCategories) ?? mapColors.trackOverlay;
      return {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: entry.points.map((p) => [p.longitude, p.latitude]),
        },
        properties: { trackId: t.id, categoryId, color },
      };
    };

    return {
      lines: linesColl,
      heatPoints: pointsColl,
      tapIndex: tapIdx,
      heatIndex: heatIdx,
      lineFor,
    };
  }, [cache, tracks, shownTrackIds, allTrackIds, customCategories]);

  const heatAt = (lngLat: { lng: number; lat: number }): { trackIds: string[]; hot: boolean } => {
    const cell = cellAt(lngLat.lng, lngLat.lat);
    const sortByStartedAtDesc = (ids: readonly string[]) =>
      [...ids].sort((a, b) => {
        const ta = tracks.find((x) => x.id === a)?.startedAt ?? 0;
        const tb = tracks.find((x) => x.id === b)?.startedAt ?? 0;
        return tb - ta;
      });

    // hot: global, all-qualifying overlap (>= 2 qualifying trails of the
    // same category) — a hot spot's carousel is populated from the same
    // global index, so it's never short a trail just because that trail's
    // trace is currently hidden.
    const { trackIds: hotTrackIds, hot } = trailsNear(heatIndex, cell);
    if (hot) return { trackIds: sortByStartedAtDesc(hotTrackIds), hot: true };

    // Not hot: fall back to the shown-trails tap index, so a plain
    // single-trail tap only ever opens an inspect panel for a trail that's
    // actually visible — trace-visibility rules apply here, unchanged.
    const { trackIds: shownTrackIdsAtCell } = trailsNear(tapIndex, cell);
    return { trackIds: sortByStartedAtDesc(shownTrackIdsAtCell), hot: false };
  };

  return { lines, heatPoints, heatAt, lineFor };
}
