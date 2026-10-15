import { formatDistance, METRIC as METRIC_UNITS } from '@core/format';
import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import { declinationAt } from '@core/geo/wmm';

import { cursorSubject } from '../cursor';
import { splitUnit } from '../format';
import { placeholderValue, sampleValue } from '../preview';
import { spokenField } from '../subject';
import { fix, IMPERIAL, METRIC, NOW, QC, snapshot } from '../testUtils';
import type { StripCursor } from '../types';
import { CURSOR_BEARING, CURSOR_DISTANCE } from './cursor';

/** The cursor 1.2 km south-east of you. */
const CURSOR: StripCursor = {
  point: { latitude: 46.8055, longitude: -71.1975 },
  kind: 'reticle',
  color: '#D32F2F',
  halo: true,
};
const SUBJECT = cursorSubject(CURSOR);
const live = (over = {}) => snapshot({ position: fix(), cursor: CURSOR, ...over });
const pad3 = (deg: number) => String(Math.round(deg)).padStart(3, '0');

describe('bearing to cursor', () => {
  const trueDeg = initialBearingDeg(QC, CURSOR.point);

  it('from you to the cursor, true by default, magnetic on request', () => {
    expect(CURSOR_BEARING.compute(live(), CURSOR_BEARING.defaults, METRIC)).toEqual({
      glyph: 'explore',
      value: `${pad3(trueDeg)}°`,
      unit: 'SE',
      subject: SUBJECT,
    });
    const m = CURSOR_BEARING.compute(live(), { reference: 'magnetic' }, METRIC);
    expect(m?.value).toBe(`${pad3(trueDeg - declinationAt(QC.latitude, QC.longitude, NOW))}°M`);
  });

  it('steps aside with no fix or no cursor showing', () => {
    const p = CURSOR_BEARING.defaults;
    expect(CURSOR_BEARING.compute(live({ position: null }), p, METRIC)).toBeNull();
    expect(CURSOR_BEARING.compute(live({ cursor: null }), p, METRIC)).toBeNull();
  });

  it('reads "Bearing to cursor: 142° SE"', () => {
    const v = { glyph: 'explore', value: '142°', unit: 'SE', subject: SUBJECT };
    expect(spokenField(CURSOR_BEARING, v)).toBe('Bearing to cursor: 142° SE');
  });
});

describe('distance to cursor', () => {
  const m = haversineMeters(QC, CURSOR.point);

  it('a straight line from you, through the units formatter', () => {
    expect(CURSOR_DISTANCE.compute(live(), CURSOR_DISTANCE.defaults, METRIC)).toEqual({
      ...splitUnit(formatDistance(m, METRIC_UNITS)),
      subject: SUBJECT,
    });
    expect(CURSOR_DISTANCE.compute(live(), CURSOR_DISTANCE.defaults, IMPERIAL)?.unit).toBe('mi');
    expect(CURSOR_DISTANCE.compute(live(), { unit: 'nmi' }, METRIC)?.unit).toBe('NM');
  });

  it('steps aside with no fix or no cursor showing', () => {
    const p = CURSOR_DISTANCE.defaults;
    expect(CURSOR_DISTANCE.compute(live({ position: null }), p, METRIC)).toBeNull();
    expect(CURSOR_DISTANCE.compute(live({ cursor: null }), p, METRIC)).toBeNull();
  });

  it('reads "Distance to cursor: 1.2 km"', () => {
    const v = { value: '1.2', unit: 'km', subject: SUBJECT };
    expect(spokenField(CURSOR_DISTANCE, v)).toBe('Distance to cursor: 1.2 km');
  });
});

describe('in the editor', () => {
  it('"—" with no live value; samples name the cursor in the user units', () => {
    expect(placeholderValue(CURSOR_DISTANCE)).toEqual({ glyph: 'straighten', value: '—' });
    expect(placeholderValue(CURSOR_BEARING)).toEqual({ glyph: 'explore', value: '—' });
    expect(sampleValue(CURSOR_DISTANCE, IMPERIAL.units)).toMatchObject({
      unit: 'mi',
      subject: { key: 'cursor', name: 'Cursor' },
    });
    expect(sampleValue(CURSOR_BEARING, METRIC.units).subject?.key).toBe('cursor');
  });
});
