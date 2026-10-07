import { haversineMeters } from '@core/geo/geomath';
import { foldForSearch } from '@core/library/searchTracks';
import type { LatLng } from '@core/models';
import { analyzeQuery, matchName, type QueryAnalysis } from './fuzzy';
import type { Place } from './place';
import { PLACE_TYPES, type PlaceType } from './placeTypes';

/**
 * Ranking for place results. The index (Photon) is a general geocoder: asked
 * for "Katahdin" it answers with streets, streams and a township before the
 * mountain. A trail app wants the opposite order, so results are sorted
 * first by **band** — what kind of place it is — and only then, within a
 * band, by how good an answer it is:
 *
 * 1. peaks, mountains, ranges, volcanoes (passes at the bottom of the band);
 * 2. lakes and water (ponds, reservoirs, bays, rivers, waterfalls, glaciers);
 * 3. trails (hiking and bike routes, named paths and tracks, trailheads);
 * 4. parks, campgrounds, huts, shelters, viewpoints, forests, islands, beaches;
 * 5. towns, villages, hamlets, cities, regions;
 * 6. roads, and anything else.
 *
 * A query with a water word ("lac …", "… lake") puts the water band first.
 * A **strong** text match — the whole name typed, exactly or as a prefix —
 * lifts a result one band (yielding to that band's own equally good
 * matches), so "Chamonix" the town still beats a stream of that name.
 * A result whose name does not match the query at all (another language, or
 * the index's own fuzziness gone wide) sinks below every band.
 *
 * Within a band: {@link matchName}'s text score × {@link PLACE_TYPES}' boost ×
 * gentle proximity × a small index-order tie-break.
 *
 * Then {@link dedupePlaces} drops the near-duplicates a geocoder returns for
 * one feature mapped twice (a lake's node and its polygon, a peak and its
 * "attraction").
 */

/** Lower-case, accent-free, separators folded to one space (the Library folding). */
export const normalizeName = foldForSearch;

/**
 * How well `name` matches the query, 0…1: {@link matchName}'s fuzzy,
 * order-free score, 0 when some typed word matches nothing.
 */
export function textScore(name: string, query: string | QueryAnalysis): number {
  return matchName(name, query).score;
}

/** 1 at the user's position, 0.75 at 50 km, ~0.55 at 500 km; 1 without a position. */
export function proximityFactor(distanceM: number | null): number {
  if (distanceM === null || !Number.isFinite(distanceM)) return 1;
  return 0.5 + 0.5 / (1 + distanceM / 50_000);
}

/** Place-type bands, best first (higher wins). See the module comment. */
export const BAND_PEAK = 6;
export const BAND_WATER = 5;
export const BAND_TRAIL = 4;
export const BAND_OUTDOOR = 3;
export const BAND_SETTLEMENT = 2;
export const BAND_OTHER = 1;
/** Results that do not match the query's words. */
export const BAND_UNMATCHED = 0;

const TYPE_BANDS: Readonly<Record<PlaceType, number>> = {
  peak: BAND_PEAK,
  mountain: BAND_PEAK,
  range: BAND_PEAK,
  volcano: BAND_PEAK,
  pass: BAND_PEAK,
  lake: BAND_WATER,
  river: BAND_WATER,
  bay: BAND_WATER,
  waterfall: BAND_WATER,
  glacier: BAND_WATER,
  trail: BAND_TRAIL,
  trailhead: BAND_TRAIL,
  park: BAND_OUTDOOR,
  campground: BAND_OUTDOOR,
  hut: BAND_OUTDOOR,
  shelter: BAND_OUTDOOR,
  viewpoint: BAND_OUTDOOR,
  forest: BAND_OUTDOOR,
  island: BAND_OUTDOOR,
  beach: BAND_OUTDOOR,
  city: BAND_SETTLEMENT,
  town: BAND_SETTLEMENT,
  village: BAND_SETTLEMENT,
  hamlet: BAND_SETTLEMENT,
  locality: BAND_SETTLEMENT,
  region: BAND_SETTLEMENT,
  road: BAND_OTHER,
  poi: BAND_OTHER,
  // On-device results are ranked among themselves: one band for all.
  coordinates: BAND_TRAIL,
  waypoint: BAND_TRAIL,
  track: BAND_TRAIL,
  map: BAND_TRAIL,
  longTrail: BAND_TRAIL,
  crag: BAND_TRAIL,
};

/**
 * The band a result of this type and text match sits in for this query. A
 * water hint swaps the peak and water bands; a strong match lifts one band.
 */
export function placeBand(
  type: PlaceType,
  match: { score: number; strong: boolean },
  hint: QueryAnalysis['hint'],
): number {
  if (match.score <= 0) return BAND_UNMATCHED;
  let band = TYPE_BANDS[type];
  if (hint === 'water') {
    if (band === BAND_WATER) band = BAND_PEAK;
    else if (band === BAND_PEAK) band = BAND_WATER;
  }
  return match.strong ? Math.min(BAND_PEAK, band + 1) : band;
}

/** A lifted result yields to the band's own members on an equal score. */
const LIFTED_FACTOR = 0.9;

export interface RankedPlace {
  place: Place;
  score: number;
  /** Metres from the user, or null without a position. */
  distanceM: number | null;
}

interface Scored extends RankedPlace {
  band: number;
  index: number;
}

const pointOf = (p: Place): LatLng => ({ latitude: p.latitude, longitude: p.longitude });

/** The better of the two names' matches. */
function bestMatch(place: Place, q: QueryAnalysis): { score: number; strong: boolean } {
  const a = matchName(place.name, q);
  if (place.altName === undefined) return a;
  const b = matchName(place.altName, q);
  return b.score > a.score || (b.score === a.score && b.strong) ? b : a;
}

function scorePlaces(places: readonly Place[], query: string, origin: LatLng | null): Scored[] {
  const q = analyzeQuery(query);
  return places
    .map((place, index) => {
      const distanceM = origin === null ? null : haversineMeters(origin, pointOf(place));
      const match = bestMatch(place, q);
      const band = placeBand(place.type, match, q.hint);
      const lifted =
        match.strong && band > placeBand(place.type, { ...match, strong: false }, q.hint);
      const text = match.score > 0 ? match.score : 0.4;
      const order = Math.max(0.85, 1 - 0.01 * index);
      const within =
        text *
        PLACE_TYPES[place.type].boost *
        proximityFactor(distanceM) *
        order *
        (lifted ? LIFTED_FACTOR : 1);
      return { place, score: band + within, distanceM, band, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

const strip = ({ place, score, distanceM }: Scored): RankedPlace => ({ place, score, distanceM });

/**
 * Score and sort (best first) — stable for equal scores. `score` is the band
 * plus the within-band score (0…1), so it only compares within one query.
 */
export function rankPlaces(
  places: readonly Place[],
  query: string,
  origin: LatLng | null,
): RankedPlace[] {
  return scorePlaces(places, query, origin).map(strip);
}

/** Two results this close with the same name are one place. */
export const DEDUPE_RADIUS_M = 200;

function inside(p: Place, bbox: Place['bbox']): boolean {
  if (bbox === undefined) return false;
  const [w, s, e, n] = bbox;
  return p.latitude >= s && p.latitude <= n && p.longitude >= w && p.longitude <= e;
}

function sameName(a: Place, b: Place): boolean {
  const names = (p: Place) =>
    [p.name, p.altName].filter((x): x is string => x !== undefined).map(normalizeName);
  const bs = names(b);
  return names(a).some((n) => bs.includes(n));
}

/**
 * Lines are mapped in pieces: a stream or a road comes back as several
 * same-named segments kilometres apart. Within this distance, two of the same
 * linear type and name are one feature.
 */
const TYPE_DEDUPE_RADIUS_M: Partial<Record<Place['type'], number>> = {
  river: 5_000,
  road: 2_000,
  // A campground is often mapped twice: its office (a node) and its grounds.
  campground: 1_000,
};

/**
 * Drop later entries that duplicate an earlier one: same name (in either
 * language) and either within {@link DEDUPE_RADIUS_M}, or the same type with
 * one inside the other's bounding box (a big lake's centre point and its
 * outline are kilometres apart), or the same type within
 * {@link TYPE_DEDUPE_RADIUS_M}. Keeps the first — the better-ranked — copy.
 */
export function dedupePlaces<T extends { place: Place }>(ranked: readonly T[]): T[] {
  const kept: T[] = [];
  for (const r of ranked) {
    const dup = kept.some(({ place: k }) => {
      if (!sameName(k, r.place)) return false;
      const d = haversineMeters(pointOf(k), pointOf(r.place));
      if (d <= DEDUPE_RADIUS_M) return true;
      if (k.type !== r.place.type) return false;
      if (d <= (TYPE_DEDUPE_RADIUS_M[k.type] ?? 0)) return true;
      return inside(r.place, k.bbox) || inside(k, r.place.bbox);
    });
    if (!dup) kept.push(r);
  }
  return kept;
}

/**
 * Rank, dedupe and cap — what the list shows. Results that do not match the
 * query's words (the index's expansions gone wide: "Mount Suzu" for "mount
 * katadhin") are dropped when anything matched; when nothing did, the index
 * knows a name we do not see, and its answers are kept.
 */
export function rankAndDedupe(
  places: readonly Place[],
  query: string,
  origin: LatLng | null,
  max = 10,
): RankedPlace[] {
  const scored = scorePlaces(places, query, origin);
  const matched = scored.filter((s) => s.band > BAND_UNMATCHED);
  return dedupePlaces(matched.length > 0 ? matched : scored)
    .slice(0, max)
    .map(strip);
}
