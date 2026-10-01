import type { BoundingBox } from '@core/models';

import {
  capNewest,
  chunkParts,
  clipParts,
  containsBounds,
  heatLayersAt,
  lineToleranceM,
  nextCullRegion,
  padBounds,
  simplifyParts,
  vertexCount,
} from './viewportCull';

const box = (minLng: number, minLat: number, maxLng: number, maxLat: number): BoundingBox => ({
  minLng,
  minLat,
  maxLng,
  maxLat,
});

describe('padBounds', () => {
  it('grows a box by a fraction of its span on each side', () => {
    expect(padBounds(box(-71.3, 46.8, -71.1, 46.9), 0.5)).toEqual({
      minLng: expect.closeTo(-71.4, 9),
      maxLng: expect.closeTo(-71.0, 9),
      minLat: expect.closeTo(46.75, 9),
      maxLat: expect.closeTo(46.95, 9),
    });
  });

  it('clamps at the poles and becomes the whole width of the world when it must', () => {
    expect(padBounds(box(-100, 80, 100, 89), 0.5)).toEqual(box(-180, 75.5, 180, 90));
  });

  it('wraps across the antimeridian', () => {
    const b = padBounds(box(175, 0, 179, 1), 0.5);
    expect(b.minLng).toBeCloseTo(173);
    expect(b.maxLng).toBeCloseTo(-179);
    // A box already crossing it stays crossing it.
    const c = padBounds(box(179, 0, -179, 1), 1);
    expect(c.minLng).toBeCloseTo(177);
    expect(c.maxLng).toBeCloseTo(-177);
  });

  it('treats a negative margin as none', () => {
    expect(padBounds(box(0, 0, 1, 1), -1)).toEqual(box(0, 0, 1, 1));
  });
});

describe('containsBounds', () => {
  it('is true only for a box entirely inside', () => {
    const outer = box(-72, 46, -70, 48);
    expect(containsBounds(outer, box(-71.5, 46.5, -71, 47))).toBe(true);
    expect(containsBounds(outer, box(-72.5, 46.5, -71, 47))).toBe(false);
    expect(containsBounds(outer, box(-71.5, 45, -71, 47))).toBe(false);
    expect(containsBounds(outer, outer)).toBe(true);
  });

  it('works across the antimeridian and for the world box', () => {
    const outer = box(170, -10, -170, 10);
    expect(containsBounds(outer, box(175, 0, -175, 1))).toBe(true);
    expect(containsBounds(outer, box(-175, 0, -172, 1))).toBe(true);
    expect(containsBounds(outer, box(160, 0, 175, 1))).toBe(false);
    expect(containsBounds(box(-180, -90, 180, 90), box(170, 0, -170, 1))).toBe(true);
    // Wider than the outer box can never fit.
    expect(containsBounds(box(0, 0, 10, 10), box(-1, 1, 20, 2))).toBe(false);
  });
});

describe('nextCullRegion', () => {
  const view = box(-71.22, 46.8, -71.2, 46.82);

  it('pads the first viewport and keeps the integer zoom', () => {
    const r = nextCullRegion(null, view, 14.6);
    expect(r.zoomLevel).toBe(14);
    expect(containsBounds(r.bounds, view)).toBe(true);
    expect(r.bounds.maxLng - r.bounds.minLng).toBeCloseTo(0.04);
  });

  it('keeps the same region (same object) while the viewport stays inside it', () => {
    const r = nextCullRegion(null, view, 14.2);
    const nudged = box(-71.215, 46.805, -71.195, 46.825);
    expect(nextCullRegion(r, nudged, 14.9)).toBe(r);
    expect(nextCullRegion(r, view, 14.0)).toBe(r);
  });

  it('moves when the viewport leaves the region or the integer zoom changes', () => {
    const r = nextCullRegion(null, view, 14.2);
    const panned = box(-71.19, 46.8, -71.17, 46.82);
    const moved = nextCullRegion(r, panned, 14.2);
    expect(moved).not.toBe(r);
    expect(containsBounds(moved.bounds, panned)).toBe(true);
    const zoomed = nextCullRegion(r, view, 15.1);
    expect(zoomed).not.toBe(r);
    expect(zoomed.zoomLevel).toBe(15);
  });

  it('falls back to the world for an unusable viewport or zoom', () => {
    expect(nextCullRegion(null, box(NaN, 0, 1, 1), 12).bounds).toEqual(box(-180, -90, 180, 90));
    expect(nextCullRegion(null, view, NaN).zoomLevel).toBe(0);
  });
});

describe('lineToleranceM', () => {
  it('adds nothing at street zooms and grows as the map zooms out', () => {
    expect(lineToleranceM(16)).toBe(0);
    expect(lineToleranceM(14)).toBe(0);
    const z12 = lineToleranceM(12);
    expect(z12).toBeGreaterThan(5);
    expect(lineToleranceM(9)).toBeCloseTo(z12 * 8, -1);
    expect(lineToleranceM(-3)).toBe(lineToleranceM(0));
  });
});

describe('simplifyParts', () => {
  const straight: [number, number][] = Array.from({ length: 50 }, (_, i) => [-71 + i * 1e-4, 46.8]);

  it('drops collinear vertices at a tolerance, keeps parts of 2+ points', () => {
    const out = simplifyParts([straight, [[0, 0]]], 5);
    expect(out).toEqual([[straight[0], straight[49]]]);
  });

  it('returns the parts as they are at tolerance 0', () => {
    const parts = [straight];
    expect(simplifyParts(parts, 0)[0]).toBe(straight);
  });
});

describe('heatLayersAt', () => {
  it('draws the glow below the crossfade end and the lines from its start', () => {
    expect(heatLayersAt(8)).toEqual({ glow: true, lines: false });
    expect(heatLayersAt(9)).toEqual({ glow: true, lines: true });
    expect(heatLayersAt(12)).toEqual({ glow: true, lines: true });
    expect(heatLayersAt(13)).toEqual({ glow: false, lines: true });
  });
});

describe('capNewest', () => {
  const at: Record<string, number> = { a: 1, b: 5, c: 3, d: 4 };
  it('keeps every id (same order) under the cap', () => {
    expect(capNewest(['a', 'b', 'c'], (id) => at[id] ?? 0, 3)).toEqual(['a', 'b', 'c']);
  });
  it('keeps the newest over the cap, in the original order', () => {
    expect(capNewest(['a', 'b', 'c', 'd'], (id) => at[id] ?? 0, 2)).toEqual(['b', 'd']);
    expect(capNewest(['a', 'b'], () => 0, -1)).toEqual([]);
  });
});

describe('chunkParts / clipParts', () => {
  // A line due east, 100 vertices 0.001° apart, from lng 0 to 0.099.
  const line: [number, number][] = Array.from({ length: 100 }, (_, i) => [i * 0.001, 0]);
  const parts = [line];
  const chunks = chunkParts(parts, 10);

  it('cuts parts into chunks sharing their boundary vertex', () => {
    expect(chunks).toHaveLength(10);
    expect(chunks[0]).toMatchObject({ part: 0, start: 0, end: 10 });
    expect(chunks[9]).toMatchObject({ part: 0, start: 90, end: 99 });
    expect(chunks[1]?.box).toEqual(box(0.01, 0, 0.02, 0));
  });

  it('returns a part kept whole without copying it', () => {
    const out = clipParts(parts, chunks, box(-1, -1, 1, 1));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(line);
  });

  it('keeps only the chunks meeting the region, joined where contiguous', () => {
    const out = clipParts(parts, chunks, box(0.025, -1, 0.045, 1));
    expect(out).toHaveLength(1);
    expect(out[0]?.[0]).toEqual([0.02, 0]);
    expect(out[0]?.[out[0].length - 1]).toEqual([0.05, 0]);
  });

  it('splits a trail that leaves the region and comes back', () => {
    // Out east and back west on a parallel line 0.01° north.
    const back: [number, number][] = line.map(([x]) => [0.099 - x, 0.01]);
    const loop = [line.concat(back)];
    const c = chunkParts(loop, 10);
    const out = clipParts(loop, c, box(-0.001, -1, 0.015, 1));
    expect(out).toHaveLength(2);
    expect(vertexCount(out)).toBeLessThan(60);
    expect(clipParts(loop, c, box(5, 5, 6, 6))).toEqual([]);
  });

  it('never clips away a chunk spanning the antimeridian', () => {
    const wrap: [number, number][][] = [
      [
        [179.9, 0],
        [-179.9, 0],
      ],
    ];
    const c = chunkParts(wrap);
    expect(c[0]?.box.minLng).toBe(-180);
    expect(clipParts(wrap, c, box(-179.95, -1, -179.85, 1))).toHaveLength(1);
  });

  it('counts vertices', () => {
    expect(vertexCount([line, line.slice(0, 3)])).toBe(103);
  });
});
