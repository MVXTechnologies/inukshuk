/**
 * The strip editor's operations (mockup §3), pure: every one takes the rows
 * and returns new rows, or null when the change is not allowed (it would
 * overflow a row's 4 spaces or make a fourth row). The UI never has to grey
 * anything out: it offers only what these accept.
 *
 * Rows hold unknown fields (a newer build's) as they are; they take no
 * space (`fitRow`) and move with their row.
 */
import { fitRow, ROW_SPACES } from './layout';
import { fieldDescriptor } from './registry';
import { MAX_ROWS, type FieldRef, type InfoStrip, type Params } from './types';

export type Rows = readonly (readonly FieldRef[])[];

/** A field's place: its row and its index in the row. */
export interface Slot {
  row: number;
  index: number;
}

const copy = (rows: Rows): FieldRef[][] => rows.map((r) => [...r]);

function spacesOf(f: FieldRef): number {
  return fieldDescriptor(f.field)?.spaces ?? 0;
}

/** Whether `f` fits in `row` beside its fields. */
function fits(row: readonly FieldRef[], f: FieldRef): boolean {
  return fitRow(row).used + spacesOf(f) <= ROW_SPACES;
}

/** Whether "Add a row" shows: fewer than {@link MAX_ROWS} rows. */
export function canAddRow(rows: Rows): boolean {
  return rows.length < MAX_ROWS;
}

/**
 * Add `f` at the end of row `row`; `row === rows.length` starts a new row.
 * Null when it does not fit or the strip already has its rows.
 */
export function addField(rows: Rows, row: number, f: FieldRef): FieldRef[][] | null {
  if (row === rows.length) return canAddRow(rows) ? [...copy(rows), [f]] : null;
  const target = rows[row];
  if (target === undefined || !fits(target, f)) return null;
  const out = copy(rows);
  out[row]!.push(f);
  return out;
}

/** Remove a field; a row left empty goes. */
export function removeField(rows: Rows, at: Slot): FieldRef[][] {
  return copy(rows)
    .map((r, i) => (i === at.row ? r.filter((_, j) => j !== at.index) : r))
    .filter((r) => r.length > 0);
}

/** Replace one field's params. */
export function setFieldParams(rows: Rows, at: Slot, params: Params): FieldRef[][] {
  return copy(rows).map((r, i) =>
    i === at.row ? r.map((f, j) => (j === at.index ? { ...f, params: { ...params } } : f)) : r,
  );
}

/**
 * Move a field to `to` (an index in the row as it is now; `to.row ===
 * rows.length` makes a new row). Within its row it is a reorder; to another
 * row it must fit there. A row left empty goes. Null when it does not fit,
 * when a new row is not allowed, or when nothing moves.
 */
export function moveField(rows: Rows, from: Slot, to: Slot): FieldRef[][] | null {
  const f = rows[from.row]?.[from.index];
  if (f === undefined) return null;
  if (to.row === from.row) {
    const row = rows[from.row]!;
    const index = Math.max(0, Math.min(to.index, row.length));
    // Dropping on itself or just after itself changes nothing.
    if (index === from.index || index === from.index + 1) return null;
    const out = copy(rows);
    const r = out[from.row]!;
    r.splice(from.index, 1);
    r.splice(index > from.index ? index - 1 : index, 0, f);
    return out;
  }
  const newRow = to.row === rows.length;
  // A field alone in its row moved to a new row is the same strip.
  if (newRow && (!canAddRow(rows) || rows[from.row]!.length === 1)) return null;
  const target = rows[to.row];
  if (!newRow && (target === undefined || !fits(target, f))) return null;
  const out = copy(rows);
  out[from.row]!.splice(from.index, 1);
  if (newRow) out.push([f]);
  else {
    const r = out[to.row]!;
    r.splice(Math.max(0, Math.min(to.index, r.length)), 0, f);
  }
  return out.filter((r) => r.length > 0);
}

/** Move a whole row to index `to` (clamped). Null when it does not move. */
export function moveRow(rows: Rows, from: number, to: number): FieldRef[][] | null {
  const index = Math.max(0, Math.min(to, rows.length - 1));
  if (rows[from] === undefined || index === from) return null;
  const out = copy(rows);
  const [r] = out.splice(from, 1);
  out.splice(index, 0, r!);
  return out;
}

// ------------------------------------------------------------------ drop geometry

/** A measured row in window coordinates, with its fields' horizontal extents. */
export interface RowRect {
  y: number;
  h: number;
  fields: readonly { x: number; w: number }[];
}

/**
 * Where a dragged field lands (`point` in window coordinates): the row under
 * it (above the first: the first; below the last: a new row when allowed,
 * else the last), at the index before the first field whose centre is right
 * of the point.
 */
export function dropSlot(rects: readonly RowRect[], point: { x: number; y: number }): Slot | null {
  if (rects.length === 0) return null;
  const last = rects.length - 1;
  let row = rects.findIndex((r) => point.y < r.y + r.h);
  if (row === -1) {
    // Below every row: a new row when there is room for one.
    if (rects.length < MAX_ROWS) return { row: rects.length, index: 0 };
    row = last;
  }
  const fields = rects[row]!.fields;
  const index = fields.findIndex((f) => point.x < f.x + f.w / 2);
  return { row, index: index === -1 ? fields.length : index };
}

// ------------------------------------------------------------------ names

/**
 * A name not taken yet: `base`, else "base 2", "base 3"… (case-insensitive,
 * trimmed to `max` characters with room for the number).
 */
export function uniqueName(base: string, taken: readonly string[], max = 40): string {
  const names = new Set(taken.map((n) => n.toLowerCase()));
  const b = base.trim().slice(0, max) || 'My strip';
  if (!names.has(b.toLowerCase())) return b;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${b.slice(0, max - suffix.length)}${suffix}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

/** The editor's subtitle: "Navigation" or "Navigation · edited". */
export function stripTitle(s: InfoStrip, edited: boolean): string {
  return edited ? `${s.name} · edited` : s.name;
}

/**
 * The short tag the coordinates field writes after a converted value, from
 * the Convert engine's output label: "NAD83(CSRS) 2010.0" → "CSRS",
 * "NAD83 (original)" → "NAD83", "ITRF2020 @ 2026.76" → "ITRF2020",
 * "WGS 84" stays.
 */
export function datumTag(outputLabel: string): string {
  if (/\(CSRS\)/i.test(outputLabel)) return 'CSRS';
  return outputLabel
    .replace(/\s*@.*$/, '')
    .replace(/\s*\(.*\)/, '')
    .replace(/\s+\d{4}(\.\d+)?$/, '')
    .trim();
}
