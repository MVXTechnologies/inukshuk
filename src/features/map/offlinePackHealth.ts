import {
  needsRedownload,
  OFFLINE_PACK_FALLBACK_MAX_ZOOM,
  overviewZoomFor,
  packZoomRange,
} from '@core/geo/tiles';
import { staleTemplateKeys, styleUrlTemplates, type UrlTemplates } from '@core/map/tileUrls';
import { offlinePackGroup } from '@core/trails/packIds';
import type { OfflineRegion } from '@data/offline';
import { readAnnouncedStale, saveAnnouncedStale } from '@data/packHealthNotice';
import { type DownloadLayer, useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useMemo } from 'react';

import { type TimedSnackbar, useTimedSnackbar } from '../common/useTimedSnackbar';

import { MAP_PACK_FORMAT } from './mapStyle';
import { packStyle, type PackExtensions } from './packStyle';

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
 * today (by default every published extension included; `'none'`: the base
 * layer only), or null for a kind no longer drawn (the retired relief map).
 */
export function currentPackUrls(
  tileUrl: string,
  region: OfflineRegion,
  extensions: Exclude<PackExtensions, 'settings'> = 'all',
): UrlTemplates | null {
  if (region.basemap === 'relief') return null;
  return styleUrlTemplates(packStyle(tileUrl, region.basemap, region.format, extensions));
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
 * read them from: those are taken to match today's BASE-LAYER templates and
 * stamped so, once — a later template change then flags them like any other
 * pack. Only the base layer: nothing says which extensions such a pack holds,
 * and stamping one it never had would flag it when that extension moves.
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
      const current = currentPackUrls(tileUrl, region, 'none');
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
 * The stale regions to update together with `region`: every stale part of
 * the same trail download (one offline map to the user — `offlinePackGroup`),
 * else `region` alone. In list order.
 */
export function staleUpdateGroup(
  region: OfflineRegion,
  regions: readonly OfflineRegion[],
  stale: ReadonlySet<string>,
): OfflineRegion[] {
  const group = offlinePackGroup(region.id);
  const members = regions.filter((r) => stale.has(r.id) && offlinePackGroup(r.id) === group);
  return members.length > 0 ? members : [region];
}

/** The offline maps (not packs: a trail download's parts are one) among `stale`, sorted. */
export function staleMapGroups(stale: ReadonlySet<string>): string[] {
  return [...new Set([...stale].map(offlinePackGroup))].sort();
}

/** How many offline maps need updating (a trail download's parts count once). */
export function staleMapCount(stale: ReadonlySet<string>): number {
  return staleMapGroups(stale).length;
}

/**
 * What the notice does given what it last announced and the stale maps now
 * (both sorted group ids): speak only when a map joined the list, and record
 * the list whenever it changed — so a map updated and later stale again is
 * news again.
 */
export function nextStaleNotice(
  announced: readonly string[],
  current: readonly string[],
): { announce: boolean; save: string[] | null } {
  const seen = new Set(announced);
  const announce = current.some((id) => !seen.has(id));
  const same = announced.length === current.length && current.every((id) => seen.has(id));
  return { announce, save: same ? null : [...current] };
}

/**
 * Tell the user when offline maps need updating — on the map, where a blank
 * offline area would otherwise be the first sign — once per newly stale map,
 * across cold starts (the announced list persists). Render the returned
 * snackbar with an action to Settings › Data (duration Infinity: see
 * `useTimedSnackbar`). Retired raster packs count too: they are blank offline.
 */
export function useOfflinePackHealthNotice(): TimedSnackbar {
  const snackbar = useTimedSnackbar(8000);
  const stale = useOfflinePackHealth();
  const loaded = useOfflineStore((s) => s.hydrated);
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const key = staleMapGroups(stale).join('\n');
  const { show } = snackbar;
  useEffect(() => {
    // Before both stores load, an empty list means "not known yet", not "all fixed".
    if (!loaded || !settingsHydrated) return;
    const current = key === '' ? [] : key.split('\n');
    let live = true;
    void (async () => {
      const announced = await readAnnouncedStale().catch(() => []);
      if (!live) return;
      const { announce, save } = nextStaleNotice(announced, current);
      // Speak before recording, so nothing is ever recorded as told unsaid.
      if (announce) {
        show(
          current.length === 1
            ? 'An offline map needs updating'
            : `${current.length} offline maps need updating`,
        );
      }
      if (save !== null) await saveAnnouncedStale(save).catch(() => undefined);
    })();
    return () => {
      live = false;
    };
  }, [key, loaded, settingsHydrated, show]);
  return snackbar;
}
