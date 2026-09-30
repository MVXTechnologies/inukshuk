import type { LngLat } from '@core/models';

import { distanceToBboxM, distanceToLineM } from './geometry';
import { trailThumb, type LongTrail, type TrailActivity, type TrailIndex } from './schema';

/**
 * Ranking, filtering and grouping of the long-distance trail index (#467):
 * Explore's "Long-distance trails near you" carousel and the "See all" list.
 *
 * NEAR-YOU SCORE — a mix of popularity and proximity, both 0…1:
 *
 *     proximity = 1 / (1 + d / PROXIMITY_HALF_KM)      (d = km to the trail)
 *     score     = POPULARITY_WEIGHT · popularity + (1 − POPULARITY_WEIGHT) · proximity
 *
 * With the half-distance at 100 km and 0.55 on popularity, a national trail
 * 60 km away (pop 0.8 → 0.44 + 0.28 = 0.72) outranks a regional one 45 km away
 * (pop 0.45 → 0.25 + 0.31 = 0.56), and a famous trail 5 000 km away (proximity
 * ≈ 0.02) can't crowd out what is actually near. Only trails within
 * NEAR_RADIUS_KM qualify for the carousel; with fewer than MIN_NEAR of them
 * the nearest others fill in, so the section is never a lonely single card.
 * Without any position the carousel is the most popular trails worldwide.
 *
 * Distances are to the index's thumbnail geometry (≈ 40 points), i.e. within
 * a kilometre or two of the true trail — enough for "45 km away" — with a
 * bbox lower bound skipping the far side of the world cheaply.
 */

export const PROXIMITY_HALF_KM = 100;
export const POPULARITY_WEIGHT = 0.55;
export const NEAR_RADIUS_KM = 300;
export const MIN_NEAR = 3;
export const DEFAULT_NEAR_LIMIT = 10;

export interface RankedTrail {
  trail: LongTrail;
  /** Metres to the trail; null without a position. */
  distanceM: number | null;
  score: number;
}

/** Metres from `origin` to the trail (its thumbnail line, else its bbox). */
export function trailDistanceM(trail: LongTrail, origin: LngLat): number {
  const lower = distanceToBboxM(origin, trail.bbox);
  const thumb = trailThumb(trail);
  if (thumb.length === 0) return lower;
  return Math.max(lower, distanceToLineM(origin, thumb));
}

export function nearScore(popularity: number, distanceM: number): number {
  const proximity = 1 / (1 + distanceM / 1000 / PROXIMITY_HALF_KM);
  return POPULARITY_WEIGHT * popularity + (1 - POPULARITY_WEIGHT) * proximity;
}

/** Every trail with its distance and near-you score (unsorted). */
export function rankTrails(trails: readonly LongTrail[], origin: LngLat | null): RankedTrail[] {
  return trails.map((trail) => {
    if (origin === null) return { trail, distanceM: null, score: trail.popularity };
    const distanceM = trailDistanceM(trail, origin);
    return { trail, distanceM, score: nearScore(trail.popularity, distanceM) };
  });
}

const byScore = (a: RankedTrail, b: RankedTrail) =>
  b.score - a.score || a.trail.name.localeCompare(b.trail.name);
const byDistance = (a: RankedTrail, b: RankedTrail) =>
  (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity) || byScore(a, b);

/** The carousel: best-scored trails within reach, topped up with the nearest others. */
export function trailsNearYou(
  ranked: readonly RankedTrail[],
  options?: { limit?: number; radiusKm?: number; activity?: TrailActivity | null },
): RankedTrail[] {
  const limit = Math.max(0, options?.limit ?? DEFAULT_NEAR_LIMIT);
  const radiusM = (options?.radiusKm ?? NEAR_RADIUS_KM) * 1000;
  const pool = ranked.filter((r) => matchesActivity(r.trail, options?.activity ?? null));
  if (limit === 0) return [];
  if (pool.every((r) => r.distanceM === null)) return [...pool].sort(byScore).slice(0, limit);
  const near = pool.filter((r) => r.distanceM !== null && r.distanceM <= radiusM).sort(byScore);
  if (near.length >= Math.min(MIN_NEAR, limit)) return near.slice(0, limit);
  const rest = pool.filter((r) => !near.includes(r)).sort(byDistance);
  return [...near, ...rest].slice(0, Math.max(Math.min(MIN_NEAR, limit), near.length));
}

export function matchesActivity(trail: LongTrail, activity: TrailActivity | null): boolean {
  return activity === null || trail.activities.includes(activity);
}

export const TRAIL_SORTS = ['nearest', 'popular', 'longest', 'name'] as const;
export type TrailSort = (typeof TRAIL_SORTS)[number];

export const TRAIL_SORT_LABELS: Record<TrailSort, string> = {
  nearest: 'Nearest first',
  popular: 'Most popular',
  longest: 'Longest first',
  name: 'A to Z',
};

export function sortRanked(ranked: readonly RankedTrail[], sort: TrailSort): RankedTrail[] {
  const out = [...ranked];
  switch (sort) {
    case 'nearest':
      return out.sort(byDistance);
    case 'popular':
      return out.sort((a, b) => b.trail.popularity - a.trail.popularity || byDistance(a, b));
    case 'longest':
      return out.sort((a, b) => b.trail.lengthKm - a.trail.lengthKm || byDistance(a, b));
    case 'name':
      return out.sort((a, b) => a.trail.name.localeCompare(b.trail.name));
  }
}

export interface TrailGroup {
  key: string;
  title: string;
  entries: RankedTrail[];
}

export const POPULAR_GROUP_SIZE = 5;

/**
 * The "See all" list's sections: POPULAR NEAR YOU (the carousel's top few),
 * then one group per country on the user's own continent and one per other
 * continent — from Québec: CANADA, UNITED STATES, then EUROPE — ordered by
 * their nearest trail (or, without a position, their most popular). A trail
 * with no known country goes to OTHER. Within a group, `sort` applies.
 */
export function groupTrails(
  ranked: readonly RankedTrail[],
  index: Pick<TrailIndex, 'countries'>,
  sort: TrailSort,
  options?: { homeContinent?: string | null; popularCount?: number },
): TrailGroup[] {
  const popularCount = options?.popularCount ?? POPULAR_GROUP_SIZE;
  const popular = trailsNearYou(ranked, { limit: popularCount });
  const taken = new Set(popular.map((r) => r.trail.id));
  const home =
    options?.homeContinent ??
    continentOf(
      [...ranked].sort(byDistance).find((r) => r.distanceM !== null)?.trail ?? null,
      index,
    );
  const groups = new Map<string, TrailGroup>();
  for (const r of ranked) {
    if (taken.has(r.trail.id)) continue;
    const code = r.trail.countries[0];
    const country = code !== undefined ? index.countries[code] : undefined;
    let key: string;
    let title: string;
    if (country === undefined) {
      key = 'other';
      title = 'OTHER';
    } else if (home !== null && country.continent !== home && country.continent !== '') {
      key = `continent:${country.continent}`;
      title = country.continent.toUpperCase();
    } else {
      key = `country:${code ?? ''}`;
      title = country.name.toUpperCase();
    }
    const group = groups.get(key) ?? { key, title, entries: [] };
    group.entries.push(r);
    groups.set(key, group);
  }
  const lead = (g: TrailGroup) =>
    g.entries.reduce((m, r) => Math.min(m, r.distanceM ?? Infinity), Infinity);
  const best = (g: TrailGroup) => g.entries.reduce((m, r) => Math.max(m, r.score), 0);
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.key === 'other') return 1;
    if (b.key === 'other') return -1;
    return lead(a) - lead(b) || best(b) - best(a) || a.title.localeCompare(b.title);
  });
  const out: TrailGroup[] = [];
  if (popular.length > 0) {
    out.push({
      key: 'popular',
      title: popular.some((r) => r.distanceM !== null) ? 'POPULAR NEAR YOU' : 'MOST POPULAR',
      entries: popular,
    });
  }
  for (const g of ordered) out.push({ ...g, entries: sortRanked(g.entries, sort) });
  return out;
}

function continentOf(trail: LongTrail | null, index: Pick<TrailIndex, 'countries'>): string | null {
  const code = trail?.countries[0];
  if (code === undefined) return null;
  const c = index.countries[code]?.continent;
  return c !== undefined && c !== '' ? c : null;
}
