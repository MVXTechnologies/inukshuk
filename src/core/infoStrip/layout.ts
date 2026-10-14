/**
 * The strip's layout rules (mockup 2.6.0 info strip §2–§5):
 * - auto-fit: a row has 4 spaces, most fields take 1, coordinates take 2;
 *   the + shows only where a space is free;
 * - recording: the panel owns its hero metrics, the strip drops duplicates;
 * - stacking: what lifts what, by measured heights.
 */
import type { HeroField } from '@core/recording/panel';

import { fieldDescriptor } from './registry';
import type { Dock, FieldRef } from './types';

/** Spaces in one strip row. */
export const ROW_SPACES = 4;
/** One strip row, dp (mockup: 30 dp rows). */
export const ROW_H_DP = 30;
/** The hairline between rows, dp. */
export const ROW_DIVIDER_DP = 1;
/** The strip's padding (hairline on top + bottom inset), dp. */
export const STRIP_PAD_DP = 7;
/** Extra height while it shares the recording panel's surface (the panel's rounded top), dp. */
export const STRIP_MERGED_EXTRA_DP = 4;
/** The heading tape's height, dp (2.5.1 NavCompass). */
export const TAPE_H_DP = 44;
/** The gap between stacked layers, dp. */
export const STACK_GAP_DP = 8;

export interface RowFit {
  /** Spaces the row's known fields take. */
  used: number;
  /** Spaces left (never negative). */
  free: number;
  /** Whether the editor shows a + in this row. */
  plus: boolean;
  /** More than {@link ROW_SPACES} spaces (only from a hand-edited or corrupt file). */
  overflow: boolean;
}

/**
 * The auto-fit rule: how many spaces a row's fields take and whether a +
 * can show. Unknown fields (a newer build's) are skipped, so they take no
 * space here.
 */
export function fitRow(fields: readonly FieldRef[]): RowFit {
  const used = fields.reduce((n, f) => n + (fieldDescriptor(f.field)?.spaces ?? 0), 0);
  const free = Math.max(0, ROW_SPACES - used);
  return { used, free, plus: free > 0, overflow: used > ROW_SPACES };
}

/**
 * The rows as drawn: unknown fields skipped, and while recording every field
 * whose metric the panel's hero row shows dropped (Q5: one owner per metric);
 * a row left empty goes, and the rest re-fit.
 */
export function visibleRows(
  rows: readonly (readonly FieldRef[])[],
  heroFields: readonly HeroField[],
  recording: boolean,
): FieldRef[][] {
  const owned = new Set(recording ? heroFields : []);
  return rows
    .map((row) =>
      row.filter((f) => {
        const d = fieldDescriptor(f.field);
        return d !== undefined && !(d.recordingMetric && owned.has(d.recordingMetric));
      }),
    )
    .filter((row) => row.length > 0);
}

/**
 * The hero metrics the strip shows, so cycling a hero slot skips them
 * (`cycleHeroField`'s `skip`).
 */
export function stripHeroMetrics(rows: readonly (readonly FieldRef[])[]): Set<HeroField> {
  const out = new Set<HeroField>();
  for (const row of rows) {
    for (const f of row) {
      const m = fieldDescriptor(f.field)?.recordingMetric;
      if (m !== undefined) out.add(m);
    }
  }
  return out;
}

/**
 * The strip's height for `rowCount` visible rows, dp: 0 with none (it
 * collapses), else rows + dividers + padding, plus the merged top while it
 * sits on the recording panel.
 */
export function stripHeightDp(rowCount: number, mergedWithPanel = false): number {
  if (rowCount <= 0) return 0;
  return (
    ROW_H_DP * rowCount +
    ROW_DIVIDER_DP * (rowCount - 1) +
    STRIP_PAD_DP +
    (mergedWithPanel ? STRIP_MERGED_EXTRA_DP : 0)
  );
}

export interface StackOffsets {
  /** Bottom dock: the strip's bottom edge above the screen bottom; null when docked on top. */
  stripBottom: number | null;
  /** Top dock: the strip's top edge below the screen top (it reaches behind the status bar); null at the bottom. */
  stripTop: number | null;
  /** The heading tape's bottom edge above the screen bottom; null while it is hidden. */
  tapeBottom: number | null;
  /** The ⓘ + scale row's bottom edge above the screen bottom. */
  scaleRowBottom: number;
  /** How far all top chrome (compass badge, search, rail, destination chip) moves down. */
  topChromeShift: number;
}

/**
 * What lifts what, from measured heights (owner 2026-10-13). Bottom up: the
 * tab bar or recording panel (`panelH`), the strip (bottom dock), the
 * compass tape (when active), then the ⓘ + scale row — the scale row sits
 * ABOVE the tape, as in 2.5.1. With the top dock the strip takes the top
 * edge, the top chrome shifts down by its height, and the bottom keeps the
 * 2.5.1 order (panel, tape, scale row).
 */
export function stackOffsets(
  dock: Dock,
  stripH: number,
  panelH: number,
  tapeActive: boolean,
): StackOffsets {
  const bottom = dock === 'bottom';
  const base = bottom ? panelH + stripH : panelH;
  const tapeBottom = tapeActive ? base + STACK_GAP_DP : null;
  const scaleRowBottom =
    tapeBottom === null ? base + STACK_GAP_DP : tapeBottom + TAPE_H_DP + STACK_GAP_DP;
  return {
    stripBottom: bottom ? panelH : null,
    stripTop: bottom ? null : 0,
    tapeBottom,
    scaleRowBottom,
    topChromeShift: bottom ? 0 : stripH,
  };
}
