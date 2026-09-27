/**
 * Sunset (and sunrise) for a place and day, for the recording panel's
 * "to sunset" field. The NOAA sunrise equation (Meeus, simplified): good to a
 * minute or two away from the poles, which is all a trail app needs — the
 * field answers "how much light is left", not an ephemeris.
 *
 * Pure: epoch milliseconds in and out, no platform time zone involved.
 */

const DEG = Math.PI / 180;
const J2000 = 2451545;
const DAY_MS = 86_400_000;
const UNIX_EPOCH_JD = 2440587.5;
/** Sun's apparent radius + standard refraction: the centre sits this far below the horizon at sunset. */
const SUNSET_ALTITUDE_DEG = -0.833;

export interface SunTimes {
  /** Epoch ms, or null when the sun does not rise that day (polar night). */
  sunrise: number | null;
  /** Epoch ms, or null when the sun does not set that day (midnight sun). */
  sunset: number | null;
  /** Epoch ms of solar noon. */
  solarNoon: number;
}

function toJulian(ms: number): number {
  return ms / DAY_MS + UNIX_EPOCH_JD;
}

function fromJulian(jd: number): number {
  return (jd - UNIX_EPOCH_JD) * DAY_MS;
}

/**
 * Sun times for the solar day containing `dateMs` at the given place
 * (longitude east-positive). Returns null rise/set when the sun stays above
 * or below the horizon all day.
 */
export function sunTimes(dateMs: number, latitude: number, longitude: number): SunTimes {
  // Days since J2000 for the local solar noon nearest `dateMs`.
  const n = Math.round(toJulian(dateMs) - J2000 - 0.0009 + longitude / 360);
  const meanNoon = n + 0.0009 - longitude / 360;
  const M = (357.5291 + 0.98560028 * meanNoon) % 360; // mean anomaly, degrees
  const C =
    1.9148 * Math.sin(M * DEG) + 0.02 * Math.sin(2 * M * DEG) + 0.0003 * Math.sin(3 * M * DEG);
  const lambda = (M + C + 180 + 102.9372) % 360; // ecliptic longitude
  const transit =
    J2000 + meanNoon + 0.0053 * Math.sin(M * DEG) - 0.0069 * Math.sin(2 * lambda * DEG);
  const sinDecl = Math.sin(lambda * DEG) * Math.sin(23.4397 * DEG);
  const cosDecl = Math.cos(Math.asin(sinDecl));
  const cosH =
    (Math.sin(SUNSET_ALTITUDE_DEG * DEG) - Math.sin(latitude * DEG) * sinDecl) /
    (Math.cos(latitude * DEG) * cosDecl);

  const solarNoon = fromJulian(transit);
  if (cosH > 1) return { sunrise: null, sunset: null, solarNoon }; // polar night
  if (cosH < -1) return { sunrise: null, sunset: null, solarNoon }; // midnight sun
  const halfDay = Math.acos(cosH) / (2 * Math.PI); // fraction of a day
  return {
    sunrise: fromJulian(transit - halfDay),
    sunset: fromJulian(transit + halfDay),
    solarNoon,
  };
}

/**
 * Milliseconds from `nowMs` until today's sunset at the place, or null when
 * there is no sunset today or it has already passed.
 */
export function msUntilSunset(nowMs: number, latitude: number, longitude: number): number | null {
  const { sunset } = sunTimes(nowMs, latitude, longitude);
  if (sunset === null || sunset <= nowMs) return null;
  return sunset - nowMs;
}
