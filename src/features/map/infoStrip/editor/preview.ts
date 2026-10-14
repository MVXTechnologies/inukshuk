import { fieldDescriptor } from '@core/infoStrip/registry';
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
 * value when the data is there, else its sample, so a field without data
 * right now (no target, no fix) still reads as what it will be.
 */
export function previewValue(
  ref: FieldRef,
  data: DepsSnapshot,
  ctx: ComputeContext,
): { value: StripValue; descriptor: FieldDescriptor } | null {
  const descriptor = fieldDescriptor(ref.field);
  if (descriptor === undefined) return null;
  const live = descriptor.compute(data, ref.params as Params, ctx);
  return { value: live ?? descriptor.sample, descriptor };
}
