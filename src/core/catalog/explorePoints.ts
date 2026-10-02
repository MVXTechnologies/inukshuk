import type { Feature, FeatureCollection, Point } from 'geojson';
import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';
import { placeActivities, placeKind } from './collections';
import type { ExploreFilter } from './exploreFacets';
import { boundsContain, trimBoundsBottom, type ExploreBounds } from './exploreMap';
import { foldText } from './filterCatalog';
import { bboxCenter } from './nearest';
import type { CatalogItem } from './schema';
import type { CatalogActivity, CatalogKind, LinkOutCollection, LinkOutPlace } from './taxonomy';

/**
 * What the Explore map draws: one POINT per thing with a location, whichever
 * shelf it comes from — a downloadable catalog sheet (at its footprint centre)
 * or a place from a link-out collection (a Sépaq park, a zec) whose maps live
 * on the publisher's site.
 *
 * Before this, the map knew catalog sheets only, so checking an activity near
 * Québec City — where the catalog has no sheet at all — drew an empty map
 * while 100 parks, reserves and zecs sat one screen away under Collections.
 *
 * Pure: the screen passes the already-filtered catalog items, the collections
 * and the same {@link ExploreFilter}; everything decidable without MapLibre is
 * here so it is tested.
 */

export interface MapSheetPoint {
  kind: 'map';
  /** Unique among the map's points (the catalog item id). */
  key: string;
  latitude: number;
  longitude: number;
  item: CatalogItem;
}

export interface PlacePoint {
  kind: 'place';
  /** Unique among the map's points (`place:<collection>/<place>`). */
  key: string;
  latitude: number;
  longitude: number;
  place: LinkOutPlace;
  collection: LinkOutCollection;
}

export type ExplorePoint = MapSheetPoint | PlacePoint;
export type ExplorePointKind = ExplorePoint['kind'];

export const placePointKey = (collectionId: string, placeId: string): string =>
  `place:${collectionId}/${placeId}`;

/** One point per placeable catalog item (no bbox = cannot be placed). */
export function mapSheetPoints(items: readonly CatalogItem[]): MapSheetPoint[] {
  const out: MapSheetPoint[] = [];
  for (const item of items) {
    if (item.bbox === undefined) continue;
    const { latitude, longitude } = bboxCenter(item.bbox);
    out.push({ kind: 'map', key: item.id, latitude, longitude, item });
  }
  return out;
}

/**
 * Does a link-out place satisfy the explorer filter?
 *
 * - `activity`: the place's activities (its own, else its type's defaults).
 * - `kind`: the kind its type is browsed under (`placeKind`).
 * - `terrain` and `sourceId` describe catalog sheets (computed from a
 *   footprint; a publisher in the catalog index) — a place has neither, so
 *   either one being set leaves places out rather than guess.
 * - `text`: every token must be in the name, type, publisher or collection.
 */
export function matchesPlaceFilter(
  place: LinkOutPlace,
  collection: Pick<LinkOutCollection, 'name' | 'publisher'>,
  filter: ExploreFilter,
): boolean {
  if (filter.terrain != null || filter.sourceId != null) return false;
  if (filter.kind != null && placeKind(place) !== filter.kind) return false;
  if (filter.activity != null && !placeActivities(place).includes(filter.activity)) return false;
  const query = filter.text?.trim();
  if (query !== undefined && query !== '') {
    const hay = foldText(`${place.name} ${place.type} ${collection.publisher} ${collection.name}`);
    for (const token of foldText(query).split(/\s+/)) {
      if (token !== '' && !hay.includes(token)) return false;
    }
  }
  return true;
}

/** The places of every collection that pass the filter. */
export function placePoints(
  collections: readonly LinkOutCollection[],
  filter: ExploreFilter = {},
): PlacePoint[] {
  const out: PlacePoint[] = [];
  const seen = new Set<string>();
  for (const collection of collections) {
    for (const place of collection.places) {
      const key = placePointKey(collection.id, place.id);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
      if (!matchesPlaceFilter(place, collection, filter)) continue;
      out.push({
        kind: 'place',
        key,
        latitude: place.latitude,
        longitude: place.longitude,
        place,
        collection,
      });
    }
  }
  return out;
}

/**
 * Everything the map shows for a filter: the catalog items that passed it
 * (`filterExploreItems` — the caller's, so the list and the map agree) plus
 * the matching places.
 */
export function explorePoints(
  filteredItems: readonly CatalogItem[],
  collections: readonly LinkOutCollection[],
  filter: ExploreFilter,
): ExplorePoint[] {
  return [...mapSheetPoints(filteredItems), ...placePoints(collections, filter)];
}

/** Properties on each point feature: which point, and what kind (drives the layer style). */
export interface ExplorePointProps {
  id: string;
  kind: ExplorePointKind;
}

/** The clustered GeoJSON source's data. */
export function explorePointCollection(
  points: readonly ExplorePoint[],
): FeatureCollection<Point, ExplorePointProps> {
  const features: Feature<Point, ExplorePointProps>[] = points.map((point) => ({
    type: 'Feature',
    id: point.key,
    geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
    properties: { id: point.key, kind: point.kind },
  }));
  return { type: 'FeatureCollection', features };
}

/** Points on screen. */
export function pointsInBounds<P extends LatLng>(points: readonly P[], bounds: ExploreBounds): P[] {
  return points.filter((point) => boundsContain(bounds, point));
}

/** Points on screen above the list sheet (see `itemsInSheetView`). */
export function pointsInSheetView<P extends LatLng>(
  points: readonly P[],
  bounds: ExploreBounds,
  sheetFraction: number,
): P[] {
  return pointsInBounds(points, trimBoundsBottom(bounds, sheetFraction));
}

/** Nearest-first from `origin` (stable; input order when there is no origin). */
export function sortPointsByDistance<P extends LatLng>(
  points: readonly P[],
  origin: LatLng | null,
): P[] {
  if (origin === null) return [...points];
  return points
    .map((point, i) => ({ point, i, d: haversineMeters(origin, point) }))
    .sort((a, b) => (a.d !== b.d ? a.d - b.d : a.i - b.i))
    .map((entry) => entry.point);
}

/**
 * Where the map should frame: a box around the user and the `count` nearest
 * points, so the first screen (and the first screen after checking an
 * activity) shows points instead of an empty map with the nearest ones just
 * off-screen. Null when there is nothing to frame.
 */
export function nearestPointsView(
  position: LatLng | null,
  points: readonly LatLng[],
  count = 24,
): ExploreBounds | null {
  if (position === null || points.length === 0) return null;
  const cos = Math.cos((position.latitude * Math.PI) / 180);
  const nearest = points
    .map((p) => ({
      p,
      d: Math.hypot(p.latitude - position.latitude, (p.longitude - position.longitude) * cos),
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.max(1, count));
  let [w, s, e, n] = [position.longitude, position.latitude, position.longitude, position.latitude];
  for (const { p } of nearest) {
    w = Math.min(w, p.longitude);
    e = Math.max(e, p.longitude);
    s = Math.min(s, p.latitude);
    n = Math.max(n, p.latitude);
  }
  return [w, s, e, n];
}

/* ------------------------------------------------------------------------ */
/* Viewport culling                                                          */
/* ------------------------------------------------------------------------ */

/** Above this many points the source is fed only the ones around the view. */
export const EXPLORE_CULL_THRESHOLD = 3000;
/** How much looser than needed a kept window may get before it is rebuilt. */
const CULL_SLACK = 4;
const WORLD: ExploreBounds = [-180, -90, 180, 90];

function sameBox(a: ExploreBounds, b: ExploreBounds): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * The box of points worth handing to the map source for a view: the view grown
 * by `pad` view-sizes on every side, so clusters at the screen edge still count
 * their off-screen members and a pan does not immediately run out of points.
 *
 * It has hysteresis: while the view stays inside the previous window — and the
 * window has not become far looser than needed after a deep zoom-in — the SAME
 * window object comes back, so the source data (and its native clustering) is
 * not rebuilt on every camera move. A view crossing the antimeridian, or one
 * whose padded box would leave the world, gets the whole world.
 */
export function cullWindow(
  view: ExploreBounds,
  previous: ExploreBounds | null,
  pad = 1,
): ExploreBounds {
  const [w, s, e, n] = view;
  const lonSpan = e - w;
  const latSpan = n - s;
  const west = w - lonSpan * pad;
  const east = e + lonSpan * pad;
  const wanted: ExploreBounds =
    w > e || west < -180 || east > 180
      ? WORLD
      : [west, Math.max(-90, s - latSpan * pad), east, Math.min(90, n + latSpan * pad)];
  if (previous === null) return wanted;
  if (sameBox(previous, wanted)) return previous;
  if (wanted === WORLD) return WORLD;
  const covers =
    view[0] >= previous[0] &&
    view[2] <= previous[2] &&
    view[1] >= previous[1] &&
    view[3] <= previous[3];
  const snug =
    previous[2] - previous[0] <= (wanted[2] - wanted[0]) * CULL_SLACK &&
    previous[3] - previous[1] <= (wanted[3] - wanted[1]) * CULL_SLACK;
  return covers && snug ? previous : wanted;
}

/**
 * The points to hand the map source: all of them while they are few (the
 * source clusters thousands natively, and a stable array never re-clusters),
 * only those inside the cull window once past `threshold`.
 */
export function cullPoints<P extends LatLng>(
  points: readonly P[],
  window: ExploreBounds | null,
  threshold: number = EXPLORE_CULL_THRESHOLD,
): readonly P[] {
  if (window === null || points.length <= threshold) return points;
  return pointsInBounds(points, window);
}

/* ------------------------------------------------------------------------ */
/* Taps, counts, empty state                                                 */
/* ------------------------------------------------------------------------ */

/** Read which point a tapped (unclustered) feature is, or null for a cluster. */
export function tappedPointOf(feature: {
  properties?: Record<string, unknown> | null;
}): { kind: ExplorePointKind; key: string } | null {
  const props = feature.properties;
  if (props == null || props.cluster === true) return null;
  if (typeof props.id !== 'string' || props.id === '') return null;
  return { kind: props.kind === 'place' ? 'place' : 'map', key: props.id };
}

/** Metres from `origin` to a point (null without an origin). */
export function pointDistanceMeters(point: LatLng, origin: LatLng | null): number | null {
  if (origin === null) return null;
  const d = haversineMeters(origin, point);
  return Number.isFinite(d) ? d : null;
}

/** How many places each Type and Activity chip adds to the catalog's own counts. */
export interface PlaceFacetCounts {
  kinds: Partial<Record<CatalogKind, number>>;
  activities: Partial<Record<CatalogActivity, number>>;
}

export function countPlaceFacets(collections: readonly LinkOutCollection[]): PlaceFacetCounts {
  const counts: PlaceFacetCounts = { kinds: {}, activities: {} };
  for (const { place } of placePoints(collections)) {
    const kind = placeKind(place);
    if (kind !== null) counts.kinds[kind] = (counts.kinds[kind] ?? 0) + 1;
    for (const a of placeActivities(place)) {
      counts.activities[a] = (counts.activities[a] ?? 0) + 1;
    }
  }
  return counts;
}

/** "3 maps · 12 places in this area" — whichever halves are present. */
export function inAreaLabel(points: readonly { kind: ExplorePointKind }[]): string {
  let maps = 0;
  let places = 0;
  for (const point of points) {
    if (point.kind === 'place') places += 1;
    else maps += 1;
  }
  const n = (count: number, one: string, many: string) =>
    `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
  const parts = [
    ...(maps > 0 || places === 0 ? [n(maps, 'map', 'maps')] : []),
    ...(places > 0 ? [n(places, 'place', 'places')] : []),
  ];
  return `${parts.join(' · ')} in this area`;
}

/**
 * Why the map has nothing to draw for the checked activity — so the screen
 * says so instead of showing a blank map:
 *
 * - `searchable`: nothing loaded matches, but shards reaching into the view
 *   are still unloaded ("Search this area" may find some);
 * - `none`: nothing anywhere we know of (an activity whose maps are waiting on
 *   a publisher's permission).
 *
 * Null while loading, with no activity checked, or when there are points
 * (points merely off-screen are the list's "Move the map…" case).
 */
export type ExploreEmptyState = 'none' | 'searchable';

export function exploreEmptyState(input: {
  activity: CatalogActivity | null | undefined;
  pointCount: number;
  /** Shards reaching into the view are still unloaded. */
  searchable: boolean;
  loading: boolean;
}): ExploreEmptyState | null {
  if (input.activity == null || input.pointCount > 0 || input.loading) return null;
  return input.searchable ? 'searchable' : 'none';
}
