import type { LatLng } from '@core/models';
import type { WeatherModelId } from './weatherModels';

/**
 * Model-domain coverage + auto-fallback resolution (weather wave B, the
 * "worldwide like Windy" fix): HRDPS and RDPS are Canada/North-America
 * domain models — outside their grids the WMS drape is silently transparent,
 * which read as "weather is Canada-only". GDPS is global, so whenever the
 * viewport centre leaves the SELECTED model's domain the drape auto-resolves
 * to GDPS (and the model sheet says why). Radar is a North-American
 * composite: outside it the picker rows carry a "Canada only" hint and the
 * drape simply shows nothing.
 *
 * Domain sources (verified live against GeoMet, 2026-08-09):
 * - HRDPS: the layer's `EX_GeographicBoundingBox` from GetCapabilities
 *   (layer=HRDPS.CONTINENTAL_TT), verbatim. It is the geographic bbox of a
 *   rotated grid, so the far corners overstate slightly — harmless: a blank
 *   fringe degrades silently, exactly the pre-wave-B behaviour.
 * - RDPS: its capabilities bbox is USELESS (the rotated grid's geographic
 *   bbox spans all longitudes north of -3.8°). The box below is a
 *   conservative interior rectangle established by probing GetFeatureInfo on
 *   a 10°×10° world grid plus the four corners (all returned real values;
 *   Tokyo/Hawaii/Moscow/Lisbon probed outside). Understating trades a
 *   little RDPS reach (e.g. it really extends to London) for never claiming
 *   RDPS where the drape would be blank — outside we use GDPS, which is
 *   correct everywhere.
 * - Radar: the RADAR_1KM_RRAI capabilities bbox, verbatim (the 1 km North
 *   American composite).
 */

/** A geographic coverage box, degrees (west < east, south < north). */
export interface CoverageBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** HRDPS continental domain — GeoMet capabilities bbox, verbatim. */
export const HRDPS_COVERAGE: CoverageBbox = {
  west: -152.768527,
  south: 27.284015,
  east: -40.693803,
  north: 70.616483,
};

/** RDPS regional domain — conservative probed interior (see module doc). */
export const RDPS_COVERAGE: CoverageBbox = {
  west: -140,
  south: 15,
  east: -50,
  north: 80,
};

/** North American radar composite — GeoMet capabilities bbox, verbatim. */
export const RADAR_COVERAGE: CoverageBbox = {
  west: -170.32,
  south: 16.93,
  east: -50,
  north: 67.19,
};

/** Per-model coverage; null = global (no fallback ever needed). */
export const MODEL_COVERAGE: Record<WeatherModelId, CoverageBbox | null> = {
  hrdps: HRDPS_COVERAGE,
  rdps: RDPS_COVERAGE,
  gdps: null,
};

/** Normalize a longitude into [-180, 180) — MapLibre centres can wrap past ±180. */
export function normalizeLongitude(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  // -0 keeps toString/format noise out of captions and cache keys.
  return wrapped === 0 ? 0 : wrapped;
}

/** Whether a point falls inside a coverage box (null box = covers everywhere). */
export function coversPoint(bbox: CoverageBbox | null, at: LatLng): boolean {
  if (bbox === null) return true;
  const lng = normalizeLongitude(at.longitude);
  return (
    at.latitude >= bbox.south && at.latitude <= bbox.north && lng >= bbox.west && lng <= bbox.east
  );
}

/** The model a drape actually resolves to at a place, and why. */
export interface EffectiveModel {
  model: WeatherModelId;
  /** True when the selection was overridden because the place is outside its domain. */
  fallback: boolean;
}

/**
 * Resolve the model the drape should use at the viewport centre: the user's
 * selection inside its domain, GDPS (global) outside it. An unknown centre
 * (map not settled yet) keeps the selection — never switch blind; the first
 * region settle re-resolves. The persisted selection itself is never
 * touched: pan back into coverage and the chosen model returns.
 */
export function resolveEffectiveModel(selected: WeatherModelId, at: LatLng | null): EffectiveModel {
  if (at === null || coversPoint(MODEL_COVERAGE[selected], at)) {
    return { model: selected, fallback: false };
  }
  return { model: 'gdps', fallback: true };
}

/**
 * Whether the radar composite has coverage at a place. An unknown centre
 * counts as covered — the picker must not flash "Canada only" at a user in
 * Québec before the first camera settle lands.
 */
export function radarAvailableAt(at: LatLng | null): boolean {
  return at === null || coversPoint(RADAR_COVERAGE, at);
}
