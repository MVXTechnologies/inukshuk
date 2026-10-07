/**
 * Every extension's lifecycle (Settings → Extensions), one way:
 *
 * - Get: install and switch on (one settings write), then its `onInstall`
 *   (coverage, companion packs…);
 * - Remove: uninstall (its switches are kept for a reinstall), then its
 *   `onRemove` (drop its companion packs…);
 * - Offline in your regions: save the switch, then its `onOfflineChange`.
 */
import type { AnyExtensionKey } from '@core/extensions/keys';

import { EXTENSION_SETTINGS } from './settingsModules';
import { setExtensionPrefs } from './prefs';

export function installExtension(key: AnyExtensionKey): void {
  setExtensionPrefs(key, { installedAt: Date.now(), show: true });
  EXTENSION_SETTINGS[key].onInstall?.();
}

export async function removeExtension(key: AnyExtensionKey): Promise<void> {
  setExtensionPrefs(key, { installedAt: 0 });
  await EXTENSION_SETTINGS[key].onRemove?.();
}

export async function setExtensionOffline(key: AnyExtensionKey, on: boolean): Promise<void> {
  setExtensionPrefs(key, { offline: on });
  await EXTENSION_SETTINGS[key].onOfflineChange?.(on);
}
