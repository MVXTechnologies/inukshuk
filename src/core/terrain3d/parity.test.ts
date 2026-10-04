/**
 * Parity fixtures for the C++ terrain engine (modules/inukshuk-terrain): the
 * TS reference computes a set of cases; the committed JSON must equal what it
 * computes today (so the TS can't drift silently), and the C++ test runner
 * (`modules/inukshuk-terrain/tests/run.sh`) checks the C++ against the same
 * file. Regenerate with `UPDATE_TERRAIN_FIXTURES=1 npx jest parity`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { cameraToCenterDistance, centerPx, eyeFromProjection, projectionMatrix } from './camera';
import { sampleMosaic, terrariumHeight, type DemNeighborhood } from './dem';
import { selectTiles } from './lod';
import { fogAmount, formShade, lightDirection, terrainLook } from './look';
import {
  bakeSlopes,
  buildGridIndices,
  buildGridVertices,
  gridVertexCount,
  parentSurfaceForChild,
} from './mesh';
import { morphFactor, pitchRamp, smoothstep } from './morph';
import { planDemRequests } from './prefetch';
import { camera, frameCamera, PLACES, rng, type PlaceName } from './testUtils';
import { demKey, tileKey } from './tiles';
import { contourAt, levelForDensity } from './contours3d';
import { shadeSurface } from './surface';
import { occludedByTerrain, placeLabels, type LabelInput, type LabelState } from './labels';
import { densify, extrudeOffset, rasterizePolygons } from './lines';

const FIXTURE = path.join(
  __dirname,
  '../../../modules/inukshuk-terrain/tests/fixtures/parity.json',
);

function round(x: number): number {
  return Number(x.toPrecision(15));
}

function build() {
  const cameras: unknown[] = [];
  for (const name of Object.keys(PLACES) as PlaceName[]) {
    for (const p of [30, 45, 60, 70, 80]) {
      for (const b of [0, 135, 290]) {
        const fc = frameCamera(camera(PLACES[name], p, b));
        const flat = selectTiles(fc, { heightScale: 0 });
        const tall = selectTiles(fc, {
          heightRange: (t) => (t.z >= 8 ? [800 + t.z * 10, 3200 + t.z * 20] : null),
          hRef: 1200,
          heightScale: 1.3,
        });
        cameras.push({
          name,
          pitch: p,
          bearing: b,
          P: fc.P,
          width: fc.width,
          height: fc.height,
          fov: fc.fovRad,
          zoom: fc.zoom,
          lat: fc.lat,
          eye: eyeFromProjection(fc.P)!.map(round),
          flat: { tiles: flat.tiles.map((s) => tileKey(s.tile)), threshold: flat.threshold },
          tall: { tiles: tall.tiles.map((s) => tileKey(s.tile)), threshold: tall.threshold },
        });
      }
    }
  }
  const r = rng(99);
  const decode: number[][] = [];
  for (let i = 0; i < 64; i++) {
    const c = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)] as const;
    decode.push([...c, terrariumHeight(...c), terrariumHeight(...c, { clampSeaLevel: false })]);
  }
  const edges: [number, number, number][] = [
    [128, 0, 0],
    [0, 0, 0],
    [255, 255, 255],
    [127, 255, 255],
    [163, 40, 0],
  ];
  for (const c of edges) {
    decode.push([...c, terrariumHeight(...c), terrariumHeight(...c, { clampSeaLevel: false })]);
  }
  const n = 8;
  const parent = Array.from({ length: gridVertexCount(n) }, () => Math.round(r() * 3000));
  const mosaicTile = (tx: number, ty: number) =>
    Float32Array.from(
      { length: 64 },
      (_, k) => (tx * 8 + (k % 8)) * 3 + (ty * 8 + Math.floor(k / 8)) * 7 + ((k * 13) % 5),
    );
  const nb: DemNeighborhood = {
    size: 8,
    center: mosaicTile(0, 0),
    neighbor: (dx, dy) => (dx === 1 && dy === 1 ? null : mosaicTile(dx, dy)),
  };
  const mosaic: number[][] = [];
  for (let i = 0; i < 40; i++) {
    const u = r() * 1.2 - 0.1;
    const v = r() * 1.2 - 0.1;
    mosaic.push([u, v, sampleMosaic(nb, u, v)]);
  }
  const scalar = {
    smoothstep: [-1, 0, 0.25, 0.5, 0.9, 1, 2].map((x) => [x, smoothstep(0, 1, x)]),
    pitchRamp: [0, 20, 25, 30, 35, 44.9, 45, 60, 80].map((p) => [p, pitchRamp(p)]),
    morph: [-1, 0, 10, 100, 140, 279, 280, 400].map((t) => [t, morphFactor(t)]),
    fog: [0, 1, 2.5, 3, 5, 8, 10.2, 11, 12, 20].map((d) => [
      d,
      fogAmount({ fogStartCtc: 2.5, fogDensity: 0.12, fogEndCtc: 12 }, d),
    ]),
    light: [0, 33, 90, 200, 359].map((b) => [b, ...lightDirection(b)]),
    form: [
      [0, 0],
      [0.3, 0.6],
      [-0.3, -0.6],
      [5, -2],
      [-40, 40],
    ].map(([sx, sy]) => [sx!, sy!, formShade(sx!, sy!, 1.6, lightDirection(30), 0.22, 0.8)]),
  };
  const sel = selectTiles(frameCamera(camera(PLACES.zermatt, 70, 30)));
  const loaded = new Set(['10/533/361', '13/4268/2897']);
  const plan = planDemRequests({
    tiles: sel.tiles.map((s) => s.tile),
    bearingDeg: 30,
    isLoaded: (d) => loaded.has(demKey(d)),
    isPending: (d) => d.z === 12 && d.x % 2 === 0,
    maxRequests: 60,
  }).map(demKey);
  // 3D scene maths (#551 redesign).
  const contours: number[][] = [];
  for (const z of [9, 11, 12, 14]) {
    for (const d of [0.2, 0.9, 2.3, 4.7, 11, 40]) {
      for (const h of [0, 3.2, 10, 49.6, 50.4, 777.7, 1000, 2512.5, -37]) {
        const c = contourAt(h, d, z);
        const l = levelForDensity(z % 3, d);
        contours.push([h, d, z, c.minor, c.major, l.index, l.finerWeight]);
      }
    }
  }
  const sl = terrainLook({
    basemap: 'map',
    dark: false,
    land: '#F2ECE0',
    landAlt: '#E6DFCF',
    relief: 'natural',
  });
  const surface: number[][] = [];
  for (const [h, sx, sy, w, g] of [
    [100, 0, 0, 0, 0],
    [3000, -0.6, -0.9, 0, 0],
    [3000, 0.6, 0.9, 0, 0.5],
    [0, 0.2, 0.1, 0, 0],
    [1800, -1.5, 0.3, 1, 0],
    [2600, 0.1, -2.2, 0.3, 0.2],
  ] as const) {
    surface.push([
      h,
      sx,
      sy,
      w,
      g,
      ...shadeSurface({
        palette: sl.surface,
        heightM: h,
        slopeX: sx,
        slopeY: sy,
        exaggeration: 1.3,
        light: lightDirection(20),
        water: w,
        glacier: g,
      }),
    ]);
  }
  const lc = camera(PLACES.chamonix, 65, 30);
  const LP = projectionMatrix(lc);
  const [lx, ly] = centerPx(lc);
  const lr = rng(7);
  const labelInputs: LabelInput[] = Array.from({ length: 30 }, (_, i) => ({
    id: i,
    x: lx + (lr() - 0.5) * 900,
    y: ly + (lr() - 0.5) * 900 - 300,
    h: 1000 + lr() * 2500,
    kind: 'peak' as const,
    priority: Math.floor(lr() * 10),
    w: 60 + Math.floor(lr() * 60),
    ph: 22,
  }));
  const states = new Map<number, LabelState>();
  const labelFrames: number[][][] = [];
  for (let f = 0; f < 4; f++) {
    const placed = placeLabels(labelInputs.slice(0, 30 - f * 3), states, {
      P: LP,
      width: lc.width,
      height: lc.height,
      ctc: cameraToCenterDistance(lc.height),
      hRef: 1100,
      heightScale: 1.2,
      dtMs: 70,
      nowMs: f * 70,
      occluded: (l) => l.id % 7 === 3,
    });
    labelFrames.push(
      placed.map((p) => [p.id, p.ax, p.ay, p.depth, p.cx, p.cy, p.gx, p.gy, p.scale, p.opacity]),
    );
  }
  const occl = [
    occludedByTerrain([0, 0, 3000], [1000, 0, 0], (x) => (x > 400 && x < 600 ? 2500 : 0)),
    occludedByTerrain([0, 0, 3000], [1000, 0, 0], () => 0),
    occludedByTerrain([0, 0, 3000], [1000, 0, 0], (x) => (x > 980 ? 900 : null)),
  ];
  const dens = densify(
    [
      [0, 0],
      [0.003, 0.001],
      [0.0031, 0.0042],
    ],
    0.0004,
  );
  const ext = [
    extrudeOffset([-0.2, 0.1], [0.4, 0.3], 1, 3, [400, 800]),
    extrudeOffset([0.5, 0.5], [0.5, -0.5], -1, 6, [1080, 2400]),
  ];
  const mask = Array.from(
    rasterizePolygons(
      [
        [
          [0.1, 0.05],
          [0.9, 0.2],
          [0.7, 0.95],
          [0.05, 0.6],
        ],
        [
          [0.3, 0.3],
          [0.5, 0.35],
          [0.4, 0.55],
        ],
      ],
      32,
    ),
  );
  return {
    scene: { contours, surface, labelFrames, occl, dens, ext, mask },
    cameras,
    decode,
    mesh: {
      n,
      vertices: Array.from(buildGridVertices(n)),
      indices: Array.from(buildGridIndices(n)),
      parent,
      child10: Array.from(parentSurfaceForChild(n, Float32Array.from(parent), 1, 0)),
      child11: Array.from(parentSurfaceForChild(n, Float32Array.from(parent), 1, 1)),
      planeSlopes: Array.from(bakeSlopes(n, (u, v) => 1000 + 300 * u - 700 * v, 125)),
    },
    mosaic,
    scalar,
    plan: { tiles: sel.tiles.map((s) => tileKey(s.tile)), keys: plan },
  };
}

describe('C++ parity fixtures', () => {
  it('the committed fixture matches the TS reference', () => {
    const data = JSON.parse(JSON.stringify(build())) as unknown;
    if (process.env.UPDATE_TERRAIN_FIXTURES) {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, JSON.stringify(data));
    }
    const committed = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as unknown;
    expectClose(committed, data, '$');
  });
});

/**
 * Deep equality that allows last-bit float differences: Math.sin/cos/atan2
 * are not correctly rounded, so V8 on Linux x86 and macOS arm64 disagree in
 * the final ULP and an exact comparison fails on CI only.
 */
function expectClose(a: unknown, b: unknown, at: string): void {
  if (typeof a === 'number' && typeof b === 'number') {
    const tol = 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
    if (Math.abs(a - b) > tol) throw new Error(`${at}: ${a} !== ${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    expect(a.length).toBe(b.length);
    a.forEach((v, i) => expectClose(v, b[i], `${at}[${i}]`));
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    expect(Object.keys(ra).sort()).toEqual(Object.keys(rb).sort());
    for (const k of Object.keys(ra)) expectClose(ra[k], rb[k], `${at}.${k}`);
    return;
  }
  expect(a).toEqual(b);
}
