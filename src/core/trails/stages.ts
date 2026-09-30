import type { LngLat } from '@core/models';

import { bboxOfLine, nearestOnLine } from './geometry';
import type { TrailBbox, TrailDetail, TrailStage } from './schema';

/**
 * Stage logic for a trail shown on the main map (#467, board `OnMap.dc.html`):
 * which stage is selected first, stepping through them, the markers (start,
 * finish, stage joins) and how far the user is from the trail.
 */

/** Beyond this the user is not "on" the trail: select stage 1, not the nearest. */
export const NEAR_STAGE_M = 25_000;

export interface NearestStage {
  index: number;
  distanceM: number;
}

/** The stage nearest to `position` (null for a stage-less trail). */
export function nearestStage(stages: readonly TrailStage[], position: LngLat): NearestStage | null {
  let best: NearestStage | null = null;
  stages.forEach((stage, index) => {
    const hit = nearestOnLine(position, stage.geometry);
    if (hit !== null && (best === null || hit.distanceM < best.distanceM)) {
      best = { index, distanceM: hit.distanceM };
    }
  });
  return best;
}

/** The stage to select when the trail opens on the map: the one you're near, else the first. */
export function initialStageIndex(detail: TrailDetail, position: LngLat | null): number | null {
  if (detail.stages.length === 0) return null;
  if (position === null) return 0;
  const near = nearestStage(detail.stages, position);
  return near !== null && near.distanceM <= NEAR_STAGE_M ? near.index : 0;
}

/** Step the selection by `delta`, clamped to the stage list. */
export function stepStage(
  detail: TrailDetail,
  current: number | null,
  delta: number,
): number | null {
  if (detail.stages.length === 0) return null;
  const from = current ?? 0;
  return Math.max(0, Math.min(detail.stages.length - 1, from + delta));
}

/** The geometry the map should frame: the selected stage, else the whole trail. */
export function focusGeometry(detail: TrailDetail, stageIndex: number | null): LngLat[][] {
  const stage = stageIndex === null ? undefined : detail.stages[stageIndex];
  return stage !== undefined ? stage.geometry : detail.geometry;
}

export function focusBbox(detail: TrailDetail, stageIndex: number | null): TrailBbox {
  return bboxOfLine(focusGeometry(detail, stageIndex)) ?? detail.bbox;
}

export interface TrailMarkers {
  start: LngLat | null;
  finish: LngLat | null;
  /** Where one stage hands over to the next. */
  joins: LngLat[];
}

export function trailMarkers(detail: TrailDetail): TrailMarkers {
  const first = detail.geometry[0]?.[0] ?? null;
  const lastPart = detail.geometry[detail.geometry.length - 1];
  const last = lastPart?.[lastPart.length - 1] ?? null;
  const joins: LngLat[] = [];
  detail.stages.slice(1).forEach((stage) => {
    const p = stage.geometry[0]?.[0];
    if (p !== undefined) joins.push(p);
  });
  const roundtrip =
    detail.roundtrip ||
    (first !== null && last !== null && first[0] === last[0] && first[1] === last[1]);
  return { start: first, finish: roundtrip ? null : last, joins };
}

/** "Stage 2 · Les Éboulements → Baie-Saint-Paul" (the name alone when it says it all). */
export function stageTitle(stage: TrailStage, index: number): string {
  return `Stage ${index + 1} · ${stage.name}`;
}
