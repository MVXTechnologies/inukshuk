import { sampleGridBilinear } from '@core/geo/terrain';
import type { TrackPoint } from '@core/models';
import * as THREE from 'three';
import type { Heightmap } from './dem';

/** Hypsometric tint: low green → tan → brown → snow, by normalised elevation. */
function elevationColor(t: number, out: THREE.Color): void {
  const stops: [number, number, number][] = [
    [0.28, 0.42, 0.24],
    [0.55, 0.54, 0.32],
    [0.46, 0.36, 0.27],
    [0.92, 0.92, 0.92],
  ];
  const x = Math.max(0, Math.min(0.999, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

/** A point on the ground plane, in normalised scene units. */
export interface GroundPoint {
  x: number;
  z: number;
}

/** A ground point draped onto the terrain surface (y = surface height + lift). */
export interface DrapedPoint {
  x: number;
  y: number;
  z: number;
}

/** Terrain surface height (scene units, exaggeration applied) at a ground x/z. */
export type HeightSampler = (x: number, z: number) => number;

export interface TerrainBuild {
  group: THREE.Group;
  center: THREE.Vector3;
  /** Half-extent of the whole terrain slab (normalised units). */
  radius: number;
  /**
   * Half-extent of just the GPX trace (normalised units), so the camera can
   * frame the trail while the padded terrain fills the rest of the view. Falls
   * back to the slab radius when there is no trace.
   */
  trailRadius: number;
  /** Map a lng/lat to its position on the terrain surface (for markers). */
  project: (lng: number, lat: number) => THREE.Vector3;
  /**
   * Inverse of {@link project} on the ground plane: a scene x/z back to lng/lat.
   * Used to find which geographic point the camera is looking at while panning,
   * so the live view can re-anchor terrain around it.
   */
  unproject: (x: number, z: number) => { lng: number; lat: number };
  /** Terrain surface height at a ground x/z (scene units, exaggerated). */
  heightAt: HeightSampler;
  /**
   * Build a flat, terrain-hugging line mesh (a thin ribbon draped on the
   * surface) for a path given in ground-plane scene coords. Densification and
   * lift are matched to this terrain's DEM resolution. Returns null for
   * degenerate paths (fewer than 2 distinct points).
   */
  drapeLine: (path: readonly GroundPoint[], opts: DrapeLineOptions) => THREE.Mesh | null;
}

export interface DrapeLineOptions {
  color: number;
  /** Half the ribbon width, in normalised scene units. */
  halfWidth: number;
}

/** RGBA texture to drape over the terrain (e.g. stitched OSM tiles). */
export interface TerrainTexture {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Lift a draped line this far above the surface so it never z-fights it. */
export const DRAPE_LIFT = 0.003;

/**
 * Drape a ground-plane polyline onto the terrain: densify long segments (so the
 * line follows the surface's undulations *between* GPS fixes instead of cutting
 * straight through ridges and hollows) and sample the terrain height at every
 * point. Consecutive near-duplicate points are dropped so downstream tangent
 * maths never sees a zero-length segment.
 */
export function drapePolyline(
  path: readonly GroundPoint[],
  heightAt: HeightSampler,
  maxSegLen: number,
  lift = DRAPE_LIFT,
): DrapedPoint[] {
  const eps = Math.max(maxSegLen * 1e-3, 1e-9);
  const out: DrapedPoint[] = [];
  const push = (x: number, z: number) => {
    const last = out[out.length - 1];
    if (last && Math.hypot(x - last.x, z - last.z) < eps) return;
    out.push({ x, y: heightAt(x, z) + lift, z });
  };
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    const prev = i > 0 ? path[i - 1]! : null;
    if (prev) {
      const len = Math.hypot(p.x - prev.x, p.z - prev.z);
      const steps = Math.min(64, Math.ceil(len / Math.max(maxSegLen, 1e-9)));
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        push(prev.x + (p.x - prev.x) * f, prev.z + (p.z - prev.z) * f);
      }
    }
    push(p.x, p.z);
  }
  return out;
}

/**
 * Triangle-strip data for a flat ribbon laid on the terrain: each draped point
 * is extruded sideways along the *horizontal* perpendicular of the path
 * direction, and both edge vertices are re-sampled onto the surface — so the
 * ribbon lies flat on the local slope (oriented to the ground, never to the
 * camera) and reads as a 2D line painted on the map.
 */
export function ribbonGeometryData(
  draped: readonly DrapedPoint[],
  halfWidth: number,
  heightAt: HeightSampler,
  lift = DRAPE_LIFT,
): { positions: Float32Array; indices: number[] } | null {
  const n = draped.length;
  if (n < 2) return null;
  const positions = new Float32Array(n * 2 * 3);
  let tx = 1;
  let tz = 0;
  for (let i = 0; i < n; i++) {
    const prev = draped[Math.max(0, i - 1)]!;
    const next = draped[Math.min(n - 1, i + 1)]!;
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-12) {
      tx = dx / len;
      tz = dz / len;
    } // else: keep the previous tangent
    const px = -tz * halfWidth;
    const pz = tx * halfWidth;
    const p = draped[i]!;
    const lx = p.x - px;
    const lz = p.z - pz;
    const rx = p.x + px;
    const rz = p.z + pz;
    positions[i * 6] = lx;
    positions[i * 6 + 1] = heightAt(lx, lz) + lift;
    positions[i * 6 + 2] = lz;
    positions[i * 6 + 3] = rx;
    positions[i * 6 + 4] = heightAt(rx, rz) + lift;
    positions[i * 6 + 5] = rz;
  }
  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  return { positions, indices };
}

/**
 * Scale factor for a world-anchored marker: shrinks proportionally as the
 * camera closes in (so the marker never balloons to fill the screen) and clamps
 * at 1 so it keeps its designed world size from further away.
 */
export function markerScaleForDistance(dist: number, refDist = 1.6, minScale = 0.35): number {
  if (!Number.isFinite(dist) || dist <= 0) return minScale;
  return Math.min(1, Math.max(minScale, dist / refDist));
}

/**
 * Build the THREE mesh for a draped line: an unlit (flat-shaded, "painted on
 * the map") ribbon hugging the terrain, with a polygon offset on top of the
 * small lift so it never z-fights the surface at grazing angles.
 */
export function buildDrapedLineMesh(
  path: readonly GroundPoint[],
  heightAt: HeightSampler,
  maxSegLen: number,
  opts: DrapeLineOptions,
): THREE.Mesh | null {
  const draped = drapePolyline(path, heightAt, maxSegLen);
  const data = ribbonGeometryData(draped, opts.halfWidth, heightAt);
  if (!data) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geo.setIndex(data.indices);
  const material = new THREE.MeshBasicMaterial({
    color: opts.color,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return new THREE.Mesh(geo, material);
}

/**
 * Build a real 3D terrain mesh (displaced, lit) from a DEM heightmap, with the
 * GPX trace draped on the surface as a flat line. Coloured by an optional draped
 * texture, else a hypsometric tint. Normalised so its larger side spans 2 units.
 */
export function buildTerrain(
  hm: Heightmap,
  points: readonly TrackPoint[],
  texture?: TerrainTexture,
  maxAnisotropy = 1,
): TerrainBuild {
  const { data, grid, bbox, minH, maxH } = hm;
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((midLat * Math.PI) / 180);
  const spanXm = (bbox.maxLng - bbox.minLng) * mPerDegLng;
  const spanZm = (bbox.maxLat - bbox.minLat) * mPerDegLat;
  const scale = 2 / Math.max(spanXm, spanZm, 1);
  const spanXn = spanXm * scale;
  const spanZn = spanZm * scale;
  const vExag = 2.6;
  const yOf = (h: number) => (h - minH) * scale * vExag;
  const range = maxH - minH || 1;

  const project = (lng: number, lat: number): THREE.Vector3 => {
    const fx = (lng - bbox.minLng) / (bbox.maxLng - bbox.minLng || 1);
    const fyN = (bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat || 1);
    const h = sampleGridBilinear(data, grid, grid, fx, fyN);
    return new THREE.Vector3((fx - 0.5) * spanXn, yOf(h) + 0.02, (fyN - 0.5) * spanZn);
  };

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const heightAt: HeightSampler = (x, z) =>
    yOf(
      sampleGridBilinear(
        data,
        grid,
        grid,
        clamp01(x / (spanXn || 1) + 0.5),
        clamp01(z / (spanZn || 1) + 0.5),
      ),
    );

  const unproject = (x: number, z: number): { lng: number; lat: number } => {
    const fx = x / (spanXn || 1) + 0.5;
    const fyN = z / (spanZn || 1) + 0.5;
    return {
      lng: bbox.minLng + fx * (bbox.maxLng - bbox.minLng),
      lat: bbox.maxLat - fyN * (bbox.maxLat - bbox.minLat),
    };
  };

  const positions = new Float32Array(grid * grid * 3);
  const colors = new Float32Array(grid * grid * 3);
  const uvs = new Float32Array(grid * grid * 2);
  const color = new THREE.Color();
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const idx = gy * grid + gx;
      const h = data[idx]!;
      positions[idx * 3] = (gx / (grid - 1) - 0.5) * spanXn;
      positions[idx * 3 + 1] = yOf(h);
      positions[idx * 3 + 2] = (gy / (grid - 1) - 0.5) * spanZn;
      uvs[idx * 2] = gx / (grid - 1);
      uvs[idx * 2 + 1] = gy / (grid - 1);
      elevationColor((h - minH) / range, color);
      colors[idx * 3] = color.r;
      colors[idx * 3 + 1] = color.g;
      colors[idx * 3 + 2] = color.b;
    }
  }
  const indices: number[] = [];
  for (let gy = 0; gy < grid - 1; gy++) {
    for (let gx = 0; gx < grid - 1; gx++) {
      const a = gy * grid + gx;
      const b = a + 1;
      const c = a + grid;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  let material: THREE.MeshStandardMaterial;
  if (texture) {
    const tex = new THREE.DataTexture(
      new Uint8Array(texture.data),
      texture.width,
      texture.height,
      THREE.RGBAFormat,
    );
    // DataTexture defaults are point-sampled (NearestFilter), linear colour space
    // and anisotropy 1 — which makes the drape look blocky, washed-out and smeared
    // at the grazing angles a tilted terrain view is dominated by. Fix all three:
    // bilinear filtering, sRGB decode (tile bytes are sRGB), and max anisotropy.
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAnisotropy;
    tex.needsUpdate = true;
    material = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
  } else {
    material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  }

  const group = new THREE.Group();
  group.add(new THREE.Mesh(geo, material));

  // Densify draped lines down to the DEM cell size so they follow the surface.
  const cellSize = Math.max(spanXn, spanZn) / (grid - 1 || 1);
  const drapeLine = (path: readonly GroundPoint[], opts: DrapeLineOptions) =>
    buildDrapedLineMesh(path, heightAt, cellSize, opts);

  const slabRadius = Math.max(spanXn, spanZn) * 1.15;
  let trailRadius = slabRadius;
  if (points.length >= 2) {
    const surface = points.map((p) => project(p.longitude, p.latitude));
    // The route is a flat red line draped on the terrain — a thin ribbon hugging
    // the surface, unlit so it reads like a 2D line painted on the map rather
    // than a 3D tube floating above it.
    const line = drapeLine(
      surface.map((v) => ({ x: v.x, z: v.z })),
      { color: 0xe01b1b, halfWidth: 0.0045 },
    );
    if (line) group.add(line);
    // Half-extent of the trace on the ground plane, for camera framing.
    let r = 0;
    for (const p of surface) r = Math.max(r, Math.hypot(p.x, p.z));
    trailRadius = Math.max(r, slabRadius * 0.12);
  }

  return {
    group,
    center: new THREE.Vector3(0, (yOf(maxH) + yOf(minH)) / 2, 0),
    radius: slabRadius,
    trailRadius,
    project,
    unproject,
    heightAt,
    drapeLine,
  };
}
