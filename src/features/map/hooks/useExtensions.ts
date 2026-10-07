import type { ExtensionKey, ExtensionsState } from '@core/map/extensions';
import { geodeticTilesUrl, tideTilesUrl } from '@data/basemapTiles';
import { cragTilesUrl } from '@data/climbing';
import { useSettingsStore } from '@state/settingsStore';

/** The published extensions (their tiles are on the host). */
export function availableExtensions(): ExtensionKey[] {
  const out: ExtensionKey[] = [];
  if (geodeticTilesUrl() !== null) out.push('geodetic');
  if (tideTilesUrl() !== null) out.push('tides');
  if (cragTilesUrl() !== null) out.push('climbing');
  return out;
}

/** The map extensions' persisted state, for `@core/map/extensions`. */
export function useExtensionsState(): ExtensionsState {
  const geodeticInstalledAt = useSettingsStore((s) => s.geodeticInstalledAt);
  const showGeodetic = useSettingsStore((s) => s.showGeodetic);
  const tidesInstalledAt = useSettingsStore((s) => s.tidesInstalledAt);
  const showTideStations = useSettingsStore((s) => s.showTideStations);
  const climbingInstalledAt = useSettingsStore((s) => s.climbingInstalledAt);
  const showClimbing = useSettingsStore((s) => s.showClimbing);
  return {
    available: availableExtensions(),
    geodeticInstalledAt,
    showGeodetic,
    tidesInstalledAt,
    showTideStations,
    climbingInstalledAt,
    showClimbing,
  };
}
