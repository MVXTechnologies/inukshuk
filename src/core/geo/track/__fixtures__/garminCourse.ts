/**
 * Synthetic but realistic Garmin Connect COURSE exports (GPX 1.1), for the
 * "D+ over 4000 m" report: a ≈40 km mountain course with ≈1 500 m of real
 * climb, whose elevations are what a course planner writes — the terrain
 * model looked up at the nearest 30 m pixel for points a few metres apart.
 *
 * The terrain is analytic (a 35 % mountainside with rolling relief), so the
 * TRUE profile is known exactly; the course climbs it in switchbacks, comes
 * straight down and returns along the valley. The path meanders a few metres
 * either side of its line, as real trails do: harmless on the true profile,
 * but it makes the nearest-pixel elevations hop between pixel rows 10 m apart.
 */

const LAT0 = 45.9;
const LON0 = 6.85;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

/** Terrain height (m) at local metres east/north of the origin. */
export function terrainHeight(x: number, y: number): number {
  return 1000 + 0.35 * y + 25 * Math.sin(x / 450) + 15 * Math.cos(y / 300);
}

/** The terrain model a course planner samples: 30 m pixels, value at the centre. */
const PIXEL_M = 30;
function nearestPixelHeight(x: number, y: number): number {
  const cx = (Math.floor(x / PIXEL_M) + 0.5) * PIXEL_M;
  const cy = (Math.floor(y / PIXEL_M) + 0.5) * PIXEL_M;
  // Garmin writes float32-ish decimals ("1234.5999755859375").
  return Math.fround(Math.round(terrainHeight(cx, cy) * 10) / 10);
}

export interface CourseSample {
  latitude: number;
  longitude: number;
  /** The exact terrain height under the point. */
  trueEle: number;
  /** What the course file carries: the nearest 30 m pixel's height. */
  courseEle: number;
}

/** The course's line in local metres (before meandering). */
function courseVertices(): [number, number][] {
  const v: [number, number][] = [[0, 0]];
  // 1. Switchbacks up the mountainside: 50 legs of ±500 m east, +80 m north.
  let x = 0;
  let y = 0;
  for (let leg = 0; leg < 50; leg++) {
    x = leg % 2 === 0 ? 500 : 0;
    y += 80;
    v.push([x, y]);
  }
  // 2. Straight down the fall line, east of the switchbacks.
  v.push([1500, y]);
  v.push([1500, 0]);
  // 3. Back along the valley floor, a long detour east and home.
  v.push([6000, 0]);
  v.push([6000, -300]);
  v.push([0, -300]);
  v.push([0, 0]);
  return v;
}

/** Course points every `stepM` metres along the meandering line. */
export function garminCourseSamples(stepM = 8): CourseSample[] {
  const verts = courseVertices();
  const out: CourseSample[] = [];
  let s = 0;
  for (let i = 1; i < verts.length; i++) {
    const [x0, y0] = verts[i - 1]!;
    const [x1, y1] = verts[i]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / stepM));
    // Unit normal to the leg: the meander's direction.
    const nx = -(y1 - y0) / len;
    const ny = (x1 - x0) / len;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const wiggle = 6 * Math.sin((s + t * len) / 23) + 3 * Math.sin((s + t * len) / 9);
      const x = x0 + (x1 - x0) * t + nx * wiggle;
      const y = y0 + (y1 - y0) * t + ny * wiggle;
      out.push({
        latitude: LAT0 + y / M_PER_DEG_LAT,
        longitude: LON0 + x / M_PER_DEG_LON,
        trueEle: terrainHeight(x, y),
        courseEle: nearestPixelHeight(x, y),
      });
    }
    s += len;
  }
  const [lx, ly] = verts[verts.length - 1]!;
  out.push({
    latitude: LAT0 + ly / M_PER_DEG_LAT,
    longitude: LON0 + lx / M_PER_DEG_LON,
    trueEle: terrainHeight(lx, ly),
    courseEle: nearestPixelHeight(lx, ly),
  });
  return out;
}

export interface CourseGpxOptions {
  /** Which elevations the file carries (default: the course planner's). */
  ele?: 'course' | 'true' | 'none';
  /** Per-point `<time>` at a virtual-partner pace (default: none, like a route). */
  times?: boolean;
  /** Also export the line as a `<rte>` (some tools emit both). */
  withRoute?: boolean;
  /** Course points as `<wpt>` (with their own `<ele>`). */
  withCoursePoints?: boolean;
  stepM?: number;
}

const T0 = Date.UTC(2026, 8, 20, 7, 0, 0);

/** A Garmin Connect course export (GPX 1.1, TrackPointExtension namespace). */
export function garminCourseGpx(opts: CourseGpxOptions = {}): string {
  const samples = garminCourseSamples(opts.stepM);
  const ele = opts.ele ?? 'course';
  const eleOf = (p: CourseSample) =>
    ele === 'none' ? '' : `<ele>${ele === 'true' ? p.trueEle.toFixed(1) : p.courseEle}</ele>`;
  // A virtual partner at 2.5 m/s, times on whole seconds.
  let d = 0;
  const trkpts = samples
    .map((p, i) => {
      const prev = samples[i - 1];
      if (prev) {
        d += Math.hypot(
          (p.latitude - prev.latitude) * M_PER_DEG_LAT,
          (p.longitude - prev.longitude) * M_PER_DEG_LON,
        );
      }
      const time = opts.times
        ? `<time>${new Date(T0 + Math.round(d / 2.5) * 1000).toISOString()}</time>`
        : '';
      return `<trkpt lat="${p.latitude.toFixed(7)}" lon="${p.longitude.toFixed(7)}">${eleOf(p)}${time}</trkpt>`;
    })
    .join('\n      ');
  const top = samples.reduce((a, b) => (b.courseEle > a.courseEle ? b : a));
  const wpts = opts.withCoursePoints
    ? `<wpt lat="${top.latitude.toFixed(7)}" lon="${top.longitude.toFixed(7)}"><ele>${top.courseEle}</ele><name>Summit</name><sym>Summit</sym><type>SUMMIT</type></wpt>
  <wpt lat="${samples[0]!.latitude.toFixed(7)}" lon="${samples[0]!.longitude.toFixed(7)}"><ele>0.0</ele><name>Water</name><type>WATER</type></wpt>
  `
    : '';
  const rte = opts.withRoute
    ? `<rte><name>Mountain course</name>${samples
        .map(
          (p) =>
            `<rtept lat="${p.latitude.toFixed(7)}" lon="${p.longitude.toFixed(7)}">${eleOf(p)}</rtept>`,
        )
        .join('')}</rte>
  `
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="Garmin Connect" version="1.1" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/11.xsd" xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns2="http://www.garmin.com/xmlschemas/GpxExtensions/v3">
  <metadata>
    <name>Mountain course</name>
    <link href="connect.garmin.com"><text>Garmin Connect</text></link>
    <time>${new Date(T0).toISOString()}</time>
  </metadata>
  ${wpts}${rte}<trk>
    <name>Mountain course</name>
    <trkseg>
      ${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}
