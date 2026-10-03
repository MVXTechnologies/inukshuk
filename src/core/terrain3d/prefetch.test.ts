import { selectTiles } from './lod';
import { bestLoadedDemZoom, COARSE_LEAD, planDemRequests } from './prefetch';
import { camera, frameCamera, PLACES } from './testUtils';
import { demKey, type DemId, type TileId } from './tiles';

const t = (z: number, x: number, y: number, wrap = 0): TileId => ({ z, x, y, wrap });

describe('planDemRequests', () => {
  it('asks for a coarse ancestor first, then the tile’s own DEM', () => {
    const plan = planDemRequests({
      tiles: [t(13, 4270, 2900)],
      bearingDeg: 0,
      isLoaded: () => false,
      maxRequests: 2,
    });
    expect(plan).toEqual([
      { z: 13 - COARSE_LEAD, x: 4270 >> COARSE_LEAD, y: 2900 >> COARSE_LEAD },
      { z: 13, x: 4270, y: 2900 },
    ]);
  });

  it('skips loaded and pending DEMs and never repeats', () => {
    const loaded = new Set(['10/533/362']);
    const plan = planDemRequests({
      tiles: [t(13, 4270, 2900), t(13, 4271, 2900), t(13, 4270, 2900, 1)],
      bearingDeg: 0,
      isLoaded: (d) => loaded.has(demKey(d)),
      isPending: (d) => demKey(d) === '13/4271/2900',
      maxRequests: 50,
    });
    const keys = plan.map(demKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('10/533/362');
    expect(keys).not.toContain('13/4271/2900');
    expect(keys.indexOf('13/4270/2900')).toBeGreaterThanOrEqual(0);
  });

  it('terrain tiles deeper than z15 ask for the z15 DEM', () => {
    const plan = planDemRequests({
      tiles: [t(17, 100, 200)],
      bearingDeg: 0,
      isLoaded: () => false,
      maxRequests: 2,
    });
    expect(plan[1]).toEqual({ z: 15, x: 25, y: 50 });
  });

  it.each([
    [0, [0, -1]],
    [90, [1, 0]],
    [180, [0, 1]],
    [270, [-1, 0]],
  ])('bearing %p prefetches the neighbour ahead (%p)', (b, [dx, dy]) => {
    const plan = planDemRequests({
      tiles: [t(12, 100, 100)],
      bearingDeg: b,
      isLoaded: () => false,
      maxRequests: 50,
    });
    const keys = plan.map(demKey);
    expect(keys).toContain(`12/${100 + dx!}/${100 + dy!}`);
    expect(keys).not.toContain(`12/${100 - dx!}/${100 - dy!}`);
  });

  it('respects the request cap', () => {
    const tiles = Array.from({ length: 40 }, (_, i) => t(12, 100 + i, 100));
    expect(
      planDemRequests({ tiles, bearingDeg: 0, isLoaded: () => false, maxRequests: 7 }),
    ).toHaveLength(7);
  });

  it('a real selection plans a bounded, de-duplicated list', () => {
    const sel = selectTiles(frameCamera(camera(PLACES.zermatt, 70, 30)));
    const plan = planDemRequests({
      tiles: sel.tiles.map((s) => s.tile),
      bearingDeg: 30,
      isLoaded: () => false,
      maxRequests: 400,
    });
    const keys = plan.map(demKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of plan) expect(d.z).toBeLessThanOrEqual(15);
  });

  it('prefetch does not wrap past the poles', () => {
    const plan = planDemRequests({
      tiles: [t(3, 2, 0)],
      bearingDeg: 0,
      isLoaded: () => false,
      maxRequests: 50,
    });
    for (const d of plan) expect(d.y).toBeGreaterThanOrEqual(0);
  });
});

describe('bestLoadedDemZoom', () => {
  const have =
    (...keys: string[]) =>
    (d: DemId) =>
      keys.includes(demKey(d));
  it('prefers the tile’s own DEM', () => {
    expect(bestLoadedDemZoom(t(12, 10, 10), have('12/10/10', '11/5/5'))).toBe(12);
  });
  it('falls back to the nearest ancestor', () => {
    expect(bestLoadedDemZoom(t(12, 10, 10), have('9/1/1', '11/5/5'))).toBe(11);
    expect(bestLoadedDemZoom(t(12, 10, 10), have('0/0/0'))).toBe(0);
  });
  it('null when nothing above is loaded', () => {
    expect(bestLoadedDemZoom(t(12, 10, 10), have('12/11/10'))).toBeNull();
  });
  it('deep terrain tiles start from z15', () => {
    expect(bestLoadedDemZoom(t(17, 400, 400), have('15/100/100'))).toBe(15);
  });
});
