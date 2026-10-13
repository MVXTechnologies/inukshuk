import { miniMapLayout, TILE_PX } from './miniMap';

describe('miniMapLayout', () => {
  const loop: [number, number][] = [
    [-70.9065, 47.0745],
    [-70.932, 47.0874],
    [-70.918, 47.08],
  ];

  it('fits the trail inside the box with padding, at the highest zoom that does', () => {
    const m = miniMapLayout(loop, 340, 190)!;
    const px = loop.map(([lng, lat]) => m.project(lng, lat));
    for (const [x, y] of px) {
      expect(x).toBeGreaterThanOrEqual(18 - 1e-6);
      expect(x).toBeLessThanOrEqual(340 - 18 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(18 - 1e-6);
      expect(y).toBeLessThanOrEqual(190 - 18 + 1e-6);
    }
    // One zoom closer would not fit.
    const closer = miniMapLayout(loop, 340, 190, { minZoom: m.z + 1, maxZoom: m.z + 1 })!;
    const xs = loop.map(([lng, lat]) => closer.project(lng, lat)[0]);
    const ys = loop.map(([lng, lat]) => closer.project(lng, lat)[1]);
    const span = Math.max(
      (Math.max(...xs) - Math.min(...xs)) / (340 - 36),
      (Math.max(...ys) - Math.min(...ys)) / (190 - 36),
    );
    expect(span).toBeGreaterThan(1);
  });

  it('covers the whole box with tiles placed on the 256 px grid', () => {
    const m = miniMapLayout(loop, 340, 190)!;
    const covers = (x: number, y: number) =>
      m.tiles.some((t) => x >= t.left && x < t.left + TILE_PX && y >= t.top && y < t.top + TILE_PX);
    for (const [x, y] of [
      [0, 0],
      [339, 0],
      [0, 189],
      [339, 189],
      [170, 95],
    ]) {
      expect(covers(x!, y!)).toBe(true);
    }
    expect(m.tiles.every((t) => t.z === m.z)).toBe(true);
  });

  it('handles a single point and refuses an empty trail', () => {
    expect(miniMapLayout([[-71, 47]], 100, 100)?.z).toBe(16);
    expect(miniMapLayout([], 100, 100)).toBeNull();
  });
});
