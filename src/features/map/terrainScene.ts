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
}

/** RGBA texture to drape over the terrain (e.g. stitched OSM tiles). */
export interface TerrainTexture {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Build a real 3D terrain mesh (displaced, lit) from a DEM heightmap, with the
 * GPX trace draped on the surface as a tube. Coloured by an optional draped
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

  const slabRadius = Math.max(spanXn, spanZn) * 1.15;
  let trailRadius = slabRadius;
  if (points.length >= 2) {
    const surface = points.map((p) => project(p.longitude, p.latitude));
    const segs = Math.min(1400, surface.length * 6);
    // A single red route line, hugging the surface and a touch thicker than a
    // hairline so it reads as a drawn track, not a thin floating wire. Shaded
    // (MeshStandard) with red emissive so it stays clearly red in shadow too.
    const curve = new THREE.CatmullRomCurve3(surface.map((v) => v.clone().setY(v.y + 0.0035)));
    const tube = new THREE.TubeGeometry(curve, segs, 0.0046, 8, false);
    group.add(
      new THREE.Mesh(
        tube,
        new THREE.MeshStandardMaterial({
          color: 0xe01b1b,
          emissive: 0x6a0a0a,
          emissiveIntensity: 0.6,
          roughness: 0.5,
        }),
      ),
    );
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
  };
}
