/**
 * The map's coordinates chip (#677): the altitude after the coordinates and
 * whether it fits.
 *
 * - Map centre: GROUND elevation from a ~30 m DEM, sampled at a point the
 *   user picked by eye. It is a model value, good to a few metres on open
 *   ground and off by more on a cliff edge or under a building, so it carries
 *   a "≈" (`≈412 m`). That also tells it apart from the GPS reading.
 * - Following: the fix's altitude, exactly as the recording panel shows it
 *   (`412 m`, no "≈": it is the same measurement, and the two must agree).
 *
 * Fit: the chip never wraps. Before the altitude is added the text is
 * estimated against the width the bottom row actually leaves the chip; if
 * both do not fit (allowing a slight font shrink), the altitude is dropped:
 * the coordinates are the payload.
 */
import { formatElevation, type Units } from '@core/format';

export type AltitudeSource = 'dem' | 'gps';

/** "≈412 m" (DEM) / "412 m" (GPS), in the user's units, rounded to the metre or foot. */
export function chipAltitudeText(meters: number, units: Units, source: AltitudeSource): string {
  const v = formatElevation(meters, units);
  return source === 'dem' ? `≈${v}` : v;
}

/** The separator between the coordinates and the altitude, as drawn. */
export const ALTITUDE_SEPARATOR = '  ·  ';

/** Estimated advance widths at the chip's 13 dp bold, tabular figures (Roboto / SF). */
const DIGIT_DP = 7.4;
const NARROW_DP = 3.8;
const WIDE_DP = 8.6;

/** A conservative width estimate of `text` in the chip's font, in dp. */
export function estimateChipTextDp(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (/[0-9A-LN-VX-Z≈]/.test(ch)) w += DIGIT_DP;
    else if (/[MWmw]/.test(ch)) w += WIDE_DP;
    else if (/[a-z]/.test(ch)) w += DIGIT_DP - 1;
    else w += NARROW_DP; // . , - space ° ′ ″ ·
  }
  return w;
}

/** Padding, copy icon and gaps around the text; plus the "you" mark while following. */
export function chipChromeDp(following: boolean): number {
  return 10 + 10 + 6 + 15 + (following ? 14 + 6 : 0);
}

/**
 * How far the text may shrink to keep the altitude. The chip's Text shrinks
 * to 0.85 at most (`adjustsFontSizeToFit`); keeping the altitude only down
 * to 0.9 leaves that last 5 % as margin for the width estimate.
 */
export const ALTITUDE_MIN_SCALE = 0.9;

/**
 * Whether `coords` plus the altitude fit in `availableDp` on one line, with
 * the font shrunk no further than {@link ALTITUDE_MIN_SCALE}. Otherwise the
 * altitude drops; the coordinates alone keep the rest of the shrink as their
 * last resort.
 */
export function altitudeFits(
  availableDp: number,
  coords: string,
  altitude: string,
  following: boolean,
): boolean {
  const text = estimateChipTextDp(`${coords}${ALTITUDE_SEPARATOR}${altitude}`);
  return text * ALTITUDE_MIN_SCALE + chipChromeDp(following) <= availableDp;
}

/**
 * Whether a camera centre is a real one: finite, on the globe, and not the
 * null island MapLibre reports before its first camera (2.5.2 QA: on first
 * launch the chip flashed "0.00000, 0.00000 · ≈-9838 m", the sea floor
 * off Africa). Nothing is shown until a real centre exists.
 */
export function isRealCenter(p: { latitude: number; longitude: number } | null): boolean {
  if (p === null) return false;
  const { latitude: lat, longitude: lon } = p;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return Math.abs(lat) > 1e-9 || Math.abs(lon) > 1e-9;
}
