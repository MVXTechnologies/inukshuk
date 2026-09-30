import type { TrackPoint, TrackSummary } from '@core/models';

/**
 * Test-only: a deterministic, realistic large library — N Strava-style
 * activities around Québec City, 1 fix per second, 0.6–4 h each (≈2k–15k
 * points), on a dozen shared corridors so heat genuinely builds up. Tracks
 * are generated on demand (`points(i)`) so a 400-trail benchmark never has to
 * hold every trail's points at once unless the code under test does.
 *
 * Geometry: the corridor waypoints of `scripts/store/gen-demo-runs.py`,
 * densified and bent with low-frequency wiggle (streets are not straight
 * lines), ridden back and forth until the activity's duration is used, with
 * coherent GPS drift of 2–5 m.
 */

type Corridor = { category: 'run' | 'bike' | 'hike'; speed: number; wps: [number, number][] };

const CORRIDORS: Corridor[] = [
  {
    category: 'run',
    speed: 3.0,
    wps: [
      [46.8046, -71.2168],
      [46.8003, -71.2139],
      [46.7978, -71.22],
      [46.8008, -71.2262],
      [46.8046, -71.2168],
    ],
  },
  {
    category: 'run',
    speed: 2.9,
    wps: [
      [46.8117, -71.2041],
      [46.8074, -71.2052],
      [46.8012, -71.2138],
      [46.7986, -71.2215],
      [46.8057, -71.22],
      [46.8104, -71.2093],
    ],
  },
  {
    category: 'bike',
    speed: 5.6,
    wps: [
      [46.7893, -71.2355],
      [46.779, -71.256],
      [46.77, -71.275],
    ],
  },
  {
    category: 'run',
    speed: 3.1,
    wps: [
      [46.8166, -71.2236],
      [46.8199, -71.2345],
      [46.818, -71.247],
      [46.813, -71.256],
      [46.8175, -71.244],
      [46.8166, -71.2236],
    ],
  },
  {
    category: 'bike',
    speed: 6.0,
    wps: [
      [46.8225, -71.231],
      [46.84, -71.242],
      [46.86, -71.253],
    ],
  },
  {
    category: 'hike',
    speed: 1.3,
    wps: [
      [46.8133, -71.208],
      [46.8127, -71.2143],
      [46.8098, -71.2105],
      [46.8117, -71.2041],
      [46.813, -71.203],
      [46.8133, -71.208],
    ],
  },
  {
    category: 'hike',
    speed: 1.4,
    wps: [
      [46.7907, -71.232],
      [46.7878, -71.238],
      [46.7835, -71.245],
    ],
  },
  {
    category: 'bike',
    speed: 5.2,
    wps: [
      [46.819, -71.2075],
      [46.826, -71.203],
      [46.8385, -71.1975],
    ],
  },
  {
    category: 'run',
    speed: 3.0,
    wps: [
      [46.829, -71.22],
      [46.8335, -71.2135],
      [46.836, -71.208],
    ],
  },
  {
    category: 'run',
    speed: 3.2,
    wps: [
      [46.8175, -71.2236],
      [46.829, -71.22],
      [46.844, -71.2185],
      [46.836, -71.208],
      [46.8175, -71.2236],
    ],
  },
  {
    category: 'run',
    speed: 3.5,
    wps: [
      [46.8104, -71.2093],
      [46.8057, -71.22],
      [46.801, -71.232],
    ],
  },
  {
    category: 'bike',
    speed: 6.5,
    wps: [
      [46.8, -71.3],
      [46.83, -71.33],
      [46.87, -71.36],
      [46.9, -71.34],
    ],
  },
];

const M_PER_DEG = 111_320;
const LAT0 = 46.81;
const M_PER_DEG_LNG = M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180);

/** mulberry32 — tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Corridor polyline in local metres, densified every ~20 m with street-ish wiggle. */
function corridorPath(c: Corridor, seed: number): { x: number; y: number }[] {
  const r = rng(seed);
  const out: { x: number; y: number }[] = [];
  for (let w = 0; w + 1 < c.wps.length; w++) {
    const a = c.wps[w];
    const b = c.wps[w + 1];
    if (!a || !b) continue;
    const ax = (a[1] + 71.2) * M_PER_DEG_LNG;
    const ay = (a[0] - LAT0) * M_PER_DEG;
    const bx = (b[1] + 71.2) * M_PER_DEG_LNG;
    const by = (b[0] - LAT0) * M_PER_DEG;
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / 20));
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const phase = r() * 6.28;
    const amp = 15 + r() * 25;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const off = amp * Math.sin(phase + t * 9) * Math.sin(Math.PI * t);
      out.push({ x: ax + (bx - ax) * t + nx * off, y: ay + (by - ay) * t + ny * off });
    }
  }
  const last = c.wps[c.wps.length - 1];
  if (last) out.push({ x: (last[1] + 71.2) * M_PER_DEG_LNG, y: (last[0] - LAT0) * M_PER_DEG });
  return out;
}

const PATHS = CORRIDORS.map((c, i) => corridorPath(c, 1000 + i));

export interface LargeLibrary {
  tracks: TrackSummary[];
  /** The trail's full-resolution fixes (regenerated deterministically per call). */
  points: (index: number) => TrackPoint[];
  /** Pause boundaries of `points(index)` (a mid-activity stop every other trail). */
  segmentStarts: (index: number) => number[];
}

function spec(i: number) {
  const r = rng(7 + i * 7919);
  const corridor = CORRIDORS[i % CORRIDORS.length] as Corridor;
  // 0.6–4 h, skewed toward ~1.5 h like a real activity history.
  const hours = 0.6 + 3.4 * Math.pow(r(), 1.8);
  return { corridorIndex: i % CORRIDORS.length, corridor, count: Math.round(hours * 3600), r };
}

/** Street-lattice node → local metres (a rotated grid like Québec's, bent a little). */
const BLOCK_M = 110;
const THETA = (38 * Math.PI) / 180;
function nodeXY(u: number, v: number): { x: number; y: number } {
  // Deterministic per-node jitter so streets are not ruler-straight.
  const h = Math.sin(u * 12.9898 + v * 78.233) * 43758.5453;
  const jx = (h - Math.floor(h) - 0.5) * 18;
  const h2 = Math.sin(u * 39.3468 + v * 11.135) * 24634.6345;
  const jy = (h2 - Math.floor(h2) - 0.5) * 18;
  const gx = u * BLOCK_M + jx;
  const gy = v * BLOCK_M + jy;
  return {
    x: gx * Math.cos(THETA) - gy * Math.sin(THETA),
    y: gx * Math.sin(THETA) + gy * Math.cos(THETA),
  };
}

const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** A street route from home: a random walk with momentum that heads back in its second half. */
function streetRoute(seed: number, lengthM: number): { x: number; y: number }[] {
  const r = rng(seed);
  let u = 0;
  let v = 0;
  let dir = Math.floor(r() * 4);
  const nodes = [nodeXY(u, v)];
  const steps = Math.max(2, Math.round(lengthM / BLOCK_M));
  for (let s = 0; s < steps; s++) {
    const homeward = s > steps / 2;
    const roll = r();
    if (homeward && roll < 0.45) {
      // Turn toward home along the longer axis.
      dir = Math.abs(u) > Math.abs(v) ? (u > 0 ? 2 : 0) : v > 0 ? 3 : 1;
    } else if (roll < 0.25) dir = (dir + 1) % 4;
    else if (roll < 0.5) dir = (dir + 3) % 4;
    const d = DIRS[dir] as [number, number];
    u += d[0];
    v += d[1];
    nodes.push(nodeXY(u, v));
  }
  return nodes;
}

function generate(i: number, stepSec = 1): TrackPoint[] {
  const { corridorIndex, corridor, count, r } = spec(i);
  // Half the history repeats a dozen favourite routes (heat builds up); the
  // rest wanders the streets (single passes far from home), and every fifth
  // activity rides one of the long corridors.
  const speed = corridor.speed;
  const lengthM = count * speed;
  let path: { x: number; y: number }[];
  if (i % 5 === 4) path = PATHS[corridorIndex] ?? [];
  else if (i % 2 === 0) path = streetRoute(500 + (i % 12), lengthM);
  else path = streetRoute(90_000 + i, lengthM);
  const startT = Date.UTC(2025, 0, 1) + i * 86_400_000 * 0.9;
  const points: TrackPoint[] = [];
  let seg = 0;
  let segT = 0;
  let dir = 1;
  let driftX = 0;
  let driftY = 0;
  let fac = 1;
  for (let k = 0; k < count; k += stepSec) {
    fac = Math.min(1.2, Math.max(0.8, 1 + (fac - 1) * 0.99 + gauss(r) * 0.01));
    let step = speed * fac * stepSec;
    // Walk along the path, bouncing at the ends (out-and-back / laps).
    while (step > 0) {
      const a = path[seg];
      const b = path[seg + dir];
      if (!a || !b) {
        dir = -dir;
        segT = 0;
        if (!path[seg + dir]) break;
        continue;
      }
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const remain = (1 - segT) * len;
      if (step < remain) {
        segT += step / len;
        step = 0;
      } else {
        step -= remain;
        seg += dir;
        segT = 0;
      }
    }
    const a = path[seg] ?? { x: 0, y: 0 };
    const b = path[seg + dir] ?? a;
    driftX = driftX * 0.8 + gauss(r) * 1.6;
    driftY = driftY * 0.8 + gauss(r) * 1.6;
    const x = a.x + (b.x - a.x) * segT + driftX;
    const y = a.y + (b.y - a.y) * segT + driftY;
    points.push({
      latitude: LAT0 + y / M_PER_DEG,
      longitude: -71.2 + x / M_PER_DEG_LNG,
      altitude: 40 + 30 * Math.sin(x / 800) + 10 * Math.cos(y / 500),
      time: startT + k * 1000,
    });
  }
  return points;
}

/**
 * A deterministic library of `count` realistic activities. `stepSec` > 1
 * generates one fix every that many seconds along the same routes (fast CI
 * fixtures; the simplified geometry is nearly identical).
 */
export function largeLibrary(
  count: number,
  { stepSec = 1 }: { stepSec?: number } = {},
): LargeLibrary {
  const tracks: TrackSummary[] = [];
  for (let i = 0; i < count; i++) {
    const { corridor, count: n } = spec(i);
    const startedAt = Date.UTC(2025, 0, 1) + i * 86_400_000 * 0.9;
    tracks.push({
      id: `trk-${String(i).padStart(4, '0')}`,
      name: `Activity ${i}`,
      startedAt,
      endedAt: startedAt + (n - 1) * 1000,
      category: corridor.category,
      fileUri: `file:///doc/tracks/trk-${i}.gpx`,
      origin: { source: 'strava', externalId: String(100000 + i) },
      stats: {
        distanceM: Math.round(n * corridor.speed),
        ascentM: 50,
        descentM: 50,
        durationS: n - 1,
        movingTimeS: n - 1,
        avgSpeedMps: corridor.speed,
        maxSpeedMps: corridor.speed * 1.3,
        pointCount: n,
      },
    });
  }
  return {
    tracks,
    points: (i) => generate(i, stepSec),
    segmentStarts: (i) => {
      if (i % 2 === 0) return [];
      const { count: n } = spec(i);
      return [Math.floor(n / 2 / stepSec)];
    },
  };
}
