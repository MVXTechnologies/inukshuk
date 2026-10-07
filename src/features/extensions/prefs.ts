/**
 * The extensions' persisted state in the settings store (`extensions[key]`,
 * `@core/extensions/prefs`): read it, change it, subscribe to it.
 */
import type { ExtensionKey } from '@core/extensions/keys';
import { withExtensionPrefs } from '@core/extensions/prefs';
import type { ExtensionsState } from '@core/extensions/state';
import type { ExtensionPrefs } from '@core/extensions/types';
import { useSettingsStore } from '@state/settingsStore';

import { availableExtensions } from './availability';

export function extensionPrefs(key: ExtensionKey): ExtensionPrefs {
  return useSettingsStore.getState().extensions[key];
}

/** Change some of one extension's fields (one settings write; none when nothing changes). */
export function setExtensionPrefs(key: ExtensionKey, patch: Partial<ExtensionPrefs>): void {
  const { extensions, set } = useSettingsStore.getState();
  const current = extensions[key];
  const changed = (Object.keys(patch) as (keyof ExtensionPrefs)[]).some(
    (f) => !Object.is(patch[f], current[f]),
  );
  if (changed) set('extensions', withExtensionPrefs(extensions, key, patch));
}

export function useExtensionPrefs(key: ExtensionKey): ExtensionPrefs {
  return useSettingsStore((s) => s.extensions[key]);
}

/** The extensions' availability and persisted state, for `@core/extensions/state`. */
export function useExtensionsState(): ExtensionsState {
  const prefs = useSettingsStore((s) => s.extensions);
  return { available: availableExtensions(), prefs };
}

/** The same, outside React. */
export function extensionsState(): ExtensionsState {
  return { available: availableExtensions(), prefs: useSettingsStore.getState().extensions };
}
