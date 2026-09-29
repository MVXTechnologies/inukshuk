import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
import type { LatLng } from '@core/models';
import { bboxCenter } from './nearest';
import type { CatalogBbox, CatalogCategory, CatalogItem, CatalogShardRef } from './schema';
import { selectShards } from './shard';

/**
 * The explorer's map view (#447), as pure geometry: which shards "Search this
 * area" should pull for the visible bounds, which loaded items are on screen,
 * the clustered-points GeoJSON, a footprint rectangle, and where a cluster tap
 * zooms to. The screen owns the MapLibre view; everything decidable without it
 * lives here so it is tested.
 *
 * Bounds are WGS84 `[west, south, east, north]` like a catalog bbox. A view
 * straddling the antimeridian arrives with `west > east`; every predicate here
 * treats that as the two halves it is.
 */

export type ExploreBounds = CatalogBbox;

/**
 * Clamp a camera's raw visible bounds into a valid WGS84 box. A world-wide
 * view reports a longitude span of 360° or more (and sometimes longitudes past
 * ±180); that collapses to the whole world rather than a nonsense box.
 */
export function normalizeBounds(raw: readonly [number, number, number, number]): ExploreBounds {
  const [w, s, e, n] = raw;
  const south = Math.max(-90, Math.min(s, n));
  const north = Math.min(90, Math.max(s, n));
  if (!Number.isFinite(w) || !Number.isFinite(e) || Math.abs(e - w) >= 360) {
    return [-180, south, 180, north];
  }
  const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
  return [wrap(w), south, wrap(e), north];
}

/** The longitude ranges a box covers (two when it crosses the antimeridian). */
function lonRanges(bounds: ExploreBounds): [number, number][] {
  const [west, , east] = bounds;
  return west <= east
    ? [[west, east]]
    : [
        [west, 180],
        [-180, east],
      ];
}

/** Do two boxes overlap (edges touching counts)? */
export function boundsIntersect(a: ExploreBounds, b: ExploreBounds): boolean {
  if (a[1] > b[3] || b[1] > a[3]) return false;
  for (const [aw, ae] of lonRanges(a)) {
    for (const [bw, be] of lonRanges(b)) {
      if (aw <= be && bw <= ae) return true;
    }
  }
  return false;
}

/** Is a point inside a box (antimeridian-aware)? */
export function boundsContain(bounds: ExploreBounds, point: LatLng): boolean {
  if (point.latitude < bounds[1] || point.latitude > bounds[3]) return false;
  return lonRanges(bounds).some(([w, e]) => point.longitude >= w && point.longitude <= e);
}

/** The middle of a box, antimeridian-aware. */
export function boundsCenter(bounds: ExploreBounds): LatLng {
  const [west, south, east, north] = bounds;
  const span = west <= east ? east - west : east + 360 - west;
  let longitude = west + span / 2;
  if (longitude > 180) longitude -= 360;
  return { latitude: (south + north) / 2, longitude };
}

/** Shards whose coverage reaches into `bounds` (`nogeo` shards never do). */
export function shardsInBounds(
  shards: readonly CatalogShardRef[],
  bounds: ExploreBounds,
): CatalogShardRef[] {
  return shards.filter((shard) => shard.bbox !== undefined && boundsIntersect(shard.bbox, bounds));
}

export interface BoundsShardSelection {
  category?: CatalogCategory | null;
  limit: number;
  byteBudget?: number;
}

/**
 * "Search this area": the shards to fetch for the visible bounds — only ones
 * that reach into the view, nearest the view's centre first, under the same
 * count and byte budgets as every other shard load (a zoomed-out world view
 * must not turn one tap into a 50 MB fetch; it gets the budget's worth nearest
 * the centre, and the button stays up for the next batch).
 */
export function selectShardsInBounds(
  shards: readonly CatalogShardRef[],
  bounds: ExploreBounds,
  selection: BoundsShardSelection,
): CatalogShardRef[] {
  return selectShards(shardsInBounds(shards, bounds), boundsCenter(bounds), selection);
}

/**
 * How many shards reaching into `bounds` are still to load — what decides
 * whether "Search this area" is worth showing. Shards in `excluded` (loaded,
 * in flight, or cooling down after a failure) do not count.
 */
export function pendingShardCountInBounds(
  shards: readonly CatalogShardRef[],
  bounds: ExploreBounds,
  excluded: ReadonlySet<string>,
  category?: CatalogCategory | null,
): number {
  let count = 0;
  for (const shard of shardsInBounds(shards, bounds)) {
    if (excluded.has(shard.id)) continue;
    if (category != null && shard.category !== category) continue;
    count += 1;
  }
  return count;
}

/** Loaded items whose footprint centre is on screen ("N maps in this area"). */
export function itemsInBounds(items: readonly CatalogItem[], bounds: ExploreBounds): CatalogItem[] {
  return items.filter(
    (item) => item.bbox !== undefined && boundsContain(bounds, bboxCenter(item.bbox)),
  );
}

/** Properties carried by each catalog point on the explorer map. */
export interface CatalogPointProps {
  id: string;
}

/**
 * One point per placeable item, at its footprint centre — the data of the
 * clustered GeoJSON source. Items without a bbox cannot be placed and are
 * left out (they still appear in the list view).
 */
export function catalogPointCollection(
  items: readonly CatalogItem[],
): FeatureCollection<Point, CatalogPointProps> {
  const features: Feature<Point, CatalogPointProps>[] = [];
  for (const item of items) {
    if (item.bbox === undefined) continue;
    const center = bboxCenter(item.bbox);
    features.push({
      type: 'Feature',
      id: item.id,
      geometry: { type: 'Point', coordinates: [center.longitude, center.latitude] },
      properties: { id: item.id },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** A catalog footprint as a closed polygon (the selected map's rectangle). */
export function footprintFeature(bbox: CatalogBbox): Feature<Polygon> {
  const [w, s, e, n] = bbox;
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
    properties: {},
  };
}

/** The deepest zoom a cluster tap may take the camera to. */
export const CLUSTER_TAP_MAX_ZOOM = 16;

/**
 * Where a cluster tap zooms: the source's expansion zoom (the level at which
 * the cluster splits), but always at least one level deeper than now — the
 * reported expansion zoom can equal the current zoom at a cluster's edge, and
 * a tap that does not move reads as broken — and never past the cap.
 */
export function clusterTapZoom(
  expansionZoom: number | null | undefined,
  currentZoom: number,
  maxZoom = CLUSTER_TAP_MAX_ZOOM,
): number {
  const base = Number.isFinite(currentZoom) ? currentZoom : 0;
  const target =
    expansionZoom != null && Number.isFinite(expansionZoom)
      ? Math.max(expansionZoom, base + 1)
      : base + 2;
  return Math.min(maxZoom, target);
}

/** Read a MapLibre cluster feature's id, or null when the feature is a plain point. */
export function clusterIdOf(feature: {
  properties?: Record<string, unknown> | null;
}): number | null {
  const props = feature.properties;
  if (props == null || props.cluster !== true) return null;
  const id = props.cluster_id;
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

/** Read the catalog item id off a tapped (unclustered) point feature. */
export function pointItemIdOf(feature: {
  properties?: Record<string, unknown> | null;
}): string | null {
  const props = feature.properties;
  if (props == null || props.cluster === true) return null;
  return typeof props.id === 'string' && props.id !== '' ? props.id : null;
}

/** A camera start around a position: roughly a region's width (zoom 7). */
export const EXPLORE_MAP_START_ZOOM = 7;
