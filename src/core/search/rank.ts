import { haversineMeters } from '@core/geo/geomath';
import { foldForSearch } from '@core/library/searchTracks';
import type { LatLng } from '@core/models';
import type { Place } from './place';
import { PLACE_TYPES } from './placeTypes';

/**
 * Ranking for place results. The index already orders by its own relevance
 * (text match + OSM importance, biased toward the location we send), and that
 * order is a strong signal — but it is a general geocoder, so streets, shops
 * and hotels named after a mountain crowd out the mountain. We re-rank by:
 *
 * - **text match** — exact name, then prefix, then word prefix, then substring;
 * - **type** — {@link PLACE_TYPES}' `boost`: peaks, lakes, campgrounds, parks,
 *   trailheads and villages up; roads and generic POIs down;
 * - **proximity** — closer is better, gently (a famous place 500 km away still
 *   shows; it just yields to an equally good match next door);
 * - **index order** — a small tie-break, so the index's sense of importance
 *   still separates two "Lac Long"s.
 *
 * Then {@link dedupePlaces} drops the near-duplicates a geocoder returns for
 * one feature mapped twice (a lake's node and its polygon, a peak and its
 * "attraction").
 */

/** Lower-case, accent-free, separators folded to one space (the Library folding). */
export const normalizeName = foldForSearch;

/** How well `name` matches the normalized query, 0.4…1. */
export function textScore(name: string, normalizedQuery: string): number {
  const n = normalizeName(name);
  if (normalizedQuery === '') return 0.4;
  if (n === normalizedQuery) return 1;
  if (n.startsWith(normalizedQuery)) return 0.9;
  if (n.split(' ').some((w) => w.startsWith(normalizedQuery))) return 0.8;
  if (n.includes(normalizedQuery)) return 0.65;
  // Matched on something we do not see (another language, an old name).
  return 0.4;
}

/** 1 at the user's position, 0.75 at 50 km, ~0.55 at 500 km; 1 without a position. */
export function proximityFactor(distanceM: number | null): number {
  if (distanceM === null || !Number.isFinite(distanceM)) return 1;
  return 0.5 + 0.5 / (1 + distanceM / 50_000);
}

export interface RankedPlace {
  place: Place;
  score: number;
  /** Metres from the user, or null without a position. */
  distanceM: number | null;
}

const pointOf = (p: Place): LatLng => ({ latitude: p.latitude, longitude: p.longitude });

/** Score and sort (best first) — stable for equal scores. */
export function rankPlaces(
  places: readonly Place[],
  query: string,
  origin: LatLng | null,
): RankedPlace[] {
  const q = normalizeName(query);
  return places
    .map((place, index) => {
      const distanceM = origin === null ? null : haversineMeters(origin, pointOf(place));
      const text = Math.max(
        textScore(place.name, q),
        place.altName === undefined ? 0 : textScore(place.altName, q),
      );
      const order = Math.max(0.6, 1 - 0.03 * index);
      const score = text * PLACE_TYPES[place.type].boost * proximityFactor(distanceM) * order;
      return { place, score, distanceM, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ place, score, distanceM }) => ({ place, score, distanceM }));
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
 * Drop later entries that duplicate an earlier one: same name (in either
 * language) and either within {@link DEDUPE_RADIUS_M}, or the same type with
 * one inside the other's bounding box (a big lake's centre point and its
 * outline are kilometres apart). Keeps the first — the better-ranked — copy.
 */
export function dedupePlaces<T extends { place: Place }>(ranked: readonly T[]): T[] {
  const kept: T[] = [];
  for (const r of ranked) {
    const dup = kept.some(({ place: k }) => {
      if (!sameName(k, r.place)) return false;
      if (haversineMeters(pointOf(k), pointOf(r.place)) <= DEDUPE_RADIUS_M) return true;
      return k.type === r.place.type && (inside(r.place, k.bbox) || inside(k, r.place.bbox));
    });
    if (!dup) kept.push(r);
  }
  return kept;
}

/** Rank, dedupe and cap — what the list shows. */
export function rankAndDedupe(
  places: readonly Place[],
  query: string,
  origin: LatLng | null,
  max = 10,
): RankedPlace[] {
  return dedupePlaces(rankPlaces(places, query, origin)).slice(0, max);
}
