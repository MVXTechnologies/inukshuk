/**
 * Colour-ramp interpolation (weather UX M1 polish): expands a layer's few
 * legend stop colours into a smooth gradient — the picker's circular layer
 * thumbnails and the legend pill render the result as thin adjacent segments,
 * which reads as a continuous ramp without any gradient dependency or binary
 * asset (OTA-clean). Pure math, no platform imports.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse "#RRGGBB" (case-insensitive). Null on anything else. */
export function hexToRgb(hex: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  const raw = m?.[1];
  if (raw === undefined) return null;
  const n = parseInt(raw, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * `count` colours linearly interpolated across `stops`, endpoints included —
 * stops spaced evenly, like a CSS linear-gradient. Degenerate inputs degrade
 * predictably: no stops → [], one stop → that colour repeated, junk stops →
 * skipped in favour of the nearest parseable neighbour (all-junk → []).
 */
export function interpolateRamp(stops: readonly string[], count: number): string[] {
  const rgbs = stops.map(hexToRgb).filter((c): c is Rgb => c !== null);
  if (rgbs.length === 0 || count <= 0) return [];
  const first = rgbs[0];
  if (rgbs.length === 1 || count === 1) {
    return first === undefined ? [] : Array.from({ length: count }, () => rgbToHex(first));
  }
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * (rgbs.length - 1);
    const lo = Math.min(Math.floor(t), rgbs.length - 2);
    const a = rgbs[lo];
    const b = rgbs[lo + 1];
    if (a === undefined || b === undefined) continue;
    const f = t - lo;
    out.push(
      rgbToHex({
        r: a.r + (b.r - a.r) * f,
        g: a.g + (b.g - a.g) * f,
        b: a.b + (b.b - a.b) * f,
      }),
    );
  }
  return out;
}
