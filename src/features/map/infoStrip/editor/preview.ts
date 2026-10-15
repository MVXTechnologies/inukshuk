import { placeholderValue } from '@core/infoStrip/preview';
import { fieldDescriptor } from '@core/infoStrip/registry';
import { captionPlan } from '@core/infoStrip/subject';
import type {
  ComputeContext,
  DepsSnapshot,
  FieldDescriptor,
  FieldRef,
  Params,
  StripValue,
} from '@core/infoStrip/types';

/**
 * What the editor shows for a field (mockup §3 "live previews"): its live
 * value when the data is there, else a placeholder ("—" behind its glyph or
 * tag, drawn muted), never a made-up value that reads as real (QA 2.6.0).
 */
export function previewValue(
  ref: FieldRef,
  data: DepsSnapshot,
  ctx: ComputeContext,
): { value: StripValue; descriptor: FieldDescriptor; live: boolean } | null {
  const descriptor = fieldDescriptor(ref.field);
  if (descriptor === undefined) return null;
  const live = descriptor.compute(data, ref.params as Params, ctx);
  return live === null
    ? { value: placeholderValue(descriptor), descriptor, live: false }
    : { value: live, descriptor, live: true };
}

/**
 * Which of the editor's fields name their target (`captionPlan`), over the
 * whole strip as the map will draw it: what the editor shows is what the
 * strip shows (a target named once, its other fields by its icon).
 */
export function previewCaptions(
  rows: readonly (readonly FieldRef[])[],
  data: DepsSnapshot,
  ctx: ComputeContext,
): boolean[][] {
  return captionPlan(rows.map((row) => row.map((f) => previewValue(f, data, ctx)?.value ?? null)));
}
