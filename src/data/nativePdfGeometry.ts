import { File, Paths } from 'expo-file-system';

/**
 * Pages whose native-renderer geometry pdf.js has verified, remembered across
 * launches (`@core/geo/nativePdfSupport` `persistentNativeGeometryKey`). In
 * the cache directory: losing it only costs one pdf.js check per page.
 */
const FILE = 'pdf-native-geometry.json';
export const NATIVE_GEOMETRY_PERSIST_LIMIT = 64;

export function loadVerifiedNativePages(): string[] {
  try {
    const file = new File(Paths.cache, FILE);
    if (!file.exists || file.size > 256 * 1024) return [];
    const value: unknown = JSON.parse(file.textSync());
    if (!Array.isArray(value)) return [];
    return value
      .filter((k): k is string => typeof k === 'string' && k.length < 2048)
      .slice(-NATIVE_GEOMETRY_PERSIST_LIMIT);
  } catch {
    return [];
  }
}

/** Best effort: a failed write only means one more verification next launch. */
export function saveVerifiedNativePages(keys: readonly string[]): void {
  try {
    const file = new File(Paths.cache, FILE);
    if (!file.exists) file.create();
    file.write(JSON.stringify(keys.slice(-NATIVE_GEOMETRY_PERSIST_LIMIT)));
  } catch {
    // ignore
  }
}
