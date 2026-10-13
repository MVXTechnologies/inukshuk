/**
 * The extension registry (architecture review P1-3): every map extension's
 * pure descriptor, by key. Everything that used to hand-list geodetic and
 * tides — the overlays row, the map style, offline packs, credits, settings
 * migration — iterates this instead. Adding an extension: docs/ARCHITECTURE.md
 * § "Adding an extension".
 */
import { GEODETIC_EXTENSION } from './descriptors/geodetic';
import { GNSS_EXTENSION } from './descriptors/gnss';
import { TEAM_EXTENSION } from './descriptors/team';
import { TIDES_EXTENSION } from './descriptors/tides';
import {
  EXTENSION_KEYS,
  isExtensionKey,
  type AnyExtensionKey,
  type DeviceExtensionKey,
  type ExtensionKey,
} from './keys';
import type {
  DeviceExtensionDescriptor,
  ExtensionDescriptor,
  ExtensionIdentity,
  ExtensionPrefs,
  StyleInputOf,
} from './types';

export const EXTENSIONS = {
  geodetic: GEODETIC_EXTENSION,
  tides: TIDES_EXTENSION,
} satisfies Record<ExtensionKey, ExtensionDescriptor>;

export function extensionDescriptor(key: ExtensionKey): ExtensionDescriptor {
  return EXTENSIONS[key];
}

/** The device extensions' descriptors (no map half), by key. */
export const DEVICE_EXTENSIONS = {
  gnss: GNSS_EXTENSION,
  team: TEAM_EXTENSION,
} satisfies Record<DeviceExtensionKey, DeviceExtensionDescriptor>;

/** What every extension, map or device, has: its name, its teaser, its first switches. */
export interface ExtensionBasics extends ExtensionIdentity {
  defaults: Pick<ExtensionPrefs, 'show' | 'offline'>;
  legacySettings?: ExtensionDescriptor['legacySettings'];
}

export function extensionBasics(key: AnyExtensionKey): ExtensionBasics {
  return isExtensionKey(key) ? EXTENSIONS[key] : DEVICE_EXTENSIONS[key];
}

/**
 * The extensions' entries in `buildOsmStyle`'s options: `{ geodetic?, tides? }`,
 * each typed by its own descriptor's style input.
 */
export type ExtensionStyleOptions = {
  [K in ExtensionKey]?: StyleInputOf<(typeof EXTENSIONS)[K]>;
};

/** Extensions whose regions get companion packs (`@data/offline`). */
export function companionExtensions(): ExtensionKey[] {
  return EXTENSION_KEYS.filter((k) => EXTENSIONS[k].offline.companion !== undefined);
}

export {
  ALL_EXTENSION_KEYS,
  DEVICE_EXTENSION_KEYS,
  EXTENSION_KEYS,
  isExtensionKey,
  type AnyExtensionKey,
  type DeviceExtensionKey,
  type ExtensionKey,
} from './keys';
