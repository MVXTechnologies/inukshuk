import {
  fieldClipMatrix,
  mercatorX,
  mercatorY,
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

  it('worldSizePx doubles per zoom level', () => {
    expect(worldSizePx(0)).toBe(512);
    expect(worldSizePx(1)).toBe(1024);
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

  it('projects a south offset downward through the y-flip', () => {
    const v = view();
    const relY = 50 / worldSizePx(v.zoom); // 50 px worth of southward offset
    const m = fieldClipMatrix(v, v.centerLng, v.centerLat);
    const c = apply(m, 0, relY);
    // 50 px south on an 800-high view → clip −0.125.
    expect(c.y).toBeCloseTo(-0.125, 5);
  });
});
