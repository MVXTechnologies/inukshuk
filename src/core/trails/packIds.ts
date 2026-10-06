/**
 * Offline-pack ids of a long-trail download (#467): a stage (or a short
 * trail as a whole) downloads as a series of packs `<prefix><n>`, one per
 * corridor box. To the user the series is ONE offline map — counted and
 * updated as one (`offlinePackGroup`).
 */

/** The id prefix shared by every pack of one trail download. */
export const trailPackPrefix = (trailId: string, stage: number | null): string =>
  `trail-${trailId}-${stage === null ? 'all' : `s${stage + 1}`}-`;

const TRAIL_PART = /^(trail-.+-(?:all|s\d+)-)\d+$/;

/**
 * The offline map a region's pack belongs to: a trail download's prefix for
 * each of its parts, the region's own id for anything else.
 */
export function offlinePackGroup(regionId: string): string {
  return TRAIL_PART.exec(regionId)?.[1] ?? regionId;
}
