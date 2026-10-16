/**
 * Settings › Display › Display size (#760): one app-wide multiplier over the
 * UI's type, spacing, icons and map chrome, from 60 % to 150 % in 10 % steps
 * (default 100 %). The map's own content (lines, symbols) is not scaled; pins
 * keep their separate Pin size (`@core/map/pinScale`).
 *
 * The OS font size still applies on top, through React Native's own font
 * scaling and the per-text `maxFontSizeMultiplier` caps, which bound only the
 * OS factor. This module never reads it.
 *
 * Touch areas never shrink with the display size: `touchSize` and
 * `hitSlopFor` keep every target at {@link MIN_TOUCH} dp or more while the
 * visual shrinks.
 *
 * Persisted as a whole percentage (`displayScale: 100`). Anything else read
 * back (junk, a hand-edited file, a retired step) is 100 %.
 *
 * PURE: no React Native / Expo imports.
 */

export const DISPLAY_SCALES = [60, 70, 80, 90, 100, 110, 120, 130, 140, 150] as const;
export type DisplayScale = (typeof DISPLAY_SCALES)[number];
export const DEFAULT_DISPLAY_SCALE: DisplayScale = 100;

/** Android's 48 dp minimum touch target (iOS asks 44 pt; 48 satisfies both). */
export const MIN_TOUCH = 48;

export function isDisplayScale(v: unknown): v is DisplayScale {
  return (DISPLAY_SCALES as readonly unknown[]).includes(v);
}

/** A stored value as a step: itself when it is one, 100 % otherwise. */
export function normalizeDisplayScale(v: unknown): DisplayScale {
  return isDisplayScale(v) ? v : DEFAULT_DISPLAY_SCALE;
}

/** The multiplier a step stands for (80 → 0.8); junk is 1. */
export function displayScaleFactor(v: unknown): number {
  return normalizeDisplayScale(v) / 100;
}

/** "80 %": the value next to the slider. */
export function displayScaleLabel(v: DisplayScale): string {
  return `${v} %`;
}

/** The slider's stop index for a step (60 → 0, 150 → 9); junk is 100 %'s. */
export function displayScaleIndex(v: unknown): number {
  return DISPLAY_SCALES.indexOf(normalizeDisplayScale(v));
}

/** The step at a slider stop, clamped to the ends. */
export function displayScaleAt(index: number): DisplayScale {
  const last = DISPLAY_SCALES.length - 1;
  const i = Number.isFinite(index) ? Math.min(last, Math.max(0, Math.round(index))) : 0;
  return DISPLAY_SCALES[i] ?? DEFAULT_DISPLAY_SCALE;
}

/**
 * A design size in dp at `factor`, rounded to the half dp so edges stay crisp
 * on 2× and 3× screens. Identity at 1 (the 100 % layout is byte-for-byte the
 * one the fit tests pin). Zero, negatives and non-finite values pass through
 * scaled the same way; NaN stays NaN.
 */
export function scaleSize(n: number, factor: number): number {
  if (factor === 1) return n;
  return Math.round(n * factor * 2) / 2;
}

/** A touchable box's side: scaled, but never below {@link MIN_TOUCH}. */
export function touchSize(n: number, factor: number, min: number = MIN_TOUCH): number {
  return Math.max(min, scaleSize(n, factor));
}

/**
 * The symmetric hitSlop that grows a `visual`-dp box to `min` dp (0 when it
 * is already that big). Pressable takes a number for all four sides.
 */
export function hitSlopFor(visual: number, min: number = MIN_TOUCH): number {
  if (!Number.isFinite(visual) || visual >= min) return 0;
  return Math.ceil((min - visual) / 2);
}

/**
 * Style keys that carry a design size and scale with the display. Border
 * widths (hairlines), opacity, flex, z-index, elevation and aspect ratio do
 * not; percentages and other strings never do.
 */
const SCALED_KEYS: ReadonlySet<string> = new Set([
  'fontSize',
  'lineHeight',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'top',
  'right',
  'bottom',
  'left',
  'start',
  'end',
  'gap',
  'rowGap',
  'columnGap',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'marginHorizontal',
  'marginVertical',
  'marginStart',
  'marginEnd',
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'paddingHorizontal',
  'paddingVertical',
  'paddingStart',
  'paddingEnd',
  'borderRadius',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'shadowRadius',
]);

/**
 * Minimum sizes that, at 100 %, already sit at a touch target: they keep at
 * least {@link MIN_TOUCH} at any scale. A row with `minHeight: 48` is a tap
 * row; its text and padding shrink, its touch area doesn't.
 */
const TOUCH_FLOOR_KEYS: ReadonlySet<string> = new Set(['minHeight', 'minWidth']);

/** A plain style object (what `StyleSheet.create` returns per key in RN ≥ 0.66). */
export type StyleRecord = Record<string, unknown>;

/**
 * One style object at `factor`: every size key scaled (see SCALED_KEYS),
 * `minHeight` / `minWidth` that were ≥ 48 floored at 48, `shadowOffset` and
 * `transform`-free nested objects left alone. Returns the same object at 1.
 */
export function scaleStyle<T extends object>(style: T, factor: number): T {
  if (factor === 1) return style;
  const out: StyleRecord = {};
  for (const [key, value] of Object.entries(style) as [string, unknown][]) {
    if (typeof value === 'number' && key === 'letterSpacing') {
      // Tracking is sub-dp; half-dp rounding would erase it.
      out[key] = Math.round(value * factor * 100) / 100;
    } else if (typeof value === 'number' && SCALED_KEYS.has(key)) {
      const scaled = scaleSize(value, factor);
      out[key] =
        TOUCH_FLOOR_KEYS.has(key) && value >= MIN_TOUCH ? Math.max(MIN_TOUCH, scaled) : scaled;
    } else if (key === 'shadowOffset' && isOffset(value)) {
      out[key] = {
        width: scaleSize(value.width, factor),
        height: scaleSize(value.height, factor),
      };
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function isOffset(v: unknown): v is { width: number; height: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { width?: unknown }).width === 'number' &&
    typeof (v as { height?: unknown }).height === 'number'
  );
}

/**
 * A whole sheet (`{ name: style }`) at `factor`, memoised per sheet and
 * factor so a re-render never rebuilds it. Identity at 1.
 */
const sheetCache = new WeakMap<object, Map<number, unknown>>();
export function scaleSheet<T extends object>(sheet: T, factor: number): T {
  if (factor === 1) return sheet;
  let byFactor = sheetCache.get(sheet);
  if (byFactor === undefined) {
    byFactor = new Map();
    sheetCache.set(sheet, byFactor);
  }
  const hit = byFactor.get(factor);
  if (hit !== undefined) return hit as T;
  const out: Record<string, unknown> = {};
  for (const [name, style] of Object.entries(sheet) as [string, unknown][]) {
    out[name] = typeof style === 'object' && style !== null ? scaleStyle(style, factor) : style;
  }
  byFactor.set(factor, out);
  return out as T;
}

/** A text style's metrics (the MD3 type-scale shape Paper uses). */
export interface FontMetrics {
  fontSize: number;
  lineHeight?: number;
  letterSpacing?: number;
}

/** Type metrics at `factor`; lineHeight and letterSpacing scale with the size. */
export function scaleFont<T extends FontMetrics>(font: T, factor: number): T {
  if (factor === 1) return font;
  return scaleStyle(font, factor);
}

/**
 * The live preview's debounce (Settings rescales while the finger rests on a
 * stop for this long; the rest of the app follows on release).
 */
export const DISPLAY_SCALE_PREVIEW_MS = 150;

/**
 * The width a layout effectively gets at a Display size: everything (type,
 * padding, icons) grows by `factor`, so a 360 dp screen at 150 % fits what a
 * 240 dp screen fits at 100 %. Fit tests check their 100 % arithmetic
 * against this width instead of 360.
 */
export function effectiveScreenDp(screenDp: number, factor: number): number {
  return factor > 0 && Number.isFinite(factor) ? screenDp / factor : screenDp;
}
