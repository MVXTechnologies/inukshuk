/** Motion and time fields: speed, heading, sunset. */
import { formatClockTime, formatSpeed } from '@core/format';
import { magneticToTrue, trueToMagnetic } from '@core/geo/wmm';
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
    // iOS reports −1 for "no speed": an invalid speed is unknown, never "0.0".
    const valid = v !== null && Number.isFinite(v) && v >= 0;
    const text = valid ? splitUnit(formatSpeed(v, units)) : { value: '—' };
    return params.style === 'sog'
      ? { glyph: 'sailing', tag: 'SOG', ...text }
      : { glyph: 'speed', ...text };
  },
  sample: { glyph: 'speed', value: '3.6', unit: 'km/h' },
  sampleIn: (units) => ({ glyph: 'speed', ...splitUnit(formatSpeed(1, units)) }),
});

/**
 * A bearing read against `from` north, shown against `want` north. Without a
 * declination (no fix, no centre) it cannot convert, and says which north it
 * is honestly: a magnetic reading stays "°M" rather than pass for true.
 */
export function northAs(
  deg: number,
  from: NorthReference,
  want: NorthReference,
  declinationDeg: number | null,
): { deg: number; magnetic: boolean } {
  if (from === want) return { deg, magnetic: from === 'magnetic' };
  if (declinationDeg === null) return { deg, magnetic: from === 'magnetic' };
  return want === 'magnetic'
    ? { deg: trueToMagnetic(deg, declinationDeg), magnetic: true }
    : { deg: magneticToTrue(deg, declinationDeg), magnetic: false };
}

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
  // On the course it never needs the compass (the sensor stays off).
  depsFor: (p) =>
    p.source === 'course' ? ['course', 'position'] : ['heading', 'course', 'position'],
  tick: 'heading4Hz',
  compute(data, params) {
    const course = data.course ?? { speedMps: 0, courseDeg: null };
    const b = choosePointingBearing(
      params.source === 'compass' ? 'heading' : 'course',
      0,
      data.headingDeg,
      course,
    );
    // Nothing to read yet: still its glyph (as speed and sunset keep theirs),
    // so a bare "—" never stands in the strip with nothing to say what it is.
    if (b === null)
      return params.source === 'course'
        ? { glyph: 'navigation', tag: 'COG', value: '—' }
        : { glyph: 'navigation', value: '—' };
    // The course is always true; the compass is true unless the OS had no fix
    // to correct it with (`headingReference`).
    const from: NorthReference =
      b.kind === 'compass' && data.headingReference === 'magnetic' ? 'magnetic' : 'true';
    const r = northAs(b.bearingDeg, from, params.reference, declinationHere(data));
    const out: StripValue = { glyph: 'navigation', ...bearingValue(r.deg, r.magnetic) };
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
  sampleClockMin: 18 * 60 + 12,
});
