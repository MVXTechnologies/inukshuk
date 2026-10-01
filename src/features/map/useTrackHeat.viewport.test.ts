/**
 * Viewport culling of the map's trail lines and heatmap (#494): only trails
 * whose box meets the cull region are loaded and drawn (cut to the region),
 * sources keep their identity while the region does, a pan to new ground
 * rebuilds them, taps still resolve drawn trails, and each zoom builds only
 * the heat layers it draws.
 */
import { simplifyTrack } from '@core/geo/track/simplify';
import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import { nextCullRegion, type CullRegion } from '@core/map/viewportCull';
import type { BoundingBox, TrackSummary } from '@core/models';
import { getHeatStore, HeatStore, setHeatStoreForTests } from '@data/heatStore';
import { MemoryHeatIO } from '@data/heatStoreMemoryIO';
import * as storage from '@data/storage';
import { clearTrackGeometryMemory, peekTrackGeometry, trackGeometryKey } from '@data/trackGeometry';
import { act, renderHook } from '@testing-library/react-native';

import { useTrackHeat, type TrackHeatViewport } from './useTrackHeat';

const mockCacheFiles = new Map<string, string>();
jest.mock('@data/storage', () => ({
  readFileText: jest.fn(async () => {
    throw new Error('runs from the warm geometry cache');
  }),
  readTrackGeometryCache: jest.fn(async (id: string) => mockCacheFiles.get(id) ?? null),
  writeTrackGeometryCache: jest.fn(),
}));
jest.mock('@data/heatStoreFiles', () => ({ createHeatFileIO: jest.fn() }));

const lib = largeLibrary(80, { stepSec: 10 });
/** The fixture's trails, each with its stored bbox and a warm geometry cache. */
const base: TrackSummary[] = lib.tracks.map((t, i) => {
  const points = lib.points(i);
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const g = simplifyTrack(points, lib.segmentStarts(i));
  mockCacheFiles.set(t.id, JSON.stringify({ key: trackGeometryKey(t), parts: g.parts }));
  return {
    ...t,
    stats: {
      ...t.stats,
      bbox: {
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
        minLng: Math.min(...lngs),
        maxLng: Math.max(...lngs),
      },
    },
  };
});
/** A trail far from Québec City (Montréal), so a Québec region must leave it out. */
const away: TrackSummary = (() => {
  const src = base[0]!;
  const shift = (p: [number, number]): [number, number] => [p[0] - 2.4, p[1] - 1.3];
  const g = simplifyTrack(lib.points(0), lib.segmentStarts(0));
  const t: TrackSummary = {
    ...src,
    id: 'away',
    stats: {
      ...src.stats,
      bbox: {
        minLat: src.stats.bbox!.minLat - 1.3,
        maxLat: src.stats.bbox!.maxLat - 1.3,
        minLng: src.stats.bbox!.minLng - 2.4,
        maxLng: src.stats.bbox!.maxLng - 2.4,
      },
    },
  };
  mockCacheFiles.set(
    'away',
    JSON.stringify({ key: trackGeometryKey(t), parts: g.parts.map((p) => p.map(shift)) }),
  );
  return t;
})();
const tracks = [...base, away];
const ids = tracks.map((t) => t.id);

/** A 400×800 dp phone viewport centred on (lng, lat) at `zoom`. */
function viewportAt(lng: number, lat: number, zoom: number): BoundingBox {
  const degPerPx = 360 / (512 * 2 ** zoom);
  const halfW = 200 * degPerPx;
  const halfH = 400 * degPerPx * Math.cos((lat * Math.PI) / 180);
  return { minLng: lng - halfW, maxLng: lng + halfW, minLat: lat - halfH, maxLat: lat + halfH };
}
const region = (lng: number, lat: number, zoom: number): CullRegion =>
  nextCullRegion(null, viewportAt(lng, lat, zoom), zoom);
const QUEBEC = { lng: -71.2, lat: 46.81 };

const meets = (b: BoundingBox, r: BoundingBox) =>
  b.minLng <= r.maxLng && r.minLng <= b.maxLng && b.minLat <= r.maxLat && r.minLat <= b.maxLat;

async function settle() {
  for (let i = 0; i < 400; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    if ((storage.readTrackGeometryCache as jest.Mock).mock.calls.length === lastReads) {
      if (++quiet > 6) break;
    } else quiet = 0;
    lastReads = (storage.readTrackGeometryCache as jest.Mock).mock.calls.length;
  }
  // The stored heat: built and written, and its tiles read back.
  await act(() => getHeatStore().whenIdle());
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}
let lastReads = -1;
let quiet = 0;

function mount(
  shown: readonly string[],
  all: readonly string[],
  heat: boolean,
  v: TrackHeatViewport,
) {
  return renderHook(
    ({ view, s }: { view: TrackHeatViewport; s: readonly string[] }) =>
      useTrackHeat(tracks, s, all, heat, view),
    { initialProps: { view: v, s: shown } },
  );
}

beforeEach(() => {
  setHeatStoreForTests(
    new HeatStore({
      io: new MemoryHeatIO(),
      policy: { maxBatch: 50, debounceMs: 50, costRatio: 4 },
    }),
  );
  clearTrackGeometryMemory();
  (storage.readTrackGeometryCache as jest.Mock).mockClear();
  lastReads = -1;
  quiet = 0;
});

jest.setTimeout(60_000);

it('loads and draws only the shown trails whose box meets the region, cut to it', async () => {
  const r = region(QUEBEC.lng, QUEBEC.lat, 15);
  const { result } = await mount(ids, ids, false, r);
  await settle();
  const meeting = new Set(tracks.filter((t) => meets(t.stats.bbox!, r.bounds)).map((t) => t.id));
  expect(meeting.size).toBeGreaterThan(0);
  expect(meeting.size).toBeLessThan(tracks.length);
  // Nothing outside the region was even read.
  const read = new Set(
    (storage.readTrackGeometryCache as jest.Mock).mock.calls.map((c) => c[0] as string),
  );
  for (const id of read) expect(meeting.has(id)).toBe(true);
  expect(peekTrackGeometry(away)).toBeUndefined();

  const lines = result.current.lines!;
  expect(lines.features.length).toBeGreaterThan(0);
  for (const f of lines.features) {
    expect(meeting.has(f.properties.trackId)).toBe(true);
    // Cut to the region: no piece lies wholly outside it (chunks of ≤ 32
    // vertices reach a little past its edge).
    const pieces =
      f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const piece of pieces) {
      const lngs = piece.map((p) => p[0]!);
      const lats = piece.map((p) => p[1]!);
      const box = {
        minLng: Math.min(...lngs),
        maxLng: Math.max(...lngs),
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
      };
      expect(meets(box, r.bounds)).toBe(true);
    }
  }
  // Heat off: no heat sources.
  expect(result.current.heatLines).toBeNull();
  expect(result.current.heatGlow).toBeNull();
});

it('draws nothing until the viewport is known', async () => {
  const { result } = await mount(ids, ids, false, null);
  await settle();
  expect(result.current.lines?.features).toEqual([]);
  expect(storage.readTrackGeometryCache).not.toHaveBeenCalled();
});

it('keeps every source while the region is unchanged; a pan rebuilds them', async () => {
  const r = region(QUEBEC.lng, QUEBEC.lat, 13);
  const { result, rerender } = await mount(ids, ids, true, r);
  await settle();
  const first = result.current;
  expect(first.lines!.features.length).toBeGreaterThan(0);
  expect(first.heatLines!.features.length).toBeGreaterThan(0);

  // A camera settle inside the region: the same region object comes back.
  const nudged = nextCullRegion(r, viewportAt(QUEBEC.lng + 0.002, QUEBEC.lat, 13.4), 13.4);
  expect(nudged).toBe(r);
  await rerender({ view: nudged, s: [...ids] });
  await settle();
  expect(result.current.lines).toBe(first.lines);
  expect(result.current.heatLines).toBe(first.heatLines);
  expect(result.current.heatGlow).toBe(first.heatGlow);
  expect(result.current.heatAt).toBe(first.heatAt);

  // Pan to Montréal: the far trail is loaded and drawn, the sources rebuilt.
  const montreal = region(QUEBEC.lng - 2.4, QUEBEC.lat - 1.3, 13);
  await rerender({ view: montreal, s: ids });
  await settle();
  expect(result.current.lines).not.toBe(first.lines);
  expect(result.current.lines!.features.map((f) => f.properties.trackId)).toEqual(['away']);
  expect(result.current.heatLines).not.toBe(first.heatLines);
});

it('resolves a tap on a drawn trail', async () => {
  const r = region(QUEBEC.lng, QUEBEC.lat, 15);
  const { result } = await mount(ids, ids, false, r);
  await settle();
  const f = result.current.lines!.features[0]!;
  const piece =
    f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates[0]!;
  const [lng, lat] = piece[Math.floor(piece.length / 2)]!;
  const hit = result.current.heatAt({ lng: lng!, lat: lat! }, 10);
  expect(hit.trackIds.length).toBeGreaterThan(0);
  expect(
    hit.trackIds.every((id) =>
      result.current.lines!.features.some((g) => g.properties.trackId === id),
    ),
  ).toBe(true);
});

it('builds only the heat layers a zoom draws', async () => {
  const street = await mount([], ids, true, region(QUEBEC.lng, QUEBEC.lat, 15));
  await settle();
  expect(street.result.current.heatGlow!.features).toEqual([]);
  expect(street.result.current.heatLines!.features.length).toBeGreaterThan(0);
  await street.unmount();

  const zoomedOut = await mount([], ids, true, region(QUEBEC.lng, QUEBEC.lat, 8));
  await settle();
  expect(zoomedOut.result.current.heatLines!.features).toEqual([]);
  expect(zoomedOut.result.current.heatGlow!.features.length).toBeGreaterThan(0);
  // The glow is clipped to the region: Montréal's trail adds no point.
  const glowLngs = zoomedOut.result.current.heatGlow!.features.map(
    (f) => f.geometry.coordinates[0]!,
  );
  expect(Math.min(...glowLngs)).toBeGreaterThan(QUEBEC.lng - 2);
  await zoomedOut.unmount();
});

it('always includes a trail with no stored box', async () => {
  const legacy: TrackSummary = { ...away, stats: { ...away.stats, bbox: undefined } };
  const { result } = await renderHook(() =>
    useTrackHeat([legacy], [legacy.id], [legacy.id], false, region(QUEBEC.lng, QUEBEC.lat, 15)),
  );
  await settle();
  expect(peekTrackGeometry(legacy)).not.toBeUndefined();
  // Loaded, but cut to the region it is not in: nothing to draw.
  expect(result.current.lines?.features).toEqual([]);
});
