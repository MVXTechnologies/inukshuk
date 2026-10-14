/**
 * Position fields: coordinates, ground elevation, altitude, accuracy and the
 * magnetic declination.
 */
import {
  COORDINATE_FORMATS,
  formatCoordinate,
  type CoordinateFormat,
} from '@core/convert/coordinateDisplay';
import { formatElevation } from '@core/format';
import { magneticField } from '@core/geo/wmm';
import { decimalYear } from '@core/gnss/datum';
import { formatAccuracy } from '@core/gnss/chip';
import { chipAltitudeText } from '@core/map/coordinatesChip';
import type { LatLng } from '@core/models';

import { signedDegrees, splitUnit } from '../format';
import type { DepsSnapshot, StripValue } from '../types';
import { defineField } from './define';

/** Where "here" is for a place-dependent value: you when there is a fix, else the map centre. */
export function herePoint(data: DepsSnapshot): LatLng | null {
  return data.position ?? data.centre;
}

/** The declination where you are (or at the centre), degrees east, or null with neither. */
export function declinationHere(data: DepsSnapshot): number | null {
  const p = herePoint(data);
  if (p === null) return null;
  return magneticField(p.latitude, p.longitude, 0, decimalYear(data.nowMs)).declinationDeg;
}

/** The centre, which is you while the map follows you (2.5.1). */
function centreOrYou(data: DepsSnapshot): { p: LatLng; you: boolean } | null {
  if (data.followsUser && data.position !== null) return { p: data.position, you: true };
  return data.centre === null ? null : { p: data.centre, you: false };
}

export type CoordsParams = {
  point: 'centre' | 'you';
  format: 'app' | CoordinateFormat;
  datum: 'wgs84' | 'csrs' | 'project';
  showAccuracy: boolean;
  tapToCopy: boolean;
};

/**
 * Coordinates of the map centre or of you (2 spaces), in any display format.
 * Another datum shows the platform's conversion and its tag; if it has none
 * (outside the datum's area, no engine yet) the WGS 84 value shows tagged
 * "WGS 84" — never a WGS 84 number under another datum's name.
 */
export const COORDS = defineField<CoordsParams>({
  id: 'coords',
  label: 'Coordinates',
  summary: 'The map centre or you, in DD, DDM, DMS, UTM or MGRS',
  synonyms: ['position', 'lat', 'lon', 'latitude', 'longitude', 'utm', 'mgrs', 'grid'],
  group: 'position',
  spaces: 2,
  params: {
    point: {
      kind: 'choice',
      label: 'Point',
      hint: 'While the map follows you, the centre is you',
      options: [
        { value: 'centre', label: 'Map centre' },
        { value: 'you', label: 'You' },
      ],
    },
    format: {
      kind: 'choice',
      label: 'Format',
      options: [
        { value: 'app', label: 'As in Settings' },
        ...COORDINATE_FORMATS.map((f) => ({ value: f.value, label: f.label })),
      ],
    },
    datum: {
      kind: 'choice',
      label: 'Datum',
      options: [
        { value: 'wgs84', label: 'WGS 84' },
        { value: 'csrs', label: 'NAD83(CSRS)' },
        { value: 'project', label: 'Project' },
      ],
    },
    showAccuracy: {
      kind: 'toggle',
      label: 'Show accuracy',
      hint: '±2 cm with the GNSS receiver, ±4 m with the phone',
    },
    tapToCopy: { kind: 'toggle', label: 'Tap to copy' },
  },
  defaults: {
    point: 'centre',
    format: 'app',
    datum: 'wgs84',
    showAccuracy: false,
    tapToCopy: true,
  },
  deps: ['camera', 'position'],
  tick: 'position',
  compute(data, params) {
    const at =
      params.point === 'you'
        ? data.position === null
          ? null
          : { p: data.position, you: true }
        : centreOrYou(data);
    if (at === null) return null;
    let p = at.p;
    let tag: string | undefined;
    if (params.datum !== 'wgs84') {
      const view = data.datums[params.datum];
      const q = view === undefined ? null : at.you ? view.you : view.centre;
      if (view !== undefined && q !== null) {
        p = q;
        tag = view.tag;
      } else {
        tag = 'WGS 84';
      }
    }
    const fmt = params.format === 'app' ? data.coordinateFormat : params.format;
    const out: StripValue = {
      glyph: at.you ? 'my_location' : 'filter_center_focus',
      value: formatCoordinate(p.latitude, p.longitude, fmt),
    };
    if (tag !== undefined) out.tag = tag;
    const acc = at.you ? data.position?.accuracyM : null;
    if (params.showAccuracy && acc != null) out.unit = formatAccuracy(acc);
    return out;
  },
  sample: { glyph: 'filter_center_focus', value: '46°48.836′N, 71°12.457′W' },
});

/**
 * Ground elevation at the map centre, from the DEM, "≈" marked (2.5.1's
 * chip). While the map follows you it is your fix's altitude, unmarked,
 * exactly as the recording panel shows it.
 */
export const ELEVATION = defineField<Record<string, never>>({
  id: 'elevation',
  label: 'Elevation',
  summary: 'Ground height at the map centre, from the terrain model',
  synonyms: ['height', 'altitude', 'dem', 'ground'],
  group: 'position',
  spaces: 1,
  params: {},
  defaults: {},
  deps: ['camera', 'elevation', 'position'],
  tick: 'cameraIdle',
  compute(data, _params, { units }) {
    const gps = data.followsUser ? data.position?.altitudeM : null;
    if (gps != null) return { glyph: 'terrain', ...splitUnit(chipAltitudeText(gps, units, 'gps')) };
    if (data.centreElevationM === null) return null;
    return {
      glyph: 'terrain',
      ...splitUnit(chipAltitudeText(data.centreElevationM, units, 'dem')),
    };
  },
  sample: { glyph: 'terrain', value: '≈212', unit: 'm' },
});

/** Your altitude from the fix (the receiver's when it is in use). */
export const ALTITUDE = defineField<Record<string, never>>({
  id: 'altitude',
  label: 'Altitude',
  summary: 'Your altitude, from the GPS fix',
  synonyms: ['height', 'elevation', 'gps'],
  group: 'position',
  spaces: 1,
  params: {},
  defaults: {},
  deps: ['position'],
  tick: 'position',
  recordingMetric: 'altitude',
  compute(data, _params, { units }) {
    const alt = data.position?.altitudeM;
    if (alt == null) return null;
    return { glyph: 'landscape', ...splitUnit(formatElevation(alt, units)) };
  },
  sample: { glyph: 'landscape', value: '412', unit: 'm' },
});

/** The fix's horizontal accuracy: "±4.0 m" phone, "±2.0 cm" RTK (sage under a metre). */
export const ACCURACY = defineField<Record<string, never>>({
  id: 'accuracy',
  label: 'GPS accuracy',
  summary: "The fix's horizontal error",
  synonyms: ['precision', 'error', 'gps', 'gnss'],
  group: 'position',
  spaces: 1,
  params: {},
  defaults: {},
  deps: ['position'],
  tick: 'position',
  compute(data) {
    const acc = data.position?.accuracyM;
    if (acc == null) return null;
    const out: StripValue = { glyph: 'gps_fixed', ...splitUnit(formatAccuracy(acc)) };
    if (acc < 1) out.tone = 'ok';
    return out;
  },
  sample: { value: '±2.0', unit: 'cm', tone: 'ok' },
});

/**
 * Magnetic declination where you are (else at the map centre), from the
 * World Magnetic Model: "−14.6°" (west negative). Amber once the date is
 * past the model's 2030.0 validity.
 */
export const DECLINATION = defineField<Record<string, never>>({
  id: 'declination',
  label: 'Magnetic declination',
  summary: 'Here, from the world magnetic model',
  synonyms: ['variation', 'magnetic', 'compass', 'wmm', 'north'],
  group: 'position',
  spaces: 1,
  params: {},
  defaults: {},
  deps: ['position', 'camera', 'clock'],
  tick: 'cameraIdle',
  compute(data) {
    const p = herePoint(data);
    if (p === null) return null;
    const m = magneticField(p.latitude, p.longitude, 0, decimalYear(data.nowMs));
    const out: StripValue = { tag: 'δ', value: signedDegrees(m.declinationDeg) };
    if (!m.inModel) out.tone = 'warn';
    return out;
  },
  sample: { tag: 'δ', value: '−14.6°' },
});
