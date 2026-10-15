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
import { METRIC, type Units } from '@core/format';
import { heroFieldText, type HeroData, type HeroField } from '@core/recording/panel';

import { splitUnit } from '../format';
import type { FieldDescriptor, StripValue } from '../types';
import { defineField } from './define';

type HeroSpec = { field: HeroField; label: string; summary: string; glyph?: string; tag?: string };

/**
 * The presets' made-up recording, formatted like a live one so a sample
 * follows the Units setting (#702): "1:12:40", "8.42 km", "+412 m",
 * "−188 m", "15:47/km", "58:10" in metric.
 */
const SAMPLE_RECORDING: HeroData = {
  elapsedS: 4360,
  distanceM: 8420,
  ascentM: 412,
  descentM: 188,
  movingTimeS: 3490,
  avgSpeedMps: 1000 / 947,
  liveSpeedMps: 1,
  altitudeM: 412,
  position: null,
  nowMs: 0,
};

function heroField(
  { field, label, summary, glyph, tag }: HeroSpec,
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
    sample: dress(heroFieldText(field, SAMPLE_RECORDING, METRIC)),
    sampleIn: (units: Units) => dress(heroFieldText(field, SAMPLE_RECORDING, units)),
  });
}

export const HERO_TIME = heroField(
  { field: 'time', label: 'Recording time', summary: 'This recording so far', glyph: 'timer' },
  ['elapsed', 'duration', 'chrono'],
);
export const HERO_DISTANCE = heroField(
  {
    field: 'distance',
    label: 'Recorded distance',
    summary: 'This recording so far',
    glyph: 'straighten',
  },
  ['km', 'miles', 'covered'],
);
export const HERO_GAIN = heroField(
  { field: 'gain', label: 'Gain', summary: 'Climbed in this recording', glyph: 'north_east' },
  ['ascent', 'climb', 'elevation gain', 'up'],
);
export const HERO_DESCENT = heroField(
  {
    field: 'descent',
    label: 'Descent',
    summary: 'Descended in this recording',
    glyph: 'south_east',
  },
  ['down', 'loss'],
);
export const HERO_PACE = heroField(
  { field: 'pace', label: 'Pace', summary: 'Average pace of this recording', tag: 'Pace' },
  ['min/km', 'tempo'],
);
export const HERO_MOVING = heroField(
  {
    field: 'moving',
    label: 'Moving time',
    summary: 'Time in motion, stops left out',
    glyph: 'directions_walk',
  },
  ['moving', 'active time'],
);
