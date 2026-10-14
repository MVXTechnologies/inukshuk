/**
 * The recording metrics as strip fields (`hero:*`): the recording panel's own
 * formatter (`heroFieldText`), so the strip and the panel can never disagree.
 * Only the metrics with no field of their own: speed, altitude and sunset
 * are the `speed`, `altitude` and `sunset` fields, which carry the same
 * `recordingMetric` for the de-dup rule.
 *
 * Shown only while recording; while the panel shows the same metric in its
 * hero row, the strip drops it (`visibleRows`).
 */
import { heroFieldText, type HeroField } from '@core/recording/panel';

import { splitUnit } from '../format';
import type { FieldDescriptor, StripValue } from '../types';
import { defineField } from './define';

type HeroSpec = { field: HeroField; label: string; summary: string; glyph?: string; tag?: string };

function heroField(
  { field, label, summary, glyph, tag }: HeroSpec,
  sample: string,
  synonyms: readonly string[],
): FieldDescriptor<Record<string, never>> {
  const dress = (text: string): StripValue => {
    const out: StripValue = splitUnit(text);
    if (glyph !== undefined) out.glyph = glyph;
    if (tag !== undefined) out.tag = tag;
    return out;
  };
  return defineField<Record<string, never>>({
    id: `hero:${field}`,
    label,
    summary,
    synonyms,
    group: 'recording',
    spaces: 1,
    params: {},
    defaults: {},
    deps: ['recording'],
    tick: 'second',
    recordingMetric: field,
    compute(data, _params, { units }) {
      return data.recording === null ? null : dress(heroFieldText(field, data.recording, units));
    },
    sample: dress(sample),
  });
}

export const HERO_TIME = heroField(
  { field: 'time', label: 'Recording time', summary: 'This recording so far', glyph: 'timer' },
  '1:12:40',
  ['elapsed', 'duration', 'chrono'],
);
export const HERO_DISTANCE = heroField(
  {
    field: 'distance',
    label: 'Recorded distance',
    summary: 'This recording so far',
    glyph: 'straighten',
  },
  '8.42 km',
  ['km', 'miles', 'covered'],
);
export const HERO_GAIN = heroField(
  { field: 'gain', label: 'Gain', summary: 'Climbed in this recording', glyph: 'north_east' },
  '+412 m',
  ['ascent', 'climb', 'elevation gain', 'up'],
);
export const HERO_DESCENT = heroField(
  {
    field: 'descent',
    label: 'Descent',
    summary: 'Descended in this recording',
    glyph: 'south_east',
  },
  '−188 m',
  ['down', 'loss'],
);
export const HERO_PACE = heroField(
  { field: 'pace', label: 'Pace', summary: 'Average pace of this recording', tag: 'Pace' },
  '15:47/km',
  ['min/km', 'tempo'],
);
export const HERO_MOVING = heroField(
  {
    field: 'moving',
    label: 'Moving time',
    summary: 'Time in motion, stops left out',
    glyph: 'directions_walk',
  },
  '58:10',
  ['moving', 'active time'],
);
