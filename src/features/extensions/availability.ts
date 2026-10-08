/**
 * Which extensions this build offers, and their tile templates: an extension
 * is published when its dataset's tiles are on the host (`@data/datasets`).
 * No React here: offline pack styles read it too.
 */
import {
  DEVICE_EXTENSION_KEYS,
  EXTENSION_KEYS,
  EXTENSIONS,
  type DeviceExtensionKey,
  type ExtensionKey,
} from '@core/extensions/registry';
import { datasetTilesUrl } from '@data/datasets';
import { gnssLinkAvailable } from '@data/gnss/link';
import { teamAvailability } from '@data/team/appTeam';

/** An extension's tile template, or null while its dataset is unpublished. */
export function extensionTilesUrl(key: ExtensionKey): string | null {
  return datasetTilesUrl(EXTENSIONS[key].dataset);
}

/** The published extensions, in registry order. */
export function availableExtensions(): ExtensionKey[] {
  return EXTENSION_KEYS.filter((k) => extensionTilesUrl(k) !== null);
}

/** Whether this build can run a device extension (its hardware path exists). */
const DEVICE_AVAILABLE: Record<DeviceExtensionKey, () => boolean> = {
  // The receiver needs the native module, or the simulated receiver (debug / E2E builds).
  gnss: gnssLinkAvailable,
  // Team mode needs the mesh module, the CSPRNG and the secure store (2.5.0+).
  team: () => teamAvailability() === 'ok',
};

/** The device extensions this build offers, in registry order. */
export function availableDeviceExtensions(): DeviceExtensionKey[] {
  return DEVICE_EXTENSION_KEYS.filter((k) => DEVICE_AVAILABLE[k]());
}
