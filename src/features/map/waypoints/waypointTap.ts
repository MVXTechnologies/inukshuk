import {
  nearestPinHitAt,
  projectablePins,
  type PinCandidate,
  type PinHitGesture,
  type ProjectedPin,
} from '@core/geo/pinHitTest';
import { pinScaleFactor } from '@core/map/pinScale';
import {
  clusterTapAction,
  leafKeys,
  readClusterFeature,
  renderedPinKey,
  routeWaypointTap,
  waypointQueryReachPx,
  type ClusterHit,
  type ClusterTapAction,
  type WaypointTapRoute,
} from '@core/map/waypointClusters';
import type { GeoJSONSourceRef } from '@maplibre/maplibre-react-native';
import { useSettingsStore } from '@state/settingsStore';
import { create } from 'zustand';

/**
 * Taps on the waypoint marks (#685): a pin, or a cluster of them.
 *
 * Pins are still hit-tested by projecting each one through the real camera
 * (#343, `@core/geo/pinHitTest`), but only the pins MapLibre actually drew
 * near the finger are candidates: a pin folded into a cluster is not on
 * screen, and must never open from a tap beside its cluster. One
 * `queryRenderedFeatures` per tap answers both questions (which pins are
 * drawn there, which clusters are under the finger); should it fail (the
 * style mid-reload), every pin is a candidate, as before #685.
 */

/** The clustered source, set by `WaypointPinLayers` (its cluster queries). */
export const waypointClusterSource: { current: GeoJSONSourceRef | null } = { current: null };

/**
 * The layers a tap asks about: the cluster disc and the unclustered pins'
 * bodies (both in the clustered source). The selected pin is never clustered,
 * so it is always a candidate and needs no asking.
 */
export const WAYPOINT_TAP_LAYERS = ['waypoint-cluster', 'waypoint-pin'];

/** What the hit-test needs from the map. */
export interface WaypointTapMap {
  project: (lngLat: [number, number]) => Promise<readonly [number, number] | null | undefined>;
  queryRenderedFeatures: (
    box: [[number, number], [number, number]],
    options: { layers: string[] },
  ) => Promise<unknown[]>;
}

/** The pin size multiplier now (read at tap time: the setting has no subscriber here). */
const scaleNow = () => pinScaleFactor(useSettingsStore.getState().pinScale);

/**
 * What a tap (or long-press) at `point` hits among the waypoint marks.
 * `keyOf` names a pin the way the layers do (`saved-<id>`, `live-<id>`);
 * `selectedKey` is the pin drawn on its own, on top (never clustered).
 */
export async function waypointAtPoint<T extends PinCandidate>(
  map: WaypointTapMap,
  pins: readonly T[],
  keyOf: (pin: T) => string,
  selectedKey: string | null,
  point: readonly [number, number],
  gesture: PinHitGesture,
): Promise<WaypointTapRoute<T>> {
  if (pins.length === 0) return { kind: 'none' };
  const scale = scaleNow();
  const [px, py] = point;
  let candidates: readonly T[] = pins;
  const clusters: ClusterHit[] = [];
  // A lone pin cannot be clustered: no query needed.
  if (pins.length > 1) {
    const reach = waypointQueryReachPx(scale);
    try {
      const found = await map.queryRenderedFeatures(
        [
          [px - reach, py - reach],
          [px + reach, py + reach],
        ],
        { layers: WAYPOINT_TAP_LAYERS },
      );
      const drawn = new Set<string>();
      for (const f of found) {
        const cluster = readClusterFeature(f);
        if (cluster !== null) {
          if (!clusters.some((c) => c.id === cluster.id)) clusters.push(cluster);
          continue;
        }
        const key = renderedPinKey(f);
        if (key !== null) drawn.add(key);
      }
      candidates = pins.filter((p) => {
        const key = keyOf(p);
        return key === selectedKey || drawn.has(key);
      });
    } catch {
      // The style is mid-reload or the map mid-teardown: every pin is a candidate.
    }
  }

  // One pin the projector refuses must never cost the whole tap (#343).
  const projected: ProjectedPin[] = new Array<ProjectedPin>(candidates.length).fill(null);
  const pinResults = await Promise.allSettled(
    projectablePins(candidates).map(async ({ index, lngLat }) => ({
      index,
      point: await map.project([lngLat[0], lngLat[1]]),
    })),
  );
  for (const r of pinResults) {
    if (r.status === 'fulfilled' && r.value.point != null) {
      projected[r.value.index] = [r.value.point[0], r.value.point[1]];
    }
  }
  const pinHit = nearestPinHitAt(candidates, projected, point, gesture, scale);

  const clusterResults = await Promise.allSettled(
    clusters.map(async (cluster) => {
      const at = await map.project(cluster.lngLat);
      return at == null ? null : { cluster, distancePx: Math.hypot(px - at[0], py - at[1]) };
    }),
  );
  const near: { cluster: ClusterHit; distancePx: number }[] = [];
  for (const r of clusterResults) if (r.status === 'fulfilled' && r.value) near.push(r.value);

  return routeWaypointTap(pinHit, near, scale);
}

/** Where a cluster splits (null when unknown), and the camera's zoom now. */
export async function clusterTapDecision(
  cluster: ClusterHit,
  currentZoom: Promise<number | null>,
): Promise<ClusterTapAction> {
  const source = waypointClusterSource.current;
  const [expansion, zoom] = await Promise.all([
    source ? source.getClusterExpansionZoom(cluster.id).catch(() => null) : Promise.resolve(null),
    currentZoom.catch(() => null),
  ]);
  return clusterTapAction(expansion, zoom);
}

/** The pin keys inside a cluster (at most `limit`). */
export async function clusterPinKeys(cluster: ClusterHit, limit = 200): Promise<string[]> {
  const source = waypointClusterSource.current;
  if (!source) return [];
  const leaves = await source.getClusterLeaves(cluster.id, limit, 0).catch(() => []);
  return leafKeys(leaves);
}

/** The cluster list sheet (#685): the pins of a cluster that cannot split further. */
export const useWaypointClusterSheet = create<{
  keys: string[] | null;
  open: (keys: string[]) => void;
  close: () => void;
}>((set) => ({
  keys: null,
  open: (keys) => set({ keys: keys.length > 0 ? keys : null }),
  close: () => set((s) => (s.keys === null ? s : { keys: null })),
}));

/**
 * A cluster tap, end to end: glide the camera to where it splits, or list
 * its pins in the sheet. `zoomTo` is MapScreen's camera move.
 */
export async function openWaypointCluster(
  cluster: ClusterHit,
  currentZoom: Promise<number | null>,
  zoomTo: (center: [number, number], zoom: number) => void,
): Promise<void> {
  const action = await clusterTapDecision(cluster, currentZoom);
  if (action.kind === 'zoom') {
    zoomTo(cluster.lngLat, action.zoom);
    return;
  }
  useWaypointClusterSheet.getState().open(await clusterPinKeys(cluster));
}
