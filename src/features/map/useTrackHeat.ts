import { isPerformedActivity } from '@core/dashboard/aggregate';
import { parseGpx } from '@core/geo/gpx';
import { cellAt } from '@core/heat/grid';
import { buildHeatIndex, trailsNear, type HeatTrackInput } from '@core/heat/heatIndex';
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
  /** Sampled points from performed trails, feeding the native `heatmap`
   * layer's density shading. Bounded to a few thousand features regardless
   * of how many/long the shown trails are — see `HEAT_POINT_TARGET`. */
  heatPoints: FeatureCollection<Point, Record<string, never>> | null;
  /** Tap lookup: all trails around the point + whether the spot is hot. */
  heatAt: (lngLat: { lng: number; lat: number }) => { trackIds: string[]; hot: boolean };
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

/** Target ceiling for the combined heatmap point source, across every shown
 * performed trail — keeps the native heatmap layer's feature count bounded
 * (and thus render cost flat) regardless of how many/long the trails are. */
const HEAT_POINT_TARGET = 3000;

/**
 * Combines every shown trail's GPX into (a) a plain per-trail LineString
 * collection — one thin, category-coloured line per trail, no run splitting
 * or hot/cold shading — and (b) a sampled-point collection from performed
 * activities only, feeding a native MapLibre `heatmap` layer that renders the
 * soft density shading MapScreen draws beneath the lines. Plus the tap lookup
 * for "what's under this point", unchanged from before: `heatAt` still looks
 * up `trackIds` from the all-trails `tapIndex` and `hot` from the
 * performed-only `index`, both built from the same per-trail dilated cell
 * trace as always. Navigation trails (imported/planned routes) are still
 * traced and rendered — and still tap-inspectable — but never contribute to
 * the heatmap or count toward `hot`.
 *
 * Per-track GPX parse + cell trace is cached by id + stats (like
 * `useTrackOverlays`), so toggling a trail back on is instant; an edited
 * trail (new point count/distance) reloads. The GPX-load effect depends only
 * on `[key, tracks]` (`key` = shownTrackIds joined) and the derived
 * `lines`/`heatPoints`/indexes are `useMemo`'d over `[cache, tracks,
 * shownTrackIds, customCategories]` — neither recomputes on camera state or
 * unrelated re-renders (e.g. GPS ticks), so their object identity is stable
 * across those.
 */
export function useTrackHeat(
  tracks: readonly TrackSummary[],
  shownTrackIds: readonly string[],
): TrackHeat {
  const customCategories = useLibraryStore((s) => s.customCategories);

  const [cache, setCache] = useState<Record<string, CacheEntry | null>>({});
  const reqIdRef = useRef(0);

  const key = shownTrackIds.join('|');

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    let cancelled = false;
    (async () => {
      for (const id of shownTrackIds) {
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
        // Yield between tracks so a large shown-set doesn't block touches,
        // and gives an abandoned request (trail list changed mid-load) a
        // checkpoint to bail at.
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
  // GPX cache, the track list, the shown-id set and the custom-category
  // palette) keeps `lines`/`heatPoints` referentially stable across that
  // churn, so MapLibre's GeoJSONSources don't re-diff/re-upload geometry
  // every frame, and avoids re-walking every point of every shown trail per
  // render.
  const { lines, heatPoints, index, tapIndex } = useMemo(() => {
    const heatInputs: HeatTrackInput[] = [];
    const tapInputs: HeatTrackInput[] = [];
    const built: {
      id: string;
      categoryId: string;
      points: TrackPoint[];
      color: string;
      performed: boolean;
    }[] = [];

    for (const id of shownTrackIds) {
      const t = tracks.find((x) => x.id === id);
      if (!t) continue;
      const entry = cache[cacheKey(t)];
      if (!entry) continue;

      const categoryId = t.category ?? 'uncategorized';
      const color = categoryColor(t.category, customCategories) ?? mapColors.trackOverlay;

      built.push({
        id,
        categoryId,
        points: entry.points,
        color,
        performed: isPerformedActivity(t),
      });

      // The tap index covers every rendered trail — navigation included —
      // so any visible trail is inspectable, not just performed ones.
      tapInputs.push({ id, categoryId, dilated: entry.trace.dilated });

      if (isPerformedActivity(t)) {
        heatInputs.push({ id, categoryId, dilated: entry.trace.dilated });
      }
    }

    const heatIndex = buildHeatIndex(heatInputs);
    const tapIdx = buildHeatIndex(tapInputs);

    // Lines: one whole-trail LineString per shown trail, no run splitting.
    let linesColl: FeatureCollection<LineString, HeatLineProperties> | null = null;
    if (built.length > 0) {
      const features: Feature<LineString, HeatLineProperties>[] = [];
      for (const b of built) {
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

    // Heat points: sampled from performed trails only (navigation trails
    // never went "hot" before, so they don't contribute density either),
    // stepped so the combined feature count stays near HEAT_POINT_TARGET
    // regardless of how many/long the performed trails are.
    let pointsColl: FeatureCollection<Point, Record<string, never>> | null = null;
    const performedEntries = built.filter((b) => b.performed);
    if (performedEntries.length > 0) {
      const totalPoints = performedEntries.reduce((sum, b) => sum + b.points.length, 0);
      const step = Math.max(1, Math.ceil(totalPoints / HEAT_POINT_TARGET));
      const features: Feature<Point, Record<string, never>>[] = [];
      for (const b of performedEntries) {
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

    return { lines: linesColl, heatPoints: pointsColl, index: heatIndex, tapIndex: tapIdx };
  }, [cache, tracks, shownTrackIds, customCategories]);

  const heatAt = (lngLat: { lng: number; lat: number }): { trackIds: string[]; hot: boolean } => {
    const cell = cellAt(lngLat.lng, lngLat.lat);
    // trackIds: every rendered trail near the tap (navigation included) —
    // tap-inspect must work regardless of performed/navigation status.
    const { trackIds } = trailsNear(tapIndex, cell);
    // hot: performed-only overlap — the carousel semantics are unchanged, so
    // a spot is only "hot" when >= 2 performed trails overlap.
    const { hot } = trailsNear(index, cell);
    const sorted = [...trackIds].sort((a, b) => {
      const ta = tracks.find((x) => x.id === a)?.startedAt ?? 0;
      const tb = tracks.find((x) => x.id === b)?.startedAt ?? 0;
      return tb - ta;
    });
    return { trackIds: sorted, hot };
  };

  return { lines, heatPoints, heatAt };
}
