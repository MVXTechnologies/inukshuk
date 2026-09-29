/**
 * Offline preview of the personal heatmap over the Québec fixture library
 * (#466) — no emulator. Skipped unless RENDER_HEAT is set to an output dir:
 *
 *   RENDER_HEAT=/tmp/heat npx jest src/features/map/heatPreview.render
 *
 * Writes before/after PNGs at z10 and z14, light and dark. "Before" is the
 * old index-sampled point cloud through a MapLibre-style heatmap kernel;
 * "after" is the pass-count grid (glow + crisp lines) with the shared style
 * constants from `@core/heat/heatStyle`. The basemap is a flat fill: this
 * judges the heat layer, not the map under it.
 */
import { simplifyTrack } from '@core/geo/track/simplify';
import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import {
  buildHeatGrid,
  CellGrid,
  HEAT_LINE_CELL_M,
  heatGlowPoints,
  heatGridLines,
  walkTrackCells,
} from '@core/heat/heatGrid';
import {
  HEAT_LINE_RAMP_DARK,
  HEAT_LINE_RAMP_LIGHT,
  HEAT_LINE_WIDTH_STOPS,
  heatGlowOpacity,
  heatLineOpacity,
  heatLineWidthFactor,
  interpolateStops,
  rampColor,
} from '@core/heat/heatStyle';
import * as fs from 'fs';
import * as path from 'path';

const OUT = process.env.RENDER_HEAT;
const d = OUT ? describe : describe.skip;
jest.setTimeout(600_000);

const W = 720;
const H = 1100;
const CENTER = { lng: -71.2, lat: 46.81 };

type RGB = [number, number, number];
const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

class Canvas {
  data: Float32Array;
  constructor(bg: RGB) {
    this.data = new Float32Array(W * H * 3);
    for (let i = 0; i < W * H; i++) this.data.set(bg, i * 3);
  }
  blend(x: number, y: number, c: RGB, a: number) {
    if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
    const i = (y * W + x) * 3;
    for (let k = 0; k < 3; k++) {
      this.data[i + k] = (this.data[i + k] as number) * (1 - a) + (c[k] as number) * a;
    }
  }
  segment(ax: number, ay: number, bx: number, by: number, width: number, c: RGB, alpha: number) {
    const r = width / 2 + 1;
    const minX = Math.floor(Math.min(ax, bx) - r);
    const maxX = Math.ceil(Math.max(ax, bx) + r);
    const minY = Math.floor(Math.min(ay, by) - r);
    const maxY = Math.ceil(Math.max(ay, by) + r);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let y = Math.max(0, minY); y <= Math.min(H - 1, maxY); y++) {
      for (let x = Math.max(0, minX); x <= Math.min(W - 1, maxX); x++) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        let t = len2 ? (px * dx + py * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const dist = Math.hypot(px - t * dx, py - t * dy);
        const cov = Math.max(0, Math.min(1, width / 2 + 0.5 - dist));
        this.blend(x, y, c, cov * alpha);
      }
    }
  }
  png(file: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PNG } = require('pngjs');
    const png = new PNG({ width: W, height: H });
    for (let i = 0; i < W * H; i++) {
      for (let k = 0; k < 3; k++) png.data[i * 4 + k] = Math.round(this.data[i * 3 + k] as number);
      png.data[i * 4 + 3] = 255;
    }
    fs.writeFileSync(file, PNG.sync.write(png));
  }
}

function project(zoom: number) {
  const scale = 256 * 2 ** zoom;
  const mx = (lng: number) => ((lng + 180) / 360) * scale;
  const my = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  };
  const cx = mx(CENTER.lng);
  const cy = my(CENTER.lat);
  return (lng: number, lat: number): [number, number] => [
    mx(lng) - cx + W / 2,
    my(lat) - cy + H / 2,
  ];
}

/** MapLibre-ish heatmap: gaussian kernels → density → colour ramp. */
function heatmapKernel(
  canvas: Canvas,
  pts: { x: number; y: number; w: number }[],
  radius: number,
  intensity: number,
  ramp: (d: number) => [RGB, number],
  opacity: number,
) {
  const dens = new Float32Array(W * H);
  const r = Math.ceil(radius);
  // MapLibre: weight * intensity * exp(-0.5 * (3 d / r)^2) / (2π·(r/3)^2)-ish; normalised
  // so a lone point peaks near 1 / 2π·… — use its GAUSS_COEF form.
  const coef = 1 / Math.sqrt(2 * Math.PI);
  for (const p of pts) {
    for (let y = Math.max(0, Math.floor(p.y - r)); y <= Math.min(H - 1, p.y + r); y++) {
      for (let x = Math.max(0, Math.floor(p.x - r)); x <= Math.min(W - 1, p.x + r); x++) {
        const d = Math.hypot(x - p.x, y - p.y) / radius;
        if (d > 1) continue;
        const i = y * W + x;
        dens[i] = (dens[i] as number) + p.w * intensity * coef * Math.exp(-0.5 * (3 * d) ** 2);
      }
    }
  }
  for (let i = 0; i < W * H; i++) {
    const dv = Math.min(1, dens[i] as number);
    if (dv <= 0) continue;
    const [c, a] = ramp(dv);
    canvas.blend(i % W, Math.floor(i / W), c, a * opacity);
  }
}

/** The pre-#466 heatmap-radius (exponential base 1.6 between these stops). */
function oldHeatRadiusPx(zoom: number): number {
  const stops: [number, number][] = [
    [6, 3],
    [10, 8],
    [13, 16],
    [16, 28],
  ];
  const first = stops[0] as [number, number];
  const last = stops[stops.length - 1] as [number, number];
  if (zoom <= first[0]) return first[1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [z1, r1] = stops[i] as [number, number];
    const [z0, r0] = stops[i - 1] as [number, number];
    if (zoom <= z1) return r0 + ((r1 - r0) * (1.6 ** (zoom - z0) - 1)) / (1.6 ** (z1 - z0) - 1);
  }
  return last[1];
}

const N = Number(process.env.RENDER_N ?? 400);
const lib = largeLibrary(N);

d('heatmap preview renders', () => {
  const geoms = lib.tracks.map((t, i) => ({
    id: t.id,
    parts: simplifyTrack(lib.points(i), lib.segmentStarts(i)).parts,
  }));

  // Old pipeline: every qualifying trail's full points, index-stepped to ~3000.
  const beforePoints: [number, number][] = [];
  {
    const counts = lib.tracks.map((t) => t.stats.pointCount);
    const total = counts.reduce((a, b) => a + b, 0);
    const step = Math.max(1, Math.ceil(total / 3000));
    for (let i = 0; i < N; i++) {
      const pts = lib.points(i);
      for (let k = 0; k < pts.length; k += step) {
        const p = pts[k];
        if (p) beforePoints.push([p.longitude, p.latitude]);
      }
    }
  }

  const grid = new CellGrid(HEAT_LINE_CELL_M);
  const heat = buildHeatGrid(
    geoms.map((g) => walkTrackCells(g, grid)),
    grid,
  );
  const lines = heatGridLines(heat);
  const glow = heatGlowPoints(heat);

  it.each([
    [10, 'light'],
    [14, 'light'],
    [10, 'dark'],
    [14, 'dark'],
    [16, 'light'],
  ] as const)('z%d %s', (zoom, theme) => {
    fs.mkdirSync(OUT as string, { recursive: true });
    const bg: RGB = theme === 'light' ? [238, 234, 224] : [30, 32, 36];
    const proj = project(zoom);

    // BEFORE
    const before = new Canvas(bg);
    heatmapKernel(
      before,
      beforePoints.map(([lng, lat]) => {
        const [x, y] = proj(lng, lat);
        return { x, y, w: 1 };
      }),
      oldHeatRadiusPx(zoom),
      interpolateStops(
        [
          [6, 0.4],
          [16, 1],
        ],
        zoom,
      ),
      (dv) => {
        const stops: [number, number][] = [
          [0, 0],
          [0.15, 0],
          [0.4, 0.18],
          [0.7, 0.35],
          [1, 0.55],
        ];
        return [[255, 130, 0], interpolateStops(stops, dv)];
      },
      interpolateStops(
        [
          [0, 0.5],
          [15, 0.5],
          [18, 0.35],
        ],
        zoom,
      ),
    );
    before.png(path.join(OUT as string, `before-z${zoom}-${theme}.png`));

    // AFTER
    const after = new Canvas(bg);
    const ramp = theme === 'light' ? HEAT_LINE_RAMP_LIGHT : HEAT_LINE_RAMP_DARK;
    const glowOpacity = heatGlowOpacity(zoom);
    if (glowOpacity > 0) {
      heatmapKernel(
        after,
        glow.features.map((f) => {
          const [x, y] = proj(
            f.geometry.coordinates[0] as number,
            f.geometry.coordinates[1] as number,
          );
          return { x, y, w: 0.5 + Math.log2(f.properties.count) / 4 };
        }),
        interpolateStops(
          [
            [6, 2],
            [10, 5],
            [12, 9],
          ],
          zoom,
        ),
        1.2,
        (dv) => [hex(rampColor(ramp, 1 + dv * 30)), Math.min(1, 0.35 + dv)],
        glowOpacity,
      );
    }
    const lineOpacity = heatLineOpacity(zoom);
    const baseW = interpolateStops(HEAT_LINE_WIDTH_STOPS, zoom);
    for (const f of lines.features) {
      const c = hex(rampColor(ramp, f.properties.count));
      const w = baseW * heatLineWidthFactor(f.properties.count);
      for (const cs of f.geometry.coordinates) {
        for (let i = 1; i < cs.length; i++) {
          const a = cs[i - 1] as number[];
          const b = cs[i] as number[];
          const [ax, ay] = proj(a[0] as number, a[1] as number);
          const [bx, by] = proj(b[0] as number, b[1] as number);
          after.segment(ax, ay, bx, by, w, c, lineOpacity);
        }
      }
    }
    after.png(path.join(OUT as string, `after-z${zoom}-${theme}.png`));
    console.log(
      `z${zoom} ${theme}: before ${beforePoints.length} pts; after ${lines.features.length} line features ` +
        `(${lines.features.reduce((s, f) => s + f.geometry.coordinates.reduce((a, l) => a + l.length, 0), 0)} coords, ` +
        `${(JSON.stringify(lines).length / 1e6).toFixed(2)} MB), ` +
        `${glow.features.length} glow points`,
    );
  });
});
