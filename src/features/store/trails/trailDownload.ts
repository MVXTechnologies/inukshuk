import { overviewZoomFor, packZoomRange } from '@core/geo/tiles';
import {
  canDownloadWholeTrail,
  CORRIDOR_MAX_ZOOM,
  planCorridorDownload,
  type CorridorPlan,
} from '@core/trails/corridor';
import { trailPackPrefix } from '@core/trails/packIds';
import type { TrailDetail } from '@core/trails/schema';
import { stageDisplayName } from '@core/trails/stages';
import { assessFreeSpaceForWrite } from '@data/diskSpace';
import type { OfflineRegion } from '@data/offline';
import { packStyle } from '@features/map/hooks/useOfflineDownload';
import { MAP_PACK_FORMAT } from '@features/map/mapStyle';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';

/**
 * Offline maps along a long-distance trail (#467), **stage by stage** (owner
 * call, #472): each stage downloads its own corridor (≈3 km each side) as a
 * series of MapLibre packs through the region downloader (`offlineStore`,
 * `createRegionPack`, the same pack style), cut by `@core/trails/corridor`.
 * A trail without stages is one download only when it is short
 * (`canDownloadWholeTrail`). The packs appear in Settings › Offline maps as
 * "<trail> · <stage> (1/n)", each deletable like any region.
 *
 * `stage` is a stage index, or null for a stage-less trail as a whole.
 */

export type TrailDownloadTarget = number | null;

// The id scheme lives in core: the offline-maps health check groups by it too.
export { trailPackPrefix };

/** A stable key for "this stage of this trail" (the download in progress). */
export const trailDownloadKey = (trailId: string, stage: TrailDownloadTarget) =>
  trailPackPrefix(trailId, stage);

export function targetGeometry(detail: TrailDetail, stage: TrailDownloadTarget) {
  return stage === null ? detail.geometry : (detail.stages[stage]?.geometry ?? []);
}

export function planTrailDownload(detail: TrailDetail, stage: TrailDownloadTarget): CorridorPlan {
  return planCorridorDownload(targetGeometry(detail, stage), MAP_PACK_FORMAT);
}

/** Whether this target may be downloaded at all (stages always; a whole trail only when short). */
export function downloadable(detail: TrailDetail, stage: TrailDownloadTarget, plan: CorridorPlan) {
  if (stage !== null) return !plan.tooBig;
  return detail.stages.length === 0 && canDownloadWholeTrail(detail.lengthKm, plan);
}

/** The target's downloaded packs (complete or not). */
export function trailPacks(
  regions: readonly OfflineRegion[],
  trailId: string,
  stage: TrailDownloadTarget,
): OfflineRegion[] {
  const prefix = trailPackPrefix(trailId, stage);
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
      return 'Too long to download in one go — download an area from the map instead';
    case 'no-space':
      return r.message;
  }
}

/**
 * Start the download. Resolves when every part has been attempted; throws the
 * collected failures. `onProgress` gets 0…1. Returns a refusal (nothing
 * started) or null; `onStarted` gets a low-space warning to show, if any.
 */
export async function downloadTrail(
  detail: TrailDetail,
  stage: TrailDownloadTarget,
  plan: CorridorPlan,
  onProgress: (fraction: number) => void,
  onStarted?: (warning: string | null) => void,
): Promise<TrailDownloadRefusal | null> {
  if (useSettingsStore.getState().offlineOnly) return { kind: 'offline-only' };
  if (useOfflineStore.getState().progress !== null) return { kind: 'busy' };
  if (!downloadable(detail, stage, plan)) return { kind: 'too-big' };
  const budget = assessFreeSpaceForWrite(plan.bytes);
  if (budget?.verdict === 'block') {
    return { kind: 'no-space', message: budget.message ?? 'Not enough free space for this trail' };
  }
  onStarted?.(budget?.verdict === 'warn' ? (budget.message ?? null) : null);
  // A retry after a partial download starts clean: the old parts' ids would collide.
  const store = useOfflineStore.getState();
  for (const old of trailPacks(store.regions, detail.id, stage)) {
    await store.remove(old.id).catch(() => undefined);
  }
  const s = stage === null ? undefined : detail.stages[stage];
  const name =
    s === undefined ? detail.name : `${detail.name} · ${stageDisplayName(s, detail.name)}`;
  const tileUrl = useSettingsStore.getState().tileUrl;
  const { maxZoom } = packZoomRange('map', 0, CORRIDOR_MAX_ZOOM, MAP_PACK_FORMAT);
  const total = plan.boxes.length;
  await useOfflineStore.getState().downloadSeries({
    parts: plan.boxes.map((bounds, i) => ({
      id: `${trailPackPrefix(detail.id, stage)}${i + 1}`,
      label: total > 1 ? `${name} (${i + 1}/${total})` : name,
      bounds,
      minZoom: Math.min(overviewZoomFor(bounds), maxZoom),
    })),
    layer: {
      basemap: 'map',
      format: MAP_PACK_FORMAT,
      styleJSON: JSON.stringify(packStyle(tileUrl, 'map', MAP_PACK_FORMAT)),
      maxZoom,
    },
    progressLabel: name,
    onProgress,
  });
  return null;
}
