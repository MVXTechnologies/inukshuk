import { cameraToCenterDistance, groundAtNdc, projectionMatrix } from './camera';
import {
  DEFAULT_FOG_END_CTC,
  DEFAULT_MAX_TILES,
  displayedZRange,
  GRID,
  MAX_ZOOM_ABOVE_CAMERA,
  screenSpaceError,
  selectTiles,
  vertexBudget,
  type Selection,
} from './lod';
import { invert } from './mat4';
import { pixelsPerMeter } from './mercator';
import { camera, frameCamera, PLACES, type PlaceName } from './testUtils';
import { tileBoundsPx, tileKey, type TileId } from './tiles';

const PITCHES = [0, 15, 30, 45, 60, 70, 80];
const BEARINGS = [0, 60, 135, 200, 290];
const PLACE_NAMES = Object.keys(PLACES) as PlaceName[];

function isAncestor(a: TileId, b: TileId): boolean {
  if (a.z >= b.z || a.wrap !== b.wrap) return false;
  const d = b.z - a.z;
  return b.x >> d === a.x && b.y >> d === a.y;
}

/** Ground points under a grid of screen points, within the fog distance. */
function groundSamples(sel: Selection, P: number[], zoom: number, lat: number): [number, number][] {
  const inv = invert(P)!;
  const ppm = pixelsPerMeter(lat, zoom);
  const out: [number, number][] = [];
  for (let iy = 0; iy <= 10; iy++) {
    for (let ix = 0; ix <= 6; ix++) {
      const g = groundAtNdc(inv, -0.95 + (1.9 * ix) / 6, -0.95 + (1.9 * iy) / 10);
      if (!g) continue;
      const e = sel.eye!;
      const d = Math.hypot(g[0] - e[0], g[1] - e[1], e[2] * ppm);
      if (d < DEFAULT_FOG_END_CTC * sel.ctc * 0.98) out.push(g);
    }
  }
  return out;
}

describe('screen-space error', () => {
  it('is the grid spacing scaled by ctc / distance', () => {
    expect(screenSpaceError(512, 32, 1000, 1000)).toBe(16);
    expect(screenSpaceError(512, 32, 1000, 2000)).toBe(8);
    expect(screenSpaceError(512, 32, 1000, 0)).toBeGreaterThan(1e6);
  });
  it('displayed z range is relative to the reference and scaled', () => {
    expect(displayedZRange([1000, 3000], 2000, 1.5)).toEqual([-1500, 1500]);
    expect(displayedZRange([1000, 3000], 0, 0)).toEqual([0, 0]);
    expect(displayedZRange([1000, 3000], 0, -1)).toEqual([-3000, -1000]);
  });
  it('vertex budget counts grid and skirts', () => {
    expect(vertexBudget(1)).toBe(33 * 33 + 4 * 33);
    expect(vertexBudget(DEFAULT_MAX_TILES)).toBeLessThan(300000);
  });
});

describe.each(PLACE_NAMES)('tile cover at %s (flat)', (name) => {
  const place = PLACES[name];
  const cases = PITCHES.flatMap((p) => BEARINGS.map((b) => [p, b] as const));

  it.each(cases)('pitch %p bearing %p', (p, b) => {
    const cam = frameCamera(camera(place, p, b));
    const sel = selectTiles(cam, { heightScale: 0 });
    expect(sel.eye).not.toBeNull();
    // budget and ordering
    expect(sel.tiles.length).toBeGreaterThan(0);
    expect(sel.tiles.length).toBeLessThanOrEqual(DEFAULT_MAX_TILES);
    for (let i = 1; i < sel.tiles.length; i++) {
      expect(sel.tiles[i]!.distance).toBeGreaterThanOrEqual(sel.tiles[i - 1]!.distance);
    }
    // no duplicates, no overlaps
    const keys = new Set(sel.tiles.map((s) => tileKey(s.tile)));
    expect(keys.size).toBe(sel.tiles.length);
    const maxZ = Math.floor(place.zoom) + MAX_ZOOM_ABOVE_CAMERA;
    for (const s of sel.tiles) {
      expect(s.tile.z).toBeLessThanOrEqual(maxZ);
      expect(s.sse <= sel.threshold || s.tile.z === maxZ).toBe(true);
    }
    const byZ = [...sel.tiles].sort((a, b2) => a.tile.z - b2.tile.z);
    for (let i = 0; i < byZ.length; i++) {
      for (let j = i + 1; j < byZ.length; j++) {
        expect(isAncestor(byZ[i]!.tile, byZ[j]!.tile)).toBe(false);
      }
    }
    // every visible ground point within the fog is covered exactly once
    for (const [gx, gy] of groundSamples(sel, cam.P, cam.zoom, cam.lat)) {
      const hits = sel.tiles.filter((s) => {
        const bb = tileBoundsPx(s.tile, cam.zoom);
        return gx >= bb.minX && gx < bb.maxX && gy >= bb.minY && gy < bb.maxY;
      });
      expect(hits).toHaveLength(1);
    }
  });
});

describe('LOD behaviour', () => {
  const place = PLACES.zermatt;

  it('is deterministic', () => {
    const cam = frameCamera(camera(place, 63, 211));
    expect(selectTiles(cam)).toEqual(selectTiles(cam));
  });

  it('top-down: one zoom level everywhere, about one level deeper than the camera', () => {
    const sel = selectTiles(frameCamera(camera(place, 0, 0)), { heightScale: 0 });
    const zs = new Set(sel.tiles.map((s) => s.tile.z));
    expect(zs.size).toBeLessThanOrEqual(2);
    for (const z of zs) expect(Math.abs(z - (place.zoom + 1))).toBeLessThanOrEqual(1);
  });

  it('tilting deepens the near tiles and coarsens the far ones', () => {
    const sel = selectTiles(frameCamera(camera(place, 75, 0)), { heightScale: 0 });
    const near = sel.tiles[0]!;
    const far = sel.tiles[sel.tiles.length - 1]!;
    expect(near.tile.z).toBeGreaterThan(far.tile.z);
  });

  it('more pitch never needs fewer tiles than flat (same place)', () => {
    const flat = selectTiles(frameCamera(camera(place, 0, 0)), { heightScale: 0 }).tiles.length;
    const steep = selectTiles(frameCamera(camera(place, 80, 0)), { heightScale: 0 }).tiles.length;
    expect(steep).toBeGreaterThanOrEqual(flat);
  });

  it('a tight budget relaxes the error threshold instead of overflowing', () => {
    const cam = frameCamera(camera(place, 80, 30));
    const sel = selectTiles(cam, { maxTiles: 20 });
    expect(sel.tiles.length).toBeLessThanOrEqual(20);
    expect(sel.threshold).toBeGreaterThan(8);
  });

  it('a stricter error threshold means more, finer tiles', () => {
    const cam = frameCamera(camera(place, 60, 0));
    const coarse = selectTiles(cam, { maxErrorPx: 16 }).tiles.length;
    const fine = selectTiles(cam, { maxErrorPx: 4 }).tiles.length;
    expect(fine).toBeGreaterThan(coarse);
  });

  it('the fog distance bounds the cover', () => {
    const cam = frameCamera(camera(place, 80, 0));
    const near = selectTiles(cam, { fogEndCtc: 3 });
    const far = selectTiles(cam, { fogEndCtc: 12 });
    expect(near.tiles.length).toBeLessThan(far.tiles.length);
    for (const s of near.tiles) expect(s.distance).toBeLessThanOrEqual(3 * near.ctc);
  });

  it('known heights keep high tiles in view and are respected by culling', () => {
    const cam = frameCamera(camera(place, 70, 0));
    const flat = selectTiles(cam, { heightScale: 0 });
    const tall = selectTiles(cam, {
      heightRange: () => [1500, 4500],
      hRef: 1500,
      heightScale: 1,
    });
    expect(tall.tiles.length).toBeGreaterThanOrEqual(flat.tiles.length * 0.5);
    expect(tall.tiles.length).toBeLessThanOrEqual(DEFAULT_MAX_TILES);
  });

  it('a degenerate camera selects nothing', () => {
    const cam = frameCamera(camera(place, 30, 0));
    expect(selectTiles({ ...cam, P: new Array<number>(16).fill(0) }).tiles).toEqual([]);
    expect(selectTiles({ ...cam, height: 0 }).tiles).toEqual([]);
  });

  it('respects a max zoom', () => {
    const sel = selectTiles(frameCamera(camera(place, 70, 0)), { maxZoom: 12 });
    for (const s of sel.tiles) expect(s.tile.z).toBeLessThanOrEqual(12);
  });

  it('uses the grid size in the error', () => {
    const cam = frameCamera(camera(place, 45, 0));
    const a = selectTiles(cam, { grid: 16 }).tiles.length;
    const b = selectTiles(cam, { grid: GRID }).tiles.length;
    expect(a).toBeGreaterThanOrEqual(b);
  });
});

describe('antimeridian and poles', () => {
  it.each([179.95, -179.95, 180])('a view at lng %p draws both sides of 180°', (lng) => {
    const cam = frameCamera(camera({ lng, lat: -16.5, zoom: 9 }, 50, 90));
    const sel = selectTiles(cam, { heightScale: 0 });
    const wraps = new Set(sel.tiles.map((s) => s.tile.wrap));
    expect(wraps.size).toBeGreaterThanOrEqual(2);
    for (const [gx, gy] of groundSamples(sel, cam.P, cam.zoom, cam.lat)) {
      const hits = sel.tiles.filter((s) => {
        const bb = tileBoundsPx(s.tile, cam.zoom);
        return gx >= bb.minX && gx < bb.maxX && gy >= bb.minY && gy < bb.maxY;
      });
      expect(hits).toHaveLength(1);
    }
  });

  it.each([84.9, -84.9, 80])('near the pole (lat %p) only valid tiles are drawn', (lat) => {
    const sel = selectTiles(frameCamera(camera({ lng: 20, lat, zoom: 8 }, 60, 0)), {
      heightScale: 0,
    });
    for (const s of sel.tiles) {
      const n = 2 ** s.tile.z;
      expect(s.tile.y).toBeGreaterThanOrEqual(0);
      expect(s.tile.y).toBeLessThan(n);
    }
  });

  it('a whole-world view at z1 stays within budget', () => {
    const sel = selectTiles(frameCamera(camera({ lng: 0, lat: 0, zoom: 1 }, 60, 0)));
    expect(sel.tiles.length).toBeGreaterThan(0);
    expect(sel.tiles.length).toBeLessThanOrEqual(DEFAULT_MAX_TILES);
  });
});

describe('ctc reported', () => {
  it('matches the camera-to-centre distance', () => {
    const c = camera(PLACES.yosemite, 45, 0);
    const sel = selectTiles(frameCamera(c));
    expect(sel.ctc).toBeCloseTo(cameraToCenterDistance(c.height), 9);
    expect(projectionMatrix(c)).toHaveLength(16);
  });
});
