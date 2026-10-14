import { formatDistance, type Units } from '@core/format';

import { bearingDeg, haversineM, lengthM, unwrapLng, type Pt } from './geo';
import type { PenStyle, Stroke } from './pen';
import type { ShapeKind } from './record';

/**
 * Drawing on the map's screen (#683): the drawer's finger works in screen dp,
 * the shapes live in `[lng, lat]`. While drawing mode is open this phone
 * knows the camera exactly (it reads it on entry and moves it itself), so the
 * projection is done here, in pure code, never one async native call per
 * touch: Web Mercator with MapLibre's 512-dp tiles, rotated by the bearing,
 * pitch 0 (drawing mode flattens the map).
 *
 * Also the two-finger camera (pinch, rotate and pan together, around the
 * point under the fingers), what a finished gesture becomes, and the live
 * readout chip.
 */
export const TILE_DP = 512;
/** A stroke shorter than this on screen is an accidental touch: dropped. */
export const MIN_STROKE_DP = 12;
export const MIN_ZOOM = 0;
/** The main map's camera cap (MapScreen's `<Camera maxZoom>`). */
export const MAX_ZOOM = 18;
export const MAX_LAT = 85.051129;

const DEG = Math.PI / 180;

export type ScreenPt = [number, number];

export interface Camera {
  center: Pt;
  zoom: number;
  /** Degrees clockwise from north, the map's heading at the top of the screen. */
  bearing: number;
}

/** A camera on a view of `width` × `height` dp. */
export interface Viewport extends Camera {
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const norm360 = (d: number) => ((d % 360) + 360) % 360;

/** World pixel (dp) of a point at `zoom`; longitudes are taken as given (no wrap). */
export function toWorld(p: Pt, zoom: number): [number, number] {
  const size = TILE_DP * 2 ** zoom;
  const lat = clamp(p[1], -MAX_LAT, MAX_LAT) * DEG;
  return [
    ((p[0] + 180) / 360) * size,
    ((1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2) * size,
  ];
}

/** The point at world pixel `w` at `zoom`, its longitude wrapped into [-180, 180). */
export function fromWorld(w: readonly [number, number], zoom: number): Pt {
  const size = TILE_DP * 2 ** zoom;
  const lng = (w[0] / size) * 360 - 180;
  const n = Math.PI * (1 - (2 * w[1]) / size);
  const lat = Math.atan(Math.sinh(n)) / DEG;
  return [norm360(lng + 180) - 180, clamp(lat, -MAX_LAT, MAX_LAT)];
}

/** Where `p` is on the screen. */
export function project(p: Pt, v: Viewport): ScreenPt {
  const [cx, cy] = toWorld(v.center, v.zoom);
  const [x, y] = toWorld([unwrapLng(p[0], v.center[0]), p[1]], v.zoom);
  const dx = x - cx;
  const dy = y - cy;
  const b = v.bearing * DEG;
  const c = Math.cos(b);
  const s = Math.sin(b);
  return [v.width / 2 + dx * c + dy * s, v.height / 2 - dx * s + dy * c];
}

/** The map offset (world dp) under a screen offset from the centre, at `bearing`. */
function worldOffset(sx: number, sy: number, bearing: number): [number, number] {
  const b = bearing * DEG;
  const c = Math.cos(b);
  const s = Math.sin(b);
  return [sx * c - sy * s, sx * s + sy * c];
}

/** The point under screen position `s`. */
export function unproject(s: ScreenPt, v: Viewport): Pt {
  const [cx, cy] = toWorld(v.center, v.zoom);
  const [ox, oy] = worldOffset(s[0] - v.width / 2, s[1] - v.height / 2, v.bearing);
  return fromWorld([cx + ox, cy + oy], v.zoom);
}

// ── Two fingers ──────────────────────────────────────────────────────────────

/** A two-finger gesture's start: the fingers, the camera, and the point under their middle. */
export interface Pinch {
  a: ScreenPt;
  b: ScreenPt;
  view: Viewport;
  anchor: Pt;
}

const mid = (a: ScreenPt, b: ScreenPt): ScreenPt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const span = (a: ScreenPt, b: ScreenPt) => Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
const angle = (a: ScreenPt, b: ScreenPt) => Math.atan2(b[1] - a[1], b[0] - a[0]);

export function startPinch(a: ScreenPt, b: ScreenPt, view: Viewport): Pinch {
  return { a, b, view, anchor: unproject(mid(a, b), view) };
}

/**
 * The camera for the fingers now at `a` and `b`: zoomed by their spread,
 * turned by their rotation, and moved so the point that was under their
 * middle stays under it (pinch, rotate and pan in one).
 */
export function pinchCamera(p: Pinch, a: ScreenPt, b: ScreenPt): Camera {
  const zoom = clamp(p.view.zoom + Math.log2(span(a, b) / span(p.a, p.b)), MIN_ZOOM, MAX_ZOOM);
  const turned = (angle(a, b) - angle(p.a, p.b)) / DEG;
  const bearing = norm360(p.view.bearing - turned);
  const m = mid(a, b);
  const [ax, ay] = toWorld(p.anchor, zoom);
  const [ox, oy] = worldOffset(m[0] - p.view.width / 2, m[1] - p.view.height / 2, bearing);
  return { center: fromWorld([ax - ox, ay - oy], zoom), zoom, bearing };
}

// ── What a gesture becomes ───────────────────────────────────────────────────

const dist = (a: ScreenPt, b: ScreenPt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** How long a gesture is on screen: the path for the pencil, first → last for the others. */
export function gestureLengthDp(tool: ShapeKind, pts: readonly ScreenPt[]): number {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (tool !== 'free') return dist(first, last);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1]!, pts[i]!);
  return total;
}

/**
 * The stroke a gesture draws, in map coordinates: the pencil's path; an
 * arrow from the first touch to the finger; a circle centred on the first
 * touch through the finger; a rectangle with those two opposite corners,
 * square to the SCREEN (so it keeps the map's rotation). Null for a gesture
 * shorter than `minDp`.
 */
export function buildStroke(
  tool: ShapeKind,
  pts: readonly ScreenPt[],
  view: Viewport,
  id: string,
  style: PenStyle,
  minDp = MIN_STROKE_DP,
): Stroke | null {
  if (pts.length < 2 || gestureLengthDp(tool, pts) < minDp) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const at = (s: ScreenPt) => unproject(s, view);
  const base = { id, sh: tool, style };
  switch (tool) {
    case 'free':
      return { ...base, pts: pts.map(at) };
    case 'arrow':
      return { ...base, pts: [at(first), at(last)] };
    case 'circle': {
      const c = at(first);
      return { ...base, pts: [c], r: haversineM(c, at(last)) };
    }
    case 'rect':
      return {
        ...base,
        pts: [first, [last[0], first[1]], last, [first[0], last[1]]].map((s) => at(s as ScreenPt)),
      };
  }
}

// ── The live readout chip ────────────────────────────────────────────────────

const POINTS16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

/** 16-point compass name of a bearing ("334°" → "NNW"). */
export function cardinal16(deg: number): string {
  return POINTS16[Math.round(norm360(deg) / 22.5) % 16]!;
}

export const TOOL_NAMES: Readonly<Record<ShapeKind, string>> = {
  free: 'Pencil',
  arrow: 'Arrow',
  circle: 'Circle',
  rect: 'Rectangle',
};

/**
 * The chip over the map while drawing: the pencil's length on the ground,
 * an arrow's distance and bearing, a circle's radius, a rectangle's sides.
 */
export function chipText(s: Stroke, units: Units): string {
  const d = (m: number) => formatDistance(m, units);
  const p = s.pts;
  switch (s.sh) {
    case 'free':
      return `Pencil · ${d(lengthM(p))}`;
    case 'arrow': {
      const brg = bearingDeg(p[0]!, p[1]!);
      return `${d(haversineM(p[0]!, p[1]!))} · ${Math.round(brg) % 360}° ${cardinal16(brg)}`;
    }
    case 'circle':
      return `Circle · ${d(s.r ?? 0)} radius`;
    case 'rect':
      return `Rectangle · ${d(haversineM(p[0]!, p[1]!))} × ${d(haversineM(p[1]!, p[2]!))}`;
  }
}

// ── Framing ──────────────────────────────────────────────────────────────────

/**
 * The camera that shows every point (circles with their radius, `pad` dp
 * all round) on a `width` × `height` view, north up, zoom in [3, 17].
 * Null for no points.
 */
export function frameCamera(
  parts: readonly { pts: readonly Pt[]; r?: number }[],
  width: number,
  height: number,
  pad = 64,
): Camera | null {
  const all: Pt[] = [];
  for (const part of parts) {
    for (const p of part.pts) {
      if (part.r === undefined) {
        all.push(p);
        continue;
      }
      const dLat = part.r / 111_320;
      const dLng = dLat / Math.max(0.01, Math.cos(p[1] * DEG));
      all.push([p[0] - dLng, p[1] - dLat], [p[0] + dLng, p[1] + dLat]);
    }
  }
  const ref = all[0];
  if (ref === undefined) return null;
  const world = all.map((p) => toWorld([unwrapLng(p[0], ref[0]), p[1]], 0));
  const xs = world.map((w) => w[0]);
  const ys = world.map((w) => w[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const fit = Math.min(
    Math.max(1, width - 2 * pad) / Math.max(1e-9, x1 - x0),
    Math.max(1, height - 2 * pad) / Math.max(1e-9, y1 - y0),
  );
  const zoom = clamp(Math.log2(fit), 3, 17);
  return { center: fromWorld([(x0 + x1) / 2, (y0 + y1) / 2], 0), zoom, bearing: 0 };
}
