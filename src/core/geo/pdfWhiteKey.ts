/**
 * "See-through white" for PDF map overlays: the near-white paper of a sheet
 * (open land, the collar, margins) turns transparent so the base map shows
 * through, while everything printed on it — coloured fills, contours, text —
 * stays.
 *
 * The rule, per pixel (8-bit, unpremultiplied RGBA):
 *
 * - **lightness** = the darkest channel. A pixel is only as white as its
 *   darkest channel: `(255, 255, 120)` is yellow, not light. Keying ramps in
 *   smoothly from {@link KEY_LIGHT_START} to full at {@link KEY_LIGHT_FULL},
 *   so the anti-aliased edge of a black glyph (a run of greys from black to
 *   white) fades gradually instead of leaving a hard light ring.
 * - **neutrality** = the channel spread (max − min). Printed tints are light
 *   but coloured — US Topo woodland green, water blue, the pink of built-up
 *   areas — and must survive, so keying is gated off between
 *   {@link KEY_CHROMA_START} and {@link KEY_CHROMA_END} of spread.
 * - The share removed is `strength × lightness × neutrality`, and the
 *   removed share is taken to be *white*: the remaining colour is un-blended
 *   from white (colour-to-alpha), never removing more white than the pixel
 *   holds. Over a white base map the result looks like the original; over a dark or photographic one a grey text
 *   edge becomes a darker, fainter edge instead of a pale halo.
 *
 * Like `pdfLayers`, the pass ships to the rasterizer WebView as plain ES5
 * **source text** (Hermes cannot turn a compiled function back into source),
 * and `loadWhiteKeyRuntime()` evaluates the same text for the tests, so the
 * page and the tests run one implementation.
 */

/**
 * The user's choice: how see-through a PDF map's white paper is, as a stop on
 * a 5-position slider — 0 = Off, 1 / 2 / 3 = 25 / 50 / 75 %, 4 = Full (100 %).
 */
export type WhiteKeyLevel = 0 | 1 | 2 | 3 | 4;

export const WHITE_KEY_LEVELS: readonly WhiteKeyLevel[] = [0, 1, 2, 3, 4];

/** The top stop (Full, 100 %). */
export const WHITE_KEY_MAX: WhiteKeyLevel = 4;

/** Nothing changes until the user picks a level. */
export const DEFAULT_WHITE_KEY: WhiteKeyLevel = 0;

/**
 * Keying strength of a stop: the share of pure white that is removed — 0,
 * 0.25, 0.5, 0.75, 1. Strength only scales HOW MUCH white goes; WHICH pixels
 * count as white (the lightness ramp and the colour cut-off below) is the
 * same at every stop, so a light printed tint such as the 2024 US Topo
 * woodland green (228, 240, 215) stays fully solid all the way to 100 %.
 */
export function whiteKeyStrength(level: WhiteKeyLevel): number {
  return level / WHITE_KEY_MAX;
}

/** What a stop reads as: "Off", "25 %", "50 %", "75 %", "100 %". */
export function whiteKeyLabel(level: WhiteKeyLevel): string {
  return level === 0 ? 'Off' : `${level * 25} %`;
}

export function isWhiteKeyLevel(v: unknown): v is WhiteKeyLevel {
  return typeof v === 'number' && (WHITE_KEY_LEVELS as readonly number[]).includes(v);
}

/**
 * The first cut of this feature stored three named levels (never shipped to
 * a store build, but on test devices): Off → 0, Some → 2 (50 %), Full → 4
 * (100 %).
 */
export const LEGACY_WHITE_KEY: Readonly<Record<'off' | 'some' | 'full', WhiteKeyLevel>> = {
  off: 0,
  some: 2,
  full: 4,
};

/**
 * A persisted level read back: a stop as-is, a legacy name migrated onto its
 * stop, anything else `undefined` (the caller picks the fallback — the
 * default for the global setting, "follow the global" for a map override).
 */
export function parseWhiteKeyLevel(v: unknown): WhiteKeyLevel | undefined {
  if (isWhiteKeyLevel(v)) return v;
  if (v === 'off' || v === 'some' || v === 'full') return LEGACY_WHITE_KEY[v];
  return undefined;
}

/** The stop nearest a continuous slider position (snapped and clamped). */
export function nearestWhiteKeyLevel(position: number): WhiteKeyLevel {
  if (!Number.isFinite(position)) return DEFAULT_WHITE_KEY;
  const n = Math.round(Math.min(WHITE_KEY_MAX, Math.max(0, position)));
  return WHITE_KEY_LEVELS[n] ?? DEFAULT_WHITE_KEY;
}

/**
 * The level a map is drawn at: its own override when it has one, otherwise
 * the global default from the Overlays menu.
 */
export function effectiveWhiteKey(
  override: WhiteKeyLevel | undefined,
  global: WhiteKeyLevel,
): WhiteKeyLevel {
  return override ?? global;
}

/** Darkest-channel value where keying starts to ramp in. */
export const KEY_LIGHT_START = 176;
/** Darkest-channel value from which a neutral pixel is fully keyed. */
export const KEY_LIGHT_FULL = 240;
/** Channel spread below which a pixel counts as fully neutral. */
export const KEY_CHROMA_START = 6;
/** Channel spread from which a pixel counts as coloured and is never keyed. */
export const KEY_CHROMA_END = 20;

/**
 * ES5 source defining `__inkKeyWhite(data, strength)` (one in-place pass over
 * a canvas `ImageData.data`, returning how many pixels changed) and
 * `__inkKeyPixel(r, g, b, a, strength)` (one pixel, returned as `[r, g, b, a]`),
 * installed on the global object.
 *
 * The pass is table-driven: the lightness and neutrality ramps are looked up
 * (256 entries each), and every pixel darker than the ramp — most of a
 * printed map's ink — costs one min/max and a branch.
 */
export const PDF_WHITE_KEY_RUNTIME_SOURCE = String.raw`(function (root) {
  'use strict';
  var LIGHT_START = ${KEY_LIGHT_START}, LIGHT_FULL = ${KEY_LIGHT_FULL};
  var CHROMA_START = ${KEY_CHROMA_START}, CHROMA_END = ${KEY_CHROMA_END};
  function smooth(lo, hi, x) {
    if (x <= lo) return 0;
    if (x >= hi) return 1;
    var t = (x - lo) / (hi - lo);
    return t * t * (3 - 2 * t);
  }
  var LIGHT = new Float32Array(256);
  var NEUTRAL = new Float32Array(256);
  for (var i = 0; i < 256; i++) {
    LIGHT[i] = smooth(LIGHT_START, LIGHT_FULL, i);
    NEUTRAL[i] = 1 - smooth(CHROMA_START, CHROMA_END, i);
  }
  function clampStrength(s) {
    s = +s;
    return s > 0 ? (s < 1 ? s : 1) : 0;
  }
  // Un-blend one channel from white, given 1/f: c = f*x + (1-f)*255  =>  x.
  function unblend(c, inv) {
    var x = 255 - (255 - c) * inv;
    return x <= 0 ? 0 : (x + 0.5) | 0;
  }
  function keyWhite(data, strength) {
    var s = clampStrength(strength);
    if (s === 0 || !data) return 0;
    var n = data.length - (data.length % 4);
    var changed = 0;
    // Printed maps are long runs of identical paper pixels: remember the last
    // keyed colour and reuse its result.
    var lr = -1, lg = -1, lb = -1, la = -1, or = 0, og = 0, ob = 0, oa = 0;
    for (var p = 0; p < n; p += 4) {
      var r = data[p], g = data[p + 1], b = data[p + 2];
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mn <= LIGHT_START) continue;
      var a = data[p + 3];
      if (r === lr && g === lg && b === lb && a === la) {
        data[p] = or; data[p + 1] = og; data[p + 2] = ob; data[p + 3] = oa;
        changed++;
        continue;
      }
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var k = LIGHT[mn] * NEUTRAL[mx - mn];
      if (k === 0) continue;
      var f = 1 - s * k;
      // Never remove more white than the pixel holds: below this the darkest
      // channel would un-blend past black and the pixel would lighten.
      var floor = (255 - mn) / 255;
      if (f < floor) f = floor;
      lr = r; lg = g; lb = b; la = a;
      if (f < 0.004) {
        or = r; og = g; ob = b; oa = 0;
      } else {
        var inv = 1 / f;
        or = unblend(r, inv); og = unblend(g, inv); ob = unblend(b, inv);
        oa = (a * f + 0.5) | 0;
      }
      data[p] = or; data[p + 1] = og; data[p + 2] = ob; data[p + 3] = oa;
      changed++;
    }
    return changed;
  }
  function keyPixel(r, g, b, a, strength) {
    var px = [r, g, b, a];
    keyWhite(px, strength);
    return px;
  }
  root.__inkKeyWhite = keyWhite;
  root.__inkKeyPixel = keyPixel;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
`;

export interface WhiteKeyRuntime {
  /** Key a whole RGBA buffer in place; returns the number of pixels changed. */
  keyWhite(data: Uint8ClampedArray | number[], strength: number): number;
  /** One pixel, keyed: `[r, g, b, a]`. */
  keyPixel(r: number, g: number, b: number, a: number, strength: number): number[];
}

/**
 * Evaluate {@link PDF_WHITE_KEY_RUNTIME_SOURCE} against a private global and
 * return its exports (tests, Node benchmarks). The app ships the source text
 * to the WebView instead.
 */
export function loadWhiteKeyRuntime(): WhiteKeyRuntime {
  const root: Record<string, unknown> = {};
  new Function('self', 'globalThis', PDF_WHITE_KEY_RUNTIME_SOURCE)(root, root);
  return {
    keyWhite: root.__inkKeyWhite as WhiteKeyRuntime['keyWhite'],
    keyPixel: root.__inkKeyPixel as WhiteKeyRuntime['keyPixel'],
  };
}

let runtime: WhiteKeyRuntime | null = null;

/**
 * The alpha a pixel keeps after keying at `strength` (0 = unchanged, 1 =
 * full). Pure white at full strength is 0; saturated colours and dark ink are
 * untouched.
 */
export function keyWhiteAlpha(
  r: number,
  g: number,
  b: number,
  a: number,
  strength: number,
): number {
  runtime ??= loadWhiteKeyRuntime();
  return runtime.keyPixel(r, g, b, a, strength)[3] ?? a;
}
