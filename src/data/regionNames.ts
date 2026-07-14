import { readJson, writeJson } from './storage';

/**
 * Persisted display names for offline regions, keyed by app-level region id
 * (`<baseId>-<basemap>`). MapLibre's RN wrapper offers no way to update a
 * pack's metadata after creation, so the auto-resolved place name (and any
 * user rename) lives in this sidecar and is merged over `listRegionPacks()`.
 */
const NAMES_FILE = 'offline-names.json';

/** Serializes read-modify-write cycles so concurrent saves can't clobber each other. */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

export async function readRegionNames(): Promise<Record<string, string>> {
  const value = await readJson<Record<string, string>>(NAMES_FILE);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const names: Record<string, string> = {};
  for (const [id, label] of Object.entries(value)) {
    if (typeof label === 'string') names[id] = label;
  }
  return names;
}

/** Merge the given entries into the persisted name map. */
export function saveRegionNames(entries: Record<string, string>): Promise<void> {
  return serialized(async () => {
    writeJson(NAMES_FILE, { ...(await readRegionNames()), ...entries });
  });
}

/** Drop a region's entry (called when the region is deleted). */
export function deleteRegionName(id: string): Promise<void> {
  return serialized(async () => {
    const names = await readRegionNames();
    if (!(id in names)) return;
    delete names[id];
    writeJson(NAMES_FILE, names);
  });
}
