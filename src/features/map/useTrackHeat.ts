import { isPerformedActivity } from '@core/dashboard/aggregate';
import { parseGpx } from '@core/geo/gpx';
import { hotColor } from '@core/heat/color';
import { runFeatures, type HeatRunProperties } from '@core/heat/features';
import { cellAt } from '@core/heat/grid';
import { buildHeatIndex, hotCountAt, trailsNear, type HeatTrackInput } from '@core/heat/heatIndex';
import { splitHeatRuns } from '@core/heat/runs';
import { traceCells, type CellTrace } from '@core/heat/trace';
import { categoryColor } from '@core/library/categories';
import type { TrackPoint, TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import { useLibraryStore } from '@state/libraryStore';
import { mapColors } from '@ui/theme';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface TrackHeat {
  /** One FeatureCollection of ALL visible trails' run features. */
  collection: FeatureCollection<LineString, HeatRunProperties> | null;
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

/**
 * Combines every shown trail's GPX into one heat-shaded FeatureCollection
 * (cold/hot LineString runs, data-driven by category colour) plus a tap
 * lookup for "what's under this point". Navigation trails (imported/planned
 * routes) are traced and rendered but always cold and never count toward
 * hot-overlap — only performed activities contribute to `hot`. Every
 * rendered trail (navigation included) is still tap-inspectable: `heatAt`
 * looks up `trackIds` from a second, all-trails index (`tapIndex`) and
 * `hot` from the performed-only index (`index`).
 *
 * Per-track GPX parse + cell trace is cached by id + stats (like
 * `useTrackOverlays`), so toggling a trail back on is instant; an edited
 * trail (new point count/distance) reloads. The GPX-load effect depends only
 * on `[key, tracks]` (`key` = shownTrackIds joined) and the derived
 * `collection`/index is `useMemo`'d over `[cache, tracks, shownTrackIds,
 * customCategories]` — neither recomputes on camera state or unrelated
 * re-renders (e.g. GPS ticks), so `collection`'s object identity is stable
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
  // palette) keeps `collection` referentially stable across that churn, so
  // MapLibre's GeoJSONSource doesn't re-diff/re-upload geometry every frame,
  // and avoids re-walking every point of every shown trail per render.
  const { collection, index, tapIndex } = useMemo(() => {
    const heatInputs: HeatTrackInput[] = [];
    const tapInputs: HeatTrackInput[] = [];
    const built: {
      id: string;
      categoryId: string;
      points: TrackPoint[];
      trace: CellTrace;
      coldColor: string;
      hotColorHex: string;
    }[] = [];

    for (const id of shownTrackIds) {
      const t = tracks.find((x) => x.id === id);
      if (!t) continue;
      const entry = cache[cacheKey(t)];
      if (!entry) continue;

      const categoryId = t.category ?? 'uncategorized';
      const coldColor = categoryColor(t.category, customCategories) ?? mapColors.trackOverlay;
      const hotColorHex = hotColor(coldColor);

      built.push({
        id,
        categoryId,
        points: entry.points,
        trace: entry.trace,
        coldColor,
        hotColorHex,
      });

      // The tap index covers every rendered trail — navigation included —
      // so any visible trail is inspectable, not just performed ones.
      tapInputs.push({ id, categoryId, dilated: entry.trace.dilated });

      if (isPerformedActivity(t)) {
        heatInputs.push({ id, categoryId, dilated: entry.trace.dilated });
      }
    }

    const heatIndex = buildHeatIndex(heatInputs);
    const tapIndex = buildHeatIndex(tapInputs);

    let coll: FeatureCollection<LineString, HeatRunProperties> | null = null;
    if (built.length > 0) {
      const features: Feature<LineString, HeatRunProperties>[] = [];
      for (const b of built) {
        // Navigation trails' categoryId never appears in the index (they're
        // excluded from heatInputs above), so hotCountAt naturally returns 0
        // for them and every run comes out cold — no special-casing needed.
        const countAt = (cellKeyStr: string) => hotCountAt(heatIndex, cellKeyStr, b.categoryId);
        const runs = splitHeatRuns(b.trace.perPoint, countAt);
        features.push(
          ...runFeatures(b.id, b.categoryId, b.points, runs, b.coldColor, b.hotColorHex),
        );
      }
      coll = { type: 'FeatureCollection', features };
    }

    return { collection: coll, index: heatIndex, tapIndex };
  }, [cache, tracks, shownTrackIds, customCategories]);

  const heatAt = (lngLat: { lng: number; lat: number }): { trackIds: string[]; hot: boolean } => {
    const cell = cellAt(lngLat.lng, lngLat.lat);
    // trackIds: every rendered trail near the tap (navigation included) —
    // tap-inspect must work regardless of performed/navigation status.
    const { trackIds } = trailsNear(tapIndex, cell);
    // hot: performed-only overlap — the carousel/heat-shading semantics are
    // unchanged, so a spot is only "hot" when >= 2 performed trails overlap.
    const { hot } = trailsNear(index, cell);
    const sorted = [...trackIds].sort((a, b) => {
      const ta = tracks.find((x) => x.id === a)?.startedAt ?? 0;
      const tb = tracks.find((x) => x.id === b)?.startedAt ?? 0;
      return tb - ta;
    });
    return { trackIds: sorted, hot };
  };

  return { collection, heatAt };
}
