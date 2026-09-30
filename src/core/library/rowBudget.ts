/**
 * Progressive rendering for a long Library (#465). The Library is a plain
 * ScrollView of sections (folders, drag targets, inline profile peeks), so
 * instead of virtualizing it, trail rows are rendered up to a budget that
 * grows as the user nears the end of the list: a 400-trail library mounts
 * (and loads thumbnails for) one page of rows, not 400.
 *
 * A budget is created per render and consumed in display order.
 */

/** Trail rows mounted up front, and added per step. */
export const LIBRARY_ROW_PAGE = 60;

export interface RowBudget {
  /** The first rows of `rows` that still fit the budget (consumes it). */
  take<T>(rows: readonly T[]): T[];
  /** Rows offered to {@link take} that did not fit. */
  readonly hidden: number;
}

export function createRowBudget(limit: number): RowBudget {
  let left = Math.max(0, Math.floor(limit));
  let hidden = 0;
  return {
    take<T>(rows: readonly T[]): T[] {
      const n = Math.min(rows.length, left);
      left -= n;
      hidden += rows.length - n;
      return n === rows.length ? [...rows] : rows.slice(0, n);
    },
    get hidden() {
      return hidden;
    },
  };
}

/** Whether a scroll position is within `thresholdPx` of the content's end. */
export function nearScrollEnd(
  offsetY: number,
  viewportHeight: number,
  contentHeight: number,
  thresholdPx: number = 1200,
): boolean {
  return offsetY + viewportHeight >= contentHeight - thresholdPx;
}
