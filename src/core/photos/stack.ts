import type { FeatureCollection, Point } from 'geojson';

import type { TrackPhoto } from './model';

/**
 * Stack ordering and grouping (#587). A stack — a map cluster, or colliding
 * circles on the profile lane — is represented by its FIRST photo in time
 * (owner Q11). The map clusters natively (MapLibre's supercluster) and picks
 * the cover with a `['min', ['get', 'order']]` cluster property, so every
 * photo carries its rank in time as `order`; the profile lane groups here.
 */

type Orderable = Pick<TrackPhoto, 'id' | 'takenAt' | 'distanceM'>;

/**
 * Photos in time order. A photo without a time sorts by where it is on the
 * trail among the timeless ones, after all the timed ones; ids break ties so
 * the order is total and stable across devices.
 */
export function comparePhotos(a: Orderable, b: Orderable): number {
  const ta = a.takenAt ?? Infinity;
  const tb = b.takenAt ?? Infinity;
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function orderPhotos<T extends Orderable>(photos: readonly T[]): T[] {
  return [...photos].sort(comparePhotos);
}

/** The cover of a stack: its first photo in time. */
export function stackCover<T extends Orderable>(photos: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const p of photos) if (!best || comparePhotos(p, best) < 0) best = p;
  return best;
}

/** Photos the map and the viewer show: not tombstoned, not hidden. */
export function visiblePhotos<T extends Pick<TrackPhoto, 'deletedAt' | 'hidden'>>(
  photos: readonly T[],
): T[] {
  return photos.filter((p) => p.deletedAt === undefined && p.hidden !== true);
}

/** GeoJSON for the clustered photo source: one point per visible photo. */
export interface PhotoFeatureProps {
  id: string;
  /** Rank in time (0 = first): the cluster cover is the `min`. */
  order: number;
}

export function photoFeatureCollection(
  photos: readonly TrackPhoto[],
): FeatureCollection<Point, PhotoFeatureProps> {
  const ordered = orderPhotos(visiblePhotos(photos));
  return {
    type: 'FeatureCollection',
    features: ordered.map((p, order) => ({
      type: 'Feature',
      id: order,
      geometry: { type: 'Point', coordinates: [p.lngLat[0], p.lngLat[1]] },
      properties: { id: p.id, order },
    })),
  };
}

/** The clustered source's `clusterProperties`: the cover is the earliest photo. */
export const PHOTO_CLUSTER_PROPERTIES = { order: ['min', ['get', 'order']] } as const;

/** One circle (or stack) on the elevation profile's photo lane. */
export interface LaneGroup<T extends Orderable> {
  /** Where to draw the circle: the middle of its members' x positions (px). */
  x: number;
  /** Members in time order; `members[0]` is the cover. */
  members: T[];
  cover: T;
}

/**
 * Group photos whose lane positions collide. Left to right, a photo joins the
 * current group while it is less than `minGapPx` from the group's FIRST x, so a
 * long run of close photos breaks into several stacks rather than one smear.
 */
export function groupLane<T extends Orderable>(
  items: readonly { photo: T; x: number }[],
  minGapPx: number,
): LaneGroup<T>[] {
  const sorted = [...items].sort((a, b) => a.x - b.x || comparePhotos(a.photo, b.photo));
  const raw: { x0: number; xs: number[]; photos: T[] }[] = [];
  for (const { photo, x } of sorted) {
    const current = raw[raw.length - 1];
    if (current && x - current.x0 < minGapPx) {
      current.xs.push(x);
      current.photos.push(photo);
    } else {
      raw.push({ x0: x, xs: [x], photos: [photo] });
    }
  }
  return raw.map(({ xs, photos }) => {
    const members = orderPhotos(photos);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      members,
      cover: members[0]!,
    };
  });
}

/**
 * The lane group the profile cursor snaps to: the nearest within `snapPx`, or
 * undefined. Dragging past a photo "catches" it so the map can highlight it.
 */
export function snapToLane<T extends Orderable>(
  groups: readonly LaneGroup<T>[],
  cursorX: number,
  snapPx = 12,
): LaneGroup<T> | undefined {
  let best: LaneGroup<T> | undefined;
  let bestD = Infinity;
  for (const g of groups) {
    const d = Math.abs(g.x - cursorX);
    // Strictly closer replaces: on a tie the left (earlier) group keeps it.
    if (d <= snapPx && d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}
