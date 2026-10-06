import {
  needsRedownload,
  OFFLINE_PACK_FALLBACK_MAX_ZOOM,
  overviewZoomFor,
  packZoomRange,
} from '@core/geo/tiles';
import { staleTemplateKeys, styleUrlTemplates, type UrlTemplates } from '@core/map/tileUrls';
import type { OfflineRegion } from '@data/offline';
import { type DownloadLayer, useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useMemo, useRef } from 'react';

import { MAP_PACK_FORMAT } from './mapStyle';
import { packStyle } from './packStyle';

/**
 * Offline-pack health (architecture review P1-2): a pack stores its tiles
 * under the exact URL templates its style named, so a pack built with
 * templates the app no longer uses holds tiles the live map will never ask
 * for — a blank map where the user thought they had one. These helpers find
 * those packs, so the offline-maps list can say "needs update" and offer the
 * re-download instead of failing silently.
 */

/**
 * Every URL template a pack of this region's kind would carry if downloaded
 * today (every published extension included), or null for a kind no longer
 * drawn (the retired relief base map).
 */
export function currentPackUrls(tileUrl: string, region: OfflineRegion): UrlTemplates | null {
  if (region.basemap === 'relief') return null;
  return styleUrlTemplates(packStyle(tileUrl, region.basemap, region.format, 'all'));
}

/**
 * The templates of `region` the live map no longer uses (empty when it is
 * healthy, or carries no record to judge by).
 */
export function staleRegionUrls(tileUrl: string, region: OfflineRegion): string[] {
  const current = currentPackUrls(tileUrl, region);
  if (current === null || region.urls === undefined) return [];
  return staleTemplateKeys(region.urls, current);
}

/**
 * Whether a region should be downloaded again: its tiles sit under URLs the
 * map no longer requests, or it is a raster pack of a base map now drawn from
 * vector tiles (`needsRedownload`).
 */
export function regionNeedsUpdate(tileUrl: string, region: OfflineRegion): boolean {
  return needsRedownload(region, MAP_PACK_FORMAT) || staleRegionUrls(tileUrl, region).length > 0;
}

/**
 * The layer that re-downloads `region` with today's style: the same base map
 * and quality, in the format the map draws now. Null for a retired base map.
 */
export function regionUpdateLayer(tileUrl: string, region: OfflineRegion): DownloadLayer | null {
  if (region.basemap === 'relief') return null;
  const basemap = region.basemap;
  const format = basemap === 'map' ? MAP_PACK_FORMAT : 'raster';
  return {
    basemap,
    format,
    styleJSON: JSON.stringify(packStyle(tileUrl, basemap, format)),
    ...packZoomRange(
      basemap,
      overviewZoomFor(region.bounds),
      region.maxZoom ?? OFFLINE_PACK_FALLBACK_MAX_ZOOM,
      format,
    ),
  };
}

/**
 * The ids of the offline regions that need downloading again. Also completes
 * the migration for packs that recorded no templates and had no saved style to
 * read them from: those are taken to match today's templates and stamped so,
 * once — a later template change then flags them like any other pack.
 */
export function useOfflinePackHealth(): ReadonlySet<string> {
  const regions = useOfflineStore((s) => s.regions);
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const settingsHydrated = useSettingsStore((s) => s.hydrated);

  useEffect(() => {
    // The raster map's template is the user's tile setting: wait for it.
    if (!settingsHydrated) return;
    const stamps: Record<string, UrlTemplates> = {};
    for (const region of regions) {
      if (region.urls !== undefined || !region.complete) continue;
      const current = currentPackUrls(tileUrl, region);
      if (current !== null) stamps[region.id] = current;
    }
    if (Object.keys(stamps).length > 0) void useOfflineStore.getState().stampUrls(stamps);
  }, [regions, tileUrl, settingsHydrated]);

  return useMemo(
    () =>
      new Set(
        settingsHydrated
          ? regions.filter((r) => r.complete && regionNeedsUpdate(tileUrl, r)).map((r) => r.id)
          : [],
      ),
    [regions, tileUrl, settingsHydrated],
  );
}

/**
 * Tell the user once per session that some offline regions need updating —
 * on the map, where a blank offline area would otherwise be the first sign.
 */
export function useOfflinePackHealthNotice(showSnack: (message: string) => void): void {
  const stale = useOfflinePackHealth();
  const told = useRef(false);
  const count = stale.size;
  useEffect(() => {
    if (told.current || count === 0) return;
    told.current = true;
    showSnack(
      count === 1
        ? 'An offline map needs updating — Settings → Offline maps'
        : `${count} offline maps need updating — Settings → Offline maps`,
    );
  }, [count, showSnack]);
}
