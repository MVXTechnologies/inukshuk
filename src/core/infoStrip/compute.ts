/**
 * One tick of the strip: every placed field's value over one snapshot. A
 * field whose data is missing (null) steps aside and its row re-fits; a row
 * left with nothing goes, so the strip's height follows what it can say.
 */
import { fieldDescriptor } from './registry';
import type {
  ComputeContext,
  DepsSnapshot,
  FieldDescriptor,
  FieldRef,
  Params,
  StripSubject,
  StripValue,
} from './types';

export interface PlacedValue {
  /** The field's place in the strip's rows (for the editor and test ids). */
  row: number;
  index: number;
  ref: FieldRef;
  descriptor: FieldDescriptor;
  value: StripValue;
}

/** The values to draw, row by row (rows as `visibleRows` left them). */
export function computeRows(
  rows: readonly (readonly FieldRef[])[],
  data: DepsSnapshot,
  ctx: ComputeContext,
): PlacedValue[][] {
  const out: PlacedValue[][] = [];
  rows.forEach((row, r) => {
    const placed: PlacedValue[] = [];
    row.forEach((ref, index) => {
      const descriptor = fieldDescriptor(ref.field);
      if (descriptor === undefined) return;
      const value = descriptor.compute(data, ref.params as Params, ctx);
      if (value !== null) placed.push({ row: r, index, ref, descriptor, value });
    });
    if (placed.length > 0) out.push(placed);
  });
  return out;
}

/** Whether two values draw the same (what `StripField`'s memo compares). */
export function sameValue(a: StripValue, b: StripValue): boolean {
  return (
    a.value === b.value &&
    a.unit === b.unit &&
    a.glyph === b.glyph &&
    a.tag === b.tag &&
    a.tone === b.tone &&
    a.namesSubject === b.namesSubject &&
    sameSubject(a.subject, b.subject)
  );
}

function sameSubject(a: StripSubject | undefined, b: StripSubject | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.key === b.key &&
    a.name === b.name &&
    a.glyph === b.glyph &&
    a.pin?.icon === b.pin?.icon &&
    a.pin?.color === b.pin?.color &&
    (a.pin === undefined) === (b.pin === undefined) &&
    a.cursor?.kind === b.cursor?.kind &&
    a.cursor?.color === b.cursor?.color &&
    a.cursor?.halo === b.cursor?.halo
  );
}

/** A field's words for screen readers: "Speed 3.6 km/h", "Time to target (ETE) ETE 0:21". */
export function spokenValue(label: string, v: StripValue): string {
  return [label, v.tag, v.value, v.unit].filter((s) => s !== undefined && s !== '').join(' ');
}
