/**
 * Which extensions this build offers, and their tile templates: an extension
 * is published when its dataset's tiles are on the host (`@data/datasets`).
 * No React here: offline pack styles read it too.
 */
import { EXTENSION_KEYS, EXTENSIONS, type ExtensionKey } from '@core/extensions/registry';
import { datasetTilesUrl } from '@data/datasets';

/** An extension's tile template, or null while its dataset is unpublished. */
export function extensionTilesUrl(key: ExtensionKey): string | null {
  return datasetTilesUrl(EXTENSIONS[key].dataset);
}

/** The published extensions, in registry order. */
export function availableExtensions(): ExtensionKey[] {
  return EXTENSION_KEYS.filter((k) => extensionTilesUrl(k) !== null);
}
