import {
  cameraToCenterDistance,
  centerPx,
  DEFAULT_FOV_RAD,
  eyeFromProjection,
  farPlane,
  groundAtNdc,
  projectionMatrix,
  projectToNdc,
} from './camera';
import { invert } from './mat4';
import { pixelsPerMeter } from './mercator';
import { camera, PLACES, type PlaceName } from './testUtils';

const PITCHES = [0, 10, 20, 30, 40, 45, 50, 60, 70, 80];
const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];
const PLACE_NAMES = Object.keys(PLACES) as PlaceName[];

describe('camera-to-centre distance', () => {
  it('is 1.5 × height at MapLibre’s default fov', () => {
    // fov = 2·atan(1/3): ½h / tan(fov/2) = 1.5 h
    expect(cameraToCenterDistance(892)).toBeCloseTo(1.5 * 892, 9);
  });
  it('shrinks with a wider fov', () => {
    expect(cameraToCenterDistance(800, 1.2)).toBeLessThan(cameraToCenterDistance(800));
  });
});

describe('far plane', () => {
  const ctc = 1000;
  it('is just past the centre when looking straight down', () => {
    expect(farPlane(ctc, 0, DEFAULT_FOV_RAD)).toBeCloseTo(ctc * 1.01, 9);
  });
  it('grows with the pitch and is capped (tanMultiple ≤ 0.99)', () => {
    const f45 = farPlane(ctc, Math.PI / 4, DEFAULT_FOV_RAD);
    const f80 = farPlane(ctc, (80 * Math.PI) / 180, DEFAULT_FOV_RAD);
    expect(f45).toBeGreaterThan(ctc * 1.01);
    expect(f80).toBeGreaterThan(f45);
    expect(f80).toBeLessThanOrEqual((ctc / 0.01) * 1.01 + 1e-6);
  });
});

describe.each(PLACE_NAMES)('projection at %s', (name) => {
  const place = PLACES[name];
  const cases = PITCHES.flatMap((p) => BEARINGS.map((b) => [p, b] as const));

  it.each(cases)('pitch %p bearing %p: the centre projects to NDC (0, 0)', (p, b) => {
    const c = camera(place, p, b);
    const [cx, cy] = centerPx(c);
    const ndc = projectToNdc(projectionMatrix(c), cx, cy, 0);
    expect(ndc).not.toBeNull();
    expect(ndc![0]).toBeCloseTo(0, 6);
    expect(ndc![1]).toBeCloseTo(0, 6);
  });

  it.each(cases)('pitch %p bearing %p: the eye is recovered from the matrix', (p, b) => {
    const c = camera(place, p, b);
    const P = projectionMatrix(c);
    const eye = eyeFromProjection(P)!;
    const ctc = cameraToCenterDistance(c.height);
    const [cx, cy] = centerPx(c);
    const pr = (p * Math.PI) / 180;
    const br = (b * Math.PI) / 180;
    const ppm = pixelsPerMeter(c.lat, c.zoom);
    expect(eye[0]).toBeCloseTo(cx - Math.sin(br) * ctc * Math.sin(pr), 3);
    expect(eye[1]).toBeCloseTo(cy + Math.cos(br) * ctc * Math.sin(pr), 3);
    expect(eye[2] * ppm).toBeCloseTo(ctc * Math.cos(pr), 3);
  });
});

describe('orientation', () => {
  const place = PLACES.chamonix;
  it('bearing 0: north is up, east is right', () => {
    const c = camera(place, 30, 0);
    const P = projectionMatrix(c);
    const [cx, cy] = centerPx(c);
    expect(projectToNdc(P, cx, cy - 50, 0)![1]).toBeGreaterThan(0);
    expect(projectToNdc(P, cx + 50, cy, 0)![0]).toBeGreaterThan(0);
  });
  it('bearing 90: east is up, south is right', () => {
    const c = camera(place, 30, 90);
    const P = projectionMatrix(c);
    const [cx, cy] = centerPx(c);
    expect(projectToNdc(P, cx + 50, cy, 0)![1]).toBeGreaterThan(0);
    expect(projectToNdc(P, cx, cy + 50, 0)![0]).toBeGreaterThan(0);
  });
  it('raising a point moves it up the screen when pitched', () => {
    const c = camera(place, 60, 0);
    const P = projectionMatrix(c);
    const [cx, cy] = centerPx(c);
    const low = projectToNdc(P, cx, cy, 0)!;
    const high = projectToNdc(P, cx, cy, 1000)!;
    expect(high[1]).toBeGreaterThan(low[1]);
  });
  it('a top-down camera sees a raised point exactly above the ground point at the centre', () => {
    const c = camera(place, 0, 0);
    const P = projectionMatrix(c);
    const [cx, cy] = centerPx(c);
    const high = projectToNdc(P, cx, cy, 500)!;
    expect(high[0]).toBeCloseTo(0, 9);
    expect(high[1]).toBeCloseTo(0, 9);
  });
  it('a point behind the eye does not project', () => {
    const c = camera(place, 60, 0);
    const P = projectionMatrix(c);
    const [cx, cy] = centerPx(c);
    const ctc = cameraToCenterDistance(c.height);
    expect(projectToNdc(P, cx, cy + ctc * 5, 0)).toBeNull();
  });
});

describe('groundAtNdc inverts projectToNdc on the ground', () => {
  const ndcs: [number, number][] = [
    [0, 0],
    [-0.9, -0.98],
    [0.9, -0.98],
    [0.5, 0.3],
    [-0.4, 0.6],
  ];
  const cases = [0, 30, 60, 75].flatMap((p) =>
    [0, 120, 250].flatMap((b) => ndcs.map((n) => [p, b, n] as const)),
  );
  it.each(cases)('pitch %p bearing %p ndc %p', (p, b, [nx, ny]) => {
    const c = camera(PLACES.zermatt, p, b);
    const P = projectionMatrix(c);
    const g = groundAtNdc(invert(P)!, nx, ny);
    expect(g).not.toBeNull();
    const back = projectToNdc(P, g![0], g![1], 0)!;
    expect(back[0]).toBeCloseTo(nx, 6);
    expect(back[1]).toBeCloseTo(ny, 6);
  });

  it('a ray above the horizon never reaches the ground', () => {
    const c = camera(PLACES.zermatt, 80, 0);
    expect(groundAtNdc(invert(projectionMatrix(c))!, 0, 0.99)).toBeNull();
  });

  it('honours a raised ground plane', () => {
    const c = camera(PLACES.zermatt, 50, 30);
    const P = projectionMatrix(c);
    const g = groundAtNdc(invert(P)!, 0.2, -0.5, 1200)!;
    const back = projectToNdc(P, g[0], g[1], 1200)!;
    expect(back[0]).toBeCloseTo(0.2, 6);
    expect(back[1]).toBeCloseTo(-0.5, 6);
  });
});
