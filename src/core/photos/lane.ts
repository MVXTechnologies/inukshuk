import type { PhotoOnAxis } from './axis';
import type { TrackPhoto } from './model';
import { groupLane, snapToLane, type LaneGroup } from './stack';

/**
 * The photo lane above the elevation profile (#587, mockup 05): one circle
 * per photo at its distance, stacked with a count where circles would
 * collide, each with a thin leader down to its point on the profile.
 */

/** Circle diameter on the lane (pt). */
export const LANE_CIRCLE = 28;
/** Circles closer than this stack (the circle plus a hair of air). */
export const LANE_MIN_GAP = LANE_CIRCLE + 3;
/** The cursor catches a circle within this many points. */
export const LANE_SNAP_PX = 12;

export interface LaneCircle {
  /** Centre of the circle, clamped so it stays inside the lane. */
  x: number;
  /** Where its photos sit on the profile (the leader lines end there). */
  anchorXs: number[];
  /** The cover's axis distance (where the cursor goes when it catches the circle). */
  distanceM: number;
  members: TrackPhoto[];
  cover: TrackPhoto;
}

/** Lay out the lane for a chart `width` wide over `totalM` metres. */
export function layoutLane(
  photos: readonly PhotoOnAxis[],
  width: number,
  totalM: number,
): LaneCircle[] {
  if (width <= 0 || totalM <= 0 || photos.length === 0) return [];
  const xOf = (d: number) => (Math.min(Math.max(d, 0), totalM) / totalM) * width;
  const byId = new Map(photos.map((p) => [p.photo.id, p.distanceM]));
  const groups: LaneGroup<TrackPhoto>[] = groupLane(
    photos.map((p) => ({ photo: p.photo, x: xOf(p.distanceM) })),
    LANE_MIN_GAP,
  );
  const r = LANE_CIRCLE / 2;
  return groups.map((g) => ({
    x: Math.min(Math.max(g.x, r), Math.max(r, width - r)),
    anchorXs: g.members.map((m) => xOf(byId.get(m.id) ?? 0)),
    distanceM: byId.get(g.cover.id) ?? 0,
    members: g.members,
    cover: g.cover,
  }));
}

/** The circle the cursor (at `cursorX`) catches, if any. */
export function laneCircleAt(
  circles: readonly LaneCircle[],
  cursorX: number,
  snapPx = LANE_SNAP_PX,
): LaneCircle | undefined {
  const hit = snapToLane(circles, cursorX, snapPx);
  return hit ? circles.find((c) => c.cover === hit.cover) : undefined;
}

/** "Photo 11 of 33": the cover's place in the viewer's order. */
export function photoOrdinal(
  ordered: readonly Pick<TrackPhoto, 'id'>[],
  photoId: string,
): { n: number; of: number } | null {
  const i = ordered.findIndex((p) => p.id === photoId);
  return i < 0 ? null : { n: i + 1, of: ordered.length };
}
