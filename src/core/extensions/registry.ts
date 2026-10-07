/**
 * The extension registry (architecture review P1-3): every map extension's
 * pure descriptor, by key. Everything that used to hand-list geodetic and
 * tides — the overlays row, the map style, offline packs, credits, settings
 * migration — iterates this instead. Adding an extension: docs/ARCHITECTURE.md
 * § "Adding an extension".
 */
import { GEODETIC_EXTENSION } from './descriptors/geodetic';
import { TIDES_EXTENSION } from './descriptors/tides';
import { EXTENSION_KEYS, type ExtensionKey } from './keys';
import type { ExtensionDescriptor, StyleInputOf } from './types';

export const EXTENSIONS = {
  geodetic: GEODETIC_EXTENSION,
  tides: TIDES_EXTENSION,
} satisfies Record<ExtensionKey, ExtensionDescriptor>;

export function extensionDescriptor(key: ExtensionKey): ExtensionDescriptor {
  return EXTENSIONS[key];
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

export { EXTENSION_KEYS, isExtensionKey, type ExtensionKey } from './keys';
