import {
  advectionUvPerMps,
  fieldClipMatrix,
  isRenderableView,
  latFromMercatorY,
  mercatorX,
  mercatorY,
  PX_PER_FRAME_PER_MPS,
  viewportGridRect,
  worldSizePx,
  type WindViewState,
} from './windProjection';

/** Apply the mat4 (column-major) to a rel-mercator point, return clip xy. */
function apply(m: Float32Array, x: number, y: number): { x: number; y: number } {
  return {
    x: (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[12] ?? 0),
    y: (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[13] ?? 0),
  };
}

const view = (over: Partial<WindViewState> = {}): WindViewState => ({
  centerLng: -71,
  centerLat: 47,
  zoom: 10,
  bearing: 0,
  pitch: 0,
  width: 400,
  height: 800,
  ...over,
});

describe('mercator helpers', () => {
  it('maps the world to [0,1] with north at 0', () => {
    expect(mercatorX(-180)).toBe(0);
    expect(mercatorX(180)).toBe(1);
    expect(mercatorX(0)).toBe(0.5);
    expect(mercatorY(0)).toBeCloseTo(0.5);
    expect(mercatorY(60)).toBeLessThan(0.5);
    expect(mercatorY(-60)).toBeGreaterThan(0.5);
  });

  it('clamps polar latitudes instead of diverging', () => {
    expect(Number.isFinite(mercatorY(90))).toBe(true);
    expect(Number.isFinite(mercatorY(-90))).toBe(true);
  });

  it('latFromMercatorY inverts mercatorY', () => {
    for (const lat of [-80, -46.8, 0, 12.5, 46.8131, 80]) {
      expect(latFromMercatorY(mercatorY(lat))).toBeCloseTo(lat, 6);
    }
  });

  it('worldSizePx doubles per zoom level', () => {
    expect(worldSizePx(0)).toBe(512);
    expect(worldSizePx(1)).toBe(1024);
  });
});

describe('isRenderableView', () => {
  it('accepts a laid-out camera', () => {
    expect(isRenderableView(view())).toBe(true);
  });

  it('rejects a camera whose layout size has not landed', () => {
    // The M3 "nothing until you pan" bug: getViewState resolving before the
    // map's onLayout seeded width/height 0, and fieldClipMatrix then scales
    // by 2·worldSize — every particle lands far outside clip space.
    expect(isRenderableView(view({ width: 0, height: 0 }))).toBe(false);
    expect(isRenderableView(view({ width: 390, height: 0 }))).toBe(false);
    const m = fieldClipMatrix(view({ width: 0, height: 0 }), -71, 47.5);
    expect(Math.abs(m[0] ?? 0)).toBeGreaterThan(1e6);
  });

  it('rejects a non-finite camera', () => {
    expect(isRenderableView(view({ zoom: Number.NaN }))).toBe(false);
    expect(isRenderableView(view({ centerLat: Number.POSITIVE_INFINITY }))).toBe(false);
  });
});

describe('fieldClipMatrix', () => {
  it('puts the camera center at clip origin', () => {
    // Field origin AT the camera center → rel (0,0) is the center.
    const m = fieldClipMatrix(view(), -71, 47);
    const c = apply(m, 0, 0);
    expect(c.x).toBeCloseTo(0, 5);
    expect(c.y).toBeCloseTo(0, 5);
  });

  it('projects a north offset upward (positive clip y) at bearing 0', () => {
    const m = fieldClipMatrix(view(), -71, 47.5);
    // Field origin is NORTH of center; rel (0,0) = the origin itself.
    const c = apply(m, 0, 0);
    expect(c.x).toBeCloseTo(0, 5);
    expect(c.y).toBeGreaterThan(0);
  });

  it('projects an east offset up when bearing is 90 (east-up map)', () => {
    const m = fieldClipMatrix(view({ bearing: 90 }), -70.5, 47);
    const c = apply(m, 0, 0);
    expect(c.y).toBeGreaterThan(0.01);
    expect(Math.abs(c.x)).toBeLessThan(1e-5);
  });

  it('scales with zoom: one more level doubles the clip offset', () => {
    const rel = { x: 0.001, y: 0 };
    const at10 = apply(fieldClipMatrix(view(), -71, 47), rel.x, rel.y);
    const at11 = apply(fieldClipMatrix(view({ zoom: 11 }), -71, 47), rel.x, rel.y);
    expect(at11.x).toBeCloseTo(at10.x * 2, 6);
  });

  it('matches a hand-computed pixel position', () => {
    const v = view();
    // A point one full mercator-x "pixel-at-zoom" east of center:
    const world = worldSizePx(v.zoom);
    const relX = 100 / world; // 100 px east
    const m = fieldClipMatrix(v, v.centerLng, v.centerLat);
    const c = apply(m, relX, 0);
    // 100 px on a 400-wide view = half of the half-width → clip 0.5.
    expect(c.x).toBeCloseTo(0.5, 5);
    expect(c.y).toBeCloseTo(0, 5);
  });

  it('keeps the spawn rect around the camera, not the whole grid', () => {
    // The shipped M3 regression: at trail zoom the 0.5° fetch grid is ~600×
    // the viewport's area, so grid-wide spawning left ~3 of 2000 particles
    // on screen. The rect must be a small patch centred on the camera.
    const v = view({ centerLng: -71.2082, centerLat: 46.8131, zoom: 14, width: 390, height: 761 });
    const field = { lon0: -71.5, lat0: 47, lonSpan: 0.5, latSpan: 0.5 };
    const r = viewportGridRect(v, field);
    // Camera centre sits inside the rect.
    const cu = (v.centerLng - field.lon0) / field.lonSpan;
    const cv = (field.lat0 - v.centerLat) / field.latSpan;
    expect(r.minU).toBeLessThan(cu);
    expect(r.maxU).toBeGreaterThan(cu);
    expect(r.minV).toBeLessThan(cv);
    expect(r.maxV).toBeGreaterThan(cv);
    // And it is a small patch, not the whole grid.
    expect(r.maxU - r.minU).toBeLessThan(0.2);
    expect(r.maxV - r.minV).toBeLessThan(0.2);
    // Sanity: the viewport is ~0.0167° wide; padded by 2·SPAWN_PAD → ~1.4×.
    expect((r.maxU - r.minU) * field.lonSpan).toBeCloseTo(0.0167 * 1.4, 2);
  });

  it('grows the spawn rect as the camera zooms out', () => {
    const field = { lon0: -71.5, lat0: 47, lonSpan: 0.5, latSpan: 0.5 };
    const at14 = viewportGridRect(view({ centerLng: -71.25, centerLat: 46.75, zoom: 14 }), field);
    const at11 = viewportGridRect(view({ centerLng: -71.25, centerLat: 46.75, zoom: 11 }), field);
    expect(at11.maxU - at11.minU).toBeGreaterThan((at14.maxU - at14.minU) * 7);
  });

  it('clamps the spawn rect to the grid and never inverts it', () => {
    const field = { lon0: -71.5, lat0: 47, lonSpan: 0.5, latSpan: 0.5 };
    // Zoomed way out: the viewport dwarfs the grid.
    const wide = viewportGridRect(view({ centerLng: -71.25, centerLat: 46.75, zoom: 4 }), field);
    expect(wide).toEqual({ minU: 0, minV: 0, maxU: 1, maxV: 1 });
    // Camera far outside the grid: degenerate but still ordered.
    const away = viewportGridRect(view({ centerLng: 10, centerLat: 5, zoom: 14 }), field);
    expect(away.maxU).toBeGreaterThan(away.minU);
    expect(away.maxV).toBeGreaterThan(away.minV);
    for (const v of [away.minU, away.maxU, away.minV, away.maxV]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('covers the corners of a rotated camera', () => {
    const field = { lon0: -71.5, lat0: 47, lonSpan: 0.5, latSpan: 0.5 };
    const v = view({ centerLng: -71.25, centerLat: 46.75, zoom: 13, width: 390, height: 761 });
    const flat = viewportGridRect(v, field);
    const turned = viewportGridRect({ ...v, bearing: 90 }, field);
    // A portrait viewport rotated 90° is wider than it is tall.
    expect(turned.maxU - turned.minU).toBeGreaterThan(flat.maxU - flat.minU);
    expect(turned.maxV - turned.minV).toBeLessThan(flat.maxV - flat.minV);
  });

  it('advects a wind speed by the intended number of screen pixels', () => {
    // The shipped M3 regression's other half: the step was a fraction of the
    // fetched GRID, so at trail zoom particles crossed the screen in one or
    // two frames and rendered as noise. The step must be screen-relative.
    const v = view({ centerLng: -71.2082, centerLat: 46.8131, zoom: 14, width: 390, height: 761 });
    const field = { lon0: -71.5, lat0: 47, lonSpan: 0.5, latSpan: 0.5 };
    const rect = viewportGridRect(v, field);
    const p = advectionUvPerMps(v, field, rect);
    const cosLat = Math.cos((v.centerLat * Math.PI) / 180);
    const mps = 10;
    // Mirror the shader: offset.x = velocity.x / cos(lat) * p.x (grid UV).
    const duGrid = ((mps / cosLat) * p.x) as number;
    const pxPerFrame = (duGrid / (rect.maxU - rect.minU)) * v.width;
    expect(pxPerFrame).toBeCloseTo(PX_PER_FRAME_PER_MPS * mps, 6);
    // ...which is a readable streak, not a teleport across the viewport.
    expect(pxPerFrame).toBeLessThan(v.width / 20);
  });

  it('keeps the on-screen advection speed constant across zooms', () => {
    const field = { lon0: -71.5, lat0: 47, lonSpan: 0.5, latSpan: 0.5 };
    const pxAt = (zoom: number): number => {
      const v = view({ centerLng: -71.25, centerLat: 46.75, zoom, width: 390, height: 761 });
      const rect = viewportGridRect(v, field);
      const p = advectionUvPerMps(v, field, rect);
      return (p.x / (rect.maxU - rect.minU)) * v.width;
    };
    expect(pxAt(11)).toBeCloseTo(pxAt(14), 9);
  });

  it('advects x and y isotropically in screen pixels', () => {
    const v = view({ centerLng: -71.25, centerLat: 46.75, zoom: 13, width: 390, height: 761 });
    const field = { lon0: -71.5, lat0: 47, lonSpan: 0.5, latSpan: 0.5 };
    const rect = viewportGridRect(v, field);
    const p = advectionUvPerMps(v, field, rect);
    const cosLat = Math.cos((v.centerLat * Math.PI) / 180);
    // Equal ground speeds east and north must move equal pixel counts.
    const pxX = ((1 / cosLat) * p.x * v.width) / (rect.maxU - rect.minU);
    const pxY = (p.y * v.height) / (rect.maxV - rect.minV);
    expect(pxY).toBeCloseTo(pxX, 2);
  });

  it('projects a south offset downward through the y-flip', () => {
    const v = view();
    const relY = 50 / worldSizePx(v.zoom); // 50 px worth of southward offset
    const m = fieldClipMatrix(v, v.centerLng, v.centerLat);
    const c = apply(m, 0, relY);
    // 50 px south on an 800-high view → clip −0.125.
    expect(c.y).toBeCloseTo(-0.125, 5);
  });
});
