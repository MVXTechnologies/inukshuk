/** Motion and time fields: speed, heading, sunset. */
import { formatClockTime, formatSpeed } from '@core/format';
import { trueToMagnetic } from '@core/geo/wmm';
import { choosePointingBearing } from '@core/nav/pointingSource';
import { sunTimes } from '@core/sun/sunTimes';

import { bearingValue, splitUnit } from '../format';
import type { StripValue } from '../types';
import { defineField, REFERENCE_PARAM, type NorthReference } from './define';
import { declinationHere, herePoint } from './position';

export type SpeedParams = { style: 'speed' | 'sog' };

/** Speed over ground from the fix; "SOG" styled for paddling. */
export const SPEED = defineField<SpeedParams>({
  id: 'speed',
  label: 'Speed',
  summary: 'Your speed over ground',
  synonyms: ['sog', 'velocity', 'km/h', 'mph', 'knots'],
  group: 'motion',
  spaces: 1,
  params: {
    style: {
      kind: 'choice',
      label: 'Label',
      options: [
        { value: 'speed', label: 'Speed' },
        { value: 'sog', label: 'SOG' },
      ],
    },
  },
  defaults: { style: 'speed' },
  deps: ['position'],
  tick: 'position',
  recordingMetric: 'speed',
  compute(data, params, { units }) {
    if (data.position === null) return null;
    const v = data.position.speedMps;
    const text = v === null ? { value: '—' } : splitUnit(formatSpeed(v, units));
    return params.style === 'sog'
      ? { glyph: 'sailing', tag: 'SOG', ...text }
      : { glyph: 'speed', ...text };
  },
  sample: { glyph: 'speed', value: '3.6', unit: 'km/h' },
});

export type HeadingParams = { source: 'compass' | 'course'; reference: NorthReference };

/**
 * Where you face: the compass, or the course over ground (tagged "COG").
 * With no magnetometer the compass source falls back to the course above
 * 0.5 m/s, as the compass tape and the pointing line do; below it "—".
 */
export const HEADING = defineField<HeadingParams>({
  id: 'heading',
  label: 'Heading',
  summary: 'Where the phone points, or your course',
  synonyms: ['compass', 'cog', 'course', 'direction', 'facing'],
  group: 'motion',
  spaces: 1,
  params: {
    source: {
      kind: 'choice',
      label: 'Source',
      options: [
        { value: 'compass', label: 'Compass' },
        { value: 'course', label: 'Course (COG)' },
      ],
    },
    reference: REFERENCE_PARAM,
  },
  defaults: { source: 'compass', reference: 'true' },
  deps: ['heading', 'course', 'position'],
  tick: 'heading4Hz',
  compute(data, params) {
    const course = data.course ?? { speedMps: 0, courseDeg: null };
    const b = choosePointingBearing(
      params.source === 'compass' ? 'heading' : 'course',
      0,
      data.headingDeg,
      course,
    );
    if (b === null) return params.source === 'course' ? { tag: 'COG', value: '—' } : { value: '—' };
    const decl = params.reference === 'magnetic' ? declinationHere(data) : null;
    const deg = decl === null ? b.bearingDeg : trueToMagnetic(b.bearingDeg, decl);
    const out: StripValue = { glyph: 'navigation', ...bearingValue(deg, decl !== null) };
    if (b.kind === 'cog') out.tag = 'COG';
    return out;
  },
  sample: { glyph: 'navigation', value: '340°', unit: 'N' },
});

/** Today's sunset, clock time, where you are (else at the map centre). */
export const SUNSET = defineField<Record<string, never>>({
  id: 'sunset',
  label: 'Sunset',
  summary: "Today's sunset here",
  synonyms: ['daylight', 'dusk', 'night', 'sun'],
  group: 'motion',
  spaces: 1,
  params: {},
  defaults: {},
  deps: ['position', 'camera', 'clock'],
  tick: 'minute',
  recordingMetric: 'sunset',
  compute(data) {
    const p = herePoint(data);
    if (p === null) return null;
    const { sunset } = sunTimes(data.nowMs, p.latitude, p.longitude);
    return { glyph: 'wb_twilight', value: sunset === null ? '—' : formatClockTime(sunset) };
  },
  sample: { glyph: 'wb_twilight', value: '18:12' },
});
