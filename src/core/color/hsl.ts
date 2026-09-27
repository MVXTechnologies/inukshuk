/**
 * Colour parsing with alpha, compositing and HSL — the pieces the theme gates
 * need beyond `contrast.ts`: Paper's MD3 defaults mix `#RRGGBB`, `rgba()` and
 * `'transparent'`, and the "no purple" guard judges hue and saturation, which
 * WCAG luminance says nothing about. Pure (no platform deps).
 */

/** An sRGB colour, channels 0..255, alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Hue in degrees [0, 360), saturation and lightness in 0..1 (CSS HSL). */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i;

/**
 * Parse `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, `rgb()`, `rgba()` or
 * `transparent`. Throws on anything else, so a typo in a token fails the gate
 * instead of slipping past it.
 */
export function parseRgba(color: string): Rgba {
  const s = color.trim();
  if (s.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = HEX.exec(s);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
    const n = (i: number) => parseInt(digits.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = FUNC.exec(s);
  if (fn) {
    const alpha = fn[4];
    let a = 1;
    if (alpha !== undefined)
      a = alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha);
    const channels = [Number(fn[1]), Number(fn[2]), Number(fn[3])];
    if (channels.some((c) => c > 255) || a > 1) throw new Error(`colour out of range: ${color}`);
    return { r: channels[0]!, g: channels[1]!, b: channels[2]!, a };
  }
  throw new Error(`invalid colour: ${color}`);
}

/** `#RRGGBB` for an opaque colour (alpha dropped). */
export function toHex({ r, g, b }: Rgba): string {
  const h = (c: number) => Math.round(c).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/**
 * The opaque colour you actually see when `fg` is drawn over `bg` (straight
 * alpha "over"). A translucent chrome colour is only legible — or purple — as
 * the mix it makes with whatever sits under it.
 */
export function compositeOver(fg: string, bg: string): string {
  const f = parseRgba(fg);
  const b = parseRgba(bg);
  if (b.a < 1) throw new Error(`background must be opaque: ${bg}`);
  const mix = (x: number, y: number) => x * f.a + y * (1 - f.a);
  return toHex({ r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b), a: 1 });
}

/** CSS HSL of a colour (alpha ignored). */
export function toHsl(color: string): Hsl {
  const { r, g, b } = parseRgba(color);
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** The brand's "no purple" band: hue 250–300° with HSL saturation above 8 %. */
export const PURPLE_BAND = { hueMin: 250, hueMax: 300, minSaturation: 0.08 } as const;

/**
 * Whether a colour reads as purple/lavender — Material's inherited tint that
 * the revamp removes. Fully transparent colours are never purple.
 */
export function isPurple(color: string): boolean {
  if (parseRgba(color).a === 0) return false;
  const { h, s } = toHsl(color);
  return h >= PURPLE_BAND.hueMin && h <= PURPLE_BAND.hueMax && s > PURPLE_BAND.minSaturation;
}
