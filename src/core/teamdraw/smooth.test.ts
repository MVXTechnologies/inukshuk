import type { Pt } from './geo';
import { catmullRom, MAX_SMOOTH_POINTS, smoothShapes, SMOOTH_STEPS } from './smooth';

const zig: Pt[] = [
  [0, 0],
  [1, 1],
  [2, 0],
  [3, 1],
];

describe('pencil smoothing', () => {
  it('passes through every point, with steps between', () => {
    const out = catmullRom(zig);
    expect(out).toHaveLength(1 + (zig.length - 1) * SMOOTH_STEPS);
    for (let i = 0; i < zig.length; i++) {
      const p = out[i * SMOOTH_STEPS]!;
      expect(p[0]).toBeCloseTo(zig[i]![0]);
      expect(p[1]).toBeCloseTo(zig[i]![1]);
    }
  });

  it('leaves two points alone (a copy) and caps long lines', () => {
    const two: Pt[] = [
      [0, 0],
      [1, 1],
    ];
    const out = catmullRom(two);
    expect(out).toEqual(two);
    expect(out[0]).not.toBe(two[0]);
    const long: Pt[] = Array.from({ length: 1500 }, (_, i) => [i * 0.001, (i % 2) * 0.001]);
    expect(catmullRom(long).length).toBeLessThanOrEqual(MAX_SMOOTH_POINTS);
  });

  it('is antimeridian-safe', () => {
    const across: Pt[] = [
      [179.999, 0],
      [-179.999, 0.001],
      [-179.998, 0],
    ];
    for (const p of catmullRom(across)) expect(Math.abs(p[0])).toBeGreaterThan(179.99);
  });

  it('curves pencil lines only', () => {
    const [free, arrow] = smoothShapes([
      { sh: 'free', pts: zig },
      { sh: 'arrow', pts: zig.slice(0, 2) },
    ]);
    expect(free!.pts.length).toBeGreaterThan(zig.length);
    expect(arrow!.pts).toEqual(zig.slice(0, 2));
  });
});
