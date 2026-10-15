import { nearestPinHitAt, pinHitArea } from '@core/geo/pinHitTest';
import { WAYPOINT_PIN_DIAMETER, WAYPOINT_SIZES, pinGeometry } from '@core/library/waypointStyle';
import type { WaypointSize } from '@core/models';
import { PIN_SCALES, pinScaleFactor } from '@core/map/pinScale';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

import {
  CLUSTERED_PHOTO_FILTER,
  IS_CLUSTER,
  NOT_CLUSTER,
  PIN_CLUSTER_MAX_ZOOM,
  clusterCountLayout,
  clusterDiscPaint,
  clusterGlyphLayout,
  clusterHitRadiusPx,
  clusterPinCollection,
  clusterTapAction,
  clusteredBodyLayout,
  clusteredBodyPaint,
  clusteredGlyphLayout,
  clusteredGlyphPaint,
  bodyTouchPx,
  clusteredPhotoLayout,
  glyphClearancePx,
  glyphReachesBody,
  leafKeys,
  maxPinClusterRadius,
  pinClusterRadius,
  readClusterFeature,
  renderedPinKey,
  routeWaypointTap,
  selectedPin,
  waypointQueryReachPx,
} from './waypointClusters';
import {
  GLYPH_SPRITE_BOX,
  PIN_RING_WIDTH,
  PIN_SPRITE_BASE_D,
  pinLabelLayout,
  type PinInput,
} from './waypointPinStyle';

const pin = (over: Partial<PinInput> = {}): PinInput => ({
  key: 'saved-a',
  latitude: 46.8,
  longitude: -71.2,
  label: 'A',
  ...over,
});

const SCALES = PIN_SCALES.map(pinScaleFactor);

describe('the clustered source: one feature per waypoint (#685)', () => {
  it('emits exactly one feature per pin, keyed by the pin', () => {
    const pins = Array.from({ length: 50 }, (_, i) =>
      pin({ key: `saved-${i}`, icon: 'camp', size: WAYPOINT_SIZES[i % 4], hasPhoto: i % 2 === 0 }),
    );
    const fc = clusterPinCollection(pins, null);
    expect(fc.features).toHaveLength(50);
    expect(new Set(fc.features.map((f) => f.properties.key)).size).toBe(50);
    expect(fc.features.map((f) => f.id)).toEqual(pins.map((p) => p.key));
  });

  it('carries the body AND the glyph of a pin on that one feature (they can never cluster apart)', () => {
    const fc = clusterPinCollection(
      [pin({ icon: 'camp', color: '#FBC02D', size: 'L', hasPhoto: true })],
      null,
    );
    expect(fc.features[0]?.properties).toEqual({
      key: 'saved-a',
      label: 'A',
      img: 'wpg-camp',
      fill: '#FBC02D',
      ring: '#FBF8F2',
      ink: expect.any(String),
      bsz: 0.8, // 40 / 50 at 1 px per dp
      gsz: 0.4, // at 2 px per dp
      ps: 0.267, // at 3 px per dp
      photo: true,
    });
    // Body and glyph layers read the same feature: the body its sprite and fill,
    // the glyph its own sprite and ink.
    expect(clusteredBodyLayout(1)['icon-image']).toBe('wp-pin');
    expect(clusteredBodyPaint['icon-color']).toEqual(['get', 'fill']);
    expect(clusteredGlyphLayout(1)['icon-image']).toEqual(['get', 'img']);
    expect(clusteredGlyphPaint['icon-color']).toEqual(['get', 'ink']);
  });

  it('leaves out the selected pin (drawn on its own, on top) and the moving one', () => {
    const pins = [
      pin({ key: 'a' }),
      pin({ key: 'b' }),
      pin({ key: 'c' }),
      pin({ key: 'bad', latitude: NaN }),
    ];
    const fc = clusterPinCollection(pins, 'b', 'c');
    expect(fc.features.map((f) => f.properties.key)).toEqual(['a']);
    expect(selectedPin(pins, 'b', 'c')?.key).toBe('b');
    expect(selectedPin(pins, 'c', 'c')).toBeNull();
    expect(selectedPin(pins, null)).toBeNull();
    expect(selectedPin(pins, 'gone')).toBeNull();
  });
});

/**
 * The 2.5.1 overlap fix, carried over (see the module header): pins left
 * unclustered are farther apart than the cluster radius, and at that
 * distance no pin's glyph can reach another pin's body — for every pair of
 * sizes, at every Pin size step.
 */
describe('unclustered pins never have a glyph over another pin', () => {
  it('a glyph reaches a body only closer than the radius, for every size pair and scale', () => {
    for (const scale of SCALES) {
      for (const a of WAYPOINT_SIZES) {
        for (const b of WAYPOINT_SIZES) {
          const r = pinClusterRadius([a, b], scale);
          // Sample the plane out to twice the radius, 1 px apart.
          for (let dx = -2 * r; dx <= 2 * r; dx += 1) {
            for (let dy = -2 * r; dy <= 2 * r; dy += 1) {
              if (Math.hypot(dx, dy) <= r) continue;
              if (glyphReachesBody(dx, dy, a, b, scale)) {
                throw new Error(`${a}/${b} at ${scale}: glyph reaches at (${dx}, ${dy}), r ${r}`);
              }
            }
          }
        }
      }
    }
  });

  it('is tight: just inside the clearance, the glyph does reach (the radius is not padded)', () => {
    for (const scale of SCALES) {
      for (const size of WAYPOINT_SIZES) {
        const c = glyphClearancePx(size, size, scale);
        // The band round the clearance, finely: nearer in, the sweep above.
        let farthest = 0;
        for (let deg = 0; deg < 360; deg += 1) {
          for (let dist = c - 1; dist <= c + 1; dist += 0.1) {
            const t = (deg * Math.PI) / 180;
            if (glyphReachesBody(Math.cos(t) * dist, Math.sin(t) * dist, size, size, scale)) {
              farthest = Math.max(farthest, dist);
            }
          }
        }
        expect(farthest).toBeLessThanOrEqual(c);
        expect(farthest).toBeGreaterThan(c - 0.5);
      }
    }
  });

  /**
   * End to end with the clustering rule MapLibre uses (supercluster, one
   * zoom level): each point not yet taken gathers every untaken point within
   * the radius; with two or more it is a cluster, else it stays a pin.
   */
  it('a greedy clustering at that radius leaves no overlapping pair (random fields)', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 40; round++) {
      const scale = SCALES[round % SCALES.length]!;
      const pts = Array.from({ length: 60 }, () => ({
        x: rnd() * 400,
        y: rnd() * 800,
        size: WAYPOINT_SIZES[Math.floor(rnd() * 4)] as WaypointSize,
      }));
      const r = pinClusterRadius(
        pts.map((p) => p.size),
        scale,
      );
      const taken = new Array<boolean>(pts.length).fill(false);
      const lone: typeof pts = [];
      pts.forEach((p, i) => {
        if (taken[i]) return;
        taken[i] = true;
        const near = pts
          .map((q, j) => ({ q, j }))
          .filter(({ q, j }) => !taken[j] && Math.hypot(q.x - p.x, q.y - p.y) <= r);
        if (near.length === 0) lone.push(p);
        for (const { j } of near) taken[j] = true;
      });
      for (const a of lone) {
        for (const b of lone) {
          if (a === b) continue;
          expect(glyphReachesBody(b.x - a.x, b.y - a.y, a.size, b.size, scale)).toBe(false);
        }
      }
    }
  });

  it('grows with the pin sizes on the map and with the Pin size setting', () => {
    // #724: the drawn teardrops, not their boxes. The box-corner bound gave
    // 44 (M) and 66 (XL): pins with a clear gap between them were grouped.
    expect(pinClusterRadius(['M'])).toBe(36);
    expect(pinClusterRadius([undefined])).toBe(36);
    expect(pinClusterRadius([])).toBe(36);
    expect(pinClusterRadius(['XL'])).toBe(54);
    expect(pinClusterRadius(['S', 'XL'])).toBeGreaterThanOrEqual(pinClusterRadius(['XL']));
    expect(maxPinClusterRadius()).toBe(pinClusterRadius(WAYPOINT_SIZES));
    const bySetting = SCALES.map((k) => pinClusterRadius(['M'], k));
    expect(bySetting).toEqual([...bySetting].sort((a, b) => a - b));
    expect(new Set(bySetting).size).toBe(4);
  });
});

/**
 * The drawn pins, rebuilt here independently of the module (#724): a body
 * is its round head plus the triangle from the tip to the head's tangent
 * points (`pinGeometry`: the head's centre √½·d above the tip), widened by
 * the ring; a glyph is its em box on the head's centre. Every distance is
 * exact (disc/triangle/box pieces), so a sweep is a proof up to its step.
 */
type Pt = [number, number];
interface Drop {
  c: Pt;
  r: number;
  tri: Pt[];
}

function drop(size: WaypointSize, scale: number, at: Pt = [0, 0]): Drop {
  const d = WAYPOINT_PIN_DIAMETER[size] * scale;
  const { headCenterY } = pinGeometry(d);
  const c: Pt = [at[0], at[1] - headCenterY];
  const r = d / 2;
  // Tangent points seen from the tip: at asin(r / h) either side of the axis.
  const h = headCenterY;
  const a = Math.asin(r / h);
  const len = Math.sqrt(h * h - r * r);
  const t1: Pt = [at[0] + Math.sin(a) * len, at[1] - Math.cos(a) * len];
  const t2: Pt = [at[0] - Math.sin(a) * len, at[1] - Math.cos(a) * len];
  return { c, r, tri: [at, t1, t2] };
}

function glyphBoxAt(size: WaypointSize, scale: number, at: Pt): Pt[] {
  const d = WAYPOINT_PIN_DIAMETER[size] * scale;
  const half = (d * GLYPH_SPRITE_BOX) / PIN_SPRITE_BASE_D / 2;
  const cy = at[1] - pinGeometry(d).headCenterY;
  return [
    [at[0] - half, cy - half],
    [at[0] + half, cy - half],
    [at[0] + half, cy + half],
    [at[0] - half, cy + half],
  ];
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy)),
  );
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
}

/** Convex polygons overlap: no edge normal separates them. */
function polysOverlap(p: Pt[], q: Pt[]): boolean {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const nx = a[1] - b[1];
      const ny = b[0] - a[0];
      let pMin = Infinity;
      let pMax = -Infinity;
      let qMin = Infinity;
      let qMax = -Infinity;
      for (const v of p) {
        const t = v[0] * nx + v[1] * ny;
        pMin = Math.min(pMin, t);
        pMax = Math.max(pMax, t);
      }
      for (const v of q) {
        const t = v[0] * nx + v[1] * ny;
        qMin = Math.min(qMin, t);
        qMax = Math.max(qMax, t);
      }
      if (pMax < qMin || qMax < pMin) return false;
    }
  }
  return true;
}

function insidePoly(v: Pt, poly: Pt[]): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const s = (b[0] - a[0]) * (v[1] - a[1]) - (b[1] - a[1]) * (v[0] - a[0]);
    if (s > 0) pos = true;
    if (s < 0) neg = true;
  }
  return !(pos && neg);
}

function pointPolyDist(v: Pt, poly: Pt[]): number {
  if (insidePoly(v, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    best = Math.min(best, segDist(v, poly[i]!, poly[(i + 1) % poly.length]!));
  }
  return best;
}

function polyPolyDist(p: Pt[], q: Pt[]): number {
  if (polysOverlap(p, q)) return 0;
  let best = Infinity;
  for (const v of p) best = Math.min(best, pointPolyDist(v, q));
  for (const v of q) best = Math.min(best, pointPolyDist(v, p));
  return best;
}

/** The gap between two shapes, each a union of convex pieces (discs, polygons). */
type Piece = { disc: Pt; r: number } | { poly: Pt[] };
const pieces = (d: Drop): Piece[] => [{ disc: d.c, r: d.r }, { poly: d.tri }];

function pieceDist(a: Piece, b: Piece): number {
  if ('disc' in a && 'disc' in b) {
    return Math.max(0, Math.hypot(a.disc[0] - b.disc[0], a.disc[1] - b.disc[1]) - a.r - b.r);
  }
  if ('disc' in a && 'poly' in b) return Math.max(0, pointPolyDist(a.disc, b.poly) - a.r);
  if ('poly' in a && 'disc' in b) return pieceDist(b, a);
  if ('poly' in a && 'poly' in b) return polyPolyDist(a.poly, b.poly);
  return Infinity;
}

function gap(a: Piece[], b: Piece[]): number {
  let best = Infinity;
  for (const p of a) for (const q of b) best = Math.min(best, pieceDist(p, q));
  return best;
}

/** The ringed bodies of A (tip at 0) and B (tip at `v`) overlap. */
function drawnBodiesOverlap(a: WaypointSize, b: WaypointSize, scale: number, v: Pt): boolean {
  return gap(pieces(drop(a, scale)), pieces(drop(b, scale, v))) < 2 * PIN_RING_WIDTH;
}

/** B's glyph (tip at `v`) covers some of A's ringed body (tip at 0). */
function drawnGlyphOnBody(a: WaypointSize, b: WaypointSize, scale: number, v: Pt): boolean {
  return gap(pieces(drop(a, scale)), [{ poly: glyphBoxAt(b, scale, v) }]) < PIN_RING_WIDTH;
}

const dir = (deg: number, dist: number): Pt => [
  Math.cos((deg * Math.PI) / 180) * dist,
  Math.sin((deg * Math.PI) / 180) * dist,
];

/** Where along the ray `deg` the drawn bodies stop touching (bisection). */
function drawnTouchAlong(a: WaypointSize, b: WaypointSize, scale: number, deg: number): number {
  let lo = 0;
  let hi = 400;
  for (let i = 0; i < 26; i++) {
    const m = (lo + hi) / 2;
    if (drawnBodiesOverlap(a, b, scale, dir(deg, m))) lo = m;
    else hi = m;
  }
  return lo;
}

/** Every non-empty set of sizes a map can hold. */
const SIZE_SETS: WaypointSize[][] = Array.from({ length: 15 }, (_, m) =>
  WAYPOINT_SIZES.filter((_, i) => ((m + 1) >> i) & 1),
);

describe('the radius follows the drawn teardrops (#724)', () => {
  it('measures the closest touch of two bodies as the drawn shapes do, every direction', () => {
    for (const scale of SCALES) {
      for (const a of WAYPOINT_SIZES) {
        for (const b of WAYPOINT_SIZES) {
          let closest = Infinity;
          // The closest touch lies on a flat stretch (side by side, ±45°): 2° finds it.
          for (let deg = 0; deg < 360; deg += 2) {
            closest = Math.min(closest, drawnTouchAlong(a, b, scale, deg));
          }
          // Sampled every degree, the sweep can only overshoot the true minimum.
          expect(bodyTouchPx(a, b, scale)).toBeLessThanOrEqual(closest + 1e-4);
          expect(bodyTouchPx(a, b, scale)).toBeGreaterThan(closest - 0.1);
        }
      }
    }
  });

  it('the module’s glyph test is the drawn one', () => {
    for (const scale of SCALES) {
      for (const a of WAYPOINT_SIZES) {
        for (const b of WAYPOINT_SIZES) {
          for (let deg = 0; deg < 360; deg += 11.25) {
            for (let dist = 0; dist < 90 * scale; dist += 2.3) {
              const [dx, dy] = dir(deg, dist);
              expect(glyphReachesBody(dx, dy, a, b, scale)).toBe(
                drawnGlyphOnBody(a, b, scale, [dx, dy]),
              );
            }
          }
        }
      }
    }
  });

  it('pins whose bodies are clear of each other are never clustered (one size on the map)', () => {
    for (const scale of SCALES) {
      for (const size of WAYPOINT_SIZES) {
        const r = pinClusterRadius([size], scale);
        // Clustered means at most r apart. In every direction the bodies at
        // r still overlap, and nearer is further inside (the overlap is
        // convex) — save the integer radius's rounding, under 1 px.
        for (let deg = 0; deg < 360; deg += 0.5) {
          if (!drawnBodiesOverlap(size, size, scale, dir(deg, r - 1))) {
            throw new Error(`${size} at ${scale}: clear at ${deg}° though ${r - 1} px apart`);
          }
        }
      }
    }
  });

  it('is exactly the closest touch for one size, unless the glyph needs the next pixel', () => {
    for (const scale of SCALES) {
      for (const size of WAYPOINT_SIZES) {
        const touch = Math.floor(bodyTouchPx(size, size, scale));
        expect(pinClusterRadius([size], scale)).toBe(
          Math.max(touch, Math.ceil(glyphClearancePx(size, size, scale))),
        );
        expect(pinClusterRadius([size], scale)).toBeLessThanOrEqual(touch + 1);
      }
    }
  });

  it('two M pins side by side with a gap stay two pins (the owner’s case)', () => {
    // Heads 32 px, rings 2 px: they touch 36 px apart, tip to tip.
    expect(bodyTouchPx('M', 'M')).toBeCloseTo(36, 6);
    expect(drawnBodiesOverlap('M', 'M', 1, [40, 0])).toBe(false);
    expect(pinClusterRadius(['M'])).toBeLessThan(40);
    // Stacked, they overlap well past the radius: drawn, never grouped.
    expect(drawnBodiesOverlap('M', 'M', 1, [0, -40])).toBe(true);
  });

  it('never has a glyph over another pin left unclustered, for every mix of sizes (drawn shapes)', () => {
    for (const scale of SCALES) {
      for (const set of SIZE_SETS) {
        const r = pinClusterRadius(set, scale);
        for (const a of set) {
          for (const b of set) {
            // Where a glyph covers a body is convex and holds the origin (a
            // glyph sits inside its own head), so once a ray is out it stays
            // out: just past the radius, every degree, is the proof.
            for (let deg = 0; deg < 360; deg += 1) {
              for (const dist of [r + 0.01, 1.5 * r]) {
                if (drawnGlyphOnBody(a, b, scale, dir(deg, dist))) {
                  throw new Error(`${set.join('+')} ${a}/${b} at ${scale}: ${deg}° ${dist} px`);
                }
              }
            }
          }
        }
      }
    }
  });

  it('never grows past the box-corner radius it replaces', () => {
    // 2.6.0's radius, from the boxes' farthest corners (the guarantee is the
    // same, measured on the shapes actually drawn).
    const boxRadius: Record<string, number> = { M: 44, XL: 66 };
    expect(pinClusterRadius(['M'])).toBeLessThan(boxRadius.M!);
    expect(pinClusterRadius(['XL'])).toBeLessThan(boxRadius.XL!);
    expect(maxPinClusterRadius()).toBeLessThan(boxRadius.XL!);
  });
});

describe('cluster taps', () => {
  it('zooms to where the cluster splits, a hair past it', () => {
    expect(clusterTapAction(15, 12.3)).toEqual({ kind: 'zoom', zoom: 15.05 });
    expect(clusterTapAction(18, 16)).toEqual({ kind: 'zoom', zoom: 18 });
  });

  it('lists the pins when they only split past the camera cap', () => {
    expect(PIN_CLUSTER_MAX_ZOOM).toBe(18);
    expect(clusterTapAction(19, 17)).toEqual({ kind: 'list' });
    expect(clusterTapAction(19, 18)).toEqual({ kind: 'list' });
  });

  it('lists them when zooming would not split it, or the split is unknown', () => {
    expect(clusterTapAction(16, 16)).toEqual({ kind: 'list' });
    expect(clusterTapAction(16, 17.2)).toEqual({ kind: 'list' });
    expect(clusterTapAction(null, 12)).toEqual({ kind: 'list' });
    expect(clusterTapAction(NaN, 12)).toEqual({ kind: 'list' });
    // Unknown camera zoom: trust the split.
    expect(clusterTapAction(14, null)).toEqual({ kind: 'zoom', zoom: 14.05 });
  });

  it('reads a rendered cluster, and tells it from a pin', () => {
    const cluster = {
      properties: { cluster: true, cluster_id: 7, point_count: 23 },
      geometry: { type: 'Point', coordinates: [-71.2, 46.8] },
    };
    expect(readClusterFeature(cluster)).toEqual({ id: 7, lngLat: [-71.2, 46.8], count: 23 });
    expect(renderedPinKey(cluster)).toBeNull();
    const body = {
      properties: { key: 'saved-a' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    };
    expect(readClusterFeature(body)).toBeNull();
    expect(renderedPinKey(body)).toBe('saved-a');
    expect(readClusterFeature({ properties: { cluster_id: 1 }, geometry: null })).toBeNull();
    expect(readClusterFeature(null)).toBeNull();
    expect(renderedPinKey({})).toBeNull();
  });

  it('turns a cluster’s leaves into pin keys, once each', () => {
    expect(
      leafKeys([
        { properties: { key: 'saved-a' } },
        { properties: { key: 'live-b' } },
        { properties: { key: 'saved-a' } },
        { properties: {} },
        null,
      ]),
    ).toEqual(['saved-a', 'live-b']);
  });
});

describe('who takes a tap: a pin or a cluster', () => {
  const C = (id: number, distancePx: number) => ({
    cluster: { id, lngLat: [0, 0] as [number, number], count: 3 },
    distancePx,
  });
  const onHead = { pin: 'p', distancePx: 4, onHead: true };
  const inSlack = { pin: 'p', distancePx: 30, onHead: false };

  it('a pin hit dead on its head wins (pins draw above clusters)', () => {
    expect(routeWaypointTap(onHead, [C(1, 5)])).toEqual({ kind: 'pin', pin: 'p' });
  });

  it('a cluster under the finger wins over a pin only in the finger’s slack', () => {
    expect(routeWaypointTap(inSlack, [C(1, 12)])).toMatchObject({ kind: 'cluster' });
  });

  it('takes the nearest cluster within reach, else the pin, else nothing', () => {
    expect(routeWaypointTap(null, [C(1, 20), C(2, 6)])).toMatchObject({
      kind: 'cluster',
      cluster: { id: 2 },
    });
    const far = clusterHitRadiusPx() + 1;
    expect(routeWaypointTap(inSlack, [C(1, far)])).toEqual({ kind: 'pin', pin: 'p' });
    expect(routeWaypointTap(null, [C(1, far)])).toEqual({ kind: 'none' });
    expect(routeWaypointTap(null, [])).toEqual({ kind: 'none' });
  });

  it('reaches as far as the drawn disc grows, never under a 48 dp target', () => {
    expect(clusterHitRadiusPx(1)).toBe(26);
    expect(clusterHitRadiusPx(1.5)).toBe(35);
    expect(clusterHitRadiusPx(0.75)).toBeGreaterThanOrEqual(24);
  });

  it('asks MapLibre about a box wide enough for every pin whose disc holds the tap', () => {
    for (const scale of SCALES) {
      const reach = waypointQueryReachPx(scale);
      for (const size of WAYPOINT_SIZES) {
        const { radiusPx, headOffsetPx } = pinHitArea(size, 'tap', scale);
        expect(reach).toBeGreaterThanOrEqual(radiusPx + headOffsetPx);
      }
      expect(reach).toBeGreaterThanOrEqual(clusterHitRadiusPx(scale));
    }
  });

  it('a tap on a 150 % head counts as dead on it where a 100 % head would be slack', () => {
    // An M pin's tip at (100, 100): its head centre 32·√½ (100 %) or 48·√½ (150 %) above.
    const pins = [{ latitude: 0, longitude: 0, size: 'M' as const }];
    const tip: [number, number][] = [[100, 100]];
    const at100 = nearestPinHitAt(pins, tip, [100 + 20, 100 - 32 * Math.SQRT1_2], 'tap', 1);
    const at150 = nearestPinHitAt(pins, tip, [100 + 20, 100 - 48 * Math.SQRT1_2], 'tap', 1.5);
    expect(at100?.onHead).toBe(false);
    expect(at150?.onHead).toBe(true);
  });
});

/** Every expression checked against the style spec (iOS kills the app on some Android shrugs off). */
function zoomAnywhere(node: unknown): boolean {
  if (Array.isArray(node)) {
    if (node[0] === 'zoom' && node.length === 1) return true;
    return node.some(zoomAnywhere);
  }
  if (typeof node === 'object' && node !== null) return Object.values(node).some(zoomAnywhere);
  return false;
}

describe('the cluster and pin layers are valid style', () => {
  it.each(SCALES)('validates at %p×, with no zoom expression and no sort key', (scale) => {
    const font = ['Noto Sans Bold'];
    const layers = [
      { id: 'c', type: 'circle', source: 's', filter: IS_CLUSTER, paint: clusterDiscPaint(scale) },
      {
        id: 'cg',
        type: 'symbol',
        source: 's',
        filter: IS_CLUSTER,
        layout: clusterGlyphLayout(scale),
      },
      {
        id: 'cc',
        type: 'symbol',
        source: 's',
        filter: IS_CLUSTER,
        layout: clusterCountLayout(scale),
      },
      {
        id: 'b',
        type: 'symbol',
        source: 's',
        filter: NOT_CLUSTER,
        layout: clusteredBodyLayout(scale),
        paint: clusteredBodyPaint,
      },
      {
        id: 'g',
        type: 'symbol',
        source: 's',
        filter: NOT_CLUSTER,
        layout: clusteredGlyphLayout(scale),
        paint: clusteredGlyphPaint,
      },
      {
        id: 'p',
        type: 'symbol',
        source: 's',
        filter: CLUSTERED_PHOTO_FILTER,
        layout: clusteredPhotoLayout(scale),
      },
      {
        id: 'l',
        type: 'symbol',
        source: 's',
        filter: NOT_CLUSTER,
        layout: pinLabelLayout(font, scale, false),
      },
    ];
    const style = {
      version: 8 as const,
      glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
      sources: {
        s: {
          type: 'geojson' as const,
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterRadius: pinClusterRadius(['M'], scale),
          clusterMaxZoom: PIN_CLUSTER_MAX_ZOOM,
        },
      },
      layers,
    };
    expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
    expect(zoomAnywhere(layers)).toBe(false);
    expect(JSON.stringify(layers)).not.toContain('symbol-sort-key');
  });

  it('scales the pins by one multiplier in icon-size, never in the data', () => {
    expect(clusteredBodyLayout(1)['icon-size']).toEqual(['get', 'bsz']);
    expect(clusteredBodyLayout(1.5)['icon-size']).toEqual(['*', ['get', 'bsz'], 1.5]);
    expect(clusteredGlyphLayout(0.75)['icon-size']).toEqual(['*', ['get', 'gsz'], 0.75]);
    expect(clusteredPhotoLayout(1.25)['icon-size']).toEqual(['*', ['get', 'ps'], 1.25]);
    expect(clusterDiscPaint(1.5)['circle-radius']).toBe(27);
    expect(pinLabelLayout(['f'], 1.5)['text-offset']).toEqual([0, 0.45]);
  });

  it('shows the photo stacks’ count pill (99+ past 99), sized with the disc', () => {
    expect(clusterCountLayout(1)['icon-image']).toEqual([
      'concat',
      'ph-count-',
      ['to-string', ['min', ['get', 'point_count'], 100]],
    ]);
    expect(clusterCountLayout(1)['icon-size']).toBeCloseTo(1 / 3, 3);
    expect(clusterCountLayout(1.5)['icon-size']).toBe(0.5);
  });
});
