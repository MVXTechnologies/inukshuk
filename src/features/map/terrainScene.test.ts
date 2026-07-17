import * as THREE from 'three';
import type { Heightmap } from './dem';
import {
  borderLoopIndices,
  buildTerrain,
  DRAPE_LIFT,
  drapePolyline,
  markerScaleForDistance,
  ribbonGeometryData,
} from './terrainScene';

// A small, flat heightmap is enough to exercise the planar project/unproject
// mapping (the x/z ↔ lng/lat transform is independent of elevation).
function flatHm(): Heightmap {
  const grid = 8;
  return {
    data: new Float32Array(grid * grid).fill(120),
    grid,
    bbox: { minLng: -73.62, maxLng: -73.5, minLat: 45.5, maxLat: 45.6 },
    range: { z: 14, minX: 0, maxX: 1, minY: 0, maxY: 1 },
    minH: 120,
    maxH: 120,
  };
}

describe('buildTerrain project/unproject', () => {
  it('round-trips lng/lat → scene x/z → lng/lat', () => {
    const { project, unproject } = buildTerrain(flatHm(), []);
    for (const [lng, lat] of [
      [-73.6, 45.52],
      [-73.55, 45.58],
      [-73.51, 45.5],
    ] as const) {
      const v = project(lng, lat);
      const back = unproject(v.x, v.z);
      expect(back.lng).toBeCloseTo(lng, 6);
      expect(back.lat).toBeCloseTo(lat, 6);
    }
  });

  it('maps the bbox centre to ~the scene origin', () => {
    const hm = flatHm();
    const { project } = buildTerrain(hm, []);
    const midLng = (hm.bbox.minLng + hm.bbox.maxLng) / 2;
    const midLat = (hm.bbox.minLat + hm.bbox.maxLat) / 2;
    const v = project(midLng, midLat);
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(0, 6);
  });

  it('exposes a surface height sampler (flat terrain → constant height)', () => {
    const { heightAt } = buildTerrain(flatHm(), []);
    // minH === maxH === 120 → the normalised surface sits at y = 0 everywhere.
    expect(heightAt(0, 0)).toBeCloseTo(0, 9);
    expect(heightAt(0.4, -0.3)).toBeCloseTo(0, 9);
    // Clamped outside the slab rather than exploding.
    expect(heightAt(99, -99)).toBeCloseTo(0, 9);
  });

  it('drapeLine builds a flat ribbon mesh for a 2-point path', () => {
    const { drapeLine } = buildTerrain(flatHm(), []);
    const mesh = drapeLine(
      [
        { x: -0.5, z: 0 },
        { x: 0.5, z: 0 },
      ],
      { color: 0xff0000, halfWidth: 0.005 },
    );
    expect(mesh).not.toBeNull();
    const pos = mesh!.geometry.getAttribute('position');
    // Densified down to the DEM cell size: many pairs of edge vertices, all
    // hugging the (flat) surface at the small anti-z-fighting lift.
    expect(pos.count).toBeGreaterThan(4);
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBeCloseTo(DRAPE_LIFT, 9);
  });

  it('drapeLine returns null for degenerate paths', () => {
    const { drapeLine } = buildTerrain(flatHm(), []);
    expect(drapeLine([], { color: 0xff0000, halfWidth: 0.005 })).toBeNull();
    expect(
      drapeLine(
        [
          { x: 0.1, z: 0.1 },
          { x: 0.1, z: 0.1 },
        ],
        { color: 0xff0000, halfWidth: 0.005 },
      ),
    ).toBeNull();
  });
});

describe('buildTerrain analytical overlays + skirt', () => {
  const terrainMesh = (b: ReturnType<typeof buildTerrain>) => b.group.children[0] as THREE.Mesh;
  const skirtMesh = (b: ReturnType<typeof buildTerrain>) => b.group.children[1] as THREE.Mesh;

  it('adds metre-space aElevM/aSlopeDeg attributes (flat → slope 0 everywhere)', () => {
    const hm = flatHm();
    const build = buildTerrain(hm, []);
    const geo = terrainMesh(build).geometry;
    const elev = geo.getAttribute('aElevM');
    const slope = geo.getAttribute('aSlopeDeg');
    expect(elev.count).toBe(hm.grid * hm.grid);
    expect(slope.count).toBe(hm.grid * hm.grid);
    for (let i = 0; i < elev.count; i++) {
      expect(elev.getX(i)).toBe(120); // raw metres, NOT the exaggerated mesh y
      expect(slope.getX(i)).toBe(0);
    }
  });

  it('adds a border skirt sharing the terrain material, dropped below the surface', () => {
    const build = buildTerrain(flatHm(), []);
    expect(build.group.children.length).toBe(2); // terrain + skirt (no trail line)
    const skirt = skirtMesh(build);
    expect(skirt.material).toBe(terrainMesh(build).material);
    const pos = skirt.geometry.getAttribute('position');
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
    }
    expect(maxY).toBeCloseTo(0, 9); // top ring on the (flat) surface
    expect(minY).toBeLessThan(0); // bottom ring extruded down
  });

  it('exposes an overlay uniforms handle by default, none when injection is off', () => {
    const hm = flatHm();
    const injected = buildTerrain(hm, []);
    expect(injected.overlay).not.toBeNull();
    expect(injected.overlay!.minH).toBe(hm.minH);
    expect(injected.overlay!.uniforms.uSlopeOpacity.value).toBe(0); // off until applied
    const plain = buildTerrain(hm, [], undefined, 1, { injectOverlays: false });
    expect(plain.overlay).toBeNull();
  });
});

describe('borderLoopIndices', () => {
  it('walks the 3×3 perimeter north→east→south→west without repeats', () => {
    expect(borderLoopIndices(3)).toEqual([0, 1, 2, 5, 8, 7, 6, 3]);
  });

  it('covers every border vertex of a larger grid exactly once', () => {
    const grid = 6;
    const loop = borderLoopIndices(grid);
    expect(loop.length).toBe(4 * (grid - 1));
    expect(new Set(loop).size).toBe(loop.length);
    for (const idx of loop) {
      const gx = idx % grid;
      const gy = Math.floor(idx / grid);
      expect(gx === 0 || gx === grid - 1 || gy === 0 || gy === grid - 1).toBe(true);
    }
  });
});

describe('drapePolyline', () => {
  const flat = () => 0;

  it('samples terrain height (+lift) at every point', () => {
    const slope = (x: number) => 2 * x;
    const pts = drapePolyline(
      [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
      ],
      slope,
      0.25,
      0.01,
    );
    for (const p of pts) expect(p.y).toBeCloseTo(2 * p.x + 0.01, 9);
  });

  it('densifies long segments so the line can follow undulations', () => {
    const pts = drapePolyline(
      [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
      ],
      flat,
      0.25,
    );
    expect(pts.length).toBe(5); // 0, .25, .5, .75, 1
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z);
      expect(seg).toBeLessThanOrEqual(0.25 + 1e-9);
    }
    // Endpoints preserved.
    expect(pts[0]).toMatchObject({ x: 0, z: 0 });
    expect(pts[pts.length - 1]).toMatchObject({ x: 1, z: 0 });
  });

  it('keeps short segments as-is and drops consecutive duplicates', () => {
    const pts = drapePolyline(
      [
        { x: 0, z: 0 },
        { x: 0, z: 0 },
        { x: 0.1, z: 0 },
      ],
      flat,
      0.25,
    );
    expect(pts.map((p) => [p.x, p.z])).toEqual([
      [0, 0],
      [0.1, 0],
    ]);
  });
});

describe('ribbonGeometryData', () => {
  const flat = () => 0;

  it('returns null for fewer than 2 points', () => {
    expect(ribbonGeometryData([], 0.01, flat)).toBeNull();
    expect(ribbonGeometryData([{ x: 0, y: 0, z: 0 }], 0.01, flat)).toBeNull();
  });

  it('lays a flat strip perpendicular to the path, on the surface', () => {
    const draped = drapePolyline(
      [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
      ],
      flat,
      10,
    );
    const data = ribbonGeometryData(draped, 0.01, flat, 0.002)!;
    // Two edge vertices per point, straddling the path along z (the horizontal
    // perpendicular of a +x path), each re-draped onto the surface + lift.
    expect(data.positions.length).toBe(draped.length * 6);
    expect(data.indices.length).toBe((draped.length - 1) * 6);
    for (let i = 0; i < draped.length; i++) {
      const [lx, ly, lz] = [
        data.positions[i * 6]!,
        data.positions[i * 6 + 1]!,
        data.positions[i * 6 + 2]!,
      ];
      const [rx, ry, rz] = [
        data.positions[i * 6 + 3]!,
        data.positions[i * 6 + 4]!,
        data.positions[i * 6 + 5]!,
      ];
      expect(lx).toBeCloseTo(rx, 9); // no spread along the path
      expect(Math.abs(rz - lz)).toBeCloseTo(0.02, 9); // full width across it
      expect(ly).toBeCloseTo(0.002, 9);
      expect(ry).toBeCloseTo(0.002, 9);
    }
  });

  it('orients the ribbon to the ground, not the camera: edge heights track the slope', () => {
    // Path along +x on terrain sloping in z: the two ribbon edges must sit at
    // *different* heights (lying on the slope), which a camera-facing or
    // vertical strip would not do.
    const slopeZ = (_x: number, z: number) => 5 * z;
    const draped = drapePolyline(
      [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
      ],
      slopeZ,
      10,
    );
    const data = ribbonGeometryData(draped, 0.01, slopeZ, 0)!;
    const lY = data.positions[1]!;
    const lZ = data.positions[2]!;
    const rY = data.positions[4]!;
    const rZ = data.positions[5]!;
    // Float32Array storage → ~7 significant digits of precision.
    expect(lY).toBeCloseTo(5 * lZ, 6);
    expect(rY).toBeCloseTo(5 * rZ, 6);
    expect(lY).not.toBeCloseTo(rY, 6);
  });
});

describe('markerScaleForDistance', () => {
  it('clamps at 1 from the reference distance outwards', () => {
    expect(markerScaleForDistance(1.6)).toBe(1);
    expect(markerScaleForDistance(9)).toBe(1);
  });

  it('shrinks proportionally as the camera closes in, down to a floor', () => {
    expect(markerScaleForDistance(0.8)).toBeCloseTo(0.5, 9);
    expect(markerScaleForDistance(0.1)).toBeCloseTo(0.35, 9);
    expect(markerScaleForDistance(0)).toBeCloseTo(0.35, 9);
    expect(markerScaleForDistance(Number.NaN)).toBeCloseTo(0.35, 9);
  });
});
