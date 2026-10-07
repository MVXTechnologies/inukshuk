/**
 * Every map extension, in DRAW order (bottom → top on the map). The same
 * order lists them in Settings → Extensions and Map overlays › Extensions;
 * a map tap asks them top-down (the symbol drawn on top wins).
 */
export const EXTENSION_KEYS = ['geodetic', 'tides'] as const;

export type ExtensionKey = (typeof EXTENSION_KEYS)[number];

export function isExtensionKey(value: unknown): value is ExtensionKey {
  return typeof value === 'string' && (EXTENSION_KEYS as readonly string[]).includes(value);
}
