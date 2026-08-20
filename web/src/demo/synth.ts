import { buildGpx, type GpxWaypoint } from '@core/geo/gpx';
import { haversineMeters } from '@core/geo/geomath';
import type { TrackPoint } from '@core/models';

/**
 * Synthesize realistic Québec City recordings.
 *
 * WHY this exists, and why it is not two-point toy data: the owner's rule is
 * that demos and visual QA run on *realistic long Québec City runs*. A trail
 * card, an elevation profile and a trim slider all lie to you at small scale —
 * a 3-point track draws a straight profile, a 200 m "run" makes every stat tile
 * read the same width, and you cannot tell whether a card's meta row wraps.
 *
 * So each demo route is a short list of real anchor coordinates (streets,
 * riverside promenades, park loops) with hand-entered elevations, and this
 * module inflates it into a several-thousand-point recording: a Catmull-Rom
 * spline through the anchors, rolling micro-terrain, a grade-aware pace with
 * pauses, GPS jitter and a heart-rate series.
 *
 * The output is GPX TEXT, deliberately. It goes back through
 * `@core/geo/gpx#parseGpx` on the way in — the exact path a dropped file takes
 * — so the demo library and a real import are the same code path, and the
 * numbers on the cards come from `computeTrackStats` either way.
 */

/** A hand-placed point on the route: real coordinate, hand-read elevation. */
export interface RouteAnchor {
  lat: number;
  lng: number;
  /** Metres above sea level at this anchor. */
  ele: number;
}

export interface SynthOptions {
  name: string;
  anchors: readonly RouteAnchor[];
  /** Close the spline back to the first anchor (a loop, not an out-and-back). */
  loop: boolean;
  /** Target average moving pace in seconds per kilometre, on the flat. */
  paceSecPerKm: number;
  /** Epoch ms of the first fix. Pass 0 for an untimed (planned-route) GPX. */
  startedAt: number;
  /** Deterministic seed — the same route always synthesizes identically. */
  seed: number;
  /** Named markers, positioned by ratio (0..1) along the route. */
  waypoints?: readonly { at: number; name: string; note?: string }[];
  /** Amplitude of the rolling micro-terrain, in metres. 0 disables it. */
  rollM?: number;
  /** Resting heart rate baseline; omit for no HR series. */
  restHr?: number;
}

/* ------------------------------------------------------------------ noise -- */

/** mulberry32 — 32 bits of state, uniform enough, and identical everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Smooth 1-D noise in [-1, 1] built from four incommensurable sinusoids.
 *
 * Value noise with interpolation would be the textbook answer; this is cheaper
 * and, more importantly, C-infinity — a kink in the elevation series shows up
 * as a visible corner on a 64-sample profile, which would be an artefact of the
 * generator rather than of the terrain.
 */
function wobble(x: number, phase: number): number {
  return (
    0.5 * Math.sin(x * 1.0 + phase) +
    0.28 * Math.sin(x * 2.37 + phase * 1.7) +
    0.14 * Math.sin(x * 5.11 + phase * 0.3) +
    0.08 * Math.sin(x * 9.73 + phase * 2.9)
  );
}

/* ----------------------------------------------------------------- spline -- */

/** Catmull-Rom on one component. `t` is the local 0..1 parameter of p1→p2. */
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

interface Densified {
  lat: number[];
  lng: number[];
  ele: number[];
  /** Cumulative ground distance to each sample, metres. */
  dist: number[];
}

/**
 * Densify the anchor polyline into a smooth curve.
 *
 * Anchors are typically 200–900 m apart; 24 spline steps per segment puts a
 * sample every ~10–40 m, which is finer than the walk below ever needs. The
 * walk then resamples by *time*, so this only has to be dense enough that
 * linear interpolation between two of these samples is indistinguishable from
 * the curve.
 */
function densify(anchors: readonly RouteAnchor[], loop: boolean): Densified {
  const n = anchors.length;
  const at = (i: number): RouteAnchor =>
    loop ? anchors[((i % n) + n) % n]! : anchors[Math.max(0, Math.min(n - 1, i))]!;

  const lat: number[] = [];
  const lng: number[] = [];
  const ele: number[] = [];
  const segments = loop ? n : n - 1;
  const STEPS = 24;

  for (let i = 0; i < segments; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < STEPS; s++) {
      const t = s / STEPS;
      lat.push(catmull(p0.lat, p1.lat, p2.lat, p3.lat, t));
      lng.push(catmull(p0.lng, p1.lng, p2.lng, p3.lng, t));
      ele.push(catmull(p0.ele, p1.ele, p2.ele, p3.ele, t));
    }
  }
  // Close the ring / land exactly on the final anchor.
  const end = loop ? at(0) : at(n - 1);
  lat.push(end.lat);
  lng.push(end.lng);
  ele.push(end.ele);

  const dist: number[] = new Array(lat.length);
  dist[0] = 0;
  for (let i = 1; i < lat.length; i++) {
    dist[i] =
      dist[i - 1]! +
      haversineMeters(
        { latitude: lat[i - 1]!, longitude: lng[i - 1]! },
        { latitude: lat[i]!, longitude: lng[i]! },
      );
  }
  return { lat, lng, ele, dist };
}

/** Linear lookup of the densified curve at a distance along it. */
function sampleAt(
  d: Densified,
  target: number,
  cursor: number,
): { lat: number; lng: number; ele: number; cursor: number } {
  let i = cursor;
  while (i < d.dist.length - 2 && d.dist[i + 1]! < target) i++;
  const d0 = d.dist[i]!;
  const d1 = d.dist[i + 1]!;
  const t = d1 === d0 ? 0 : (target - d0) / (d1 - d0);
  return {
    lat: d.lat[i]! + (d.lat[i + 1]! - d.lat[i]!) * t,
    lng: d.lng[i]! + (d.lng[i + 1]! - d.lng[i]!) * t,
    ele: d.ele[i]! + (d.ele[i + 1]! - d.ele[i]!) * t,
    cursor: i,
  };
}

/* ------------------------------------------------------------------- walk -- */

/** Metres of latitude per degree — good to ~0.1% anywhere on Earth. */
const M_PER_DEG_LAT = 111_320;

/**
 * Grade-adjusted speed multiplier, the shape every pace calculator agrees on:
 * a climb costs far more than the matching descent gives back, and past about
 * -10% a descent starts costing again (braking).
 *
 * Piecewise and deliberately gentle. An early version used a steeper uphill
 * penalty and it dragged the demo hikes below `computeTrackStats`'s 0.5 m/s
 * moving-time threshold for most of every climb, which made moving time read
 * as a third of elapsed — a generator artefact that would have looked like a
 * bug in the stats.
 */
function gradeFactor(grade: number): number {
  const g = Math.max(-0.22, Math.min(0.22, grade));
  if (g >= 0) return 1 / (1 + 6.5 * g);
  if (g >= -0.1) return 1 - 2.2 * g;
  return 1.22 - 3 * (-g - 0.1);
}

/**
 * Turn a route description into a recorded point series.
 *
 * The walk is by wall-clock second, not by distance: that is what a phone does,
 * and it is what makes moving time, pauses and `avgSpeedMps` come out
 * realistic. Pauses are inserted at a handful of pseudo-random distances (a
 * light, a gate, a photo) so `movingTimeS` is genuinely below `durationS` and
 * the Library's two time readings differ the way they do on a real card.
 */
export function synthPoints(opts: SynthOptions): TrackPoint[] {
  const rand = rng(opts.seed);
  const curve = densify(opts.anchors, opts.loop);
  const total = curve.dist[curve.dist.length - 1]!;
  const rollM = opts.rollM ?? 4;
  const phase = rand() * 100;

  // Fixed pause distances, so the same seed always stops in the same places.
  const pauses = Array.from({ length: 3 + Math.floor(rand() * 3) }, () => ({
    atM: (0.1 + rand() * 0.8) * total,
    seconds: 20 + Math.floor(rand() * 100),
    done: false,
  })).sort((a, b) => a.atM - b.atM);

  const points: TrackPoint[] = [];
  const untimed = opts.startedAt === 0;
  let travelled = 0;
  let cursor = 0;
  let t = 0;
  // Effort drifts over a long run: the last third is genuinely slower.
  const fatigue = 0.06 + rand() * 0.08;
  let hr = opts.restHr ?? 0;

  // Untimed "planned route" GPX: no clock at all, just geometry every ~15 m.
  const stepMode = untimed ? 'distance' : 'time';

  while (travelled < total) {
    const s = sampleAt(curve, travelled, cursor);
    cursor = s.cursor;

    // Rolling micro-terrain on top of the anchor interpolation: real ground is
    // never a straight ramp between two survey points. Wavelengths are hundreds
    // of metres, and `computeTrackStats` applies a 3 m hysteresis, so this adds
    // believable D+ instead of GPS-noise garbage.
    const roll = rollM * wobble(travelled / 260, phase);
    const elevation = s.ele + roll;

    // GPS jitter: a smooth lateral wander of a couple of metres, not white
    // noise — a consumer receiver's error is strongly autocorrelated, and white
    // noise here would visibly fatten the drawn line at high zoom.
    const jitterM = 2.2 * wobble(travelled / 40, phase + 11);
    const dLat = (jitterM / M_PER_DEG_LAT) * Math.cos(travelled / 17);
    const dLng =
      (jitterM / (M_PER_DEG_LAT * Math.cos((s.lat * Math.PI) / 180))) * Math.sin(travelled / 17);

    // Local grade, read a little ahead so the pace responds before the climb.
    const ahead = sampleAt(curve, Math.min(total, travelled + 40), cursor);
    const grade = (ahead.ele - s.ele) / 40;

    const flatSpeed = 1000 / opts.paceSecPerKm;
    const drift =
      1 + 0.07 * wobble(travelled / 900, phase + 5) - fatigue * (travelled / total) ** 2;
    const speed = Math.max(0.4, flatSpeed * gradeFactor(grade) * drift);

    const point: TrackPoint = {
      latitude: s.lat + dLat,
      longitude: s.lng + dLng,
      altitude: Math.round(elevation * 10) / 10,
      time: untimed ? 0 : opts.startedAt + Math.round(t * 1000),
      accuracy: Math.round((4 + 3 * (1 + wobble(travelled / 600, phase + 3))) * 10) / 10,
    };

    if (!untimed) {
      point.speed = Math.round(speed * 100) / 100;
      if (opts.restHr !== undefined) {
        // First-order lag toward the effort's steady-state HR, so the series
        // ramps at the start and lags the hills the way a chest strap does.
        const targetHr = opts.restHr + 62 * (speed / flatSpeed) + 340 * Math.max(0, grade);
        hr += (targetHr - hr) * 0.03;
        point.heartRateBpm = Math.round(hr);
      }
    }
    points.push(point);

    if (stepMode === 'distance') {
      travelled += 15;
      continue;
    }

    // One fix per second, plus any pause that falls in this step.
    travelled += speed;
    t += 1;
    for (const p of pauses) {
      if (!p.done && travelled >= p.atM) {
        p.done = true;
        t += p.seconds;
      }
    }
  }

  // Land the recording exactly on the last anchor.
  const last = sampleAt(curve, total, cursor);
  points.push({
    latitude: last.lat,
    longitude: last.lng,
    altitude: Math.round(last.ele * 10) / 10,
    time: untimed ? 0 : opts.startedAt + Math.round(t * 1000),
    accuracy: 5,
    ...(untimed ? {} : { speed: 0 }),
  });

  return points;
}

/** The route's `<wpt>` markers, placed by ratio along the densified curve. */
function synthWaypoints(opts: SynthOptions): GpxWaypoint[] {
  if (opts.waypoints === undefined || opts.waypoints.length === 0) return [];
  const curve = densify(opts.anchors, opts.loop);
  const total = curve.dist[curve.dist.length - 1]!;
  let cursor = 0;
  return opts.waypoints.map((w) => {
    const s = sampleAt(curve, Math.max(0, Math.min(1, w.at)) * total, cursor);
    cursor = s.cursor;
    const out: GpxWaypoint = { latitude: s.lat, longitude: s.lng, name: w.name };
    if (w.note !== undefined) out.description = w.note;
    return out;
  });
}

/**
 * The whole route as a GPX 1.1 document, serialized by `@core/geo/gpx#buildGpx`.
 *
 * Round-tripping through text rather than handing the UI a `TrackPoint[]`
 * directly is the point: the demo library is then produced by exactly the
 * import path a dropped file takes, so anything that would break a real GPX
 * import breaks the demo seed too, loudly, on the first load.
 */
export function synthGpx(opts: SynthOptions): string {
  const points = synthPoints(opts);
  return buildGpx({
    points,
    metadata: {
      name: opts.name,
      time: opts.startedAt === 0 ? undefined : opts.startedAt,
      creator: 'Inukshuk playground (synthetic)',
    },
    waypoints: synthWaypoints(opts),
  });
}
