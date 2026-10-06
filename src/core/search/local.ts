import { searchTerms, foldForSearch } from '@core/library/searchTracks';
import type { BoundingBox, LatLng } from '@core/models';
import type { Place, PlaceBbox, PlaceSource } from './place';
import type { PlaceType } from './placeTypes';
import { rankPlaces, type RankedPlace } from './rank';

/**
 * On-device search: what the place box can still find with no connection (or
 * with "Locally downloaded only" on). The online index is not on the phone, so
 * this searches what is — the user's own waypoints, trails and maps, the map
 * sheets of the store catalog loaded so far (sheet names are place names:
 * "Mont-Sainte-Anne", "Lac Saint-Jean Ouest"…), and the cached index of
 * long-distance trails.
 *
 * Matching is the Library's: accent-, case-, separator- and word-order-
 * insensitive, every typed term must appear.
 */

export interface LocalSearchSources {
  waypoints: readonly { id: string; label: string; latitude: number; longitude: number }[];
  tracks: readonly { id: string; name: string; bbox?: BoundingBox }[];
  maps: readonly { id: string; name: string; bbox?: BoundingBox }[];
  catalog: readonly {
    id: string;
    title: string;
    bbox?: [number, number, number, number];
    region?: string;
  }[];
  longTrails: readonly {
    id: string;
    name: string;
    nameFr?: string;
    nameEn?: string;
    bbox: [number, number, number, number];
    mid: [number, number];
    region?: string;
  }[];
  /**
   * Climbing crags: the saved ones always, the world's index once the
   * extension is installed (`@core/climbing/search`). `folded` is the name
   * already folded (the index is ~50k names: folding them per keystroke is
   * what would cost).
   */
  crags?: readonly {
    uid: string;
    name: string;
    folded?: string;
    lng: number;
    lat: number;
    region?: string;
  }[];
}

const toBbox = (b: BoundingBox): PlaceBbox => [b.minLng, b.minLat, b.maxLng, b.maxLat];

function centreOf([w, s, e, n]: PlaceBbox): { latitude: number; longitude: number } {
  return { latitude: (s + n) / 2, longitude: (w + e) / 2 };
}

function areaPlace(
  source: PlaceSource,
  type: PlaceType,
  id: string,
  name: string,
  bbox: PlaceBbox,
  context: string,
): Place {
  return { id: `${source}:${id}`, source, type, name, ...centreOf(bbox), bbox, context };
}

/** True when every term of the query appears in the folded name. */
function matches(name: string, terms: readonly string[]): boolean {
  const folded = foldForSearch(name);
  return terms.every((t) => folded.includes(t));
}

/** Local matches for a query, ranked like the online results (best first). */
export function searchLocal(
  query: string,
  sources: LocalSearchSources,
  options: { lang: 'fr' | 'en'; origin: LatLng | null; max?: number },
): RankedPlace[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const found: Place[] = [];

  for (const w of sources.waypoints) {
    if (!matches(w.label, terms)) continue;
    found.push({
      id: `waypoint:${w.id}`,
      source: 'waypoint',
      type: 'waypoint',
      name: w.label,
      latitude: w.latitude,
      longitude: w.longitude,
      context: 'Your waypoint',
    });
  }
  for (const t of sources.tracks) {
    if (t.bbox === undefined || !matches(t.name, terms)) continue;
    found.push(areaPlace('track', 'track', t.id, t.name, toBbox(t.bbox), 'Your trail'));
  }
  for (const m of sources.maps) {
    if (m.bbox === undefined || !matches(m.name, terms)) continue;
    found.push(areaPlace('map', 'map', m.id, m.name, toBbox(m.bbox), 'Your map'));
  }
  for (const t of sources.longTrails) {
    const names = [t.name, t.nameFr, t.nameEn].filter((n): n is string => n !== undefined);
    if (!names.some((n) => matches(n, terms))) continue;
    const preferred = options.lang === 'fr' ? (t.nameFr ?? t.name) : (t.nameEn ?? t.name);
    const other = options.lang === 'fr' ? t.nameEn : t.nameFr;
    const place: Place = {
      id: `longTrail:${t.id}`,
      source: 'longTrail',
      type: 'longTrail',
      name: preferred,
      latitude: t.mid[1],
      longitude: t.mid[0],
      bbox: t.bbox,
      context: t.region !== undefined ? `Long trail · ${t.region}` : 'Long trail',
    };
    if (other !== undefined && other !== preferred) place.altName = other;
    found.push(place);
  }
  let crags = 0;
  for (const c of sources.crags ?? []) {
    const folded = c.folded ?? foldForSearch(c.name);
    if (!terms.every((t) => folded.includes(t))) continue;
    found.push({
      id: `crag:${c.uid}`,
      source: 'crag',
      type: 'crag',
      name: c.name,
      latitude: c.lat,
      longitude: c.lng,
      ...(c.region ? { context: c.region } : {}),
    });
    // A common word ("lac") can match thousands: the ranking needs a few.
    if (++crags >= 50) break;
  }
  for (const c of sources.catalog) {
    if (c.bbox === undefined || !matches(c.title, terms)) continue;
    const context = c.region !== undefined ? `Map sheet · ${c.region}` : 'Map sheet';
    found.push(areaPlace('catalog', 'map', c.id, c.title, c.bbox, context));
  }

  return rankPlaces(found, query, options.origin).slice(0, options.max ?? 10);
}
