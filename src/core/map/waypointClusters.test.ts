import { nearestPinHitAt, pinHitArea } from '@core/geo/pinHitTest';
import { WAYPOINT_SIZES } from '@core/library/waypointStyle';
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
import { pinLabelLayout, type PinInput } from './waypointPinStyle';

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
        let farthest = 0;
        for (let dx = -c; dx <= c; dx += 0.25) {
          for (let dy = -c; dy <= c; dy += 0.25) {
            if (glyphReachesBody(dx, dy, size, size, scale)) {
              farthest = Math.max(farthest, Math.hypot(dx, dy));
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
    expect(pinClusterRadius(['M'])).toBe(44);
    expect(pinClusterRadius([undefined])).toBe(44);
    expect(pinClusterRadius([])).toBe(44);
    expect(pinClusterRadius(['XL'])).toBe(66);
    expect(pinClusterRadius(['S', 'XL'])).toBeGreaterThanOrEqual(pinClusterRadius(['XL']));
    expect(maxPinClusterRadius()).toBe(pinClusterRadius(WAYPOINT_SIZES));
    const bySetting = SCALES.map((k) => pinClusterRadius(['M'], k));
    expect(bySetting).toEqual([...bySetting].sort((a, b) => a - b));
    expect(new Set(bySetting).size).toBe(4);
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
