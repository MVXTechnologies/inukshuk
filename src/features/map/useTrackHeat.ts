import type { TrackGeometry } from '@core/geo/track/simplify';
import {
  buildGridIndex,
  buildHeatGrid,
  CellGrid,
  gridTrailsNearWithin,
  HEAT_LINE_CELL_M,
  heatGlowPoints,
  heatGridLines,
  walkTrackCells,
  type GridIndex,
  type GridIndexInput,
  type HeatGlowProps,
  type HeatLineProps,
  type TrackCellWalk,
} from '@core/heat/heatGrid';
import { qualifiesForHeat } from '@core/heat/qualify';
import { categoryColor } from '@core/library/categories';
import type { TrackSummary } from '@core/models';
import { peekTrackGeometry } from '@data/trackGeometry';
import { useLibraryStore } from '@state/libraryStore';
import { mapColors } from '@ui/theme';
import type { Feature, FeatureCollection, LineString, MultiLineString, Point } from 'geojson';
import { useCallback, useMemo } from 'react';

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
  /** One thin line per shown trail, category-coloured, from the trail's
   * SIMPLIFIED geometry (a few metres; never the full recording). */
  lines: FeatureCollection<LineString | MultiLineString, HeatLineProperties> | null;
  /** The personal heatmap at street zooms: pass-count lines over every
   * qualifying trail in the library (see `heatGridLines`). Null while the
   * heatmap is off. */
  heatLines: FeatureCollection<MultiLineString, HeatLineProps> | null;
  /** The personal heatmap's low-zoom glow: one weighted point per occupied
   * coarse cell (see `heatGlowPoints`). Null while the heatmap is off. */
  heatGlow: FeatureCollection<Point, HeatGlowProps> | null;
  /**
   * Trails at a tapped point. `radiusM` is the finger's tolerance on the
   * ground (the caller converts its pixel tolerance at the current zoom).
   * Hot detection (and the trackIds returned for a hot spot) is global, over
   * every qualifying trail; a non-hot tap falls back to the shown trails.
   */
  heatAt: (
    lngLat: { lng: number; lat: number },
    radiusM?: number,
    /** The heat is on screen: a tap on it opens the trail that makes it. */
    glowTappable?: boolean,
  ) => { trackIds: string[]; hot: boolean };
  /** Line geometry (simplified) for any loaded trackId, regardless of
   * shown/qualifying membership — the focused-trail highlight. Null until
   * that trail's geometry is loaded, or if the id is unknown. */
  lineFor: (trackId: string) => HeatLineFeature | null;
}

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

function lineGeometry(g: TrackGeometry): LineString | MultiLineString | null {
  const parts = g.parts.filter((p) => p.length >= 2);
  const [only] = parts;
  if (!only) return null;
  return parts.length === 1
    ? { type: 'LineString', coordinates: only }
    : { type: 'MultiLineString', coordinates: parts };
}

/**
 * Trail lines and the personal heatmap for the map (#465, #466).
 *
 * - `lines`: one category-coloured line per SHOWN trail (visibility rules
 *   unchanged), from simplified geometry.
 * - `heatLines` / `heatGlow`: the personal heatmap over EVERY qualifying
 *   trail in `allTrackIds` (the caller widens it to the whole library while
 *   the heatmap is on), built from a distinct-pass grid — crisp lines at
 *   street zooms, a glow when zoomed out. Only computed while `heatEnabled`.
 * - `heatAt`: the tap lookup (hot = 2+ qualifying trails of one category).
 *
 * Geometry comes from `@data/trackGeometry` (one parse per trail, cached on
 * disk) and is loaded in batches by `useTrackGeometries`, so a 400-trail
 * library rebuilds these a handful of times while loading, not 400 times.
 * Everything is memoized against the actual inputs, so GPS ticks, camera
 * moves and selection changes never rebuild (or re-upload) a source.
 */
export function useTrackHeat(
  tracks: readonly TrackSummary[],
  shownTrackIds: readonly string[],
  allTrackIds: readonly string[],
  heatEnabled = true,
): TrackHeat {
  const customCategories = useLibraryStore((s) => s.customCategories);
  const tracksById = useMemo(() => indexTracks(tracks), [tracks]);

  const shownKey = shownTrackIds.join('|');
  const allKey = allTrackIds.join('|');
  const loadIds = useMemo(
    () => Array.from(new Set([...shownTrackIds, ...allTrackIds])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownKey, allKey],
  );
  const version = useTrackGeometries(tracksById, loadIds);

  // Shown trails: lines + the tap index behind plain single-trail inspect.
  const { lines, tapIndex } = useMemo(() => {
    const tapInputs: GridIndexInput[] = [];
    const features: HeatLineFeature[] = [];
    for (const id of shownTrackIds) {
      const t = tracksById.get(id);
      if (!t) continue;
      const g = peekTrackGeometry(t);
      if (!g) continue;
      const categoryId = t.category ?? 'uncategorized';
      const geometry = lineGeometry(g);
      if (geometry) {
        const color = categoryColor(t.category, customCategories) ?? mapColors.trackOverlay;
        features.push({
          type: 'Feature',
          geometry,
          properties: { trackId: id, categoryId, color },
        });
      }
      // Every rendered trail — navigation included — is inspectable.
      tapInputs.push({ id, categoryId, cells: cellWalk(g).cells });
    }
    return {
      lines:
        shownTrackIds.length > 0
          ? ({ type: 'FeatureCollection', features } as FeatureCollection<
              LineString | MultiLineString,
              HeatLineProperties
            >)
          : null,
      tapIndex: buildGridIndex(tapInputs),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, shownKey, tracksById, customCategories]);

  // All qualifying trails: the hot/tap index (always — it backs hot-spot
  // detection among shown trails too) and, while the heatmap is on, the
  // pass-count grid it draws.
  const { heatIndex, heatLines, heatGlow } = useMemo(() => {
    const heatInputs: GridIndexInput[] = [];
    const trailWalks: TrackCellWalk[] = [];
    for (const id of allTrackIds) {
      const t = tracksById.get(id);
      if (!t || !qualifiesForHeat(t)) continue;
      const g = peekTrackGeometry(t);
      if (!g) continue;
      const walk = cellWalk(g);
      heatInputs.push({ id, categoryId: t.category ?? 'uncategorized', cells: walk.cells });
      if (heatEnabled) trailWalks.push(walk);
    }
    const index = buildGridIndex(heatInputs);
    if (!heatEnabled || trailWalks.length === 0) {
      return { heatIndex: index, heatLines: null, heatGlow: null };
    }
    const grid = buildHeatGrid(trailWalks, LINE_GRID);
    return { heatIndex: index, heatLines: heatGridLines(grid), heatGlow: heatGlowPoints(grid) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, allKey, tracksById, heatEnabled]);

  const lineFor = useCallback(
    (trackId: string): HeatLineFeature | null => {
      const t = tracksById.get(trackId);
      if (!t) return null;
      const g = peekTrackGeometry(t);
      const geometry = g ? lineGeometry(g) : null;
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

      // Not hot: a shown trace under the finger wins (trace-visibility rules).
      const { trackIds: shownTrackIdsAtCell } = near(tapIndex);
      if (shownTrackIdsAtCell.length > 0) {
        return { trackIds: sortByStartedAtDesc(shownTrackIdsAtCell), hot: false };
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
