/**
 * The drawing panel's bottom row (#515): Undo · Clear · [Return chip] · Save.
 *
 * Save must never shrink below its one-line label, so space is given up in
 * this order, from the measured widths:
 *
 * 1. `full`    — everything on one row, the Return chip with its label;
 * 2. `compact` — the chip collapses to icon + caret (its spoken label stays);
 * 3. `stacked` — Save moves to its own full-width row under the icon row
 *                (whose chip is full if it fits there, else compact).
 *
 * Pure: widths in dp, from the views' layouts.
 */

export type BottomRowMode = 'full' | 'compact' | 'stacked';

export interface BottomRowWidths {
  /** The row's inner width. */
  row: number;
  /** Undo + Clear, fixed-size icon buttons. */
  icons: number;
  /** The Return chip with its label, and collapsed to icon + caret (0 = no chip). */
  chipFull: number;
  chipCompact: number;
  /** Save at its natural width: label on one line plus padding. */
  save: number;
  /** Space between items. */
  gap: number;
}

export interface BottomRowLayout {
  mode: BottomRowMode;
  /** Whether the chip shows its label. */
  chipLabel: boolean;
}

export function bottomRowLayout(w: BottomRowWidths): BottomRowLayout {
  const hasChip = w.chipFull > 0;
  const lead = w.icons + (hasChip ? w.gap : 0);
  const fits = (chip: number) => lead + chip + w.gap + w.save <= w.row;
  // Not measured yet: the full row (it is re-laid out once widths arrive).
  if (w.row <= 0) return { mode: 'full', chipLabel: true };
  if (!hasChip) return fits(0) ? { mode: 'full', chipLabel: true } : stacked(true);
  if (fits(w.chipFull)) return { mode: 'full', chipLabel: true };
  if (fits(w.chipCompact)) return { mode: 'compact', chipLabel: false };
  return stacked(lead + w.chipFull <= w.row);
}

const stacked = (chipLabel: boolean): BottomRowLayout => ({ mode: 'stacked', chipLabel });
