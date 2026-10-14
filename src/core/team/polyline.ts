/**
 * Google's encoded polyline at precision 1e5, as team records carry it (trail
 * bases, drawings). Strict: anything malformed, past `maxPoints` or outside the
 * world is refused whole (peer input), unlike the lenient trail-catalogue
 * decoder in `@core/trails/polyline`.
 */

/** Encoded polyline (1e5) → `[lng, lat]` points; null for anything malformed. Total. */
export function decodeLine(src: string, maxPoints: number): [number, number][] | null {
  const out: [number, number][] = [];
  let i = 0;
  let la = 0;
  let lo = 0;
  const next = (): number | null => {
    let shift = 0;
    let result = 0;
    for (;;) {
      if (i >= src.length || shift > 30) return null;
      const b = src.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) return null;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < src.length) {
    const dla = next();
    const dlo = next();
    if (dla === null || dlo === null) return null;
    la += dla;
    lo += dlo;
    if (out.length >= maxPoints) return null;
    const p: [number, number] = [lo / 1e5, la / 1e5];
    if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) return null;
    out.push(p);
  }
  return out;
}
