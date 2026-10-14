import type { AnyExtensionKey } from '@core/extensions/keys';
import { installedExtensions } from '@core/extensions/state';
import type { InfoStripSettings } from '@core/infoStrip/settings';
import type { InfoStrip } from '@core/infoStrip/types';
import { availableDeviceExtensions, availableExtensions } from '@features/extensions/availability';
import { useSettingsStore } from '@state/settingsStore';
import { useMemo } from 'react';

/** The strip on the map (`settings.infoStrip.current`). */
export const useCurrentStrip = (): InfoStrip => useSettingsStore((s) => s.infoStrip.current);

/** Change the whole `infoStrip` key (one write, with its 2.5.1 mirror). */
export function updateInfoStrip(fn: (s: InfoStripSettings) => InfoStripSettings): void {
  const { infoStrip, setInfoStrip } = useSettingsStore.getState();
  setInfoStrip(fn(infoStrip));
}

/** Change the strip on the map. */
export function updateCurrentStrip(fn: (s: InfoStrip) => InfoStrip): void {
  updateInfoStrip((all) => ({ ...all, current: fn(all.current) }));
}

/**
 * The extensions installed on this device (map and device ones): which
 * extension fields the picker lists and a preset keeps.
 */
export function useInstalledExtensions(): ReadonlySet<AnyExtensionKey> {
  const prefs = useSettingsStore((s) => s.extensions);
  return useMemo(
    () =>
      new Set<AnyExtensionKey>([
        ...installedExtensions({ available: availableExtensions(), prefs }),
        ...availableDeviceExtensions().filter((k) => prefs[k].installedAt > 0),
      ]),
    [prefs],
  );
}
