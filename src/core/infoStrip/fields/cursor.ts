/**
 * Cursor fields (owner, 2.6.x): the bearing and the distance from your fix
 * to the point the centre cursor marks, live while you pan (`../cursor`).
 * Like a target field without a target, they step aside with no fix or no
 * cursor showing ("—" in the editor).
 */
import { distanceUnitLabel, formatDistance } from '@core/format';
import { haversineMeters } from '@core/geo/geomath';

import { CURSOR_SUBJECT, cursorSubject } from '../cursor';
import { formatDistanceIn, splitUnit, type DistanceUnit } from '../format';
import { bearingFromYou } from './bearing';
import { defineField, REFERENCE_PARAM, type NorthReference } from './define';

const CURSOR_DEPS = ['position', 'cursor'] as const;

export type CursorBearingParams = { reference: NorthReference };

/** From you to the cursor: the initial great-circle bearing, true or magnetic (as the target's). */
export const CURSOR_BEARING = defineField<CursorBearingParams>({
  id: 'cursorBearing',
  label: 'Bearing to cursor',
  spokenTo: 'Bearing to',
  summary: 'From you to the centre cursor, as you pan',
  synonyms: ['direction', 'azimuth', 'crosshair', 'reticle', 'centre', 'center', 'aim'],
  group: 'navigation',
  spaces: 1,
  params: { reference: REFERENCE_PARAM },
  defaults: { reference: 'true' },
  deps: CURSOR_DEPS,
  tick: 'camera10Hz',
  compute(data, params) {
    const c = data.cursor;
    if (c === null || data.position === null) return null;
    // "—" with the cursor on you (inside your fix's error, or a few metres).
    return {
      glyph: 'explore',
      ...bearingFromYou(data, data.position, c.point, params.reference),
      subject: cursorSubject(c),
    };
  },
  sample: { glyph: 'explore', value: '142°', unit: 'SE', subject: CURSOR_SUBJECT },
});

export type CursorDistanceParams = { unit: DistanceUnit };

/** From you to the cursor, in a straight line. */
export const CURSOR_DISTANCE = defineField<CursorDistanceParams>({
  id: 'cursorDistance',
  label: 'Distance to cursor',
  spokenTo: 'Distance to',
  summary: 'Straight line from you to the centre cursor, as you pan',
  synonyms: ['range', 'far', 'crosshair', 'reticle', 'centre', 'center', 'measure'],
  group: 'navigation',
  spaces: 1,
  params: {
    unit: {
      kind: 'choice',
      label: 'Units',
      options: [
        { value: 'app', label: 'App units' },
        { value: 'km', label: distanceUnitLabel('km') },
        { value: 'mi', label: distanceUnitLabel('mi') },
        { value: 'nmi', label: distanceUnitLabel('nmi') },
      ],
    },
  },
  defaults: { unit: 'app' },
  deps: CURSOR_DEPS,
  tick: 'camera10Hz',
  compute(data, params, ctx) {
    const c = data.cursor;
    if (c === null || data.position === null) return null;
    const m = haversineMeters(data.position, c.point);
    return { ...splitUnit(formatDistanceIn(m, params.unit, ctx.units)), subject: cursorSubject(c) };
  },
  sample: { value: '1.20', unit: 'km', subject: CURSOR_SUBJECT },
  sampleIn: (units) => ({ ...splitUnit(formatDistance(1200, units)), subject: CURSOR_SUBJECT }),
  placeholder: { glyph: 'straighten' },
});
