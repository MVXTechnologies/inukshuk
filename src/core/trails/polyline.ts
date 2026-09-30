import type { LngLat } from '@core/models';

/**
 * Google's encoded-polyline format, the wire format of the long-distance trail
 * geometry (#467): the index's thumbnails at precision 4 (~11 m), the detail
 * documents at precision 5 (~1 m). The build side is
 * `infra/tiles/nas/trails_build.py` (`encode_polyline`) — same algorithm,
 * latitude first on the wire, [lon, lat] in and out here.
 *
 * Decoding is defensive: a truncated or garbled string yields the points
 * decoded before the damage, never an exception.
 */

export function decodePolyline(text: string, precision = 5): LngLat[] {
  const factor = 10 ** precision;
  const out: LngLat[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number | null => {
    let shift = 0;
    let result = 0;
    for (;;) {
      if (i >= text.length) return null;
      const b = text.charCodeAt(i) - 63;
      i += 1;
      if (b < 0 || b > 63) return null;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
      if (shift > 30) return null;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < text.length) {
    const dLat = next();
    const dLon = next();
    if (dLat === null || dLon === null) break;
    lat += dLat;
    lon += dLon;
    out.push([lon / factor, lat / factor]);
  }
  return out;
}

export function encodePolyline(points: readonly LngLat[], precision = 5): string {
  const factor = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const push = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const [lon, lat] of points) {
    const iLat = Math.round(lat * factor);
    const iLon = Math.round(lon * factor);
    push(iLat - prevLat);
    push(iLon - prevLon);
    prevLat = iLat;
    prevLon = iLon;
  }
  return out;
}
