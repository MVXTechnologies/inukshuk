import { formatClockTime } from '@core/format';
import { declinationAt } from '@core/geo/wmm';
import { sunTimes } from '@core/sun/sunTimes';

import { fix, IMPERIAL, METRIC, NOW, QC, snapshot } from '../testUtils';
import { stripNeeds } from '../deps';
import { HEADING, northAs, SPEED, SUNSET } from './motion';

describe('speed', () => {
  it('speed over ground, in the app units', () => {
    const data = snapshot({ position: fix({ speedMps: 1 }) });
    expect(SPEED.compute(data, { style: 'speed' }, METRIC)).toEqual({
      glyph: 'speed',
      value: '3.6',
      unit: 'km/h',
    });
    expect(SPEED.compute(data, { style: 'speed' }, IMPERIAL)?.unit).toBe('mph');
  });

  it('SOG style for paddling', () => {
    const data = snapshot({ position: fix({ speedMps: 1.4444 }) });
    expect(SPEED.compute(data, { style: 'sog' }, METRIC)).toEqual({
      glyph: 'sailing',
      tag: 'SOG',
      value: '5.2',
      unit: 'km/h',
    });
  });

  it('"—" when the fix has no speed; out without a fix', () => {
    expect(
      SPEED.compute(snapshot({ position: fix({ speedMps: null }) }), SPEED.defaults, METRIC),
    ).toEqual({ glyph: 'speed', value: '—' });
    expect(SPEED.compute(snapshot(), SPEED.defaults, METRIC)).toBeNull();
  });

  it('"—" for an invalid speed (iOS reports −1), never "0.0"', () => {
    for (const bad of [-1, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        SPEED.compute(snapshot({ position: fix({ speedMps: bad }) }), SPEED.defaults, METRIC),
      ).toEqual({ glyph: 'speed', value: '—' });
    }
    expect(
      SPEED.compute(snapshot({ position: fix({ speedMps: -1 }) }), { style: 'sog' }, METRIC),
    ).toEqual({ glyph: 'sailing', tag: 'SOG', value: '—' });
    // Standing still is a real 0.
    expect(
      SPEED.compute(snapshot({ position: fix({ speedMps: 0 }) }), SPEED.defaults, METRIC)?.value,
    ).toBe('0.0');
  });
});

describe('heading', () => {
  const moving = { speedMps: 1.2, courseDeg: 28 };

  it('the compass, true north', () => {
    expect(HEADING.compute(snapshot({ headingDeg: 340 }), HEADING.defaults, METRIC)).toEqual({
      glyph: 'navigation',
      value: '340°',
      unit: 'N',
    });
  });

  it('magnetic: true minus the declination here', () => {
    const data = snapshot({ headingDeg: 340, centre: QC });
    const mag = 340 - declinationAt(QC.latitude, QC.longitude, NOW);
    expect(HEADING.compute(data, { source: 'compass', reference: 'magnetic' }, METRIC)).toEqual({
      glyph: 'navigation',
      value: `${String(Math.round(mag) % 360).padStart(3, '0')}°M`,
      unit: 'N',
    });
    // Nowhere to compute a declination: stays true, honestly unmarked.
    expect(
      HEADING.compute(
        snapshot({ headingDeg: 340 }),
        { source: 'compass', reference: 'magnetic' },
        METRIC,
      )?.value,
    ).toBe('340°');
  });

  describe('a compass reading on magnetic north (the OS had no fix to correct it)', () => {
    const decl = declinationAt(QC.latitude, QC.longitude, NOW);
    const pad = (d: number) => String(Math.round((d + 360) % 360) % 360).padStart(3, '0');

    it('true wanted: magnetic plus the declination, unmarked', () => {
      const data = snapshot({ headingDeg: 340, headingReference: 'magnetic', centre: QC });
      expect(HEADING.compute(data, HEADING.defaults, METRIC)?.value).toBe(`${pad(340 + decl)}°`);
    });

    it('magnetic wanted: the reading as it is, "°M"', () => {
      const data = snapshot({ headingDeg: 340, headingReference: 'magnetic', centre: QC });
      expect(
        HEADING.compute(data, { source: 'compass', reference: 'magnetic' }, METRIC)?.value,
      ).toBe('340°M');
    });

    it('no declination to convert with: says "°M" rather than pass for true', () => {
      const data = snapshot({ headingDeg: 340, headingReference: 'magnetic' });
      expect(HEADING.compute(data, HEADING.defaults, METRIC)?.value).toBe('340°M');
    });

    it('a true reading is unchanged by the flag (and the course is always true)', () => {
      const data = snapshot({ headingDeg: 340, headingReference: 'true', centre: QC });
      expect(HEADING.compute(data, HEADING.defaults, METRIC)?.value).toBe('340°');
      const cog = snapshot({
        headingReference: 'magnetic',
        course: moving,
        centre: QC,
      });
      expect(HEADING.compute(cog, HEADING.defaults, METRIC)).toMatchObject({
        tag: 'COG',
        value: '028°',
      });
    });

    it('northAs: both ways, and no conversion without a declination', () => {
      expect(northAs(10, 'true', 'true', -14)).toEqual({ deg: 10, magnetic: false });
      expect(northAs(10, 'magnetic', 'magnetic', -14)).toEqual({ deg: 10, magnetic: true });
      expect(northAs(10, 'true', 'magnetic', -14).deg).toBeCloseTo(24);
      expect(northAs(24, 'magnetic', 'true', -14).deg).toBeCloseTo(10);
      expect(northAs(10, 'true', 'magnetic', null)).toEqual({ deg: 10, magnetic: false });
    });
  });

  it('subscribes to the compass only on the compass source', () => {
    const compass = stripNeeds([[{ field: 'heading', params: HEADING.defaults }]]);
    expect(compass.deps.has('heading')).toBe(true);
    const course = stripNeeds([
      [{ field: 'heading', params: { source: 'course', reference: 'true' } }],
    ]);
    expect(course.deps.has('heading')).toBe(false);
    expect(course.deps.has('course')).toBe(true);
  });

  it('no magnetometer: the course over ground, tagged COG, above 0.5 m/s', () => {
    expect(HEADING.compute(snapshot({ course: moving }), HEADING.defaults, METRIC)).toEqual({
      glyph: 'navigation',
      tag: 'COG',
      value: '028°',
      unit: 'NE',
    });
    expect(
      HEADING.compute(
        snapshot({ course: { speedMps: 0.2, courseDeg: 28 } }),
        HEADING.defaults,
        METRIC,
      ),
    ).toEqual({ value: '—' });
    expect(HEADING.compute(snapshot(), HEADING.defaults, METRIC)).toEqual({ value: '—' });
  });

  it('course source: COG even with a compass', () => {
    const p = { source: 'course', reference: 'true' } as const;
    expect(HEADING.compute(snapshot({ headingDeg: 340, course: moving }), p, METRIC)).toMatchObject(
      {
        tag: 'COG',
        value: '028°',
      },
    );
    expect(HEADING.compute(snapshot({ headingDeg: 340 }), p, METRIC)).toEqual({
      tag: 'COG',
      value: '—',
    });
  });
});

describe('sunset', () => {
  it("today's sunset here, clock time", () => {
    const { sunset } = sunTimes(NOW, QC.latitude, QC.longitude);
    expect(SUNSET.compute(snapshot({ centre: QC }), {}, METRIC)).toEqual({
      glyph: 'wb_twilight',
      value: formatClockTime(sunset!),
    });
  });

  it('"—" in the polar night, out with no place', () => {
    const dec = Date.UTC(2026, 11, 21, 12);
    expect(
      SUNSET.compute(
        snapshot({ nowMs: dec, centre: { latitude: 78.2, longitude: 15.6 } }),
        {},
        METRIC,
      )?.value,
    ).toBe('—');
    expect(SUNSET.compute(snapshot(), {}, METRIC)).toBeNull();
  });
});
