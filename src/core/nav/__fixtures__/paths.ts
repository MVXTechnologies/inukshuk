import type { LatLng } from '@core/models';

/**
 * Test-only path builders in local metres around Québec City (46.81 N,
 * 71.21 W), so a test can say "a switchback whose legs are 15 m apart" and
 * get real coordinates.
 */
const LAT0 = 46.8139;
const LON0 = -71.2082;
const M_PER_DEG_LAT = 111_195;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

/** A coordinate `x` m east and `y` m north of the origin. */
export function at(x: number, y: number): LatLng {
  return { latitude: LAT0 + y / M_PER_DEG_LAT, longitude: LON0 + x / M_PER_DEG_LON };
}

/** Densify the polyline through `corners` (metres) with a point every `stepM`. */
export function polyline(corners: readonly [number, number][], stepM = 5): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i]!;
    const [bx, by] = corners[i + 1]!;
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.round(len / stepM));
    for (let s = 0; s < steps; s++)
      out.push(at(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps));
  }
  const last = corners[corners.length - 1]!;
  out.push(at(last[0], last[1]));
  return out;
}

/**
 * A climb in `legs` switchbacks: each leg runs `legM` east or west, and the
 * next leg starts `gapM` further north. Legs are `gapM` apart as the crow
 * flies but `legM + gapM` apart along the trail.
 */
export function switchbacks(legs: number, legM: number, gapM: number, stepM = 5): LatLng[] {
  const corners: [number, number][] = [[0, 0]];
  for (let i = 0; i < legs; i++) {
    const x = i % 2 === 0 ? legM : 0;
    corners.push([x, i * gapM]);
    if (i + 1 < legs) corners.push([x, (i + 1) * gapM]);
  }
  return polyline(corners, stepM);
}

/** Deterministic Gaussian-ish noise (sum of uniforms) from a seeded LCG. */
export function noise(seed: number): () => number {
  let s = seed;
  const u = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return () => u() + u() + u() - 1.5;
}

/** Offset a coordinate by (dx, dy) metres. */
export function offset(p: LatLng, dx: number, dy: number): LatLng {
  return {
    latitude: p.latitude + dy / M_PER_DEG_LAT,
    longitude: p.longitude + dx / M_PER_DEG_LON,
  };
}
