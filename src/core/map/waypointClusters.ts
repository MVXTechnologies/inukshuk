import { pinHitArea, type PinHit } from '@core/geo/pinHitTest';
import {
  WAYPOINT_PIN_DIAMETER,
  WAYPOINT_SIZES,
  pinGeometry,
  waypointFill,
  waypointInk,
  waypointRing,
  waypointSize,
} from '@core/library/waypointStyle';
import type { WaypointSize } from '@core/models';
import { countImageName } from '@core/photos/mapStyle';
import type {
  CircleLayerSpecification,
  FilterSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import type { Feature, FeatureCollection, Point } from 'geojson';

import {
  ALWAYS,
  BODY_OFFSET,
  DEFAULT_GLYPH_IMAGE,
  GLYPH_OFFSET,
  GLYPH_SPRITE_BOX,
  GLYPH_SPRITE_DENSITY,
  PHOTO_IMAGE,
  PHOTO_OFFSET,
  PHOTO_SPRITE_DENSITY,
  PIN_IMAGE,
  PIN_RING_WIDTH,
  PIN_SPRITE_BASE_D,
  PIN_SPRITE_DENSITY,
  glyphImageName,
  scaledSize,
  type PinInput,
} from './waypointPinStyle';

type SymbolLayout = NonNullable<SymbolLayerSpecification['layout']>;
type SymbolPaint = NonNullable<SymbolLayerSpecification['paint']>;
type CirclePaint = NonNullable<CircleLayerSpecification['paint']>;

/**
 * Waypoint pin clusters (#685): pins that would overlap become one round
 * mark with their count, natively — MapLibre clusters the GeoJSON source
 * (`cluster: true`) on its own thread, so panning and zooming run no JS.
 *
 * ## One feature per pin
 *
 * The clustered source holds ONE feature per waypoint, and its body and its
 * glyph are two layers reading that same feature. A pin's two halves can
 * therefore never fall into different clusters, and a cluster's
 * `point_count` is a count of waypoints. (Two features per pin, as the
 * unclustered source had, would make every lone pin a "cluster of 2".)
 *
 * ## Why the 2.5.1 overlap fix still holds
 *
 * 2.5.1 drew body and glyph in ONE layer, in source order (body₀, glyph₀,
 * body₁, …), so the glyph of a pin behind could never land on the pin in
 * front (`waypointPinStyle`). A clustered source cannot keep that order:
 * MapLibre builds its tiles from the cluster index, in index order, not
 * source order. So the guarantee moves to the cluster radius instead:
 *
 * - Two points that are NOT clustered at a zoom are more than the radius
 *   apart on screen at that zoom (the greedy clustering would have merged
 *   them otherwise), and further apart at any fractional zoom above it.
 * - {@link pinClusterRadius} is at least the farthest tip-to-tip offset at
 *   which one pin's glyph could touch another pin's body, ring included, for
 *   every pair of sizes on the map, at the Pin size setting — in EVERY
 *   direction, whichever pin is in front: across a tile edge MapLibre stacks
 *   whole tiles, so `viewport-y` is not a promise the guarantee may lean on.
 *
 * So pins left unclustered never have a glyph over another's body (proven by
 * `waypointClusters.test.ts`). Clusters exist up to the camera's cap
 * ({@link PIN_CLUSTER_MAX_ZOOM}), so the guarantee holds at every zoom the
 * map allows. On a pitched map the far side is foreshortened and the margin
 * shrinks there; that is the one place two pins can still overlap.
 *
 * ## Grouped only once they meet (#724)
 *
 * Supercluster merges by a CIRCLE; a pin is a teardrop, taller than wide.
 * Both distances are measured on the shapes drawn (`pinGeometry`: the round
 * head √½·d above the tip, the tangents down to it, the ring round both),
 * exactly, as hulls of discs. Tip to tip, at 100 %:
 *
 *            bodies touch   bodies touch   glyph can reach   radius   (2.6.0,
 *            side by side   stacked        a body (farthest)          boxes)
 *   S  / S       30             35.4           28.7              30      36
 *   M  / M       36             42.6           34.8              36      44
 *   L  / L       44             52.3           43.0              44      54
 *   XL / XL      54             64.4           53.3              54      66
 *
 * The radius is the closest touch (side by side), so two pins are grouped
 * only once their bodies meet; stacked ones overlap a little before they
 * are, drawn lower-on-screen in front (`viewport-y`). That is safe because
 * for one size the glyph's reach is always inside the touch (the table; it
 * holds up to d ≈ 77 px, past XL at 150 %), so the radius needs no padding
 * for it — save the integer's rounding: XL at 125 % touches at 66.5 and its
 * glyph needs 67. With a MIX of sizes it can need more: a big pin's icon
 * sits high on its head and reaches a small pin's tip from far below (S +
 * XL: touch 30, glyph 53.3), so a mixed map takes the glyph's 54 and its
 * small pins group a little before they meet — never past the old box
 * radius.
 *
 * The clusters MapLibre draws at zoom z + f are those of tile zoom z, so
 * between whole zooms pins up to 2^f × the radius apart can still show
 * grouped; at whole zooms they are grouped exactly as above.
 *
 * The selected pin and the pin being moved are never in this source: the
 * selected one draws on top in its own source (the one-layer, source-order
 * drawing of `waypointPinStyle`), the moving one in the move overlay.
 *
 * PURE: no React Native / Expo imports.
 */

/** The map's camera cap (MapScreen `maxZoom`): clusters still form there. */
export const PIN_CLUSTER_MAX_ZOOM = 18;

// ---------------------------------------------------------------- geometry

/** Half the glyph's em box, as a fraction of the pin's diameter (28 of 50 → 0.28). */
const GLYPH_HALF = GLYPH_SPRITE_BOX / PIN_SPRITE_BASE_D / 2;

/** A disc (x, y, radius), screen px, y down; a radius of 0 is a point. */
interface Disc {
  x: number;
  y: number;
  r: number;
}

/**
 * A pin's drawn body around its tip, ring included: the convex hull of its
 * head (√½·d above the tip, `pinGeometry`) and its tip, each widened by the
 * ring. (The teardrop IS that hull: the sides are the tangents from the tip.)
 */
function bodyDiscs(size: WaypointSize | undefined, scale: number): Disc[] {
  const d = WAYPOINT_PIN_DIAMETER[waypointSize(size)] * scale;
  return [
    { x: 0, y: -pinGeometry(d).headCenterY, r: d / 2 + PIN_RING_WIDTH },
    { x: 0, y: 0, r: PIN_RING_WIDTH },
  ];
}

/** A pin's glyph em box around its tip, centred on the head: its four corners. */
function glyphCorners(size: WaypointSize | undefined, scale: number): Disc[] {
  const d = WAYPOINT_PIN_DIAMETER[waypointSize(size)] * scale;
  const h = d * GLYPH_HALF;
  const cy = -pinGeometry(d).headCenterY;
  return [
    { x: -h, y: cy - h, r: 0 },
    { x: h, y: cy - h, r: 0 },
    { x: h, y: cy + h, r: 0 },
    { x: -h, y: cy + h, r: 0 },
  ];
}

/**
 * The tip offsets (B's tip from A's) at which B's shape meets A's: the hull
 * of every A disc minus every B disc (a Minkowski difference of two hulls of
 * discs is the hull of the pairwise differences), with the directions where
 * two of its discs share a tangent and the hull's reach along each.
 */
interface Hull {
  discs: Disc[];
  /** [nx, ny, reach]: reach = max(r + c·n), the hull's extent along n. */
  tangents: [number, number, number][];
  /** The farthest any point of it is from the origin: max(|c| + r). */
  far: number;
}

function reachAlong(discs: readonly Disc[], nx: number, ny: number): number {
  let reach = -Infinity;
  for (const c of discs) reach = Math.max(reach, c.r + c.x * nx + c.y * ny);
  return reach;
}

function meetingSet(a: readonly Disc[], b: readonly Disc[]): Hull {
  const discs = a.flatMap((p) => b.map((q) => ({ x: p.x - q.x, y: p.y - q.y, r: p.r + q.r })));
  const tangents: [number, number, number][] = [[1, 0, reachAlong(discs, 1, 0)]];
  for (let i = 0; i < discs.length; i++) {
    for (let j = i + 1; j < discs.length; j++) {
      const p = discs[i]!;
      const q = discs[j]!;
      const len = Math.hypot(p.x - q.x, p.y - q.y);
      if (len === 0) continue;
      const c = (q.r - p.r) / len;
      if (Math.abs(c) > 1) continue;
      const phi = Math.atan2(p.y - q.y, p.x - q.x);
      for (const t of [phi + Math.acos(c), phi - Math.acos(c)]) {
        const nx = Math.cos(t);
        const ny = Math.sin(t);
        tangents.push([nx, ny, reachAlong(discs, nx, ny)]);
      }
    }
  }
  let far = 0;
  for (const c of discs) far = Math.max(far, Math.hypot(c.x, c.y) + c.r);
  return { discs, tangents, far };
}

/**
 * How deep `v` sits inside the hull (> 0 inside, < 0 out): the least, over
 * every direction n, of the hull's reach along n past v — max(r + (c − v)·n).
 * That envelope of sinusoids bottoms out where one term is at its own
 * minimum (n pointing from that disc's centre at v) or two terms cross (a
 * shared tangent, the same for every v), so those are the only directions
 * to try: exact, no sampling.
 */
function hullDepth(hull: Hull, vx: number, vy: number): number {
  let depth = Infinity;
  for (const t of hull.tangents) depth = Math.min(depth, t[2] - vx * t[0] - vy * t[1]);
  for (const c of hull.discs) {
    const len = Math.hypot(vx - c.x, vy - c.y);
    // At v the term is the constant r: a flat stretch, met at its crossings.
    if (len === 0) continue;
    const nx = (vx - c.x) / len;
    const ny = (vy - c.y) / len;
    depth = Math.min(depth, reachAlong(hull.discs, nx, ny) - vx * nx - vy * ny);
  }
  return depth;
}

const glyphHulls = new Map<string, Hull>();

/** Where B's glyph meets A's body (memoised: 4 sizes² × the Pin size steps). */
function glyphHull(a: WaypointSize | undefined, b: WaypointSize | undefined, scale: number): Hull {
  const key = `${waypointSize(a)}|${waypointSize(b)}|${scale}`;
  let hull = glyphHulls.get(key);
  if (hull === undefined) {
    hull = meetingSet(bodyDiscs(a, scale), glyphCorners(b, scale));
    glyphHulls.set(key, hull);
  }
  return hull;
}

/**
 * Whether pin B's glyph, B's tip at (`dx`, `dy`) px from A's tip (y down),
 * covers any of pin A's drawn body, ring included: the defect 2.5.1 fixed
 * (an icon of one pin drawn on another).
 */
export function glyphReachesBody(
  dx: number,
  dy: number,
  sizeA: WaypointSize | undefined,
  sizeB: WaypointSize | undefined,
  scale = 1,
): boolean {
  const hull = glyphHull(sizeA, sizeB, scale);
  // Quick answers first (a plane sweep asks this a million times): past the
  // farthest disc is out, inside any disc is in.
  if (dx * dx + dy * dy >= hull.far * hull.far) return false;
  for (const c of hull.discs) {
    if ((dx - c.x) ** 2 + (dy - c.y) ** 2 < c.r * c.r) return true;
  }
  return hullDepth(hull, dx, dy) > 0;
}

/**
 * The farthest tip-to-tip distance at which B's glyph can still touch A's
 * body, px, in any direction: the meeting set's farthest point, which is on
 * the disc that reaches farthest (|centre| + radius).
 */
export function glyphClearancePx(
  sizeA: WaypointSize | undefined,
  sizeB: WaypointSize | undefined,
  scale = 1,
): number {
  return glyphHull(sizeA, sizeB, scale).far;
}

/**
 * The closest tip-to-tip distance at which two drawn bodies touch, px, over
 * every direction: side by side, heads ring to ring (d + 2 rings for one
 * size). The meeting set holds the origin, so its nearest edge is its depth
 * there.
 */
export function bodyTouchPx(
  sizeA: WaypointSize | undefined,
  sizeB: WaypointSize | undefined,
  scale = 1,
): number {
  return hullDepth(meetingSet(bodyDiscs(sizeA, scale), bodyDiscs(sizeB, scale)), 0, 0);
}

/**
 * The cluster radius (screen px, integer as MapLibre takes it) for pins of
 * these sizes at this Pin size (#724): the closest touch of two bodies — so
 * pins are grouped only once they meet — but never under the farthest
 * glyph clearance, so pins left apart never have an icon on another (see
 * the header). For one size the touch always wins, give or take the
 * integer's rounding; a mix of sizes can need more. Absent sizes are M.
 * Changes only when the setting changes or the sizes on the map do.
 */
export function pinClusterRadius(sizes: Iterable<WaypointSize | undefined>, scale = 1): number {
  const present = new Set<WaypointSize>();
  for (const s of sizes) present.add(waypointSize(s));
  if (present.size === 0) present.add('M');
  let touch = Infinity;
  let glyph = 0;
  for (const a of present) {
    for (const b of present) {
      touch = Math.min(touch, bodyTouchPx(a, b, scale));
      glyph = Math.max(glyph, glyphClearancePx(a, b, scale));
    }
  }
  // The float touch of 36 px can come out a hair under; never lose the pixel to it.
  return Math.max(Math.floor(touch + 1e-9), Math.ceil(glyph));
}

/** The largest radius any mix of sizes can need at `scale` (all four present). */
export function maxPinClusterRadius(scale = 1): number {
  return pinClusterRadius(WAYPOINT_SIZES, scale);
}

// ---------------------------------------------------------------- features

export interface ClusterPinProps {
  key: string;
  label: string;
  /** The glyph sprite. */
  img: string;
  /** Body fill and ring, glyph ink. */
  fill: string;
  ring: string;
  ink: string;
  /** `icon-size` of the body, the glyph and the photo badge at 100 %. */
  bsz: number;
  gsz: number;
  ps: number;
  photo: boolean;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The pins that may cluster, ONE feature each (see the header), in input
 * order. The selected pin (drawn on its own, on top) and the hidden one (the
 * move overlay draws it) are left out, as are unplottable coordinates.
 */
export function clusterPinCollection(
  pins: readonly PinInput[],
  selectedKey: string | null,
  hiddenKey: string | null = null,
): FeatureCollection<Point, ClusterPinProps> {
  const features: Feature<Point, ClusterPinProps>[] = [];
  for (const p of pins) {
    if (p.key === selectedKey || p.key === hiddenKey) continue;
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    const k = WAYPOINT_PIN_DIAMETER[waypointSize(p.size)] / PIN_SPRITE_BASE_D;
    features.push({
      type: 'Feature',
      id: p.key,
      geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
      properties: {
        key: p.key,
        label: p.label,
        img: glyphImageName(p.icon),
        fill: waypointFill(p.color),
        ring: waypointRing(p.color),
        ink: waypointInk(p.color),
        bsz: round3(k / PIN_SPRITE_DENSITY),
        gsz: round3(k / GLYPH_SPRITE_DENSITY),
        ps: round3(k / PHOTO_SPRITE_DENSITY),
        photo: p.hasPhoto === true,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** The selected pin, when it is drawn (not hidden, plottable), or null. */
export function selectedPin(
  pins: readonly PinInput[],
  selectedKey: string | null,
  hiddenKey: string | null = null,
): PinInput | null {
  if (selectedKey === null || selectedKey === hiddenKey) return null;
  return pins.find((p) => p.key === selectedKey) ?? null;
}

// ---------------------------------------------------------------- layers

export const IS_CLUSTER: FilterSpecification = ['has', 'point_count'];
export const NOT_CLUSTER: FilterSpecification = ['!', ['has', 'point_count']];
export const CLUSTERED_PHOTO_FILTER: FilterSpecification = [
  'all',
  NOT_CLUSTER,
  ['==', ['get', 'photo'], true],
];

/** An unclustered pin's body: tinted, ringed, its tip on the point; lower on screen in front. */
export function clusteredBodyLayout(scale: number): SymbolLayout {
  return {
    ...ALWAYS,
    'icon-image': PIN_IMAGE,
    'icon-size': scaledSize('bsz', scale),
    'icon-anchor': 'bottom',
    'icon-offset': BODY_OFFSET,
    'symbol-z-order': 'viewport-y',
  };
}

export const clusteredBodyPaint: SymbolPaint = {
  'icon-color': ['get', 'fill'],
  'icon-halo-color': ['get', 'ring'],
  'icon-halo-width': PIN_RING_WIDTH,
};

/** An unclustered pin's glyph, centred on its head (a layer above every body). */
export function clusteredGlyphLayout(scale: number): SymbolLayout {
  return {
    ...ALWAYS,
    'icon-image': ['get', 'img'],
    'icon-size': scaledSize('gsz', scale),
    'icon-anchor': 'center',
    'icon-offset': GLYPH_OFFSET,
    'symbol-z-order': 'viewport-y',
  };
}

export const clusteredGlyphPaint: SymbolPaint = { 'icon-color': ['get', 'ink'] };

export function clusteredPhotoLayout(scale: number): SymbolLayout {
  return {
    ...ALWAYS,
    'icon-image': PHOTO_IMAGE,
    'icon-size': scaledSize('ps', scale),
    'icon-anchor': 'center',
    'icon-offset': PHOTO_OFFSET,
    'symbol-z-order': 'viewport-y',
  };
}

/**
 * The cluster mark (mockup 252-pins): the photo stacks' idiom — a round mark
 * with the stone count pill at its top-right (the same bundled `ph-count-N`
 * images, which draw on the glyph-less raster and satellite styles too) —
 * in the default pin's colours with the inukshuk, so it reads as pins. Map
 * marks, not chrome: the same in light and dark, like the pins themselves.
 */
export const CLUSTER_DISC_RADIUS = 18;
const CLUSTER_GLYPH_EM = 20;
/** The count pill's centre from the disc's: up and right, dp at 100 %. */
const CLUSTER_BADGE_AT = 13;
/** The bundled badges are drawn at 3× in 1× files. */
const BADGE_PX_PER_DP = 3;

export function clusterDiscPaint(scale: number): CirclePaint {
  return {
    'circle-radius': round3(CLUSTER_DISC_RADIUS * scale),
    'circle-color': waypointFill(undefined),
    'circle-stroke-width': 2.5,
    'circle-stroke-color': waypointRing(undefined),
    'circle-pitch-alignment': 'viewport',
  };
}

export function clusterGlyphLayout(scale: number): SymbolLayout {
  return {
    ...ALWAYS,
    'icon-image': DEFAULT_GLYPH_IMAGE,
    // The glyph sprite's em box is GLYPH_SPRITE_BOX dp at GLYPH_SPRITE_DENSITY px per dp.
    'icon-size': round3((CLUSTER_GLYPH_EM / GLYPH_SPRITE_BOX / GLYPH_SPRITE_DENSITY) * scale),
    'icon-anchor': 'center',
  };
}

export const clusterGlyphPaint: SymbolPaint = { 'icon-color': waypointInk(undefined) };

export function clusterCountLayout(scale: number): SymbolLayout {
  const at = CLUSTER_BADGE_AT * BADGE_PX_PER_DP;
  return {
    ...ALWAYS,
    'icon-image': ['concat', 'ph-count-', ['to-string', ['min', ['get', 'point_count'], 100]]],
    'icon-size': round3(scale / BADGE_PX_PER_DP),
    'icon-anchor': 'center',
    // Image pixels × icon-size: the pill follows the disc's scale.
    'icon-offset': [at, -at],
  };
}

/** The badge image names a cluster count needs ({@link countImageName}). */
export const clusterCountImage = countImageName;

// ---------------------------------------------------------------- taps

/** A cluster under a tap: its id in the source, where it is, how many pins. */
export interface ClusterHit {
  id: number;
  lngLat: [number, number];
  count: number;
}

/** Read a rendered cluster feature, or null when it is not one. */
export function readClusterFeature(feature: unknown): ClusterHit | null {
  const f = feature as {
    properties?: Record<string, unknown> | null;
    geometry?: { type?: string; coordinates?: unknown } | null;
  } | null;
  const p = f?.properties ?? null;
  const id = p?.['cluster_id'];
  if (typeof id !== 'number') return null;
  const c = f?.geometry?.coordinates;
  if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
  const count = p?.['point_count'];
  return { id, lngLat: [c[0], c[1]], count: typeof count === 'number' ? count : 0 };
}

/** The pin key of a rendered pin feature (body or glyph, either source), or null. */
export function renderedPinKey(feature: unknown): string | null {
  const p = (feature as { properties?: Record<string, unknown> | null } | null)?.properties;
  const key = p?.['key'];
  return typeof key === 'string' && typeof p?.['cluster_id'] !== 'number' ? key : null;
}

/** The pin keys under a cluster, from its leaves, in the order MapLibre gives them. */
export function leafKeys(leaves: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const leaf of leaves) {
    const key = renderedPinKey(leaf);
    if (key !== null && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Finger slack round the cluster disc, px. */
export const CLUSTER_TAP_SLOP_PX = 8;

/** How far from a cluster's centre a tap still takes it (never under a 48 dp target). */
export function clusterHitRadiusPx(scale = 1): number {
  return Math.max(24, CLUSTER_DISC_RADIUS * scale + CLUSTER_TAP_SLOP_PX);
}

/**
 * The half-size of the box asked of MapLibre around a tap (rendered pins and
 * clusters): wide enough to hold every pin whose hit disc can contain the
 * tap — the largest size's disc, centred on its head above the tip — and
 * every cluster within reach.
 */
export function waypointQueryReachPx(scale = 1): number {
  const xl = pinHitArea('XL', 'tap', scale);
  return Math.ceil(Math.max(xl.radiusPx + xl.headOffsetPx, clusterHitRadiusPx(scale)));
}

export type WaypointTapRoute<P> =
  { kind: 'pin'; pin: P } | { kind: 'cluster'; cluster: ClusterHit } | { kind: 'none' };

/**
 * Who takes a tap among the waypoint marks: a pin hit dead on its head (pins
 * draw above clusters), else a cluster within reach (the nearest), else a
 * pin within the finger's slack.
 */
export function routeWaypointTap<P>(
  pin: PinHit<P> | null,
  clusters: readonly { cluster: ClusterHit; distancePx: number }[],
  scale = 1,
): WaypointTapRoute<P> {
  if (pin?.onHead) return { kind: 'pin', pin: pin.pin };
  const reach = clusterHitRadiusPx(scale);
  let best: { cluster: ClusterHit; distancePx: number } | null = null;
  for (const c of clusters) {
    if (c.distancePx <= reach && (best === null || c.distancePx < best.distancePx)) best = c;
  }
  if (best !== null) return { kind: 'cluster', cluster: best.cluster };
  if (pin !== null) return { kind: 'pin', pin: pin.pin };
  return { kind: 'none' };
}

export type ClusterTapAction = { kind: 'zoom'; zoom: number } | { kind: 'list' };

/**
 * A cluster tap: glide to where it splits; or, when it only splits past the
 * camera's cap (pins at one spot), the expansion is unknown, or zooming
 * would not split it (already at that zoom), list its pins.
 */
export function clusterTapAction(
  expansionZoom: number | null,
  currentZoom: number | null,
): ClusterTapAction {
  if (expansionZoom === null || !Number.isFinite(expansionZoom)) return { kind: 'list' };
  if (expansionZoom > PIN_CLUSTER_MAX_ZOOM) return { kind: 'list' };
  if (currentZoom !== null && Number.isFinite(currentZoom) && expansionZoom <= currentZoom + 0.01) {
    return { kind: 'list' };
  }
  // A hair past the split, so the camera's float landing never rounds back below it.
  return { kind: 'zoom', zoom: Math.min(PIN_CLUSTER_MAX_ZOOM, expansionZoom + 0.05) };
}
