import type { BoundingBox, LatLng, MapDocument } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';
import { searchLocal, type LocalSearchSources } from '@core/search/local';
import { coordinatePlace, classifyQuery, SEARCH_DEBOUNCE_MS } from '@core/search/query';
import { rankAndDedupe, type RankedPlace } from '@core/search/rank';
import { fetchPlaces, PlaceSearchError, type PlaceSearchFailure } from '@data/placeSearch';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { useLongTrailsStore } from '@state/longTrailsStore';
import { useEffect, useMemo, useState } from 'react';

/**
 * The map's place search (#496), as a hook: what to show for the current
 * query.
 *
 * - A coordinate ("46.81, -71.21", DMS, DDM) is answered at once, first.
 * - A name of ≥ 2 characters goes to the index 250 ms after the last
 *   keystroke; a newer keystroke aborts the request in flight, so a slow
 *   answer to "Mon" never replaces the answer to "Mont-Sainte-Anne".
 * - Matches on the device (your waypoints, trails and maps, catalog sheets,
 *   long trails) are always computed — they are the whole answer offline or
 *   under "Locally downloaded only", and a short extra section online.
 */

export type OnlineStatus =
  | 'idle' // nothing asked yet (empty or short query, or a coordinate)
  | 'loading'
  | 'ready'
  | 'local-only' // "Locally downloaded only" is on: the index is never asked
  | PlaceSearchFailure;

export interface PlaceSearchState {
  /** The coordinate result, when the query parses as one. */
  coordinate: RankedPlace | null;
  online: RankedPlace[];
  local: RankedPlace[];
  status: OnlineStatus;
  /** True for an empty query: the sheet shows recents instead. */
  empty: boolean;
  /** True for a one-character name. */
  tooShort: boolean;
}

/** The union of a map's georeferenced page boxes, or undefined. */
function mapBbox(doc: MapDocument): BoundingBox | undefined {
  let out: BoundingBox | undefined;
  for (const g of doc.georeferences) {
    const b = g.bbox;
    out =
      out === undefined
        ? { ...b }
        : {
            minLat: Math.min(out.minLat, b.minLat),
            minLng: Math.min(out.minLng, b.minLng),
            maxLat: Math.max(out.maxLat, b.maxLat),
            maxLng: Math.max(out.maxLng, b.maxLng),
          };
  }
  return out;
}

/** The on-device haystacks, from the stores that already hold them. */
function useLocalSources(): LocalSearchSources {
  const waypoints = useLibraryStore((s) => s.waypoints);
  const tracks = useLibraryStore((s) => s.tracks);
  const maps = useLibraryStore((s) => s.maps);
  const catalog = useCatalogStore((s) => s.items);
  const trailIndex = useLongTrailsStore((s) => s.index);
  return useMemo(
    () => ({
      waypoints,
      tracks: tracks.map((t) => ({ id: t.id, name: t.name, bbox: t.stats.bbox })),
      maps: maps.map((m) => ({ id: m.id, name: m.name, bbox: mapBbox(m) })),
      catalog,
      longTrails: trailIndex?.trails ?? [],
    }),
    [waypoints, tracks, maps, catalog, trailIndex],
  );
}

export function usePlaceSearch({
  query,
  origin,
  bias,
  lang,
  offlineOnly,
}: {
  query: string;
  /** The user's position: distances, and proximity ranking. */
  origin: LatLng | null;
  /** Where to bias the index when there is no position (the map centre). */
  bias: LatLng | null;
  lang: 'fr' | 'en';
  offlineOnly: boolean;
}): PlaceSearchState {
  const sources = useLocalSources();
  const classified = classifyQuery(query);
  const text = classified.kind === 'text' ? classified.text : null;
  const near = origin ?? bias;
  // Rounded so a moving GPS fix does not refire the search every second.
  const nearKey = near === null ? '' : `${near.latitude.toFixed(2)},${near.longitude.toFixed(2)}`;

  // The last answer from the index, and the query it answers. Anything else
  // (loading, local-only, idle) is derived at render time.
  const [result, setResult] = useState<{
    text: string;
    status: PlaceSearchFailure | 'ready';
    online: RankedPlace[];
  } | null>(null);

  useEffect(() => {
    if (text === null || offlineOnly) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchPlaces({ text, lang, near, signal: controller.signal }).then(
        (places) => {
          if (controller.signal.aborted) return;
          setResult({ text, status: 'ready', online: rankAndDedupe(places, text, origin) });
        },
        (e: unknown) => {
          if (controller.signal.aborted) return;
          const status = e instanceof PlaceSearchError ? e.reason : 'failed';
          setResult({ text, status, online: [] });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `near` and `origin` are read through nearKey: a new fix in the same
    // square kilometre must not cancel and refire the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, lang, offlineOnly, nearKey]);

  const local = useMemo(
    () => (text === null ? [] : searchLocal(text, sources, { lang, origin, max: 10 })),
    // origin is folded into nearKey for the same reason as above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, sources, lang, nearKey],
  );

  const coordinate = useMemo<RankedPlace | null>(() => {
    if (classified.kind !== 'coordinates') return null;
    const place = coordinatePlace(classified.at);
    const distanceM = origin === null ? null : haversineMeters(origin, classified.at);
    return { place, score: 1, distanceM };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classified.kind === 'coordinates' ? classified.text : null, nearKey]);

  let status: OnlineStatus;
  let online: RankedPlace[];
  if (text === null) {
    status = 'idle';
    online = [];
  } else if (offlineOnly) {
    status = 'local-only';
    online = [];
  } else if (result !== null && result.text === text) {
    status = result.status;
    online = result.online;
  } else {
    // Keep the previous answer on screen while the new one loads: the list
    // refines as you type instead of blinking empty on every keystroke.
    status = 'loading';
    online = result?.online ?? [];
  }
  return {
    coordinate,
    online,
    local,
    status,
    empty: classified.kind === 'empty',
    tooShort: classified.kind === 'too-short',
  };
}
