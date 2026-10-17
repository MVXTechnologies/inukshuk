/**
 * One-line fit arithmetic at a Display size (#760), for the fit tests: "if it
 * fits, it fits" (owner 2026-10-16), so a standard label must render on one
 * line at 360 dp at Small, Default and Large.
 *
 * Widths are em advances measured from the bundled Atkinson Hyperlegible Next
 * (`assets/fonts/*.ttf`, PIL `ImageFont.getlength`), never guessed; the
 * callers keep their measured table next to the test.
 *
 * PURE: no React Native / Expo imports.
 */
import { scaleFontSize, scaleSize, scaleSpacing } from './displayScale';

/** The OS font scale React Native applies, bounded by a Text's maxFontSizeMultiplier. */
export function osTextScale(osFontScale: number, cap?: number): number {
  const os = Number.isFinite(osFontScale) && osFontScale > 0 ? osFontScale : 1;
  return cap === undefined ? os : Math.min(os, cap);
}

/** A text's advance in dp: `em` × its size at the Display size × the capped OS scale. */
export function textAdvanceDp(
  em: number,
  sp: number,
  factor: number,
  osFontScale = 1,
  cap?: number,
): number {
  return em * scaleFontSize(sp, factor) * osTextScale(osFontScale, cap);
}

/** What a row's text gets at `factor`: the screen less its spacing and fixed boxes. */
export interface RowParts {
  /** Paddings, margins, gaps and insets at 100 % (they scale as spacing). */
  spacing: readonly number[];
  /** Icons, avatars, buttons and other boxes at 100 % (they scale as content). */
  boxes: readonly number[];
}

export function rowRoomDp(screenDp: number, parts: RowParts, factor: number): number {
  const spacing = parts.spacing.reduce((a, n) => a + scaleSpacing(n, factor), 0);
  const boxes = parts.boxes.reduce((a, n) => a + scaleSize(n, factor), 0);
  return screenDp - spacing - boxes;
}

/** Whether a text of advance `em` at `sp` sits on one line in `roomDp`. */
export function fitsOneLine(
  em: number,
  sp: number,
  roomDp: number,
  factor: number,
  osFontScale = 1,
  cap?: number,
): boolean {
  return textAdvanceDp(em, sp, factor, osFontScale, cap) <= roomDp;
}
