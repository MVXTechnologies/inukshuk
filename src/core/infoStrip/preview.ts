/**
 * What the editor shows for a field without live data (QA 2.6.0): never a
 * made-up value that reads as real ("Camp lac 1.23 km", "Lauzon +3.84 m"),
 * but a placeholder: the field's glyph or tag with "—". The presets'
 * miniatures keep their samples, with clock times in the phone's 12/24 h form.
 */
import { formatClockTime, type Units } from '@core/format';

import type { FieldDescriptor, StripValue } from './types';

/** The placeholder value: "—" behind the field's glyph and tag. */
export const PLACEHOLDER_TEXT = '—';

export function placeholderValue(d: FieldDescriptor): StripValue {
  const { glyph, tag } = d.placeholder ?? d.sample;
  const out: StripValue = { value: PLACEHOLDER_TEXT };
  if (glyph !== undefined) out.glyph = glyph;
  if (tag !== undefined) out.tag = tag;
  return out;
}

/**
 * The sample as a miniature shows it: a distance, height or speed in the
 * user's units (`sampleIn`, #702), a clock-time sample (`sampleClockMin`) in
 * the phone's own form ("2:32 PM" or "14:32"), any other as declared.
 * `clock` formats an epoch in local time (injected for tests).
 */
export function sampleValue(
  d: FieldDescriptor,
  units: Units,
  clock: (epochMs: number) => string = formatClockTime,
): StripValue {
  if (d.sampleIn !== undefined) return d.sampleIn(units);
  if (d.sampleClockMin === undefined) return d.sample;
  const at = new Date(2026, 0, 1, Math.floor(d.sampleClockMin / 60), d.sampleClockMin % 60);
  return { ...d.sample, value: clock(at.getTime()) };
}
