import type { LatLng } from '@core/models';
import type { Place } from '@core/search/place';
import { parsePhotonResponse } from '@core/search/photon';
import { searchQueryString } from '@core/search/query';
import { sanitizeRecents } from '@core/search/recents';
import { TILE_HOST } from './basemapTiles';
import * as storage from './storage';

/**
 * Place search over the network (#496): our Worker's `GET /search`, which
 * proxies Photon (OSM data, by komoot) — see `infra/tiles/worker/src/search.ts`
 * and docs/DEPLOYMENT.md. What leaves the phone: the typed query, the UI
 * language, and a location rounded to ~1 km (`searchQueryString`).
 */

/** Why a search produced no online answer. */
export type PlaceSearchFailure =
  /** No network, or the request never got an answer. */
  | 'offline'
  /** Our rate limit or Photon's: try again in a minute. */
  | 'busy'
  /** Anything else on the server side. */
  | 'failed';

export class PlaceSearchError extends Error {
  constructor(readonly reason: PlaceSearchFailure) {
    super(`place search ${reason}`);
    this.name = 'PlaceSearchError';
  }
}

/** Give up on a request after this long; the offline fallback takes over. */
const TIMEOUT_MS = 10_000;

/**
 * Ask the index. Rejects with {@link PlaceSearchError}, or with the abort
 * error when `signal` cancels it (a newer keystroke) — callers ignore that one.
 */
export async function fetchPlaces(params: {
  text: string;
  lang: 'fr' | 'en';
  near: LatLng | null;
  signal: AbortSignal;
}): Promise<Place[]> {
  const url = `${TILE_HOST}/search?${searchQueryString(params)}`;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  params.signal.addEventListener('abort', onAbort);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: timeout.signal });
  } catch (e) {
    if (params.signal.aborted) throw e;
    throw new PlaceSearchError('offline');
  } finally {
    clearTimeout(timer);
    params.signal.removeEventListener('abort', onAbort);
  }
  if (res.status === 429 || res.status === 503) throw new PlaceSearchError('busy');
  if (res.status === 504) throw new PlaceSearchError('offline');
  if (!res.ok) throw new PlaceSearchError('failed');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new PlaceSearchError('failed');
  }
  return parsePhotonResponse(body);
}

const RECENTS_FILE = 'place-search-recents.json';

/** The recent searches on this device, newest first ([] when none or unreadable). */
export async function loadPlaceRecents(): Promise<Place[]> {
  try {
    return sanitizeRecents(await storage.readJson<unknown>(RECENTS_FILE));
  } catch {
    return [];
  }
}

/** Best effort: losing a recents write must never break a search. */
export function savePlaceRecents(list: readonly Place[]): void {
  try {
    storage.writeJson(RECENTS_FILE, list);
  } catch {
    /* recents are a convenience */
  }
}
