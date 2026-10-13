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

/**
 * Device extensions: installed and removed like the map ones (Settings →
 * Extensions, the same Get / switch / Remove frame and the same persisted
 * `extensions[key]` entry), but they add a device or a tool, not a map layer
 * — no tiles, no style, no offline packs, no overlays row. Listed after the
 * map extensions, in this order.
 */
export const DEVICE_EXTENSION_KEYS = ['gnss', 'team'] as const;

export type DeviceExtensionKey = (typeof DEVICE_EXTENSION_KEYS)[number];

/** Every extension, map ones first: what `extensions` in settings.json holds. */
export const ALL_EXTENSION_KEYS = [...EXTENSION_KEYS, ...DEVICE_EXTENSION_KEYS] as const;

export type AnyExtensionKey = ExtensionKey | DeviceExtensionKey;
