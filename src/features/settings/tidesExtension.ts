/**
 * The Tide stations extension's actions (Settings → Extensions):
 *
 * - Get: install and switch on (the overlays' Extensions panel gets its
 *   switch; Canada's stations then load live from CHS onto the device; new
 *   offline regions carry the station tiles — a few kB, the archive stops at
 *   z10 and overzooms).
 * - Remove: uninstall. The device's own CHS copy (a few hundred kB) stays, so
 *   a reinstall works offline at once.
 */
import { parseTideCoverage, type TideCoverage } from '@core/tides/coverage';
import { TILE_HOST } from '@data/basemapTiles';
import { useSettingsStore } from '@state/settingsStore';

export function installTides(): void {
  const { set } = useSettingsStore.getState();
  set('tidesInstalledAt', Date.now());
  set('showTideStations', true);
}

export function removeTides(): void {
  useSettingsStore.getState().set('tidesInstalledAt', 0);
}

/** Stations per source from `/tides.json`; null offline. */
export async function fetchTideCoverage(): Promise<TideCoverage | null> {
  try {
    const res = await fetch(`${TILE_HOST}/tides.json?v=1`);
    return res.ok ? parseTideCoverage(await res.json()) : null;
  } catch {
    return null;
  }
}
