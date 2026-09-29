import { parseLinkOutCollections } from '@core/catalog/collections';
import type { LinkOutCollection } from '@core/catalog/taxonomy';
import { loadCatalogCollectionsRaw } from '@data/catalogCollections';
import { useEffect, useState } from 'react';

/**
 * The link-out collections (Parcs Québec…), loaded once per session and
 * shared by the landing and the collection screen. `unavailable` covers both
 * "no collections.json on this catalog" and "offline with no cached copy" —
 * either way the explorer hides the collection rather than show a dead card.
 */

export type LinkOutCollectionsState =
  | { status: 'loading'; collections: readonly LinkOutCollection[] }
  | { status: 'ready'; collections: readonly LinkOutCollection[] }
  | { status: 'unavailable'; collections: readonly LinkOutCollection[] };

let request: Promise<LinkOutCollection[]> | null = null;
let settled: LinkOutCollection[] | null = null;

function loadOnce(): Promise<LinkOutCollection[]> {
  if (request === null) {
    request = loadCatalogCollectionsRaw()
      .then((raw) => parseLinkOutCollections(raw).collections)
      .catch(() => [] as LinkOutCollection[])
      .then((collections) => {
        settled = collections;
        // An empty answer (offline first launch) may be retried next mount.
        if (collections.length === 0) request = null;
        return collections;
      });
  }
  return request;
}

/** Test hook: forget the session cache. */
export function resetLinkOutCollectionsCache(): void {
  request = null;
  settled = null;
}

const EMPTY: readonly LinkOutCollection[] = [];

export function useLinkOutCollections(): LinkOutCollectionsState {
  const [collections, setCollections] = useState<LinkOutCollection[] | null>(settled);
  useEffect(() => {
    let alive = true;
    void loadOnce().then((loaded) => {
      if (alive) setCollections(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (collections === null) return { status: 'loading', collections: EMPTY };
  if (collections.length === 0) return { status: 'unavailable', collections: EMPTY };
  return { status: 'ready', collections };
}
