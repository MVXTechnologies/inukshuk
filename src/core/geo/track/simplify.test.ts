import {
  geometryPoints,
  geometryVertexCount,
  parseTrackGeometry,
  simplifyIndices,
  simplifyTrack,
  TRACK_SIMPLIFY_TOLERANCE_M,
} from './simplify';

const LAT = 46.81;
const M_LNG = 111_320 * Math.cos((LAT * Math.PI) / 180);
const pt = (xM: number, yM: number) => ({
  longitude: -71.2 + xM / M_LNG,
  latitude: LAT + yM / 111_320,
});

/** Distance (m) from point p to the polyline through `line`. */
function distToPolyline(p: { x: number; y: number }, line: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

const toM = (c: [number, number]) => ({ x: (c[0] + 71.2) * M_LNG, y: (c[1] - LAT) * 111_320 });

describe('simplifyIndices', () => {
  it('keeps both endpoints and drops collinear fixes', () => {
    const line = Array.from({ length: 100 }, (_, i) => pt(i * 3, 0));
    expect(simplifyIndices(line, 1)).toEqual([0, 99]);
  });

  it('keeps corners', () => {
    const l = [pt(0, 0), pt(50, 0), pt(100, 0), pt(100, 50), pt(100, 100)];
    expect(simplifyIndices(l, 1)).toEqual([0, 2, 4]);
  });

  it('returns short inputs unchanged', () => {
    expect(simplifyIndices([], 5)).toEqual([]);
    expect(simplifyIndices([pt(0, 0)], 5)).toEqual([0]);
    expect(simplifyIndices([pt(0, 0), pt(1, 1)], 5)).toEqual([0, 1]);
  });

  it('handles a 100 000-point recording without recursion', () => {
    const long = Array.from({ length: 100_000 }, (_, i) => pt(i, Math.sin(i / 50) * 20));
    const kept = simplifyIndices(long, 4);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(99_999);
    expect(kept.length).toBeLessThan(10_000);
  });

  it('treats a degenerate chord (a loop back to the start) correctly', () => {
    const loop = [pt(0, 0), pt(100, 0), pt(100, 100), pt(0, 100), pt(0, 0)];
    expect(simplifyIndices(loop, 1)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('simplifyTrack', () => {
  // A 1 Hz jog with ±1.5 m GPS wobble along a bent street.
  const wobbly = Array.from({ length: 3600 }, (_, i) => {
    const x = i * 3;
    return pt(x, 40 * Math.sin(x / 300) + 1.5 * Math.sin(i * 1.7));
  });

  it('stays within the tolerance of every original fix', () => {
    const g = simplifyTrack(wobbly);
    const line = (g.parts[0] ?? []).map(toM);
    for (const p of wobbly.filter((_, i) => i % 7 === 0)) {
      const q = toM([p.longitude, p.latitude]);
      // + rounding to 1e-6° (≤ 0.1 m).
      expect(distToPolyline(q, line)).toBeLessThanOrEqual(TRACK_SIMPLIFY_TOLERANCE_M + 0.2);
    }
  });

  it('keeps a small fraction of a dense recording', () => {
    const g = simplifyTrack(wobbly);
    expect(geometryVertexCount(g)).toBeLessThan(wobbly.length / 5);
  });

  it('never bridges a pause: one part per segment', () => {
    const pts = [pt(0, 0), pt(10, 0), pt(20, 0), pt(500, 500), pt(510, 500)];
    const g = simplifyTrack(pts, [3]);
    expect(g.parts).toHaveLength(2);
    expect(g.parts[0]).toHaveLength(2);
    expect(g.parts[1]).toHaveLength(2);
  });

  it('drops invalid fixes and empty segments, keeps a lone-fix segment', () => {
    const pts = [
      pt(0, 0),
      { latitude: Number.NaN, longitude: 0 },
      pt(10, 0),
      { latitude: 95, longitude: 0 },
      pt(20, 20),
    ];
    const g = simplifyTrack(pts, [3, 4, 99, 0]);
    expect(g.parts).toHaveLength(2);
    expect(g.parts[1]).toHaveLength(1);
    expect(simplifyTrack([]).parts).toEqual([]);
  });

  it('rounds to 1e-6 degrees', () => {
    const g = simplifyTrack([
      { latitude: 46.123456789, longitude: -71.987654321 },
      { latitude: 46.2, longitude: -71.9 },
    ]);
    expect(g.parts[0]?.[0]).toEqual([-71.987654, 46.123457]);
  });
});

describe('parseTrackGeometry', () => {
  it('round-trips a geometry through JSON', () => {
    const g = simplifyTrack([pt(0, 0), pt(100, 30), pt(200, 0)]);
    expect(parseTrackGeometry(JSON.parse(JSON.stringify(g)))).toEqual(g);
  });

  it.each([
    null,
    42,
    {},
    { parts: 'x' },
    { parts: ['x'] },
    { parts: [[[1]]] },
    { parts: [[['a', 2]]] },
    { parts: [[[200, 10]]] },
    { parts: [[[10, 95]]] },
    { parts: [[[Number.NaN, 1]]] },
  ])('rejects %j', (value) => {
    expect(parseTrackGeometry(value)).toBeNull();
  });
});

describe('geometryPoints', () => {
  it('flattens parts to lat/lng fixes', () => {
    expect(
      geometryPoints({
        parts: [
          [
            [1, 2],
            [3, 4],
          ],
          [[5, 6]],
        ],
      }),
    ).toEqual([
      { latitude: 2, longitude: 1 },
      { latitude: 4, longitude: 3 },
      { latitude: 6, longitude: 5 },
    ]);
  });
});
