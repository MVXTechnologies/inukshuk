import type { GridIndexLike, HeatGlowProps, HeatLineProps } from '@core/heat/heatGrid';
import {
  mergeGlow,
  mergeLineBuckets,
  StoredTapIndex,
  TileMapper,
  tilesMeeting,
  type TileKey,
  type TileRender,
  type TileTap,
} from '@core/heat/heatTiles';
import {
  glowWithin,
  heatLinesWithin,
  indexHeatLines,
  type IndexedHeatLines,
} from '@core/heat/heatViewport';
import { qualifiesForHeat } from '@core/heat/qualify';
import type { BoundingBox, TrackSummary } from '@core/models';
import { getHeatStore } from '@data/heatStore';
import type { FeatureCollection, MultiLineString, Point } from 'geojson';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

/**
 * The personal heatmap from the stored, tiled heat product (#500).
 *
 * - Keeps the store in step with `heatTracks` (the trails the heat counts,
 *   visible ones first) while `enabled`: only new, changed or removed trails
 *   are (re)computed, in the background (see `@data/heatStore`).
 * - Reads only the stored tiles meeting `bounds` (`null` = every tile;
 *   `undefined` = viewport not known yet → nothing) and clips them to it.
 * - Taps resolve against the stored grid of those tiles: trail ids and
 *   categories come from the live library, so the carousel never waits on
 *   (or loads) any trail's geometry.
 *
 * Outputs keep their identity until a tile in view gets a new revision or
 * the region changes.
 */

const EMPTY_LINES: FeatureCollection<MultiLineString, HeatLineProps> = {
  type: 'FeatureCollection',
  features: [],
};
const EMPTY_GLOW: FeatureCollection<Point, HeatGlowProps> = {
  type: 'FeatureCollection',
  features: [],
};
const WORLD: BoundingBox = { minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 };
const NO_INDEX: GridIndexLike = { get: () => undefined };

/** A tile render's chains, chunked for clipping (once per decoded render). */
const indexed = new WeakMap<TileRender, IndexedHeatLines>();
function indexedLines(r: TileRender): IndexedHeatLines {
  let i = indexed.get(r);
  if (!i) {
    i = indexHeatLines(r.lines);
    indexed.set(r, i);
  }
  return i;
}

interface Loaded<T> {
  key: string;
  byTile: ReadonlyMap<TileKey, T>;
}

export interface StoredHeat {
  heatLines: FeatureCollection<MultiLineString, HeatLineProps> | null;
  heatGlow: FeatureCollection<Point, HeatGlowProps> | null;
  /** Tap lookup over every stored trail in the loaded tiles. */
  index: GridIndexLike;
}

export function useStoredHeat(
  enabled: boolean,
  tracksById: ReadonlyMap<string, TrackSummary>,
  heatTracks: readonly TrackSummary[],
  bounds: BoundingBox | null | undefined,
  needs: { glow: boolean; lines: boolean },
): StoredHeat {
  const store = getHeatStore();

  // Keep the store in step with the library (a no-op when it already is).
  useEffect(() => {
    if (enabled) store.sync(heatTracks);
  }, [store, enabled, heatTracks]);
  useEffect(() => {
    if (!enabled) void store.pause();
  }, [store, enabled]);
  useEffect(
    () => () => {
      void store.pause();
    },
    [store],
  );

  const stamp = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.stamp,
  );

  // The tiles in view at their current revisions.
  const tilesKey = useMemo(() => {
    if (!enabled || bounds === undefined) return '';
    const stored = store.storedTiles();
    return tilesMeeting(stored.keys(), bounds)
      .sort()
      .map((k) => `${k}@${stored.get(k)}`)
      .join('|');
    // `stamp` changes whenever the stored tiles do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, stamp, enabled, bounds]);

  const [renders, setRenders] = useState<Loaded<TileRender>>({ key: '', byTile: new Map() });
  const [taps, setTaps] = useState<Loaded<TileTap>>({ key: '', byTile: new Map() });
  useEffect(() => {
    let cancelled = false;
    const keys = tilesKey ? tilesKey.split('|').map((s) => s.slice(0, s.indexOf('@'))) : [];
    (async () => {
      const r = new Map<TileKey, TileRender>();
      for (const k of keys) {
        const render = await store.readRender(k);
        if (cancelled) return;
        if (render) r.set(k, render);
      }
      setRenders({ key: tilesKey, byTile: r });
      // The tap tables after the drawing: a tap needs them only once seen.
      const t = new Map<TileKey, TileTap>();
      for (const k of keys) {
        const tap = await store.readTap(k);
        if (cancelled) return;
        if (tap) t.set(k, tap);
      }
      setTaps({ key: tilesKey, byTile: t });
    })();
    return () => {
      cancelled = true;
    };
  }, [store, tilesKey]);

  const clip = bounds ?? WORLD;
  const heatLines = useMemo(() => {
    if (!enabled) return null;
    if (!needs.lines || renders.byTile.size === 0) return EMPTY_LINES;
    return mergeLineBuckets(
      [...renders.byTile.values()].map((r) => heatLinesWithin(indexedLines(r), clip)),
    );
  }, [enabled, needs.lines, renders, clip]);
  const heatGlow = useMemo(() => {
    if (!enabled) return null;
    if (!needs.glow || renders.byTile.size === 0) return EMPTY_GLOW;
    return mergeGlow([...renders.byTile.values()].map((r) => glowWithin(r.glow, clip)));
  }, [enabled, needs.glow, renders, clip]);

  const index = useMemo<GridIndexLike>(() => {
    if (!enabled || taps.byTile.size === 0) return NO_INDEX;
    return new StoredTapIndex(new TileMapper(store.grid), taps.byTile, (slot) => {
      const id = store.slotTrack(slot);
      const t = id === undefined ? undefined : tracksById.get(id);
      if (!t || !qualifiesForHeat(t)) return null;
      return { id: t.id, categoryId: t.category ?? 'uncategorized' };
    });
  }, [store, enabled, taps, tracksById]);

  return useMemo(() => ({ heatLines, heatGlow, index }), [heatLines, heatGlow, index]);
}
