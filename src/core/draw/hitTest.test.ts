import { hitHandle, MIDPOINT_HIT_PX, VERTEX_HIT_PX } from './hitTest';

describe('hitHandle', () => {
  const vertices: [number, number][] = [
    [100, 100],
    [200, 100],
  ];
  const mids: [number, number][] = [[150, 100]];

  it('finds the nearest vertex inside the radius', () => {
    expect(hitHandle(vertices, mids, [105, 98])).toEqual({ kind: 'vertex', index: 0 });
    expect(hitHandle(vertices, mids, [195, 110])).toEqual({ kind: 'vertex', index: 1 });
  });

  it('falls back to a midpoint, then to nothing', () => {
    expect(hitHandle(vertices, mids, [150, 108])).toEqual({ kind: 'midpoint', index: 0 });
    expect(hitHandle(vertices, mids, [150, 100 + MIDPOINT_HIT_PX + 1])).toBeNull();
    expect(hitHandle(vertices, mids, [400, 400])).toBeNull();
  });

  it('a vertex beats a closer midpoint when both are in range', () => {
    const v: [number, number][] = [[100, 100]];
    const m: [number, number][] = [[110, 100]];
    expect(hitHandle(v, m, [108, 100])).toEqual({ kind: 'vertex', index: 0 });
  });

  it('skips points that could not be projected', () => {
    expect(hitHandle([null, [200, 100]], [], [200, 100 + VERTEX_HIT_PX])).toEqual({
      kind: 'vertex',
      index: 1,
    });
    expect(hitHandle([null], [null], [0, 0])).toBeNull();
  });
});
