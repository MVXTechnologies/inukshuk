/**
 * Slope (and aspect) of a Web-Mercator elevation mosaic, in degrees, per DEM
 * pixel — the measurement behind the map's slope shading (#722).
 *
 * Every function here is marked `'worklet'` so the 2D overlay can run it on a
 * background worklet runtime (off the JS thread); the directive is a plain
 * string, so under Node/Jest this is an ordinary pure module.
 *
 * What makes the numbers right:
 * - **Horn 3×3 gradient** (GDAL / CalTopo / ArcGIS), on every DEM pixel.
 * - **True ground size per row, on the WGS84 ellipsoid.** Web Mercator uses the
 *   spherical formula on geodetic latitudes, so it is not conformal on the
 *   ellipsoid: a pixel is N·cosφ·Δλ wide but M·Δφ tall (±0.17 % at 45°).
 * - **Edges use the span they actually have.** The mosaic's first/last row and
 *   column clamp their missing neighbour; the gradient is then divided by the
 *   ONE-pixel span, not two (the old code halved slopes on the outer ring).
 * - **No-data** (NaN, or a Terrarium void decoding to about −32 768 m) never
 *   reads as a cliff: a missing neighbour is extrapolated linearly from the
 *   centre and its opposite neighbour (exact on a plane), a missing centre
 *   yields NaN (drawn transparent).
 */

const DEG = 180 / Math.PI;
/** WGS84 semi-major axis (m) — also the Web-Mercator sphere radius. */
const WGS84_A = 6378137;
/** WGS84 first eccentricity squared. */
const WGS84_E2 = 0.00669437999014;
/** Elevations below this are no-data (Terrarium voids decode to ≈ −32 768 m). */
export const NODATA_BELOW_M = -12000;

/** Latitude (degrees) of a global pixel row (fractional) at zoom `z`, 256-px tiles. */
export function mercatorRowLatDeg(row: number, z: number): number {
  'worklet';
  const n = Math.PI * (1 - (2 * row) / (256 * Math.pow(2, z)));
  return Math.atan(Math.sinh(n)) * DEG;
}

/**
 * Ground metres of one Web-Mercator pixel (256-px tiles, zoom `z`) at a
 * latitude, on the WGS84 ellipsoid: `ew` along the parallel, `ns` along the
 * meridian.
 */
export function mercatorPixelGroundM(latDeg: number, z: number): { ew: number; ns: number } {
  'worklet';
  const phi = latDeg / DEG;
  const projected = (2 * Math.PI * WGS84_A) / (256 * Math.pow(2, z));
  const s = Math.sin(phi);
  const w = 1 - WGS84_E2 * s * s;
  const c = Math.cos(phi) * projected;
  return { ew: c / Math.sqrt(w), ns: (c * (1 - WGS84_E2)) / (w * Math.sqrt(w)) };
}

export interface SlopeAspectField {
  /** Slope in degrees (0..90) per pixel; NaN where the DEM has no data. */
  slope: Float32Array;
  /**
   * Aspect: compass bearing (degrees, 0 = north, clockwise) the slope FACES,
   * i.e. the downhill direction; NaN on flat ground or no-data. Only computed
   * when asked for (it costs an atan2 per pixel).
   */
  aspect: Float32Array | null;
}

/**
 * Horn slope (and optionally aspect) of every pixel of a Web-Mercator
 * elevation mosaic: `data` is metres, row-major `width` × `height`, row 0 =
 * north, and row 0 is global pixel row `topRow` of zoom `z` (256-px tiles).
 */
export function slopeAspectField(
  data: ArrayLike<number>,
  width: number,
  height: number,
  z: number,
  topRow: number,
  withAspect: boolean,
): SlopeAspectField {
  'worklet';
  const slope = new Float32Array(width * height);
  const aspect = withAspect ? new Float32Array(width * height) : null;
  const projected = (2 * Math.PI * WGS84_A) / (256 * Math.pow(2, z));
  for (let y = 0; y < height; y++) {
    // Row-centre latitude → ground size (inlined mercatorPixelGroundM: hot path).
    const lat = Math.atan(
      Math.sinh(Math.PI * (1 - (2 * (topRow + y + 0.5)) / (256 * Math.pow(2, z)))),
    );
    const sn = Math.sin(lat);
    const w = 1 - WGS84_E2 * sn * sn;
    const c = Math.cos(lat) * projected;
    const ew = c / Math.sqrt(w);
    const ns = (c * (1 - WGS84_E2)) / (w * Math.sqrt(w));
    const yN = y > 0 ? y - 1 : 0;
    const yS = y < height - 1 ? y + 1 : y;
    const spanY = yS - yN;
    // Horn weights sum to 4 per side: gradient = Δ / (4 · span · cell).
    const kY = spanY > 0 ? 1 / (4 * spanY * ns) : 0;
    const rN = yN * width;
    const r0 = y * width;
    const rS = yS * width;
    for (let x = 0; x < width; x++) {
      const o = r0 + x;
      const e = data[o] as number;
      if (!(e >= NODATA_BELOW_M)) {
        // NaN or a void: nothing to measure.
        slope[o] = NaN;
        if (aspect !== null) aspect[o] = NaN;
        continue;
      }
      const xW = x > 0 ? x - 1 : 0;
      const xE = x < width - 1 ? x + 1 : x;
      const spanX = xE - xW;
      let a = data[rN + xW] as number;
      let b = data[rN + x] as number;
      let cc = data[rN + xE] as number;
      let d = data[r0 + xW] as number;
      let f = data[r0 + xE] as number;
      let g = data[rS + xW] as number;
      let h = data[rS + x] as number;
      let i = data[rS + xE] as number;
      // Rare path: fill missing neighbours by reflection through the centre.
      if (
        !(a >= NODATA_BELOW_M) ||
        !(b >= NODATA_BELOW_M) ||
        !(cc >= NODATA_BELOW_M) ||
        !(d >= NODATA_BELOW_M) ||
        !(f >= NODATA_BELOW_M) ||
        !(g >= NODATA_BELOW_M) ||
        !(h >= NODATA_BELOW_M) ||
        !(i >= NODATA_BELOW_M)
      ) {
        const ok = (v: number) => v >= NODATA_BELOW_M;
        const fill = (v: number, opp: number) => (ok(v) ? v : ok(opp) ? 2 * e - opp : e);
        const a0 = a;
        const b0 = b;
        const c0 = cc;
        const d0 = d;
        a = fill(a0, i);
        i = fill(i, a0);
        cc = fill(c0, g);
        g = fill(g, c0);
        b = fill(b0, h);
        h = fill(h, b0);
        d = fill(d0, f);
        f = fill(f, d0);
      }
      const dzdx = spanX > 0 ? (cc + 2 * f + i - (a + 2 * d + g)) / (4 * spanX * ew) : 0;
      // Positive dzdy = elevation rising toward the SOUTH.
      const dzdy = (g + 2 * h + i - (a + 2 * b + cc)) * kY;
      const grad = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
      slope[o] = Math.atan(grad) * DEG;
      if (aspect !== null) {
        if (grad === 0) {
          aspect[o] = NaN;
        } else {
          // Downhill = −gradient: east component −dzdx, north component +dzdy.
          const bearing = Math.atan2(-dzdx, dzdy) * DEG;
          aspect[o] = bearing < 0 ? bearing + 360 : bearing;
        }
      }
    }
  }
  return { slope, aspect };
}

/** The 8 aspect sectors, clockwise from north (#723). */
export const ASPECT_SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Sector index 0..7 (N, NE … NW; each 45° wide, centred on its direction) of
 * an aspect from {@link slopeAspectField}, or −1 for flat / no-data (NaN).
 */
export function aspectSector(aspectDeg: number): number {
  'worklet';
  if (!(aspectDeg >= 0)) return -1;
  return Math.floor(((aspectDeg + 22.5) % 360) / 45) % 8;
}

/**
 * Average a slope field down by `step` × `step` blocks (ragged last blocks
 * average what they have). NaN pixels are skipped; an all-NaN block stays NaN.
 * Averaging DEGREES (not gradients) keeps a ridge or a gully steep — opposite
 * gradients would cancel. Measured against LiDAR (#722) a 2×2 average moves
 * the error by < 0.15°, so the display keeps it.
 */
export function blockMeanDegrees(
  field: Float32Array,
  width: number,
  height: number,
  step: number,
): { data: Float32Array; width: number; height: number } {
  'worklet';
  const s = Math.max(1, Math.floor(step));
  if (s === 1) return { data: field, width, height };
  const outW = Math.ceil(width / s);
  const outH = Math.ceil(height / s);
  const sum = new Float32Array(outW * outH);
  const count = new Uint16Array(outW * outH);
  for (let y = 0; y < height; y++) {
    const oy = Math.floor(y / s) * outW;
    for (let x = 0; x < width; x++) {
      const v = field[y * width + x] as number;
      if (v !== v) continue; // NaN
      const o = oy + Math.floor(x / s);
      sum[o] = (sum[o] as number) + v;
      count[o] = (count[o] as number) + 1;
    }
  }
  for (let o = 0; o < sum.length; o++) {
    const n = count[o] as number;
    sum[o] = n > 0 ? (sum[o] as number) / n : NaN;
  }
  return { data: sum, width: outW, height: outH };
}
