import { overviewZoomFor, packZoomRange } from '@core/geo/tiles';
import { CORRIDOR_MAX_ZOOM, planCorridorDownload, type CorridorPlan } from '@core/trails/corridor';
import type { TrailDetail } from '@core/trails/schema';
import { assessFreeSpaceForWrite } from '@data/diskSpace';
import type { OfflineRegion } from '@data/offline';
import { packStyle } from '@features/map/hooks/useOfflineDownload';
import { MAP_PACK_FORMAT } from '@features/map/mapStyle';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';

/**
 * "Download" on a trail page (#467): the offline map along the whole trail,
 * ≈3 km each side, as a series of MapLibre packs — the region download's own
 * machinery (`offlineStore`, `createRegionPack`, the same pack style), cut
 * along the trail by `@core/trails/corridor`. The packs appear in Settings ›
 * Offline maps as "<trail> (1/n)"…, each deletable like any region.
 */

export const trailPackPrefix = (trailId: string) => `trail-${trailId}-`;

export function planTrailDownload(detail: TrailDetail): CorridorPlan {
  return planCorridorDownload(detail.geometry, MAP_PACK_FORMAT);
}

/** The trail's downloaded packs (complete or not). */
export function trailPacks(regions: readonly OfflineRegion[], trailId: string): OfflineRegion[] {
  const prefix = trailPackPrefix(trailId);
  return regions.filter((r) => r.id.startsWith(prefix));
}

export type TrailDownloadRefusal =
  | { kind: 'offline-only' }
  | { kind: 'busy' }
  | { kind: 'too-big' }
  | { kind: 'no-space'; message: string };

export function refusalMessage(r: TrailDownloadRefusal): string {
  switch (r.kind) {
    case 'offline-only':
      return "Turn off 'Locally downloaded only' to download a trail";
    case 'busy':
      return 'Another offline map is downloading — try again when it’s done';
    case 'too-big':
      return 'This trail is too long to download in one go — download an area from the map instead';
    case 'no-space':
      return r.message;
  }
}

/**
 * Start the download. Resolves when every part has been attempted; throws the
 * collected failures. `onProgress` gets 0…1 for the whole trail. Returns a
 * refusal (nothing started) or a warning to show alongside the progress.
 */
export async function downloadTrail(
  detail: TrailDetail,
  plan: CorridorPlan,
  onProgress: (fraction: number) => void,
  onStarted?: (warning: string | null) => void,
): Promise<TrailDownloadRefusal | null> {
  if (useSettingsStore.getState().offlineOnly) return { kind: 'offline-only' };
  if (useOfflineStore.getState().progress !== null) return { kind: 'busy' };
  if (plan.tooBig) return { kind: 'too-big' };
  const budget = assessFreeSpaceForWrite(plan.bytes);
  if (budget?.verdict === 'block') {
    return { kind: 'no-space', message: budget.message ?? 'Not enough free space for this trail' };
  }
  onStarted?.(budget?.verdict === 'warn' ? (budget.message ?? null) : null);
  // A retry after a partial download starts clean: the old parts' ids would collide.
  const store = useOfflineStore.getState();
  for (const old of trailPacks(store.regions, detail.id)) {
    await store.remove(old.id).catch(() => undefined);
  }
  const tileUrl = useSettingsStore.getState().tileUrl;
  const { maxZoom } = packZoomRange('map', 0, CORRIDOR_MAX_ZOOM, MAP_PACK_FORMAT);
  const total = plan.boxes.length;
  await useOfflineStore.getState().downloadSeries({
    parts: plan.boxes.map((bounds, i) => ({
      id: `${trailPackPrefix(detail.id)}${i + 1}`,
      label: total > 1 ? `${detail.name} (${i + 1}/${total})` : detail.name,
      bounds,
      minZoom: Math.min(overviewZoomFor(bounds), maxZoom),
    })),
    layer: {
      basemap: 'map',
      format: MAP_PACK_FORMAT,
      styleJSON: JSON.stringify(packStyle(tileUrl, 'map', MAP_PACK_FORMAT)),
      maxZoom,
    },
    progressLabel: detail.name,
    onProgress,
  });
  return null;
}
