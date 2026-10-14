/**
 * The World Magnetic Model (WMM2025), pure TypeScript: the magnetic
 * declination (and the rest of the main field) at a place and date, for the
 * info strip's declination field and for magnetic bearings.
 *
 * The algorithm is the one in the WMM2025 technical report (NOAA NCEI / BGS),
 * §1.2 "Equations":
 * 1. geodetic (WGS 84) latitude and height → geocentric spherical latitude
 *    and radius;
 * 2. the Gauss coefficients at the date: g(t) = g + (t − t₀)·ġ (and h);
 * 3. the field in spherical coordinates from the Schmidt semi-normalised
 *    associated Legendre functions, up to degree and order 12;
 * 4. rotated back to the geodetic frame: X north, Y east, Z down;
 *    declination D = atan2(Y, X).
 *
 * Validated against NOAA's published WMM2025 test values (all 112 points in
 * `__fixtures__/wmm2025-*.txt`) to well inside 0.01° of declination; see
 * `wmm.test.ts`.
 *
 * Cost: one call is about 90 coefficient terms and a 13 × 13 Legendre table,
 * a few microseconds. The info strip asks for it once per camera settle or
 * per position fix, never per frame.
 */
import { decimalYear } from '@core/gnss/datum';

import { WMM2025_COEFFS, WMM2025_EPOCH, WMM2025_VALID_UNTIL } from './wmm2025';

const RAD = Math.PI / 180;
/** WGS 84 semi-major axis, km. */
const A_KM = 6378.137;
/** WGS 84 flattening. */
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
/** The model's geomagnetic reference radius, km. */
const RE_KM = 6371.2;
const N_MAX = 12;

export interface MagneticField {
  /** Declination, degrees east of true north (west negative). */
  declinationDeg: number;
  /** Inclination (dip), degrees, positive down. */
  inclinationDeg: number;
  /** North, east and down components, nT. */
  x: number;
  y: number;
  z: number;
  /** Horizontal and total intensity, nT. */
  h: number;
  f: number;
  /** The date is inside the model's validity (2025.0–2030.0). */
  inModel: boolean;
}

/** Row-major (n, m) index into the coefficient tables. */
const idx = (n: number, m: number) => n * (N_MAX + 1) + m;
const SIZE = (N_MAX + 1) * (N_MAX + 1);

const G = new Float64Array(SIZE);
const H = new Float64Array(SIZE);
const GDOT = new Float64Array(SIZE);
const HDOT = new Float64Array(SIZE);
for (const [n, m, g, h, gd, hd] of WMM2025_COEFFS) {
  G[idx(n, m)] = g;
  H[idx(n, m)] = h;
  GDOT[idx(n, m)] = gd;
  HDOT[idx(n, m)] = hd;
}

/**
 * Schmidt semi-normalisation factors S(n, m), so that S·P(Gauss) = P̆ (the
 * report's eq. 3). Fixed: computed once.
 */
const SCHMIDT = new Float64Array(SIZE);
SCHMIDT[idx(0, 0)] = 1;
for (let n = 1; n <= N_MAX; n++) {
  SCHMIDT[idx(n, 0)] = (SCHMIDT[idx(n - 1, 0)]! * (2 * n - 1)) / n;
  for (let m = 1; m <= n; m++) {
    const k = m === 1 ? 2 : 1;
    SCHMIDT[idx(n, m)] = SCHMIDT[idx(n, m - 1)]! * Math.sqrt(((n - m + 1) * k) / (n + m));
  }
}

/**
 * The magnetic field at a geodetic position and decimal year.
 *
 * @param latitudeDeg geodetic latitude, degrees (clamped a hair inside the
 *   poles, where declination is undefined).
 * @param longitudeDeg degrees east.
 * @param heightKm height above the WGS 84 ellipsoid, km (0 for the ground is
 *   plenty for a declination: it changes by ~0.01° per km of height).
 * @param decimalYear e.g. 2026.78. Outside 2025.0–2030.0 the model is
 *   extrapolated and `inModel` is false.
 */
export function magneticField(
  latitudeDeg: number,
  longitudeDeg: number,
  heightKm: number,
  decimalYear: number,
): MagneticField {
  const lat = Math.max(-89.999999, Math.min(89.999999, latitudeDeg)) * RAD;
  const lon = longitudeDeg * RAD;
  const dt = decimalYear - WMM2025_EPOCH;

  // 1. Geodetic → geocentric spherical (report eq. 7).
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const rc = A_KM / Math.sqrt(1 - E2 * sinLat * sinLat);
  const p = (rc + heightKm) * cosLat;
  const zc = (rc * (1 - E2) + heightKm) * sinLat;
  const r = Math.hypot(p, zc);
  const latC = Math.asin(zc / r);

  // 3. Legendre functions of cos(colatitude) = sin(geocentric latitude),
  // Gauss-normalised by recursion, with their colatitude derivatives.
  const ct = Math.sin(latC);
  const st = Math.cos(latC);
  const P = new Float64Array(SIZE);
  const dP = new Float64Array(SIZE);
  P[idx(0, 0)] = 1;
  for (let n = 1; n <= N_MAX; n++) {
    for (let m = 0; m <= n; m++) {
      const i = idx(n, m);
      if (n === m) {
        const j = idx(n - 1, n - 1);
        P[i] = st * P[j]!;
        dP[i] = st * dP[j]! + ct * P[j]!;
      } else {
        const j = idx(n - 1, m);
        const k2 = n >= 2 && m <= n - 2 ? ((n - 1) ** 2 - m * m) / ((2 * n - 1) * (2 * n - 3)) : 0;
        const i2 = n >= 2 && m <= n - 2 ? idx(n - 2, m) : -1;
        P[i] = ct * P[j]! - (i2 >= 0 ? k2 * P[i2]! : 0);
        dP[i] = ct * dP[j]! - st * P[j]! - (i2 >= 0 ? k2 * dP[i2]! : 0);
      }
    }
  }

  // The sum over degrees and orders (report eq. 10, spherical components).
  let bx = 0; // north (−Bθ)
  let by = 0; // east (Bφ), before the 1/sinθ
  let bz = 0; // down (−Br)
  const ar = RE_KM / r;
  let arn = ar * ar; // (a/r)^(n+2), starting at n = 0
  for (let n = 1; n <= N_MAX; n++) {
    arn *= ar;
    for (let m = 0; m <= n; m++) {
      const i = idx(n, m);
      const s = SCHMIDT[i]!;
      const g = (G[i]! + dt * GDOT[i]!) * s;
      const h = (H[i]! + dt * HDOT[i]!) * s;
      const cm = Math.cos(m * lon);
      const sm = Math.sin(m * lon);
      const gh = g * cm + h * sm;
      bx += arn * gh * dP[i]!;
      by += arn * m * (g * sm - h * cm) * P[i]!;
      bz -= (n + 1) * arn * gh * P[i]!;
    }
  }
  by /= st;

  // 4. Spherical → geodetic: rotate by the latitude difference (report eq. 17).
  const psi = latC - lat;
  const x = bx * Math.cos(psi) - bz * Math.sin(psi);
  const z = bx * Math.sin(psi) + bz * Math.cos(psi);
  const y = by;
  const h = Math.hypot(x, y);
  return {
    declinationDeg: Math.atan2(y, x) / RAD,
    inclinationDeg: Math.atan2(z, h) / RAD,
    x,
    y,
    z,
    h,
    f: Math.hypot(h, z),
    inModel: decimalYear >= WMM2025_EPOCH && decimalYear <= WMM2025_VALID_UNTIL,
  };
}

/**
 * Declination at a place and time, degrees east of true north, on the ground
 * (`heightM` above the ellipsoid, default 0).
 */
export function declinationAt(
  latitudeDeg: number,
  longitudeDeg: number,
  nowMs: number,
  heightM = 0,
): number {
  return magneticField(latitudeDeg, longitudeDeg, heightM / 1000, decimalYear(nowMs))
    .declinationDeg;
}

/** A true bearing as a magnetic one (true − declination), in [0, 360). */
export function trueToMagnetic(trueDeg: number, declinationDeg: number): number {
  return (((trueDeg - declinationDeg) % 360) + 360) % 360;
}

/** A magnetic bearing as a true one (magnetic + declination), in [0, 360). */
export function magneticToTrue(magneticDeg: number, declinationDeg: number): number {
  return (((magneticDeg + declinationDeg) % 360) + 360) % 360;
}
