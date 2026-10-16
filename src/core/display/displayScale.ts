/**
 * Settings › Display › Display size (#760): one app-wide multiplier over the
 * UI's type, spacing, icons and map chrome. Three sizes (owner 2026-10-16:
 * aesthetics first, no free slider): Small 85 %, Default 100 %, Large 115 %.
 * Nothing reflows between them: every layout just scales, and still fits a
 * 360 dp phone at 115 %. The map's own content (lines, symbols) is not
 * scaled; pins keep their separate Pin size (`@core/map/pinScale`).
 *
 * The OS font size still applies on top, through React Native's own font
 * scaling and the per-text `maxFontSizeMultiplier` caps, which bound only the
 * OS factor. This module never reads it.
 *
 * Touch areas never shrink with the display size: `touchSize` and
 * `hitSlopFor` keep every target at {@link MIN_TOUCH} dp or more while the
 * visual shrinks.
 *
 * Persisted as the factor itself (`displayScale: 0.85`). Anything else read
 * back (junk, a hand-edited file, an older build's value) is 1.
 *
 * PURE: no React Native / Expo imports.
 */

export const DISPLAY_SCALES = [0.85, 1, 1.15] as const;
export type DisplayScale = (typeof DISPLAY_SCALES)[number];
export const DEFAULT_DISPLAY_SCALE: DisplayScale = 1;

/**
 * The smallest text the Display size draws (sp): text shrinks with the
 * setting but stops here. 10 sp: the 100 % type scale's smallest caption is
 * 12 sp, and 12 × 0.85 lands on 10, so the floor never bends a standard
 * caption at Small; it only holds up the few sub-12 labels (badges, chips).
 * Text designed smaller than the floor keeps its own size.
 */
export const MIN_TEXT_SP = 10;

/** The size text designed at `fontSize` draws at `factor`, held at the floor. */
export function scaleFontSize(fontSize: number, factor: number): number {
  const scaled = scaleSize(fontSize, factor);
  return Math.max(scaled, Math.min(fontSize, MIN_TEXT_SP));
}

/** Android's 48 dp minimum touch target (iOS asks 44 pt; 48 satisfies both). */
export const MIN_TOUCH = 48;

export function isDisplayScale(v: unknown): v is DisplayScale {
  return (DISPLAY_SCALES as readonly unknown[]).includes(v);
}

/** A stored value as a size: itself when it is one, 1 otherwise. */
export function normalizeDisplayScale(v: unknown): DisplayScale {
  return isDisplayScale(v) ? v : DEFAULT_DISPLAY_SCALE;
}

/** The multiplier a stored value stands for; junk is 1. */
export function displayScaleFactor(v: unknown): number {
  return normalizeDisplayScale(v);
}

/** The segment labels, smallest first. */
export const DISPLAY_SCALE_LABELS: Record<DisplayScale, string> = {
  0.85: 'Small',
  1: 'Default',
  1.15: 'Large',
};

/** "Small", "Default", "Large". */
export function displayScaleLabel(v: unknown): string {
  return DISPLAY_SCALE_LABELS[normalizeDisplayScale(v)];
}

/** "85 %": the size as a percentage, for screen readers and the row. */
export function displayScalePercent(v: unknown): string {
  return `${Math.round(normalizeDisplayScale(v) * 100)} %`;
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
 * Sizes that, at 100 %, sit at a touch target keep at least {@link MIN_TOUCH}
 * at any scale: a `minHeight` / `minWidth` of 48 or more (a tap row), and a
 * `width` / `height` of exactly 48 (`target.min`, the app's touch box; the
 * icon inside it shrinks, the box doesn't). A visual 48 dp disc that should
 * shrink draws its own visual inside a 48 dp touch box instead.
 */
const MIN_FLOOR_KEYS: ReadonlySet<string> = new Set(['minHeight', 'minWidth']);
const BOX_FLOOR_KEYS: ReadonlySet<string> = new Set(['width', 'height']);

function touchFloored(key: string, value: number): boolean {
  return (
    (MIN_FLOOR_KEYS.has(key) && value >= MIN_TOUCH) ||
    (BOX_FLOOR_KEYS.has(key) && value === MIN_TOUCH)
  );
}

/** A plain style object (what `StyleSheet.create` returns per key in RN ≥ 0.66). */
export type StyleRecord = Record<string, unknown>;

/**
 * One style object at `factor`: every size key scaled (see SCALED_KEYS),
 * touch sizes floored at 48 (see `touchFloored`), text held at the floor,
 * `shadowOffset` scaled, everything else left alone. The same object at 1.
 */
export function scaleStyle<T extends object>(style: T, factor: number): T {
  if (factor === 1) return style;
  const out: StyleRecord = {};
  for (const [key, value] of Object.entries(style) as [string, unknown][]) {
    if (typeof value === 'number' && key === 'letterSpacing') {
      // Tracking is sub-dp; half-dp rounding would erase it.
      out[key] = Math.round(value * factor * 100) / 100;
    } else if (typeof value === 'number' && key === 'fontSize') {
      out[key] = scaleFontSize(value, factor);
    } else if (typeof value === 'number' && key === 'lineHeight') {
      // Leading follows the text: when the floor held the size up, the line
      // keeps the design's ratio to it instead of clipping the glyphs.
      const fs = (style as { fontSize?: unknown }).fontSize;
      const scaled = scaleSize(value, factor);
      out[key] =
        typeof fs === 'number' && fs > 0
          ? Math.max(scaled, Math.round(scaleFontSize(fs, factor) * (value / fs) * 2) / 2)
          : scaled;
    } else if (typeof value === 'number' && key === 'borderRadius' && roundBox(style, value)) {
      // A circle on a touch box the floor kept at 48 stays a circle.
      out[key] = value;
    } else if (typeof value === 'number' && SCALED_KEYS.has(key)) {
      const scaled = scaleSize(value, factor);
      out[key] = touchFloored(key, value) ? Math.max(MIN_TOUCH, scaled) : scaled;
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

/** A 48 × 48 touch box drawn as a circle (radius 24): the floor keeps both. */
function roundBox(style: object, radius: number): boolean {
  const { width, height } = style as { width?: unknown; height?: unknown };
  return width === MIN_TOUCH && height === MIN_TOUCH && radius === MIN_TOUCH / 2;
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
 * The width a layout effectively gets at a Display size: everything (type,
 * padding, icons) grows by `factor`, so a 360 dp screen at 150 % fits what a
 * 240 dp screen fits at 100 %. Fit tests check their 100 % arithmetic
 * against this width instead of 360.
 */
export function effectiveScreenDp(screenDp: number, factor: number): number {
  return factor > 0 && Number.isFinite(factor) ? screenDp / factor : screenDp;
}
