import { parseUrlTemplates, type UrlTemplates } from '@core/map/tileUrls';

import { readJson, writeJson } from './storage';

/**
 * URL templates stamped onto offline packs from before packs recorded their
 * own (`PackMeta.urls`), keyed by app-level region id. MapLibre's RN wrapper
 * cannot update a pack's metadata after creation, so — like the region names
 * (`./regionNames`) — the stamp lives in this sidecar and is merged over
 * `listRegionPacks()`. A pack's own metadata always wins over its stamp.
 */
const PACK_URLS_FILE = 'offline-pack-urls.json';

/** Serializes read-modify-write cycles so concurrent saves can't clobber each other. */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

export async function readPackUrls(): Promise<Record<string, UrlTemplates>> {
  const value = await readJson<unknown>(PACK_URLS_FILE);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, UrlTemplates> = {};
  for (const [id, urls] of Object.entries(value)) {
    const parsed = parseUrlTemplates(urls);
    if (parsed !== null) out[id] = parsed;
  }
  return out;
}

/** Merge the given stamps into the persisted map. */
export function savePackUrls(entries: Record<string, UrlTemplates>): Promise<void> {
  return serialized(async () => {
    writeJson(PACK_URLS_FILE, { ...(await readPackUrls()), ...entries });
  });
}

/** Drop a region's stamp (its pack was deleted, or replaced by one that records its own). */
export function deletePackUrls(id: string): Promise<void> {
  return serialized(async () => {
    const all = await readPackUrls();
    if (!(id in all)) return;
    delete all[id];
    writeJson(PACK_URLS_FILE, all);
  });
}
