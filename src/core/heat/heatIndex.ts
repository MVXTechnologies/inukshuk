import { ringKeys, type Cell } from './grid';

/** One visible performed trail's footprint (never navigation trails). */
export interface HeatTrackInput {
  id: string;
  categoryId: string;
  dilated: ReadonlySet<string>;
}

/** cellKey → categoryId → the distinct trail ids touching that cell. */
export type HeatIndex = Map<string, Map<string, Set<string>>>;

/** Track insertion order for each HeatIndex instance */
const insertionOrders = new WeakMap<HeatIndex, Map<string, number>>();

/**
 * Builds a heat index from tracks. The returned Map instance is coupled to an
 * internal WeakMap that tracks track insertion order. Pass the exact Map
 * returned by this function to trailsNear to guarantee trackIds are in input
 * insertion order. An index built or filtered any other way falls back to
 * ring-scan order.
 */
export function buildHeatIndex(tracks: readonly HeatTrackInput[]): HeatIndex {
  const index: HeatIndex = new Map();
  const insertionOrder = new Map<string, number>();
  let order = 0;

  for (const track of tracks) {
    for (const key of track.dilated) {
      let byCategory = index.get(key);
      if (!byCategory) {
        byCategory = new Map();
        index.set(key, byCategory);
      }
      let ids = byCategory.get(track.categoryId);
      if (!ids) {
        ids = new Set();
        byCategory.set(track.categoryId, ids);
      }
      if (!ids.has(track.id)) {
        ids.add(track.id);
        if (!insertionOrder.has(track.id)) {
          insertionOrder.set(track.id, order++);
        }
      }
    }
  }

  insertionOrders.set(index, insertionOrder);
  return index;
}

export function hotCountAt(index: HeatIndex, key: string, categoryId: string): number {
  return index.get(key)?.get(categoryId)?.size ?? 0;
}

/**
 * Everything at (or one cell around) a tap: all trail ids in the ring in
 * insertion order, and whether any single category runs >= 2 trails there.
 * trackIds ordering (input insertion order) is only guaranteed for the exact
 * Map instance returned by buildHeatIndex; an index built or filtered any
 * other way falls back to ring-scan order.
 */
export function trailsNear(index: HeatIndex, cell: Cell): { trackIds: string[]; hot: boolean } {
  const idOrder = insertionOrders.get(index) ?? new Map();

  // Count distinct trails per category in the ring
  const categoryCounts = new Map<string, Set<string>>();
  const trackIds: string[] = [];
  const seen = new Set<string>();

  for (const key of ringKeys(cell)) {
    const byCategory = index.get(key);
    if (!byCategory) continue;
    for (const [categoryId, ids] of byCategory) {
      let categoryIds = categoryCounts.get(categoryId);
      if (!categoryIds) {
        categoryIds = new Set();
        categoryCounts.set(categoryId, categoryIds);
      }
      for (const id of ids) {
        categoryIds.add(id);
        if (!seen.has(id)) {
          seen.add(id);
          trackIds.push(id);
        }
      }
    }
  }

  // hot when any category has >= 2 distinct trails in the ring
  let hot = false;
  for (const categoryIds of categoryCounts.values()) {
    if (categoryIds.size >= 2) {
      hot = true;
      break;
    }
  }

  // Sort by global insertion order
  trackIds.sort((a, b) => (idOrder.get(a) ?? 0) - (idOrder.get(b) ?? 0));

  return { trackIds, hot };
}
