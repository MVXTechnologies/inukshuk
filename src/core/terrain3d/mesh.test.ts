import {
  ATTRIBUTES_PER_VERTEX,
  bakeHeights,
  bakeSlopes,
  buildGridIndices,
  buildGridVertices,
  coarsen,
  coarseSurface,
  gridIndex,
  gridVertexCount,
  packAttributes,
  parentSurfaceForChild,
  skirtDepth,
  skirtSource,
  surfaceAt,
  triangleCount,
  vertexCount,
} from './mesh';
import { rng } from './testUtils';

const SIZES = [2, 4, 8, 16, 32];

describe.each(SIZES)('grid n = %p', (n) => {
  const verts = buildGridVertices(n);
  const idx = buildGridIndices(n);

  it('has the advertised vertex and triangle counts', () => {
    expect(verts.length).toBe(vertexCount(n) * 3);
    expect(idx.length).toBe(triangleCount(n) * 3);
    expect(vertexCount(n)).toBe((n + 1) ** 2 + 4 * (n + 1));
  });

  it('indexes only existing vertices', () => {
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(vertexCount(n));
    }
  });

  it('every grid triangle has non-zero area in (u, v)', () => {
    const g = 2 * n * n;
    for (let t = 0; t < g; t++) {
      const [a, b, c] = [idx[t * 3]!, idx[t * 3 + 1]!, idx[t * 3 + 2]!];
      const ax = verts[a * 3]!,
        ay = verts[a * 3 + 1]!;
      const area =
        (verts[b * 3]! - ax) * (verts[c * 3 + 1]! - ay) -
        (verts[c * 3]! - ax) * (verts[b * 3 + 1]! - ay);
      expect(Math.abs(area)).toBeGreaterThan(0);
    }
  });

  it('the grid triangles tile the unit square exactly once', () => {
    let total = 0;
    for (let t = 0; t < 2 * n * n; t++) {
      const [a, b, c] = [idx[t * 3]!, idx[t * 3 + 1]!, idx[t * 3 + 2]!];
      const ax = verts[a * 3]!,
        ay = verts[a * 3 + 1]!;
      total +=
        Math.abs(
          (verts[b * 3]! - ax) * (verts[c * 3 + 1]! - ay) -
            (verts[c * 3]! - ax) * (verts[b * 3 + 1]! - ay),
        ) / 2;
    }
    expect(total).toBeCloseTo(1, 9);
  });

  it('grid vertices are in row-major u/v order, skirts flagged', () => {
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const k = gridIndex(n, i, j);
        expect(verts[k * 3]).toBeCloseTo(i / n, 9);
        expect(verts[k * 3 + 1]).toBeCloseTo(j / n, 9);
        expect(verts[k * 3 + 2]).toBe(0);
      }
    }
    for (let k = gridVertexCount(n); k < vertexCount(n); k++) expect(verts[k * 3 + 2]).toBe(1);
  });

  it('each skirt vertex sits exactly on the edge vertex it copies', () => {
    for (let k = gridVertexCount(n); k < vertexCount(n); k++) {
      const s = skirtSource(n, k);
      expect(verts[k * 3]).toBe(verts[s * 3]);
      expect(verts[k * 3 + 1]).toBe(verts[s * 3 + 1]);
      const u = verts[s * 3]!;
      const v = verts[s * 3 + 1]!;
      expect(u === 0 || u === 1 || v === 0 || v === 1).toBe(true);
    }
  });

  it('skirt triangles each join two edge vertices and a dropped copy', () => {
    for (let t = 2 * n * n; t < triangleCount(n); t++) {
      const tri = [idx[t * 3]!, idx[t * 3 + 1]!, idx[t * 3 + 2]!];
      const skirts = tri.filter((v) => v >= gridVertexCount(n)).length;
      expect(skirts === 1 || skirts === 2).toBe(true);
    }
  });
});

describe('coarse surface = parent surface (morph continuity)', () => {
  const n = 32;
  const r = rng(7);
  const parentHeights = Float32Array.from({ length: gridVertexCount(n) }, () => r() * 3000 + 500);
  const quads: [number, number][] = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  it.each(quads)('quadrant (%p, %p): every child vertex lies on the parent triangles', (qx, qy) => {
    const child = parentSurfaceForChild(n, parentHeights, qx, qy);
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const u = (qx + i / n) / 2;
        const v = (qy + j / n) / 2;
        expect(child[gridIndex(n, i, j)]).toBeCloseTo(surfaceAt(n, parentHeights, u, v), 3);
      }
    }
  });

  it('a grid’s own coarse surface keeps its even vertices', () => {
    const h = Float32Array.from({ length: gridVertexCount(8) }, (_, k) => k * 1.5);
    const c = coarsen(8, h);
    for (let j = 0; j <= 8; j += 2) {
      for (let i = 0; i <= 8; i += 2) expect(c[gridIndex(8, i, j)]).toBe(h[gridIndex(8, i, j)]);
    }
  });

  it('the coarse surface of a plane is the plane', () => {
    const plane = (u: number, v: number) => 100 + 40 * u - 25 * v;
    const h = bakeHeights(16, plane);
    const c = coarsen(16, h);
    for (let k = 0; k < c.length; k++) expect(c[k]).toBeCloseTo(h[k]!, 3);
  });

  it('odd n is rejected', () => {
    expect(() => coarseSurface(3, () => 0)).toThrow();
  });
});

describe('baking', () => {
  it('bakes heights at vertex positions', () => {
    const h = bakeHeights(4, (u, v) => u * 10 + v * 100);
    expect(h[gridIndex(4, 0, 0)]).toBe(0);
    expect(h[gridIndex(4, 4, 0)]).toBe(10);
    expect(h[gridIndex(4, 2, 4)]).toBe(105);
  });

  it.each([
    [0, 0],
    [0.3, 0],
    [0, -0.5],
    [0.25, 0.75],
    [-1.2, 0.4],
  ])('slopes of a plane with gradient (%p, %p) m/m are exact', (gx, gy) => {
    const n = 8;
    const tileMeters = 4000;
    const cell = tileMeters / n;
    const f = (u: number, v: number) => 1500 + gx * u * tileMeters + gy * v * tileMeters;
    const s = bakeSlopes(n, f, cell);
    for (let k = 0; k < gridVertexCount(n); k++) {
      expect(s[k * 2]).toBeCloseTo(gx, 5);
      expect(s[k * 2 + 1]).toBeCloseTo(gy, 5);
    }
  });

  it('packs [hFrom, hTo, sx, sy] per vertex; skirts copy their edge', () => {
    const n = 4;
    const hTo = Float32Array.from({ length: gridVertexCount(n) }, (_, k) => k);
    const hFrom = Float32Array.from({ length: gridVertexCount(n) }, (_, k) => -k);
    const slopes = Float32Array.from({ length: gridVertexCount(n) * 2 }, (_, k) => k / 10);
    const a = packAttributes(n, hFrom, hTo, slopes);
    expect(a.length).toBe(vertexCount(n) * ATTRIBUTES_PER_VERTEX);
    const g = gridIndex(n, 3, 2);
    expect(Array.from(a.slice(g * 4, g * 4 + 4))).toEqual(
      [-g, g, slopes[g * 2]!, slopes[g * 2 + 1]!].map((x) => Math.fround(x)),
    );
    for (let k = gridVertexCount(n); k < vertexCount(n); k++) {
      const s = skirtSource(n, k);
      expect(a[k * 4 + 1]).toBe(hTo[s]);
    }
  });

  it.each([
    [100, 15],
    [1000, 30],
    [10000, 300],
    [1e6, 1500],
  ])('skirt depth for a %p m tile is %p m', (m, d) => {
    expect(skirtDepth(m)).toBeCloseTo(d, 9);
  });
});

describe('surfaceAt', () => {
  const n = 4;
  const h = Float32Array.from({ length: gridVertexCount(n) }, (_, k) => (k * 37) % 11);
  it('returns vertex heights at vertices', () => {
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        expect(surfaceAt(n, h, i / n, j / n)).toBeCloseTo(h[gridIndex(n, i, j)]!, 9);
      }
    }
  });
  it('follows the (i, j)–(i+1, j+1) diagonal at quad centres', () => {
    const a = h[gridIndex(n, 1, 1)]!;
    const d = h[gridIndex(n, 2, 2)]!;
    expect(surfaceAt(n, h, 1.5 / n, 1.5 / n)).toBeCloseTo((a + d) / 2, 9);
  });
  it('clamps outside [0, 1]', () => {
    expect(surfaceAt(n, h, -1, -1)).toBe(h[0]);
    expect(surfaceAt(n, h, 2, 2)).toBe(h[gridVertexCount(n) - 1]);
  });
});
