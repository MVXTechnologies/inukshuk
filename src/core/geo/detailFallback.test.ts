/**
 * Keeping already-rendered detail while its replacement renders (#344).
 *
 * The complaint this answers: panning keeps the map crisp, but any zoom change
 * blanked the detail until new tiles finished, because a tile's cache key
 * carries the camera-derived crop and width and every key changed at once.
 */
import type { BoundingBox } from '@core/models';

import { chooseFallbackDetails, unionOfBboxes, type FallbackCandidate } from './detailFallback';

const box = (minLng: number, minLat: number, maxLng: number, maxLat: number): BoundingBox => ({
  minLng,
  minLat,
  maxLng,
  maxLat,
});

const tile = (
  cacheKey: string,
  bbox: BoundingBox,
  over: Partial<FallbackCandidate> = {},
): FallbackCandidate => ({
  cacheKey,
  overviewKey: 'page-1',
  bbox,
  pixels: 1_000_000,
  ...over,
});

/** The whole page, and the quadrant a zoomed-in camera was looking at. */
const PAGE = box(-71, 46, -70, 47);
const NW = box(-71, 46.5, -70.5, 47);

const input = (over: Partial<Parameters<typeof chooseFallbackDetails>[0]> = {}) => ({
  cached: [] as FallbackCandidate[],
  freshKeys: new Set<string>(),
  freshBboxes: [] as BoundingBox[],
  liveOverviewKeys: new Set(['page-1']),
  bounds: PAGE,
  budgetPixels: 4_000_000,
  maxCount: 12,
  ...over,
});

describe('unionOfBboxes', () => {
  it('is null for nothing', () => {
    expect(unionOfBboxes([])).toBeNull();
  });

  it('spans every box given', () => {
    expect(unionOfBboxes([box(-71, 46, -70.5, 46.5), box(-70.6, 46.4, -70, 47)])).toEqual(
      box(-71, 46, -70, 47),
    );
  });
});

describe('chooseFallbackDetails', () => {
  // The zoom-out case from the report: last zoom's tiles cover part of the new
  // view, and keeping them beats showing nothing while the new ones render.
  it('keeps the previous zoom’s tiles when the new ones have not arrived', () => {
    const previous = tile('zoom14:nw', NW);
    const { keep } = chooseFallbackDetails(input({ cached: [previous] }));
    expect(keep).toEqual([previous]);
  });

  it('drops a tile the camera can no longer see', () => {
    const elsewhere = tile('far', box(10, 10, 11, 11));
    expect(chooseFallbackDetails(input({ cached: [elsewhere] })).keep).toEqual([]);
  });

  it('does not repeat a tile that is already being drawn fresh', () => {
    const shown = tile('same', NW);
    const { keep } = chooseFallbackDetails(
      input({ cached: [shown], freshKeys: new Set(['same']) }),
    );
    expect(keep).toEqual([]);
  });

  it('drops a tile a fresh one already covers completely', () => {
    const covered = tile('old:nw', NW);
    const { keep } = chooseFallbackDetails(input({ cached: [covered], freshBboxes: [PAGE] }));
    expect(keep).toEqual([]);
  });

  it('keeps a tile a fresh one only partly covers', () => {
    const straddling = tile('old:wide', box(-71, 46, -70, 46.6));
    const { keep } = chooseFallbackDetails(
      input({ cached: [straddling], freshBboxes: [box(-71, 46, -70.5, 46.6)] }),
    );
    expect(keep).toEqual([straddling]);
  });

  // The rule that must never be relaxed: a tile's geography only means
  // anything for the document that produced it.
  it('never keeps a tile from a page that is no longer on screen', () => {
    const other = tile('other-doc', NW, { overviewKey: 'page-from-a-replaced-pdf' });
    expect(chooseFallbackDetails(input({ cached: [other] })).keep).toEqual([]);
  });

  it('stops at the pixel budget, keeping the most recent', () => {
    const cached = [tile('a', NW, { pixels: 3_000_000 }), tile('b', NW, { pixels: 3_000_000 })];
    const { keep, pixels } = chooseFallbackDetails(input({ cached, budgetPixels: 4_000_000 }));
    expect(keep.map((t) => t.cacheKey)).toEqual(['a']);
    expect(pixels).toBe(3_000_000);
  });

  it('stops at the tile count', () => {
    const cached = Array.from({ length: 6 }, (_, i) => tile(`t${i}`, NW, { pixels: 1 }));
    expect(chooseFallbackDetails(input({ cached, maxCount: 2 })).keep).toHaveLength(2);
  });

  it('keeps nothing when there is no region to judge against', () => {
    expect(chooseFallbackDetails(input({ cached: [tile('a', NW)], bounds: null })).keep).toEqual(
      [],
    );
  });

  it('keeps nothing when the budget is exhausted or zero', () => {
    expect(chooseFallbackDetails(input({ cached: [tile('a', NW)], budgetPixels: 0 })).keep).toEqual(
      [],
    );
    expect(chooseFallbackDetails(input({ cached: [tile('a', NW)], maxCount: 0 })).keep).toEqual([]);
  });

  it('skips an oversized tile but still takes a later one that fits', () => {
    const cached = [tile('huge', NW, { pixels: 9_000_000 }), tile('small', NW, { pixels: 10 })];
    expect(
      chooseFallbackDetails(input({ cached, budgetPixels: 1_000_000 })).keep.map((t) => t.cacheKey),
    ).toEqual(['small']);
  });
});
