import { ROUTE_SAMPLE_STEP_M } from '@core/draw/elevation';
import { densifyLine } from '@core/draw/geometry';
import type { LegMode } from '@core/draw/legs';
import {
  areaFileStem,
  areasToGeoJson,
  buildRoutePlan,
  plannedRouteGpx,
  plannedRoutePoints,
} from '@core/draw/serialize';
import { buildImportedTrack } from '@core/geo/track';
import type { Area, LngLat, Track, TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import { primeTrackGeometry } from '@data/trackGeometry';
import { strToU8 } from 'fflate';

import type { RouteElevationResult } from './useRouteElevation';

/**
 * Turning a drawn route into a Library trail (#502), and an area into a file
 * to share (#503). The file-system shell over `@core/draw/serialize`.
 */

export interface DrawnRouteInput {
  /** The control points the user placed (the plan "Edit route" reopens). */
  vertices: readonly LngLat[];
  /**
   * The line as drawn — Trails/Roads legs as routed (#515) — which the GPX
   * holds, densified. Absent: straight lines through `vertices`.
   */
  line?: readonly LngLat[];
  /** Per leg: how it was drawn. Absent: all Freehand. */
  legModes?: readonly LegMode[];
  /** The chip the tool was on (it reopens on it). */
  mode?: LegMode;
  name: string;
  /** Activity id, or null for a plain Navigation trail. */
  category: string | null;
  /** The DEM elevation for exactly this line, when it could be had. */
  elevation: RouteElevationResult | null;
}

/** The trail (points, stats, plan) for a drawn route; pure apart from the clock. */
export function buildDrawnTrack(id: string, input: DrawnRouteInput): Track {
  const samples =
    input.elevation?.plan.samples ?? densifyLine(input.line ?? input.vertices, ROUTE_SAMPLE_STEP_M);
  const points = plannedRoutePoints(samples, input.elevation?.elevation.elevations);
  const track = buildImportedTrack({
    id,
    points,
    name: input.name,
    fallbackName: input.name || 'Route',
    fallbackTime: Date.now(),
  });
  // The bar's numbers, not the recorder's GPS-tuned hysteresis over the
  // same samples: the Library must say what the drawing tool said.
  if (input.elevation) {
    track.stats = {
      ...track.stats,
      ascentM: input.elevation.elevation.ascentM,
      descentM: input.elevation.elevation.descentM,
    };
  }
  track.category = input.category ?? 'navigation';
  track.plan = buildRoutePlan(input.vertices, input.legModes ?? [], input.mode ?? 'freehand');
  return track;
}

/** Write a new drawn route's GPX; the caller adds the returned trail to the Library. */
export function writeNewDrawnRoute(input: DrawnRouteInput): { track: Track; fileUri: string } {
  const track = buildDrawnTrack(storage.newId(), input);
  const fileUri = storage.writeTrackGpx(track.id, plannedRouteGpx(track.name, track.points));
  primeTrackGeometry(track, track.points);
  return { track, fileUri };
}

/** The Library patch an edited route commits. */
export type DrawnRoutePatch = Pick<
  TrackSummary,
  'fileUri' | 'name' | 'stats' | 'plan' | 'category'
>;

/**
 * Save an edited route as a NEW GPX revision, commit its Library pointer, and
 * only then retire the old file — the same order an overwrite trim uses, so a
 * failed commit never leaves the trail pointing at nothing.
 */
export async function overwriteDrawnRoute(
  summary: TrackSummary,
  input: DrawnRouteInput,
  commit: (patch: DrawnRoutePatch) => void | Promise<void>,
): Promise<DrawnRoutePatch> {
  const track = buildDrawnTrack(summary.id, input);
  const fileUri = storage.writeTrackGpx(storage.newId(), plannedRouteGpx(track.name, track.points));
  const patch: DrawnRoutePatch = {
    fileUri,
    name: track.name,
    stats: track.stats,
    plan: track.plan,
    category: track.category,
  };
  await commit(patch);
  primeTrackGeometry({ ...summary, ...patch }, track.points);
  if (summary.fileUri !== fileUri) {
    try {
      storage.deleteFileAt(summary.fileUri);
    } catch {
      // The new revision is committed; an orphan must not turn success into failure.
    }
  }
  return patch;
}

/** Write one area as a `.geojson` in the cache for the share sheet; returns its uri. */
export function writeAreaGeoJson(area: Area): string {
  const writer = storage.createCacheFileWriter(`${areaFileStem(area.name)}.geojson`);
  try {
    writer.write(strToU8(areasToGeoJson([area])));
  } finally {
    writer.close();
  }
  return writer.uri;
}
