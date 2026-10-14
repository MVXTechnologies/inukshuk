/**
 * Saying what a reading is TO (owner, 2.6.0: "when adding a distance in the
 * bar to something, it should say to what, or at least show the same target
 * icon"). A distance, bearing, ETE or ETA carries its target, an off-trail
 * distance its trail ({@link StripSubject}); its cell shows, in order of
 * preference:
 *   1. caption: the subject's icon and NAME before the value
 *      ("[pin] Lac-Beauport 3.2 km"), when the whole value still fits beside
 *      at least {@link CAPTION_MIN_CHARS} characters of the name. Only the
 *      name is ever cut (an ellipsis); the value never is;
 *   2. icon: the subject's icon only (a saved waypoint's own map pin, in its
 *      colour; else the target's glyph), the value fitted to what is left
 *      (`fitStripValue`'s steps). The icon stays even in the narrowest cell:
 *      it is what says to what.
 *
 * Named once (`captionPlan`): a strip names each subject at most once. A
 * target-name field names it (its icon replaces its glyph); else the first
 * field to it in reading order (row 1 first, left to right) may caption it.
 * Every other field to the same subject shows its icon only: "Camp lac" next
 * to "Camp lac 1.2 km" next to "Camp lac 0:21" says nothing new, and the icon
 * still ties each reading to it.
 *
 * Pure. Widths are `fit.ts`'s estimates.
 */
import { spokenValue } from './compute';
import { estimateWidthDp, fitStripValue, isName, VALUE_SP, type FittedValue } from './fit';
import type { FieldDescriptor, StripValue } from './types';

/** The caption's type size, sp (StripField), and its average advance, em. */
export const CAPTION_SP = 11;
const CAPTION_EM = 0.58;
/** The fewest characters of a name worth showing (else the icon says it alone). */
export const CAPTION_MIN_CHARS = 5;
/** The subject's icon (14, the pin a little narrower) plus its gap, dp: the glyph's. */
export const SUBJECT_ICON_DP = 18;
/** Between the caption and the value, dp. */
const CAPTION_GAP_DP = 6;

/** How a cell shows its subject. */
export type SubjectShow = 'caption' | 'icon' | 'none';

export interface FittedCell extends FittedValue {
  subject: SubjectShow;
}

/** The narrowest caption worth drawing for `name`: a few characters (and the ellipsis), dp. */
export function captionMinWidthDp(name: string, fontScale = 1): number {
  const chars = name.length <= CAPTION_MIN_CHARS ? name.length : CAPTION_MIN_CHARS + 1;
  return chars * CAPTION_EM * CAPTION_SP * fontScale + CAPTION_GAP_DP;
}

/**
 * The fullest form of a cell that fits `widthDp` (see the module note).
 * `mayCaption`: the strip lets this cell name its subject (`captionPlan`).
 */
export function fitCell(
  v: StripValue,
  widthDp: number,
  fontScale = 1,
  mayCaption = true,
): FittedCell {
  const s = v.subject;
  if (s === undefined) return { ...fitStripValue(v, widthDp, fontScale), subject: 'none' };
  if (v.namesSubject === true) {
    // The name field: the subject's icon in the glyph's place, then as any name.
    const f = fitStripValue({ ...v, glyph: s.glyph }, widthDp, fontScale);
    return { ...f, value: withoutGlyph(f.value), subject: 'icon' };
  }
  if (mayCaption) {
    const need =
      SUBJECT_ICON_DP +
      captionMinWidthDp(s.name, fontScale) +
      estimateWidthDp(v, VALUE_SP, fontScale);
    if (need <= widthDp) {
      return { value: v, valueSp: VALUE_SP, shrinkToFit: !isName(v), subject: 'caption' };
    }
  }
  return { ...fitStripValue(v, widthDp - SUBJECT_ICON_DP, fontScale), subject: 'icon' };
}

/**
 * A cell before it knows its width, or in a content-sized box (the picker):
 * the subject's icon, no caption, the value whole.
 */
export function unfittedCell(v: StripValue): FittedCell {
  return {
    value: v.namesSubject === true ? withoutGlyph(v) : v,
    valueSp: VALUE_SP,
    shrinkToFit: false,
    subject: v.subject === undefined ? 'none' : 'icon',
  };
}

/**
 * Which cells may caption their subject, cell by cell (rows as drawn; a null
 * cell is one not drawn). See the module note: a subject a name field names
 * is captioned nowhere else; any other, by its first field in reading order.
 */
export function captionPlan(rows: readonly (readonly (StripValue | null)[])[]): boolean[][] {
  const named = new Set<string>();
  for (const row of rows) {
    for (const v of row) {
      if (v?.subject !== undefined && v.namesSubject === true) named.add(v.subject.key);
    }
  }
  return rows.map((row) =>
    row.map((v) => {
      const s = v?.subject;
      if (s === undefined || v?.namesSubject === true || named.has(s.key)) return false;
      named.add(s.key);
      return true;
    }),
  );
}

/**
 * A field's words for screen readers, naming what it is to: "Distance to
 * Lac-Beauport: 3.2 km", "Time to Camp lac: 0:21" (a tag the phrase already
 * says goes); any other as `label tag value unit`.
 */
export function spokenField(d: Pick<FieldDescriptor, 'label' | 'spokenTo'>, v: StripValue): string {
  const s = v.subject;
  if (s !== undefined && v.namesSubject !== true && d.spokenTo !== undefined) {
    const reading = [v.value, v.unit].filter((x) => x !== undefined && x !== '').join(' ');
    return `${d.spokenTo} ${s.name}: ${reading}`;
  }
  return spokenValue(d.label, v);
}

function withoutGlyph(v: StripValue): StripValue {
  const out = { ...v };
  delete out.glyph;
  return out;
}
