import type { BoundingBox } from '@core/models';

/**
 * Lat/lng graticule for a made map: pick a clean angular interval so the
 * frame carries a handful of grid lines (the CalTopo look), and format the
 * edge labels the way paper topos do (degrees, minutes when fractional).
 */

/** Clean intervals in degrees, finest→coarsest (30" up to 5°). */
const INTERVALS = [1 / 120, 1 / 60, 1 / 30, 1 / 12, 0.25, 0.5, 1, 2, 5] as const;

/** Aim for about this many lines across the wider axis. */
const TARGET_LINES = 5;

export interface Graticule {
  intervalDeg: number;
  /** Longitudes of north-south lines inside the bbox, ascending. */
  meridians: number[];
  /** Latitudes of east-west lines inside the bbox, ascending. */
  parallels: number[];
}

export function graticuleForBbox(bbox: BoundingBox): Graticule {
  const span = Math.max(bbox.maxLng - bbox.minLng, bbox.maxLat - bbox.minLat);
  const ideal = span / TARGET_LINES;
  const intervalDeg = INTERVALS.find((i) => i >= ideal) ?? INTERVALS[INTERVALS.length - 1]!;

  const lines = (min: number, max: number): number[] => {
    const out: number[] = [];
    for (let v = Math.ceil(min / intervalDeg) * intervalDeg; v <= max + 1e-9; v += intervalDeg) {
      // Snap to the grid exactly — the accumulating float sum drifts.
      out.push(Math.round(v / intervalDeg) * intervalDeg);
    }
    return out;
  };

  return {
    intervalDeg,
    meridians: lines(bbox.minLng, bbox.maxLng),
    parallels: lines(bbox.minLat, bbox.maxLat),
  };
}

/** "71°15'W" / "46°45'N" — whole degrees stay plain, fractions become minutes. */
export function formatGratLabel(value: number, axis: 'lat' | 'lng'): string {
  if (value === 0) return '0°';
  const hemi = axis === 'lat' ? (value > 0 ? 'N' : 'S') : value > 0 ? 'E' : 'W';
  const abs = Math.abs(value);
  const deg = Math.floor(abs + 1e-9);
  const minutes = Math.round((abs - deg) * 60);
  if (minutes === 0) return `${deg}°${hemi}`;
  if (minutes === 60) return `${deg + 1}°${hemi}`;
  return `${deg}°${minutes}'${hemi}`;
}
