/**
 * The terrain mesh: one shared regular grid (+ a skirt around its four
 * edges) reused by every tile, and per tile only a small height buffer
 * baked on the CPU.
 *
 * Vertex order: the (n+1)² grid row-major (row j = v, column i = u, v grows
 * SOUTH like world y), then four skirt rows of n+1 vertices — top (v = 0),
 * bottom (v = 1), left (u = 0), right (u = 1) — each a copy of its edge
 * vertex that the shader drops by the skirt depth.
 *
 * Quads are split along the (i, j)–(i+1, j+1) diagonal. That fixed choice
 * is what lets a child tile's "coarse" surface (its even vertices, linearly
 * interpolated the way the parent's triangles interpolate) equal the
 * parent's surface exactly — so a morph from coarse to fine starts from
 * precisely what was on screen.
 *
 * Per-vertex tile attributes: `[hFrom, hTo, slopeX, slopeY]` — the morph's
 * start and end heights (m) and the surface slope (m per m, x east, y south)
 * for the form lighting.
 */

export const ATTRIBUTES_PER_VERTEX = 4;

export function gridVertexCount(n: number): number {
  return (n + 1) * (n + 1);
}

export function skirtVertexCount(n: number): number {
  return 4 * (n + 1);
}

export function vertexCount(n: number): number {
  return gridVertexCount(n) + skirtVertexCount(n);
}

/** Triangle count of the grid plus skirts. */
export function triangleCount(n: number): number {
  return 2 * n * n + 4 * 2 * n;
}

/** Shared vertex buffer: `[u, v, skirt]` per vertex (skirt 1 = dropped copy). */
export function buildGridVertices(n: number): Float32Array {
  const out = new Float32Array(vertexCount(n) * 3);
  let k = 0;
  const put = (u: number, v: number, s: number) => {
    out[k++] = u;
    out[k++] = v;
    out[k++] = s;
  };
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) put(i / n, j / n, 0);
  for (let i = 0; i <= n; i++) put(i / n, 0, 1); // top
  for (let i = 0; i <= n; i++) put(i / n, 1, 1); // bottom
  for (let j = 0; j <= n; j++) put(0, j / n, 1); // left
  for (let j = 0; j <= n; j++) put(1, j / n, 1); // right
  return out;
}

/** Index of grid vertex (i, j). */
export function gridIndex(n: number, i: number, j: number): number {
  return j * (n + 1) + i;
}

/** Which grid vertex a skirt vertex copies (by position in the vertex buffer). */
export function skirtSource(n: number, k: number): number {
  const g = gridVertexCount(n);
  const e = k - g;
  const side = Math.floor(e / (n + 1));
  const t = e % (n + 1);
  switch (side) {
    case 0:
      return gridIndex(n, t, 0);
    case 1:
      return gridIndex(n, t, n);
    case 2:
      return gridIndex(n, 0, t);
    default:
      return gridIndex(n, n, t);
  }
}

/** Shared index buffer (triangles) for the grid and its skirts. */
export function buildGridIndices(n: number): Uint32Array {
  const out = new Uint32Array(triangleCount(n) * 3);
  let k = 0;
  const tri = (a: number, b: number, c: number) => {
    out[k++] = a;
    out[k++] = b;
    out[k++] = c;
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = gridIndex(n, i, j);
      const b = gridIndex(n, i + 1, j);
      const c = gridIndex(n, i, j + 1);
      const d = gridIndex(n, i + 1, j + 1);
      tri(a, c, d);
      tri(a, d, b);
    }
  }
  const g = gridVertexCount(n);
  const edges: [number, (t: number) => number][] = [
    [g, (t) => gridIndex(n, t, 0)],
    [g + (n + 1), (t) => gridIndex(n, t, n)],
    [g + 2 * (n + 1), (t) => gridIndex(n, 0, t)],
    [g + 3 * (n + 1), (t) => gridIndex(n, n, t)],
  ];
  for (const [base, src] of edges) {
    for (let t = 0; t < n; t++) {
      const e0 = src(t);
      const e1 = src(t + 1);
      const s0 = base + t;
      const s1 = base + t + 1;
      tri(e0, s0, e1);
      tri(e1, s0, s1);
    }
  }
  return out;
}

/**
 * Heights of the (n+1)² grid from a sampler over the tile's own [0, 1]²
 * (u east, v south).
 */
export function bakeHeights(n: number, sample: (u: number, v: number) => number): Float32Array {
  const out = new Float32Array(gridVertexCount(n));
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) out[gridIndex(n, i, j)] = sample(i / n, j / n);
  }
  return out;
}

/**
 * Slopes (m per m) by central differences over a ring one cell outside the
 * tile, so edge slopes match the neighbour's. `cellMeters` = ground metres
 * per grid cell. Returns `[sx, sy]` pairs per grid vertex.
 */
export function bakeSlopes(
  n: number,
  sample: (u: number, v: number) => number,
  cellMeters: number,
): Float32Array {
  const out = new Float32Array(gridVertexCount(n) * 2);
  const inv = 1 / (2 * cellMeters);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const v = j / n;
      const d = 1 / n;
      const sx = (sample(u + d, v) - sample(u - d, v)) * inv;
      const sy = (sample(u, v + d) - sample(u, v - d)) * inv;
      const k = gridIndex(n, i, j) * 2;
      out[k] = sx;
      out[k + 1] = sy;
    }
  }
  return out;
}

/**
 * The coarse surface a fine grid collapses to: even vertices kept, odd ones
 * interpolated the way a half-resolution grid with the same diagonal would.
 * `evenHeight(a, b)` gives the height at even vertex (2a, 2b).
 */
export function coarseSurface(
  n: number,
  evenHeight: (a: number, b: number) => number,
): Float32Array {
  if (n % 2 !== 0) throw new Error('coarseSurface: n must be even');
  const out = new Float32Array(gridVertexCount(n));
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      let h: number;
      if (i % 2 === 0 && j % 2 === 0) h = evenHeight(i / 2, j / 2);
      else if (i % 2 === 1 && j % 2 === 0)
        h = (evenHeight((i - 1) / 2, j / 2) + evenHeight((i + 1) / 2, j / 2)) / 2;
      else if (i % 2 === 0 && j % 2 === 1)
        h = (evenHeight(i / 2, (j - 1) / 2) + evenHeight(i / 2, (j + 1) / 2)) / 2;
      // Quad centre: on the (i−1, j−1)–(i+1, j+1) diagonal.
      else h = (evenHeight((i - 1) / 2, (j - 1) / 2) + evenHeight((i + 1) / 2, (j + 1) / 2)) / 2;
      out[gridIndex(n, i, j)] = h;
    }
  }
  return out;
}

/** A grid's own coarse surface (its even vertices). */
export function coarsen(n: number, heights: Float32Array): Float32Array {
  return coarseSurface(n, (a, b) => heights[gridIndex(n, 2 * a, 2 * b)]!);
}

/**
 * What the PARENT tile shows over this child's quadrant (qx, qy ∈ {0, 1}),
 * from the parent's grid heights: the child's even vertex (2a, 2b) is the
 * parent's vertex (qx·n/2 + a, qy·n/2 + b).
 */
export function parentSurfaceForChild(
  n: number,
  parentHeights: Float32Array,
  qx: number,
  qy: number,
): Float32Array {
  const h = n / 2;
  return coarseSurface(n, (a, b) => parentHeights[gridIndex(n, qx * h + a, qy * h + b)]!);
}

/**
 * Interleave a tile's attribute buffer for the shared vertex order (grid then
 * skirts; skirts copy their edge vertex).
 */
export function packAttributes(
  n: number,
  hFrom: Float32Array,
  hTo: Float32Array,
  slopes: Float32Array,
): Float32Array {
  const count = vertexCount(n);
  const out = new Float32Array(count * ATTRIBUTES_PER_VERTEX);
  const g = gridVertexCount(n);
  for (let k = 0; k < count; k++) {
    const s = k < g ? k : skirtSource(n, k);
    const o = k * ATTRIBUTES_PER_VERTEX;
    out[o] = hFrom[s]!;
    out[o + 1] = hTo[s]!;
    out[o + 2] = slopes[s * 2]!;
    out[o + 3] = slopes[s * 2 + 1]!;
  }
  return out;
}

/** Skirt drop (m) for a tile `tileMeters` wide: deep enough to hide any crack. */
export function skirtDepth(tileMeters: number): number {
  return Math.min(1500, Math.max(15, tileMeters * 0.03));
}

/** Bilinear interpolation of a grid at (u, v) honouring the fixed diagonal. */
export function surfaceAt(n: number, heights: Float32Array, u: number, v: number): number {
  const fx = Math.min(Math.max(u, 0), 1) * n;
  const fy = Math.min(Math.max(v, 0), 1) * n;
  const i = Math.min(Math.floor(fx), n - 1);
  const j = Math.min(Math.floor(fy), n - 1);
  const tx = fx - i;
  const ty = fy - j;
  const a = heights[gridIndex(n, i, j)]!;
  const b = heights[gridIndex(n, i + 1, j)]!;
  const c = heights[gridIndex(n, i, j + 1)]!;
  const d = heights[gridIndex(n, i + 1, j + 1)]!;
  // Triangles (a, c, d) when ty ≥ tx, else (a, d, b).
  if (ty >= tx) return a + (c - a) * ty + (d - c) * tx;
  return a + (b - a) * tx + (d - b) * ty;
}
