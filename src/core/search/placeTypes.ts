/**
 * What kind of place a search result is: the OSM tag (`osm_key`/`osm_value`
 * as Photon returns them) folded into the handful of kinds a hiker cares
 * about, each with its icon, its label, how far to zoom when flying to it, and
 * how much the ranking favours it.
 *
 * Pure: icon names are MaterialCommunityIcons glyph names (plain strings), so
 * the UI can draw them without core knowing about React.
 */

export type PlaceType =
  | 'city'
  | 'town'
  | 'village'
  | 'hamlet'
  | 'locality'
  | 'region'
  | 'campground'
  | 'peak'
  | 'volcano'
  | 'pass'
  | 'lake'
  | 'river'
  | 'bay'
  | 'waterfall'
  | 'glacier'
  | 'island'
  | 'beach'
  | 'park'
  | 'forest'
  | 'trailhead'
  | 'hut'
  | 'shelter'
  | 'viewpoint'
  | 'road'
  | 'poi'
  // Results that do not come from the place index.
  | 'coordinates'
  | 'waypoint'
  | 'track'
  | 'map'
  | 'longTrail';

export interface PlaceTypeInfo {
  /** MaterialCommunityIcons glyph. */
  icon: string;
  /** Short English label ("Peak", "Campground"). */
  label: string;
  /** Camera zoom when flying to a point of this type. */
  zoom: number;
  /**
   * Ranking weight, 0…1: outdoor places (peaks, lakes, campgrounds, parks,
   * trailheads, villages) first; streets and shops last.
   */
  boost: number;
  /** Frame the place's bounding box (when known) instead of a fixed zoom. */
  fitBounds: boolean;
}

export const PLACE_TYPES: Readonly<Record<PlaceType, PlaceTypeInfo>> = {
  city: { icon: 'city-variant-outline', label: 'City', zoom: 12, boost: 0.9, fitBounds: false },
  town: { icon: 'home-city-outline', label: 'Town', zoom: 13, boost: 0.9, fitBounds: false },
  village: { icon: 'home-group', label: 'Village', zoom: 14, boost: 0.95, fitBounds: false },
  hamlet: { icon: 'home-outline', label: 'Hamlet', zoom: 15, boost: 0.75, fitBounds: false },
  locality: {
    icon: 'map-marker-outline',
    label: 'Locality',
    zoom: 14,
    boost: 0.65,
    fitBounds: false,
  },
  region: { icon: 'map-outline', label: 'Region', zoom: 8, boost: 0.6, fitBounds: true },
  campground: { icon: 'tent', label: 'Campground', zoom: 15, boost: 1, fitBounds: false },
  peak: { icon: 'image-filter-hdr', label: 'Peak', zoom: 14, boost: 1, fitBounds: false },
  volcano: { icon: 'volcano', label: 'Volcano', zoom: 13, boost: 1, fitBounds: false },
  pass: { icon: 'terrain', label: 'Mountain pass', zoom: 15, boost: 0.9, fitBounds: false },
  lake: { icon: 'waves', label: 'Lake', zoom: 13, boost: 1, fitBounds: true },
  river: { icon: 'water', label: 'River', zoom: 13, boost: 0.85, fitBounds: false },
  bay: { icon: 'sail-boat', label: 'Bay', zoom: 12, boost: 0.8, fitBounds: true },
  waterfall: { icon: 'waterfall', label: 'Waterfall', zoom: 15, boost: 0.9, fitBounds: false },
  glacier: { icon: 'snowflake', label: 'Glacier', zoom: 13, boost: 0.85, fitBounds: true },
  island: { icon: 'island', label: 'Island', zoom: 13, boost: 0.85, fitBounds: true },
  beach: { icon: 'beach', label: 'Beach', zoom: 15, boost: 0.75, fitBounds: false },
  park: { icon: 'pine-tree', label: 'Park', zoom: 12, boost: 0.95, fitBounds: true },
  forest: { icon: 'forest', label: 'Forest', zoom: 13, boost: 0.75, fitBounds: true },
  trailhead: { icon: 'hiking', label: 'Trailhead', zoom: 16, boost: 0.95, fitBounds: false },
  hut: { icon: 'home-roof', label: 'Hut', zoom: 15, boost: 0.9, fitBounds: false },
  shelter: {
    icon: 'shield-home-outline',
    label: 'Shelter',
    zoom: 15,
    boost: 0.85,
    fitBounds: false,
  },
  viewpoint: { icon: 'binoculars', label: 'Viewpoint', zoom: 15, boost: 0.8, fitBounds: false },
  road: { icon: 'road-variant', label: 'Road', zoom: 15, boost: 0.35, fitBounds: false },
  poi: { icon: 'map-marker-outline', label: 'Place', zoom: 16, boost: 0.5, fitBounds: false },
  coordinates: {
    icon: 'crosshairs-gps',
    label: 'Coordinates',
    zoom: 15,
    boost: 1,
    fitBounds: false,
  },
  waypoint: { icon: 'map-marker', label: 'Your waypoint', zoom: 16, boost: 1, fitBounds: false },
  track: { icon: 'map-marker-path', label: 'Your trail', zoom: 14, boost: 1, fitBounds: true },
  map: { icon: 'map', label: 'Map', zoom: 13, boost: 1, fitBounds: true },
  longTrail: { icon: 'routes', label: 'Long trail', zoom: 10, boost: 1, fitBounds: true },
};

/** `osm_key:osm_value` → type, for the tags that name one kind outright. */
const BY_TAG: Readonly<Record<string, PlaceType>> = {
  'place:city': 'city',
  'place:town': 'town',
  'place:municipality': 'town',
  'place:village': 'village',
  'place:hamlet': 'hamlet',
  'place:isolated_dwelling': 'hamlet',
  'place:farm': 'hamlet',
  'place:suburb': 'locality',
  'place:quarter': 'locality',
  'place:neighbourhood': 'locality',
  'place:locality': 'locality',
  'place:island': 'island',
  'place:islet': 'island',
  'place:archipelago': 'island',
  'place:county': 'region',
  'place:state': 'region',
  'place:province': 'region',
  'place:region': 'region',
  'place:country': 'region',
  'boundary:administrative': 'region',
  'boundary:national_park': 'park',
  'boundary:protected_area': 'park',
  'leisure:nature_reserve': 'park',
  'leisure:park': 'park',
  'natural:peak': 'peak',
  'natural:hill': 'peak',
  'natural:ridge': 'peak',
  'natural:volcano': 'volcano',
  'natural:saddle': 'pass',
  'mountain_pass:yes': 'pass',
  'natural:water': 'lake',
  'water:lake': 'lake',
  'water:pond': 'lake',
  'water:reservoir': 'lake',
  'landuse:reservoir': 'lake',
  'natural:bay': 'bay',
  'natural:strait': 'bay',
  'natural:glacier': 'glacier',
  'natural:beach': 'beach',
  'natural:wood': 'forest',
  'landuse:forest': 'forest',
  'natural:island': 'island',
  'waterway:river': 'river',
  'waterway:stream': 'river',
  'waterway:canal': 'river',
  'waterway:rapids': 'river',
  'water:river': 'river',
  'waterway:waterfall': 'waterfall',
  'natural:waterfall': 'waterfall',
  'tourism:camp_site': 'campground',
  'tourism:caravan_site': 'campground',
  'tourism:camp_pitch': 'campground',
  'tourism:alpine_hut': 'hut',
  'tourism:wilderness_hut': 'hut',
  'amenity:shelter': 'shelter',
  'tourism:viewpoint': 'viewpoint',
  'highway:trailhead': 'trailhead',
};

/** Photon's own coarse `type` (its layer), for tags {@link BY_TAG} does not know. */
const BY_LAYER: Readonly<Record<string, PlaceType>> = {
  city: 'city',
  district: 'locality',
  locality: 'locality',
  county: 'region',
  state: 'region',
  country: 'region',
  street: 'road',
};

/**
 * The place type for an OSM tag pair, falling back on Photon's layer and then
 * on a few key-wide rules (every `highway` is a road, every `waterway` water).
 */
export function placeTypeOf(osmKey: string, osmValue: string, layer?: string): PlaceType {
  const exact = BY_TAG[`${osmKey}:${osmValue}`];
  if (exact !== undefined) return exact;
  if (osmKey === 'mountain_pass') return 'pass';
  if (osmKey === 'waterway') return 'river';
  if (osmKey === 'highway') return 'road';
  const byLayer = layer === undefined ? undefined : BY_LAYER[layer];
  return byLayer ?? 'poi';
}
