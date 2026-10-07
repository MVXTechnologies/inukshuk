import type { PlaceType } from './placeTypes';

/** [west, south, east, north], degrees. */
export type PlaceBbox = [number, number, number, number];

/** Where a search result came from. */
export type PlaceSource =
  | 'index' // the online place index (Photon, through our Worker)
  | 'coordinates'
  | 'waypoint'
  | 'track'
  | 'map'
  | 'catalog'
  | 'longTrail'
  | 'crag';

/** One search result, whatever produced it. */
export interface Place {
  /** Stable within its source ("osm:N123", "waypoint:abc"…), used for dedupe and recents. */
  id: string;
  source: PlaceSource;
  type: PlaceType;
  /** Name in the user's language when the index has one. */
  name: string;
  /** The same place's name in the other language (EN ↔ FR), when it differs. */
  altName?: string;
  latitude: number;
  longitude: number;
  bbox?: PlaceBbox;
  /** "Beaupré, Québec, Canada" — the line under the name. */
  context?: string;
  /** Summit elevation in metres, when the index carries it. */
  elevationM?: number;
}
