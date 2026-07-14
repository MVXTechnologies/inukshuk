import type { LatLng } from '@core/models';
import type { Feature, Polygon } from 'geojson';

/**
 * Direction-cone geometry for the user-location dot: a translucent sector
 * ("flashlight beam") anchored at the user's position, pointing at the compass
 * heading, whose width reflects how much the heading can be trusted.
 *
 * Pure math (no platform deps): the map feature just re-runs this whenever the
 * smoothed heading or the fix moves.
 */

const DEG2RAD = Math.PI / 180;
/** Metres per degree of latitude (WGS84 mean). */
const M_PER_DEG_LAT = 111_320;
/** Latitudes are clamped here — the flat-earth step blows up at the poles. */
const MAX_LAT = 85;

export interface HeadingConeOptions {
  /** Cone apex — the user's position. */
  center: LatLng;
  /** Direction the cone points, degrees clockwise from north. */
  headingDeg: number;
  /** Half the angular width of the sector, degrees. Must be in (0, 90]. */
  halfAngleDeg: number;
  /** Ground radius of the sector, metres. Must be > 0. */
  radiusM: number;
  /** Arc segments (more = smoother edge). Default 24. */
  steps?: number;
}

/**
 * Map expo-location's compass calibration level (0 = uncalibrated … 3 = high
 * accuracy, `null` = unknown) to a sector half-angle: the worse the
 * calibration, the wider (vaguer) the beam.
 */
export function coneHalfAngleDeg(accuracy: number | null | undefined): number {
  if (accuracy === null || accuracy === undefined || !Number.isFinite(accuracy)) return 40;
  const level = Math.min(3, Math.max(0, Math.round(accuracy)));
  // level:                       0   1   2   3
  const halfAngleByLevel = [55, 45, 35, 25] as const;
  return halfAngleByLevel[level] ?? 40;
}

/**
 * Build the sector polygon as a GeoJSON feature: apex at `center`, arc swept
 * from `headingDeg - halfAngleDeg` to `headingDeg + halfAngleDeg` at
 * `radiusM`. Uses a local flat-earth approximation (fine for the < few hundred
 * metres a view cone spans); latitude is clamped to ±85° so the longitude
 * scaling stays finite near the poles.
 */
export function headingConeFeature(options: HeadingConeOptions): Feature<Polygon> {
  const { center, headingDeg, halfAngleDeg, radiusM, steps = 24 } = options;
  if (!Number.isFinite(headingDeg)) {
    throw new Error(`headingDeg must be finite, got ${headingDeg}`);
  }
  if (!(halfAngleDeg > 0 && halfAngleDeg <= 90)) {
    throw new Error(`halfAngleDeg must be in (0, 90], got ${halfAngleDeg}`);
  }
  if (!(radiusM > 0)) {
    throw new Error(`radiusM must be > 0, got ${radiusM}`);
  }
  if (!(Number.isInteger(steps) && steps >= 2)) {
    throw new Error(`steps must be an integer >= 2, got ${steps}`);
  }

  const lat = Math.min(MAX_LAT, Math.max(-MAX_LAT, center.latitude));
  const lng = center.longitude;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(lat * DEG2RAD);

  const apex: [number, number] = [lng, lat];
  const ring: [number, number][] = [apex];
  for (let i = 0; i <= steps; i++) {
    const bearing = (headingDeg - halfAngleDeg + (2 * halfAngleDeg * i) / steps) * DEG2RAD;
    const dNorthM = radiusM * Math.cos(bearing);
    const dEastM = radiusM * Math.sin(bearing);
    ring.push([lng + dEastM / mPerDegLng, lat + dNorthM / M_PER_DEG_LAT]);
  }
  ring.push(apex); // close the ring

  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {},
  };
}
