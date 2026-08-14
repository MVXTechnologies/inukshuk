import { buildLocatorScene, type LocatorScene } from './locator';
import { LOCATOR_BASEMAP } from './locatorBasemap';
import type { CatalogBbox } from './schema';

/**
 * Memoized `buildLocatorScene` against the app's single locator basemap.
 *
 * Building a scene projects and Sutherland–Hodgman-clips ~5.5k basemap points
 * (measured over the real manifest: 0.26 ms on desktop V8, several times that
 * on Hermes). A `useMemo` in the row component only survives while that row is
 * mounted, and a FlatList recycles cells constantly — so scrolling back up
 * re-ran the whole projection for rows it had already drawn. The scene is a
 * deterministic pure function of its inputs, so it is safe to cache process-
 * wide; there is no staleness to worry about.
 *
 * The cache is BOUNDED. The catalog it was written against was ~130 items, but
 * the world catalog is ~66k — an unbounded map would retain a scene per bbox
 * ever scrolled past, and each scene holds several path strings. Eviction is
 * least-recently-used: `Map` iterates in insertion order, so a hit re-inserts
 * and the oldest key is always first.
 */

/** Max scenes retained. ~900 chars of path data each, so a few hundred KB. */
export const LOCATOR_SCENE_CACHE_MAX = 256;

const cache = new Map<string, LocatorScene>();

/**
 * The locator scene for `bbox` at `size` px, built at most once per distinct
 * pair. `size` is part of the key: two different canvas sizes are two different
 * scenes, and keying on the bbox alone would hand back paths projected for the
 * wrong viewBox.
 */
export function locatorScene(bbox: CatalogBbox, size: number): LocatorScene {
  const key = `${size}|${bbox.join(',')}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency: delete + set moves this key to the end of the order.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const scene = buildLocatorScene(bbox, LOCATOR_BASEMAP, size);
  cache.set(key, scene);
  if (cache.size > LOCATOR_SCENE_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return scene;
}

/** Entries currently retained. Exposed for tests. */
export function locatorSceneCacheSize(): number {
  return cache.size;
}

/** Drop everything. Exposed for tests — nothing in the app needs to call this. */
export function clearLocatorSceneCache(): void {
  cache.clear();
}
