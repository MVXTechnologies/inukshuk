import type {
  ExpressionSpecification,
  FilterSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-gl-style-spec';

import { isNotePhoto, type TrackPhoto } from './model';
import { orderPhotos, visiblePhotos } from './stack';

type SymbolLayout = NonNullable<SymbolLayerSpecification['layout']>;

/**
 * Trail photos on a MapLibre map (#587): the clustered source's options, the
 * layers' layout, the sprite image names and their LRU, and what a tap on
 * the photo source means. Pure, so every expression is checked against the
 * style spec (`validateStyleMin` in the test): MapLibre iOS kills the app on
 * expressions Android shrugs off, e.g. a `["zoom"]` anywhere but the input of
 * a top-level interpolate/step.
 *
 * - One clustered GeoJSON source per map instance; every feature carries its
 *   rank in time as `order`, and a cluster's `order` is the `min` of its
 *   members (`PHOTO_CLUSTER_PROPERTIES`), so ONE `icon-image` expression
 *   names the sprite for a photo and for a stack's cover (owner Q11).
 * - Sprite names carry a short hash of the drawn photo set: when the set
 *   changes, ranks shift, and a new name can never show an old image.
 * - Count badges are bundled images (`ph-count-<n>`, 100 = "99+"): the
 *   raster and satellite styles declare no glyphs, so `text-field` would
 *   vanish there.
 * - No `symbol-sort-key` (one draw per distinct key per frame).
 */

/** Pixels per point of the round sprites (264 px = 44 pt). */
export const SPRITE_PIXEL_RATIO = 6;
/** The older 132 px sprites (`.map.png`, team `-s.png`), still on disk. */
export const LEGACY_SPRITE_PIXEL_RATIO = 3;

/** A sprite file's pixels per point: 2× files are named `…map2.png` / `…-s2.png`. */
export function spritePixelRatio(path: string): number {
  return /(?:\.map2|-s2)\.png$/.test(path) ? SPRITE_PIXEL_RATIO : LEGACY_SPRITE_PIXEL_RATIO;
}
/** The bundled badges and ring are drawn at 3× in 1× files: shown at a third. */
const BUNDLED_3X = 1 / 3;

export const PHOTO_CLUSTER_RADIUS = 34;
export const PHOTO_CLUSTER_MAX_ZOOM = 18;
/**
 * A stack that only splits past this zoom is photos a few metres apart (the
 * summit's 16): a tap opens the first in the photo card instead of zooming in.
 */
export const PHOTO_LEAVES_ZOOM = 18;

/** Most sprites registered with the map at once (~70 KB of texture each). */
export const MAX_SPRITES = 150;

/**
 * Circle size by zoom (owner 2026-10-07: "when I zoom in close to a photo it
 * should get larger"): smaller over a whole trail, clearly larger at street
 * zoom. Always a top-level `interpolate` on `["zoom"]` (nested in a match or
 * case it crashes MapLibre iOS). The 264 px sprites stay sharp up to 2× on
 * a 3× screen, so 2× is the ceiling.
 */
export const PHOTO_SIZE_STOPS: readonly (readonly [number, number])[] = [
  [12, 0.8],
  [15, 0.95],
  [17, 1.4],
  [18.5, 2],
];
const SIZE_STOPS = PHOTO_SIZE_STOPS;

/**
 * The photo circles' scale at `zoom` (the same stops, linear between them):
 * for what must follow them but can't take a zoom expression, like a badge's
 * `circle-translate` (MapLibre iOS's RN bridge crashes on an expression there).
 */
export function photoScaleAt(zoom: number): number {
  const first = PHOTO_SIZE_STOPS[0]!;
  const last = PHOTO_SIZE_STOPS[PHOTO_SIZE_STOPS.length - 1]!;
  if (zoom <= first[0]) return first[1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < PHOTO_SIZE_STOPS.length; i++) {
    const [z1, s1] = PHOTO_SIZE_STOPS[i]!;
    const [z0, s0] = PHOTO_SIZE_STOPS[i - 1]!;
    if (zoom <= z1) return s0 + ((s1 - s0) * (zoom - z0)) / (z1 - z0);
  }
  return last[1];
}

function sizeBy(scale: number): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], ...SIZE_STOPS.flatMap(([z, s]) => [z, s * scale])];
}

/** The photos a map draws: visible ones, in time order, never note photos. */
export function mapPhotos(photos: readonly TrackPhoto[]): TrackPhoto[] {
  // A note photo is the user's own full-size file, not a round sprite, and
  // its note already has a numbered pin on the map; the strip and the viewer
  // still show it.
  return orderPhotos(visiblePhotos(photos)).filter((p) => !isNotePhoto(p));
}

/** A short, stable hash of the drawn set (ids in order): part of every sprite name. */
export function photoSetKey(photos: readonly Pick<TrackPhoto, 'id'>[]): string {
  let h = 0x811c9dc5;
  for (const p of photos) {
    for (let i = 0; i < p.id.length; i++) {
      h ^= p.id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2c; // separator
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Sprite name prefix for one map instance and photo set. */
export function spritePrefix(instanceId: string, setKey: string): string {
  return `ph-${instanceId}-${setKey}-`;
}

/** The sprite name of the photo at rank `order`. */
export function spriteName(prefix: string, order: number): string {
  return `${prefix}${order}`;
}

/** The rank a sprite name asks for, or null when it is not one of this prefix's. */
export function orderOfSprite(prefix: string, name: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/** The bundled badge for a stack of `n` (2 … 100, where 100 reads "99+"). */
export function countImageName(n: number): string {
  return `ph-count-${Math.max(2, Math.min(100, Math.floor(n)))}`;
}

export const SELECTED_RING_IMAGE = 'ph-selected-ring';

/** The selected photo's sprite scale over a regular circle's (54 pt vs 44 pt). */
const SELECTED_SCALE = 54 / 44;

/** Layout of the circles (photos and stack covers). */
export function spriteLayout(prefix: string): SymbolLayout {
  return {
    'icon-image': ['concat', prefix, ['to-string', ['get', 'order']]],
    'icon-size': sizeBy(1),
    // Clustering already keeps circles apart.
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
}

/** Filter for stacks (clusters). */
export const CLUSTER_FILTER: FilterSpecification = ['has', 'point_count'];

/** Layout of the count badge at a stack's top-right. */
export function countLayout(): SymbolLayout {
  return {
    'icon-image': ['concat', 'ph-count-', ['to-string', ['min', ['get', 'point_count'], 100]]],
    'icon-size': sizeBy(BUNDLED_3X),
    // Image pixels × icon-size: 16 pt right and up from the circle's centre.
    'icon-offset': [48, -48],
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
}

/** Layout of the selected photo's sage disc (drawn behind it, so it reads as a ring). */
export function selectedRingLayout(): SymbolLayout {
  return {
    'icon-image': SELECTED_RING_IMAGE,
    'icon-size': sizeBy(BUNDLED_3X),
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
}

/** Layout of the selected photo itself: its own sprite, larger. */
export function selectedSpriteLayout(prefix: string): SymbolLayout {
  return {
    'icon-image': ['concat', prefix, ['to-string', ['get', 'order']]],
    'icon-size': sizeBy(SELECTED_SCALE),
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
  };
}

/**
 * The sprite LRU after the map asked for `names` (most recent last), capped
 * at `max`. A name dropped while still on screen is simply asked for again;
 * with clustering a view holds far fewer than `max` circles.
 */
export function touchSprites(
  lru: readonly string[],
  names: readonly string[],
  max = MAX_SPRITES,
): string[] {
  const asked = new Set(names);
  const next = [...lru.filter((n) => !asked.has(n)), ...asked];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** The sprites to register before the map asks: the first `max` ranks. */
export function initialSprites(prefix: string, count: number, max = MAX_SPRITES): string[] {
  return Array.from({ length: Math.min(count, max) }, (_, i) => spriteName(prefix, i));
}

/** What a press on the photo source hit. */
export type PhotoPress =
  { kind: 'photo'; id: string } | { kind: 'stack'; clusterId: number; lngLat: [number, number] };

/** Read the first feature of a press on the photo source. */
export function readPhotoPress(feature: {
  properties?: Record<string, unknown> | null;
  geometry?: { type: string; coordinates?: unknown } | null;
}): PhotoPress | null {
  const props = feature.properties ?? null;
  if (!props) return null;
  if (props['cluster'] === true || typeof props['cluster_id'] === 'number') {
    const clusterId = props['cluster_id'];
    const coords = feature.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
    if (typeof clusterId !== 'number' || !Array.isArray(coords)) return null;
    const [lng, lat] = coords as unknown[];
    if (typeof lng !== 'number' || typeof lat !== 'number') return null;
    return { kind: 'stack', clusterId, lngLat: [lng, lat] };
  }
  return typeof props['id'] === 'string' ? { kind: 'photo', id: props['id'] } : null;
}

/**
 * A stack tap: zoom to where it splits, or — when it only splits past
 * {@link PHOTO_LEAVES_ZOOM}, or the zoom is unknown — open its photos.
 */
export function stackTapAction(
  expansionZoom: number | null,
  currentZoom: number,
): { kind: 'zoom'; zoom: number } | { kind: 'open' } {
  if (expansionZoom === null || !Number.isFinite(expansionZoom)) return { kind: 'open' };
  if (expansionZoom > PHOTO_LEAVES_ZOOM) return { kind: 'open' };
  return {
    kind: 'zoom',
    zoom: Math.min(PHOTO_LEAVES_ZOOM, Math.max(expansionZoom, currentZoom + 1)),
  };
}

/** How long the main map's own press handler may still claim a photo tap (ms). */
export const PHOTO_TAP_FRESH_MS = 1000;

/**
 * The main map's photo chip (mockups 1–2), legend and switch in one: one
 * trail reads "<name> · 33 photos"; several, "45 photos on 3 trails".
 * Null when nothing is drawn.
 */
export function mainMapPhotoChipLabel(
  trails: readonly { name: string; count: number }[],
): string | null {
  const withPhotos = trails.filter((t) => t.count > 0);
  const total = withPhotos.reduce((n, t) => n + t.count, 0);
  if (total === 0) return null;
  const photos = total === 1 ? '1 photo' : `${total} photos`;
  if (withPhotos.length === 1) return `${withPhotos[0]!.name} · ${photos}`;
  return `${photos} on ${withPhotos.length} trails`;
}

/** A stack's photo ids in time order, from its leaves' properties. */
export function leafIds(
  leaves: readonly { properties?: Record<string, unknown> | null }[],
): string[] {
  return leaves
    .map((f) => f.properties ?? {})
    .filter(
      (p): p is { id: string; order: number } & Record<string, unknown> =>
        typeof p['id'] === 'string' && typeof p['order'] === 'number',
    )
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id);
}
