import type { LatLng } from '@core/models';
import {
  nearestOnTrail,
  projectOnSegment,
  toLocal,
  type PreparedTrail,
  type QueryCost,
  type TrailProjection,
} from './trailIndex';

/**
 * Where you are on a followed trail, fix after fix (#678), incrementally.
 *
 * ## Why incremental
 *
 * The plain "nearest point of the whole trail" is wrong exactly where it
 * matters: on a switchback or an out-and-back, the next leg (or the way back)
 * is a few metres away, so the nearest point jumps hundreds of metres along
 * the trail on one noisy fix, and the next waypoint gets skipped. The tracker
 * keeps the segment you were on and searches only a short **window** around
 * it: back by `backM` plus the distance moved, forward by `aheadM` plus twice
 * the distance moved. A leg 200 m further along the trail is never in a
 * window you can walk in one fix.
 *
 * ## When it reaches for the whole trail
 *
 * On the first fix, and whenever the window's best is farther than
 * `windowTrustM` (you left the trail, or jumped), it asks the grid
 * (`nearestOnTrail`), preferring the candidate closest along to where you
 * were when two are nearly as near. While you are far from the trail (more
 * than `farM`), the answer is reused until you have moved a tenth of that
 * distance: the nearest point of a trail 2 km away does not move when you
 * take ten steps.
 *
 * ## Cost per fix (`TrailFix.cost`)
 *
 * - On the trail: the segments in the window, about (backM + aheadM) / the
 *   point spacing, plus a few for the distance moved, whatever the trail's
 *   length. Measured on the Québec fixture activities (1 Hz, ~3.6 m per
 *   point, 2.6 k–7.2 k points): 24.5 projections per fix on average, 32 at
 *   most, each a few flops. `maxWindowSegments` caps it on very dense trails.
 * - Whole-trail (grid) query, measured on the same tracks: 70–170 segments
 *   (out-and-back corridors stack two legs in every cell).
 * - Off the trail: the grid query, O(segments near you).
 * - Far off the trail: one grid query per tenth of the distance walked.
 */

export interface TrailTrackerOptions {
  /** Window reach behind the last position, metres (plus the distance moved). */
  backM?: number;
  /** Window reach ahead of the last position, metres (plus twice the distance moved). */
  aheadM?: number;
  /** A window answer farther than this triggers a whole-trail search, metres. */
  windowTrustM?: number;
  /** Beyond this distance from the trail, whole-trail searches are throttled, metres. */
  farM?: number;
  /** Hard cap on window segments per fix. */
  maxWindowSegments?: number;
}

export interface TrailFix extends TrailProjection {
  /** The work this fix cost. */
  cost: QueryCost & { windowSegments: number; global: boolean };
}

export interface TrailTracker {
  /** Feed a fix; returns where it is on the trail. */
  update(fix: LatLng): TrailFix;
  /** Forget the last position: the next fix searches the whole trail. */
  reset(): void;
}

const DEFAULTS = {
  backM: 25,
  aheadM: 50,
  windowTrustM: 30,
  farM: 300,
  maxWindowSegments: 600,
} as const;

export function createTrailTracker(
  trail: PreparedTrail,
  options: TrailTrackerOptions = {},
): TrailTracker {
  const {
    backM = DEFAULTS.backM,
    aheadM = DEFAULTS.aheadM,
    windowTrustM = DEFAULTS.windowTrustM,
    farM = DEFAULTS.farM,
    maxWindowSegments = DEFAULTS.maxWindowSegments,
  } = options;

  let last: TrailProjection | null = null;
  let lastX = 0;
  let lastY = 0;
  // The fix the last whole-trail search answered (for the far throttle).
  let globalAt: { x: number; y: number } | null = null;

  const window = (
    prev: TrailProjection,
    px: number,
    py: number,
    movedM: number,
    cost: TrailFix['cost'],
  ) => {
    const from = prev.alongM - (backM + movedM);
    const to = prev.alongM + aheadM + 2 * movedM;
    let best: TrailProjection | null = null;
    const take = (seg: number) => {
      cost.windowSegments++;
      cost.segments++;
      const cand = projectOnSegment(trail, seg, px, py);
      if (best === null || cand.distM < best.distM) best = cand;
    };
    const lastSeg = Math.max(0, trail.n - 2);
    // Forward from the current segment (inclusive), then backward.
    for (let s = prev.seg; s <= lastSeg && cost.windowSegments < maxWindowSegments; s++) {
      // Past the end of the along axis is past `to` too.
      if ((trail.along[s] ?? Infinity) > to) break;
      if (trail.segActive[s] || trail.n === 1) take(s);
    }
    for (let s = prev.seg - 1; s >= 0 && cost.windowSegments < maxWindowSegments; s--) {
      if ((trail.along[s + 1] ?? -Infinity) < from) break;
      if (trail.segActive[s]) take(s);
    }
    return best as TrailProjection | null;
  };

  return {
    update(fix) {
      const { x: px, y: py } = toLocal(trail, fix);
      const cost: TrailFix['cost'] = { segments: 0, cells: 0, windowSegments: 0, global: false };
      let result: TrailProjection | null = null;
      if (last !== null) {
        const movedM = Math.hypot(px - lastX, py - lastY);
        const inWindow = window(last, px, py, movedM, cost);
        if (inWindow !== null && inWindow.distM <= windowTrustM) {
          result = inWindow;
        } else if (
          // Far away and barely moved since the last whole-trail answer: reuse it.
          globalAt !== null &&
          last.distM > farM &&
          Math.hypot(px - globalAt.x, py - globalAt.y) < last.distM / 10
        ) {
          result = projectOnSegment(trail, last.seg, px, py);
        } else {
          const global = nearestOnTrail(trail, fix, { prefer: last.alongM, cost });
          cost.global = true;
          globalAt = { x: px, y: py };
          result = inWindow !== null && inWindow.distM <= global.distM ? inWindow : global;
        }
      } else {
        result = nearestOnTrail(trail, fix, { cost });
        cost.global = true;
        globalAt = { x: px, y: py };
      }
      last = result;
      lastX = px;
      lastY = py;
      return { ...result, cost };
    },
    reset() {
      last = null;
      globalAt = null;
    },
  };
}
