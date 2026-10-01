import type { TrackPoint } from '@core/models';
import type { ElevationExtremes, SteepestStretches, Stop } from './highlights';
import { indexAtDistance, interpolateOnAxis, pointAtIndex, type TrackAxis } from './trackAxis';
import type { TrackPointAt } from './interpolate';

/**
 * The outing as a story, for the trail view's Timeline tab (#511): start,
 * the notes left along the way, the stops, the steepest stretch, the summit
 * and the finish, in trail order. Every event carries its position on the
 * trail's distance axis so a tap can move the profile cursor and the map
 * marker straight to it.
 */
export type TimelineEventKind = 'start' | 'note' | 'stop' | 'pause' | 'steep' | 'summit' | 'finish';

export interface TimelineEvent {
  kind: TimelineEventKind;
  /** Where on the trail: distance axis, position, altitude and clock time (when timed). */
  at: TrackPointAt;
  /** A note: its id, number (1..N in trail order), text and photo. */
  noteId?: string;
  noteNum?: number;
  noteText?: string;
  photoUri?: string;
  /** Time stood still here (a stop merged into this event, or the stop itself), seconds. */
  stoppedS?: number;
  /** A recording pause (kind 'pause'), seconds. */
  pausedS?: number;
  /** Steepest stretch: signed grade (%) and length (m). */
  gradePct?: number;
  lengthM?: number;
  /** This event is (also) the trail's high point, at this altitude. */
  highPointM?: number;
}

export interface TimelineNote {
  id: string;
  distanceM: number;
  text: string;
  photoUri?: string;
}

export interface TimelineInput {
  points: readonly TrackPoint[];
  axis: TrackAxis;
  /** Notes in trail order (`orderNotes`); numbered 1..N in this order. */
  notes: readonly TimelineNote[];
  stops: readonly Stop[];
  steepest: SteepestStretches;
  extremes: ElevationExtremes | null;
  /** Stops and a high point this close (m) to another event fold into it. */
  mergeM?: number;
  /** A high point this little above the trail's lowest point is no summit. */
  minSummitRiseM?: number;
}

const DEFAULT_MERGE_M = 150;
const DEFAULT_MIN_SUMMIT_RISE_M = 30;

/** Kinds a stop or high point can fold into, most important first. */
const ANCHORS: readonly TimelineEventKind[] = ['summit', 'note', 'start', 'finish'];

/**
 * Build the Timeline. Rules:
 * - start and finish always (unless the trail has fewer than 2 points);
 * - every note, at its anchor;
 * - the steepest climb and steepest descent, each at its start;
 * - the high point as a "summit" when it rises at least `minSummitRiseM`
 *   above the low point — folded into start/finish when it's within
 *   `mergeM` of them (a climb that ends on top has no separate summit);
 * - each stop/pause; a stop within `mergeM` of a summit, note, start or
 *   finish folds into it ("Summit · Stopped 18 min"), and two stops closer
 *   than that add up.
 * Ordered by distance; ties keep start first and finish last.
 */
export function buildOutingTimeline(input: TimelineInput): TimelineEvent[] {
  const { points, axis, notes, stops, steepest, extremes } = input;
  if (points.length < 2) return [];
  const mergeM = input.mergeM ?? DEFAULT_MERGE_M;
  const minRise = input.minSummitRiseM ?? DEFAULT_MIN_SUMMIT_RISE_M;
  const lastIndex = points.length - 1;
  const at = (i: number) => pointAtIndex(points, axis, i)!;

  const start: TimelineEvent = { kind: 'start', at: at(0) };
  const finish: TimelineEvent = { kind: 'finish', at: at(lastIndex) };
  const events: TimelineEvent[] = [start];

  notes.forEach((n, i) => {
    const pos =
      interpolateOnAxis(points, axis, n.distanceM) ?? at(indexAtDistance(axis, n.distanceM));
    events.push({
      kind: 'note',
      at: pos,
      noteId: n.id,
      noteNum: i + 1,
      noteText: n.text,
      ...(n.photoUri ? { photoUri: n.photoUri } : {}),
    });
  });

  for (const s of [steepest.climb, steepest.descent]) {
    if (!s) continue;
    events.push({
      kind: 'steep',
      at: at(s.startIndex),
      gradePct: s.gradePct,
      lengthM: s.lengthM,
    });
  }

  events.push(finish);

  // The high point: its own "summit", or folded into start/finish.
  if (extremes && extremes.highM - extremes.lowM >= minRise) {
    const highAt = at(extremes.highIndex);
    const near = (e: TimelineEvent) => Math.abs(e.at.distanceM - highAt.distanceM) <= mergeM;
    if (near(finish)) finish.highPointM = extremes.highM;
    else if (near(start)) start.highPointM = extremes.highM;
    else events.push({ kind: 'summit', at: highAt, highPointM: extremes.highM });
  }

  // Stops: fold into the nearest anchor in range, else stand alone (adjacent
  // stops within range add up).
  const standalone: TimelineEvent[] = [];
  for (const s of stops) {
    if (s.kind === 'pause') {
      standalone.push({ kind: 'pause', at: at(s.startIndex), pausedS: s.durationS });
      continue;
    }
    const sAt = at(s.startIndex);
    const sEnd = axis.cumM[s.endIndex] ?? sAt.distanceM;
    // Distance from an event to the stop's stretch (0 when inside it).
    const gap = (e: TimelineEvent) =>
      e.at.distanceM < sAt.distanceM
        ? sAt.distanceM - e.at.distanceM
        : Math.max(0, e.at.distanceM - sEnd);
    let target: TimelineEvent | null = null;
    for (const kind of ANCHORS) {
      const cands = events.filter((e) => e.kind === kind && gap(e) <= mergeM);
      if (cands.length > 0) {
        target = cands.reduce((a, b) => (gap(b) < gap(a) ? b : a));
        break;
      }
    }
    const prev = standalone[standalone.length - 1];
    if (target) target.stoppedS = (target.stoppedS ?? 0) + s.durationS;
    else if (prev && prev.kind === 'stop' && sAt.distanceM - prev.at.distanceM <= mergeM) {
      prev.stoppedS = (prev.stoppedS ?? 0) + s.durationS;
    } else standalone.push({ kind: 'stop', at: sAt, stoppedS: s.durationS });
  }
  events.push(...standalone);

  // Start first, finish last, everything else along the trail (stable).
  const rank = (e: TimelineEvent) => (e.kind === 'start' ? 0 : e.kind === 'finish' ? 2 : 1);
  return events.sort((a, b) => rank(a) - rank(b) || a.at.distanceM - b.at.distanceM);
}
