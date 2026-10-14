/**
 * Taps on the waypoint marks (#685): a pin, a cluster, or neither — with
 * the real hit-test and routing, against a fake map whose projection is a
 * plain ×10 (a pin made at screen point (x, y) sits at [x/10, y/10]) and
 * whose rendered features are whatever the test says MapLibre drew.
 */
import { pinHitArea } from '@core/geo/pinHitTest';
import { useSettingsStore } from '@state/settingsStore';

import { pinAtPoint, type VisiblePin } from './pinHit';
import {
  WAYPOINT_TAP_LAYERS,
  clusterPinKeys,
  openWaypointCluster,
  useWaypointClusterSheet,
  waypointAtPoint,
  waypointClusterSource,
  type WaypointTapMap,
} from './waypointTap';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const saved = (id: string, x: number, y: number): VisiblePin =>
  ({
    source: 'saved',
    id,
    label: id,
    longitude: x / 10,
    latitude: y / 10,
    createdAt: 0,
  }) as VisiblePin;
const key = (p: VisiblePin) => `${p.source}-${p.id}`;

interface Drawn {
  pins?: string[];
  clusters?: { id: number; at: [number, number]; count: number }[];
}

function fakeMap(drawn: Drawn | 'throws') {
  const queries: { box: unknown; layers: string[] }[] = [];
  const map: WaypointTapMap = {
    project: async (lngLat) => [lngLat[0] * 10, lngLat[1] * 10],
    queryRenderedFeatures: async (box, options) => {
      queries.push({ box, layers: options.layers });
      if (drawn === 'throws') throw new Error('style reloading');
      return [
        ...(drawn.pins ?? []).map((k) => ({ properties: { key: k } })),
        ...(drawn.clusters ?? []).map((c) => ({
          properties: { cluster: true, cluster_id: c.id, point_count: c.count },
          geometry: { type: 'Point', coordinates: [c.at[0] / 10, c.at[1] / 10] },
        })),
      ];
    },
  };
  return { map, queries };
}

/** Where to tap to land on the head of an M pin whose tip is at (x, y). */
const headOf = (x: number, y: number): [number, number] => [
  x,
  y - pinHitArea('M', 'tap').headOffsetPx,
];

beforeEach(() => {
  useSettingsStore.setState({ pinScale: 100 });
  useWaypointClusterSheet.setState({ keys: null });
  waypointClusterSource.current = null;
});

describe('waypointAtPoint', () => {
  const a = saved('a', 100, 300);
  const b = saved('b', 104, 300); // folded with c into a cluster
  const c = saved('c', 106, 302);

  it('opens a drawn pin', async () => {
    const { map, queries } = fakeMap({ pins: ['saved-a'] });
    const hit = await waypointAtPoint(map, [a, b, c], key, null, headOf(100, 300), 'tap');
    expect(hit).toEqual({ kind: 'pin', pin: a });
    // One query per tap, on the clustered source's layers only.
    expect(queries).toHaveLength(1);
    expect(queries[0]?.layers).toEqual(WAYPOINT_TAP_LAYERS);
  });

  it('never opens a pin hidden inside a cluster; the cluster takes the tap', async () => {
    // a is not drawn here (say it is in another cluster); b and c are in cluster 9.
    const { map } = fakeMap({ clusters: [{ id: 9, at: [105, 290], count: 2 }] });
    const hit = await waypointAtPoint(map, [a, b, c], key, null, [105, 290], 'tap');
    expect(hit).toMatchObject({ kind: 'cluster', cluster: { id: 9, count: 2 } });
  });

  it('a tap beside a cluster, near a pin folded into it, opens nothing', async () => {
    const { map } = fakeMap({ clusters: [{ id: 9, at: [160, 290], count: 2 }] });
    const hit = await waypointAtPoint(map, [b, c], key, null, headOf(104, 300), 'tap');
    expect(hit).toEqual({ kind: 'none' });
  });

  it('a pin dead on its head wins over a cluster under the same finger', async () => {
    const { map } = fakeMap({ pins: ['saved-a'], clusters: [{ id: 3, at: [100, 300], count: 4 }] });
    const hit = await waypointAtPoint(map, [a, b], key, null, headOf(100, 300), 'tap');
    expect(hit).toEqual({ kind: 'pin', pin: a });
  });

  it('the selected pin is always a candidate (it is never clustered, never asked about)', async () => {
    const { map } = fakeMap({ pins: [] });
    const hit = await waypointAtPoint(map, [a, b], key, 'saved-a', headOf(100, 300), 'tap');
    expect(hit).toEqual({ kind: 'pin', pin: a });
  });

  it('falls back to every pin when MapLibre cannot answer (style mid-reload)', async () => {
    const { map } = fakeMap('throws');
    const hit = await waypointAtPoint(map, [a, b], key, null, headOf(100, 300), 'tap');
    expect(hit).toEqual({ kind: 'pin', pin: a });
  });

  it('a lone pin cannot be clustered: no query at all', async () => {
    const { map, queries } = fakeMap({ pins: [] });
    const hit = await waypointAtPoint(map, [a], key, null, headOf(100, 300), 'tap');
    expect(hit).toEqual({ kind: 'pin', pin: a });
    expect(queries).toHaveLength(0);
  });

  it('asks a wider box at 150 % and hits the larger head', async () => {
    const { map, queries } = fakeMap({ pins: ['saved-a'] });
    const half = (q: { box: unknown }) => {
      const [[x0], [x1]] = q.box as [[number, number], [number, number]];
      return (x1 - x0) / 2;
    };
    const big = pinHitArea('M', 'tap', 1.5);
    // Past the 100 % disc, inside the 150 % one.
    const tap: [number, number] = [100 + big.radiusPx - 1, 300 - big.headOffsetPx];
    expect(await waypointAtPoint(map, [a, b], key, null, tap, 'tap')).toEqual({ kind: 'none' });
    useSettingsStore.setState({ pinScale: 150 });
    expect(await waypointAtPoint(map, [a, b], key, null, tap, 'tap')).toEqual({
      kind: 'pin',
      pin: a,
    });
    expect(half(queries[1]!)).toBeGreaterThan(half(queries[0]!));
  });

  it('a long-press on a cluster never starts a Move', async () => {
    const { map } = fakeMap({ clusters: [{ id: 9, at: [105, 290], count: 2 }] });
    expect(await pinAtPoint(map, [b, c], [105, 290])).toBeNull();
    const drawn = fakeMap({ pins: ['saved-a'] });
    expect(await pinAtPoint(drawn.map, [a, b], headOf(100, 300))).toBe(a);
  });
});

describe('a cluster tap', () => {
  const cluster = { id: 4, lngLat: [-71.2, 46.8] as [number, number], count: 3 };

  function source(expansion: number, leaves: string[]) {
    const calls = { expansion: 0, leaves: 0 };
    waypointClusterSource.current = {
      getClusterExpansionZoom: async () => {
        calls.expansion += 1;
        return expansion;
      },
      getClusterLeaves: async () => {
        calls.leaves += 1;
        return leaves.map((k) => ({ type: 'Feature', properties: { key: k } }) as never);
      },
    } as never;
    return calls;
  }

  it('glides to where it splits, and asks for no leaves', async () => {
    const calls = source(15, ['saved-a', 'saved-b']);
    const zoomTo = jest.fn();
    await openWaypointCluster(cluster, Promise.resolve(12), zoomTo);
    expect(zoomTo).toHaveBeenCalledWith([-71.2, 46.8], 15.05);
    expect(calls).toEqual({ expansion: 1, leaves: 0 });
    expect(useWaypointClusterSheet.getState().keys).toBeNull();
  });

  it('at the camera cap, opens the list sheet with its pins', async () => {
    source(19, ['saved-a', 'live-b', 'saved-c']);
    const zoomTo = jest.fn();
    await openWaypointCluster(cluster, Promise.resolve(18), zoomTo);
    expect(zoomTo).not.toHaveBeenCalled();
    expect(useWaypointClusterSheet.getState().keys).toEqual(['saved-a', 'live-b', 'saved-c']);
  });

  it('when zooming would not split it, lists it too', async () => {
    source(16, ['saved-a', 'saved-b']);
    const zoomTo = jest.fn();
    await openWaypointCluster(cluster, Promise.resolve(16.4), zoomTo);
    expect(zoomTo).not.toHaveBeenCalled();
    expect(useWaypointClusterSheet.getState().keys).toEqual(['saved-a', 'saved-b']);
  });

  it('without a source (unmounted mid-tap), opens nothing', async () => {
    const zoomTo = jest.fn();
    await openWaypointCluster(cluster, Promise.resolve(12), zoomTo);
    expect(zoomTo).not.toHaveBeenCalled();
    expect(useWaypointClusterSheet.getState().keys).toBeNull();
    expect(await clusterPinKeys(cluster)).toEqual([]);
  });

  it('the sheet store closes without notifying when already closed', () => {
    const seen = jest.fn();
    const unsub = useWaypointClusterSheet.subscribe(seen);
    useWaypointClusterSheet.getState().close();
    expect(seen).not.toHaveBeenCalled();
    useWaypointClusterSheet.getState().open([]);
    expect(useWaypointClusterSheet.getState().keys).toBeNull();
    unsub();
  });
});
