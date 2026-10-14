/**
 * Fitting a field into its share of a row (QA 2.6.0: "Kiosque …", "COG 300°…",
 * "SOG 4.8 k…" in a 1-space cell). A value is never cut: when the field does
 * not fit, it gives up, in order,
 *   1. its tag ("COG", "SOG", "ETA") — the glyph still says what it is;
 *   2. one type step (13 → 11.5 sp);
 *   3. unit detail: a compass point after degrees ("300°" says it), the
 *      arrow-only tide trend, "nmi" → "NM";
 *   4. its glyph.
 * The renderer then lets the native text shrink as the last resort, so only a
 * NAME (a target's) can still ellipsise, never a number.
 *
 * Widths are estimates (dp per character, measured on the strip's font on
 * Android at font scale 1), deliberately a little generous: dropping a tag
 * one step early costs less than a cut value.
 */
import type { StripValue } from './types';

/** The strip's type sizes, sp (StripField). */
export const VALUE_SP = 13;
export const VALUE_SMALL_SP = 11.5;
const TAG_SP = 10.5;
const UNIT_SP = 11;
/** Glyph (14) plus its gap (4), dp. */
const GLYPH_DP = 18;
/** The gap between the tag and what follows, dp. */
const GAP_DP = 4;

/** Average advance per character, in em (bold tabular figures, caps tags). */
const VALUE_EM = 0.6;
const TAG_EM = 0.72;
const UNIT_EM = 0.6;

const COMPASS_POINT = /^(N|NE|E|SE|S|SW|W|NW|NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW)$/;

/** The estimated width of a value as StripField draws it, dp. */
export function estimateWidthDp(v: StripValue, valueSp: number, fontScale = 1): number {
  let w = v.value.length * VALUE_EM * valueSp;
  if (v.unit !== undefined && v.unit !== '') w += (v.unit.length + 1) * UNIT_EM * UNIT_SP;
  if (v.tag !== undefined) w += v.tag.length * TAG_EM * TAG_SP + GAP_DP;
  w *= fontScale;
  if (v.glyph !== undefined) w += GLYPH_DP;
  return w;
}

/** A unit's shorter form, or undefined when it can go entirely. */
export function shortUnit(value: string, unit: string): string | undefined {
  if (COMPASS_POINT.test(unit) && value.includes('°')) return undefined;
  if (unit === 'nmi') return 'NM';
  // Tide: "m ↑" → "↑" (the level's metres are the strip's own unit).
  const trend = /^m\s*([↑↓])$/.exec(unit);
  if (trend) return trend[1];
  return unit;
}

export interface FittedValue {
  value: StripValue;
  /** The value's type size, sp. */
  valueSp: number;
}

/** The fullest form of `v` that fits `widthDp` (see the module note). */
export function fitStripValue(v: StripValue, widthDp: number, fontScale = 1): FittedValue {
  const fits = (x: StripValue, sp: number) => estimateWidthDp(x, sp, fontScale) <= widthDp;
  if (fits(v, VALUE_SP)) return { value: v, valueSp: VALUE_SP };
  let cur: StripValue = v;
  // 1. The tag, when a glyph still names the field; else it stays to the end.
  if (cur.tag !== undefined && cur.glyph !== undefined) {
    cur = without(cur, 'tag');
    if (fits(cur, VALUE_SP)) return { value: cur, valueSp: VALUE_SP };
  }
  // 2. One type step.
  if (fits(cur, VALUE_SMALL_SP)) return { value: cur, valueSp: VALUE_SMALL_SP };
  // 3. Unit detail.
  if (cur.unit !== undefined) {
    const u = shortUnit(cur.value, cur.unit);
    cur = u === undefined ? without(cur, 'unit') : { ...cur, unit: u };
    if (fits(cur, VALUE_SMALL_SP)) return { value: cur, valueSp: VALUE_SMALL_SP };
  }
  // 4. The glyph (a tag-only field keeps its tag: it is what names it).
  if (cur.glyph !== undefined) {
    cur = without(cur, 'glyph');
    if (fits(cur, VALUE_SMALL_SP)) return { value: cur, valueSp: VALUE_SMALL_SP };
  }
  // A tag with no glyph goes last.
  if (cur.tag !== undefined) cur = without(cur, 'tag');
  return { value: cur, valueSp: VALUE_SMALL_SP };
}

function without(v: StripValue, key: 'tag' | 'unit' | 'glyph'): StripValue {
  const out = { ...v };
  delete out[key];
  return out;
}
