import { buildBBoxIndex, type BBoxEntry } from '@core/geo/bboxIndex';
import type { TrackGeometry } from '@core/geo/track/simplify';
import {
  buildGridIndex,
  CellGrid,
  gridTrailsNearWithin,
  HEAT_LINE_CELL_M,
  HeatGridSync,
  heatGlowPoints,
  heatGridLines,
  walkTrackCells,
  type GridIndex,
  type GridIndexInput,
  type HeatGlowProps,
  type HeatLineProps,
  type TrackCellWalk,
} from '@core/heat/heatGrid';
import { glowWithin, heatLinesWithin, indexHeatLines } from '@core/heat/heatViewport';
import { qualifiesForHeat } from '@core/heat/qualify';
import { categoryColor } from '@core/library/categories';
import {
  capNewest,
  chunkParts,
  clipParts,
  heatLayersAt,
  lineToleranceM,
  MAX_TRAIL_LINE_VERTICES,
  simplifyParts,
  vertexCount,
  type CullRegion,
  type LineChunk,
} from '@core/map/viewportCull';
import type { BoundingBox, TrackSummary } from '@core/models';
import { peekTrackGeometry } from '@data/trackGeometry';
import { useLibraryStore } from '@state/libraryStore';
import { mapColors } from '@ui/theme';
import type { Feature, FeatureCollection, LineString, MultiLineString, Point } from 'geojson';
import { useCallback, useMemo, useState } from 'react';

import { indexTracks, useTrackGeometries } from './useTrackGeometries';

/** Properties carried by each rendered trail line (data-driven styling). */
export interface HeatLineProperties {
  trackId: string;
  categoryId: string;
  color: string;
}

/** A trail's line: one part per `<trkseg>`, so pauses are never drawn across. */
export type HeatLineFeature = Feature<LineString | MultiLineString, HeatLineProperties>;

export interface TrackHeat {
  /** One thin line per shown trail in the cull region, category-coloured,
   * from the trail's SIMPLIFIED geometry (a few metres; never the full
   * recording), simplified further to the region's zoom. */
  lines: FeatureCollection<LineString | MultiLineString, HeatLineProperties> | null;
  /** The personal heatmap at street zooms: pass-count lines over every
   * qualifying trail in the library (see `heatGridLines`), clipped to the
   * cull region (empty at zooms that don't draw them). Null while the
   * heatmap is off. */
  heatLines: FeatureCollection<MultiLineString, HeatLineProps> | null;
  /** The personal heatmap's low-zoom glow: one weighted point per occupied
   * coarse cell (see `heatGlowPoints`), clipped to the cull region (empty at
   * zooms that don't draw it). Null while the heatmap is off. */
  heatGlow: FeatureCollection<Point, HeatGlowProps> | null;
  /**
   * Trails at a tapped point. `radiusM` is the finger's tolerance on the
   * ground (the caller converts its pixel tolerance at the current zoom).
   * Hot detection (and the trackIds returned for a hot spot) is global, over
   * every qualifying trail; a non-hot tap falls back to the drawn trails.
   */
  heatAt: (
    lngLat: { lng: number; lat: number },
    radiusM?: number,
    /** The heat is on screen: a tap on it opens the trail that makes it. */
    glowTappable?: boolean,
  ) => { trackIds: string[]; hot: boolean };
  /** Line geometry (the stored simplified geometry) for any loaded trackId,
   * regardless of shown/qualifying membership — the focused-trail
   * highlight. Null until that trail's geometry is loaded, or if the id is
   * unknown. */
  lineFor: (trackId: string) => HeatLineFeature | null;
}

/**
 * Where the map is looking: a {@link CullRegion} (build only what meets it),
 * `null` while the viewport isn't known yet (nothing is visible), or `'all'`
 * (no culling — the whole library at full detail).
 */
export type TrackHeatViewport = CullRegion | null | 'all';

// Per-geometry derived data, computed once per trail revision (a geometry
// object is replaced when its trail is edited) and shared across renders and
// hook instances. One walk feeds both the heat lines and the tap index.
const walks = new WeakMap<TrackGeometry, TrackCellWalk>();
const LINE_GRID = new CellGrid(HEAT_LINE_CELL_M);

function cellWalk(g: TrackGeometry): TrackCellWalk {
  let w = walks.get(g);
  if (!w) {
    w = walkTrackCells({ id: '', parts: g.parts }, LINE_GRID);
    walks.set(g, w);
  }
  return w;
}

/** A geometry at a zoom's extra simplification (memoized per geometry and tolerance). */
const simplifiedAt = new WeakMap<TrackGeometry, Map<number, [number, number][][]>>();

function partsAt(g: TrackGeometry, toleranceM: number): [number, number][][] {
  let byTolerance = simplifiedAt.get(g);
  if (!byTolerance) {
    byTolerance = new Map();
    simplifiedAt.set(g, byTolerance);
  }
  let parts = byTolerance.get(toleranceM);
  if (!parts) {
    parts = simplifyParts(g.parts, toleranceM);
    byTolerance.set(toleranceM, parts);
  }
  return parts;
}

/** Clip chunks per parts array (one per geometry and tolerance). */
const chunksOf = new WeakMap<[number, number][][], LineChunk[]>();

function chunked(parts: [number, number][][]): LineChunk[] {
  let c = chunksOf.get(parts);
  if (!c) {
    c = chunkParts(parts);
    chunksOf.set(parts, c);
  }
  return c;
}

function asLine(parts: [number, number][][]): LineString | MultiLineString | null {
  const [only] = parts;
  if (!only) return null;
  return parts.length === 1
    ? { type: 'LineString', coordinates: only }
    : { type: 'MultiLineString', coordinates: parts };
}

const WORLD: BoundingBox = { minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 };
/** A box that meets nothing: the region of a viewport not known yet. */
const NOWHERE: BoundingBox = { minLat: 91, maxLat: 91, minLng: 0, maxLng: 0 };
/** An invalid box: the spatial index returns its trail for every region. */
const NO_BOX: BoundingBox = { minLat: NaN, maxLat: NaN, minLng: NaN, maxLng: NaN };
const EMPTY_GLOW: FeatureCollection<Point, HeatGlowProps> = {
  type: 'FeatureCollection',
  features: [],
};
const EMPTY_HEAT_LINES: FeatureCollection<MultiLineString, HeatLineProps> = {
  type: 'FeatureCollection',
  features: [],
};
const ALL_HEAT_LAYERS = { glow: true, lines: true } as const;
/** Street-level detail: no culling ('all') builds at this zoom. */
const FULL_DETAIL_ZOOM = 22;

/**
 * Trail lines and the personal heatmap for the map (#465, #466, #494).
 *
 * - `lines`: one category-coloured line per SHOWN trail (visibility rules
 *   unchanged) that meets the cull region, cut to the region and simplified
 *   to its zoom — at most `MAX_TRAIL_LINES` trails and
 *   `MAX_TRAIL_LINE_VERTICES` coordinates, newest first.
 * - `heatLines` / `heatGlow`: the personal heatmap over EVERY qualifying
 *   trail in `allTrackIds` (the caller widens it to the whole library while
 *   the heatmap is on), from a distinct-pass grid kept up to date trail by
 *   trail — crisp lines at street zooms, a glow when zoomed out — built only
 *   for the zooms that draw them and clipped to the cull region. Only
 *   computed while `heatEnabled`.
 * - `heatAt`: the tap lookup (hot = 2+ qualifying trails of one category);
 *   a plain trail tap resolves against the trails actually drawn.
 *
 * Culling never reads geometry: trails are matched to the region by their
 * `stats.bbox` (computed at import) through a spatial index. Only the drawn
 * trails — and, heatmap on, the qualifying ones, visible first — have their
 * geometry loaded (`@data/trackGeometry`, in batches by
 * `useTrackGeometries`). Everything is memoized against the actual inputs,
 * and the caller's region is sticky (see `nextCullRegion`), so GPS ticks,
 * small pans and selection changes never rebuild (or re-upload) a source.
 */
export function useTrackHeat(
  tracks: readonly TrackSummary[],
  shownTrackIds: readonly string[],
  allTrackIds: readonly string[],
  heatEnabled = true,
  viewport: TrackHeatViewport = 'all',
): TrackHeat {
  const customCategories = useLibraryStore((s) => s.customCategories);
  const tracksById = useMemo(() => indexTracks(tracks), [tracks]);
  const regionBounds = viewport === 'all' ? null : (viewport?.bounds ?? NOWHERE);
  const zoomLevel = viewport === 'all' || viewport === null ? FULL_DETAIL_ZOOM : viewport.zoomLevel;

  const shownKey = shownTrackIds.join('|');
  const allKey = allTrackIds.join('|');

  // Every trail's box, indexed once per library change. A trail without a
  // stored box (pre-bbox data) can't be culled: every region includes it.
  const bboxIndex = useMemo(() => {
    const entries: BBoxEntry[] = tracks.map((t) => ({ id: t.id, bbox: t.stats.bbox ?? NO_BOX }));
    return buildBBoxIndex(entries);
  }, [tracks]);
  const inRegion = useMemo(
    () => (regionBounds ? new Set(bboxIndex.query(regionBounds)) : null),
    [bboxIndex, regionBounds],
  );

  // The shown trails to draw: those in the region, capped (newest first).
  const drawIds = useMemo(() => {
    const visible = inRegion ? shownTrackIds.filter((id) => inRegion.has(id)) : shownTrackIds;
    return capNewest(visible, (id) => tracksById.get(id)?.startedAt ?? 0);
    // `shownKey` is the joined shownTrackIds — callers rebuild the array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, inRegion, tracksById]);
  const drawKey = drawIds.join('|');

  // What to load: the drawn trails, plus (heatmap on) every qualifying
  // trail — those in the region first, so the visible heat fills in first.
  const loadIds = useMemo(() => {
    if (!heatEnabled) return drawIds;
    const first: string[] = [...drawIds];
    const later: string[] = [];
    const seen = new Set(first);
    for (const id of allTrackIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const t = tracksById.get(id);
      if (!t || !qualifiesForHeat(t)) continue;
      (inRegion === null || inRegion.has(id) ? first : later).push(id);
    }
    return first.concat(later);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawKey, allKey, heatEnabled, inRegion, tracksById]);
  const version = useTrackGeometries(tracksById, loadIds);

  // The drawn trails whose geometry is in: the lines rebuild only when this
  // changes, so a batch of off-screen heat trails loading leaves them alone.
  const loadedDrawKey = useMemo(
    () =>
      drawIds
        .filter((id) => {
          const t = tracksById.get(id);
          return t !== undefined && peekTrackGeometry(t) !== undefined;
        })
        .join('|'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, drawKey, tracksById],
  );
  const toleranceM = lineToleranceM(zoomLevel);
  const anyShown = shownTrackIds.length > 0;

  // Drawn trails: lines (clipped to the region, newest first within the
  // vertex budget) + the tap index behind plain single-trail inspect.
  const { lines, tapIndex } = useMemo(() => {
    const tapInputs: GridIndexInput[] = [];
    const candidates: { t: TrackSummary; g: TrackGeometry; parts: [number, number][][] }[] = [];
    for (const id of loadedDrawKey ? loadedDrawKey.split('|') : []) {
      const t = tracksById.get(id);
      if (!t) continue;
      const g = peekTrackGeometry(t);
      if (!g) continue;
      const simplified = partsAt(g, toleranceM);
      const parts = regionBounds
        ? clipParts(simplified, chunked(simplified), regionBounds)
        : simplified;
      if (parts.length > 0) candidates.push({ t, g, parts });
    }
    // Over the budget, the newest trails win; the rest keep source order.
    let budget = MAX_TRAIL_LINE_VERTICES;
    const kept = new Set<TrackSummary>();
    for (const c of [...candidates].sort((x, y) => y.t.startedAt - x.t.startedAt)) {
      const n = vertexCount(c.parts);
      if (n > budget) continue;
      budget -= n;
      kept.add(c.t);
    }
    const features: HeatLineFeature[] = [];
    for (const { t, g, parts } of candidates) {
      if (!kept.has(t)) continue;
      const geometry = asLine(parts);
      if (!geometry) continue;
      const categoryId = t.category ?? 'uncategorized';
      const color = categoryColor(t.category, customCategories) ?? mapColors.trackOverlay;
      features.push({
        type: 'Feature',
        geometry,
        properties: { trackId: t.id, categoryId, color },
      });
      // Every drawn trail — navigation included — is inspectable.
      tapInputs.push({ id: t.id, categoryId, cells: cellWalk(g).cells });
    }
    return {
      lines: anyShown
        ? ({ type: 'FeatureCollection', features } as FeatureCollection<
            LineString | MultiLineString,
            HeatLineProperties
          >)
        : null,
      tapIndex: buildGridIndex(tapInputs),
    };
  }, [loadedDrawKey, anyShown, toleranceM, regionBounds, tracksById, customCategories]);

  // All qualifying trails: the hot/tap index (always — it backs hot-spot
  // detection among shown trails too) and, while the heatmap is on, the
  // pass-count grid, updated trail by trail.
  const [gridSync] = useState(() => new HeatGridSync(LINE_GRID));
  const { heatIndex, heatGrid, gridStamp } = useMemo(() => {
    const heatInputs: GridIndexInput[] = [];
    const target = new Map<string, TrackCellWalk>();
    for (const id of allTrackIds) {
      const t = tracksById.get(id);
      if (!t || !qualifiesForHeat(t)) continue;
      const g = peekTrackGeometry(t);
      if (!g) continue;
      const walk = cellWalk(g);
      heatInputs.push({ id, categoryId: t.category ?? 'uncategorized', cells: walk.cells });
      target.set(id, walk);
    }
    const index = buildGridIndex(heatInputs);
    // Off: drop the grid (memory); it is rebuilt if the heatmap comes back.
    if (!heatEnabled) gridSync.clear();
    else gridSync.sync(target);
    return { heatIndex: index, heatGrid: gridSync.heat, gridStamp: gridSync.stamp };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, allKey, tracksById, heatEnabled]);

  const needs = viewport === 'all' ? ALL_HEAT_LAYERS : heatLayersAt(zoomLevel);
  // The whole library's glow points / heat chains: once per grid change, and
  // only at zooms that draw them. A settle then only clips.
  const glowAll = useMemo(
    () => (heatGrid && needs.glow ? heatGlowPoints(heatGrid) : null),
    // `gridStamp` changes whenever the (mutable) grid does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gridStamp, heatGrid, needs.glow],
  );
  const chains = useMemo(
    () => (heatGrid && needs.lines ? indexHeatLines(heatGridLines(heatGrid)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gridStamp, heatGrid, needs.lines],
  );
  const heatGlow = useMemo(() => {
    if (!heatEnabled) return null;
    if (!glowAll) return EMPTY_GLOW;
    return regionBounds ? glowWithin(glowAll, regionBounds) : glowAll;
  }, [heatEnabled, glowAll, regionBounds]);
  const heatLines = useMemo(() => {
    if (!heatEnabled) return null;
    if (!chains) return EMPTY_HEAT_LINES;
    return heatLinesWithin(chains, regionBounds ?? WORLD);
  }, [heatEnabled, chains, regionBounds]);

  const lineFor = useCallback(
    (trackId: string): HeatLineFeature | null => {
      const t = tracksById.get(trackId);
      if (!t) return null;
      const g = peekTrackGeometry(t);
      const geometry = g ? asLine(partsAt(g, 0)) : null;
      if (!geometry) return null;
      const categoryId = t.category ?? 'uncategorized';
      const color = categoryColor(t.category, customCategories) ?? mapColors.trackOverlay;
      return { type: 'Feature', geometry, properties: { trackId: t.id, categoryId, color } };
    },
    // `version`: a trail loaded since the last call must become drawable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracksById, customCategories, version],
  );

  const heatAt = useCallback(
    (
      lngLat: { lng: number; lat: number },
      radiusM = 0,
      glowTappable = false,
    ): { trackIds: string[]; hot: boolean } => {
      const near = (index: GridIndex) =>
        gridTrailsNearWithin(index, LINE_GRID, lngLat.lng, lngLat.lat, radiusM);
      // Newest first. A Map lookup per id: a hot corridor can hold hundreds
      // of trails, and `tracks.find` in the comparator made this
      // O(k·log k·n) per tap.
      const sortByStartedAtDesc = (ids: readonly string[]) =>
        ids
          .map((id) => ({ id, at: tracksById.get(id)?.startedAt ?? 0 }))
          .sort((a, b) => b.at - a.at)
          .map((x) => x.id);

      // hot: global, all-qualifying overlap (>= 2 qualifying trails of the
      // same category) — a hot spot's carousel is populated from the same
      // global index, so it's never short a trail just because that trail's
      // trace is currently hidden.
      const { trackIds: hotTrackIds, hot } = near(heatIndex);
      if (hot) return { trackIds: sortByStartedAtDesc(hotTrackIds), hot: true };

      // Not hot: a drawn trace under the finger wins (trace-visibility rules).
      const { trackIds: drawnAtCell } = near(tapIndex);
      if (drawnAtCell.length > 0) {
        return { trackIds: sortByStartedAtDesc(drawnAtCell), hot: false };
      }
      // No shown trace, but the heat is drawn for every qualifying trail,
      // traces on or off — a tap on a single-pass heat line is that trail.
      if (glowTappable && hotTrackIds.length > 0) {
        return { trackIds: sortByStartedAtDesc(hotTrackIds).slice(0, 1), hot: false };
      }
      return { trackIds: [], hot: false };
    },
    [heatIndex, tapIndex, tracksById],
  );

  return useMemo(
    () => ({ lines, heatLines, heatGlow, heatAt, lineFor }),
    [lines, heatLines, heatGlow, heatAt, lineFor],
  );
}
