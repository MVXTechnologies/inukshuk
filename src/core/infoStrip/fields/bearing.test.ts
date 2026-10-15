import { cursorSubject } from '../cursor';
import { fix, METRIC, QC, snapshot } from '../testUtils';
import type { StripCursor } from '../types';
import { bearingFloorM, bearingFromYou, MIN_BEARING_M } from './bearing';
import { CURSOR_BEARING } from './cursor';
import { TARGET_BEARING } from './navigation';

/** A point `m` metres from Québec City, due south-east (flat-earth: metres apart). */
const away = (m: number) => {
  const d = m * Math.SQRT1_2;
  const perDegLat = 111_320;
  const perDegLon = perDegLat * Math.cos((QC.latitude * Math.PI) / 180);
  return { latitude: QC.latitude - d / perDegLat, longitude: QC.longitude + d / perDegLon };
};

describe('bearingFloorM: no direction to a point you stand on', () => {
  it('3 m, or the fix accuracy when worse', () => {
    expect(bearingFloorM({ accuracyM: null })).toBe(MIN_BEARING_M);
    expect(bearingFloorM({ accuracyM: 1 })).toBe(MIN_BEARING_M);
    expect(bearingFloorM({ accuracyM: 12 })).toBe(12);
    expect(bearingFloorM({ accuracyM: Number.NaN })).toBe(MIN_BEARING_M);
  });
});

describe('bearingFromYou', () => {
  const data = snapshot();

  it('"—" inside the floor, the bearing past it', () => {
    expect(bearingFromYou(data, fix({ accuracyM: null }), QC, 'true')).toEqual({ value: '—' });
    expect(bearingFromYou(data, fix({ accuracyM: null }), away(2.5), 'true')).toEqual({
      value: '—',
    });
    expect(bearingFromYou(data, fix({ accuracyM: null }), away(4), 'true')).toEqual({
      value: '135°',
      unit: 'SE',
    });
    // A 20 m fix: 15 m away is still inside its error circle.
    expect(bearingFromYou(data, fix({ accuracyM: 20 }), away(15), 'true').value).toBe('—');
    expect(bearingFromYou(data, fix({ accuracyM: 20 }), away(25), 'true').value).toBe('135°');
  });

  it('magnetic too (the declination where you are)', () => {
    const here = snapshot({ position: fix() });
    expect(bearingFromYou(here, fix(), QC, 'magnetic')).toEqual({ value: '—' });
    expect(bearingFromYou(here, fix(), away(500), 'magnetic').value).toMatch(/^\d{3}°M$/);
  });
});

describe('the bearing fields keep their place, with "—", on top of their target', () => {
  it('bearing to cursor with the cursor on you (QA 2.6.1: "143° SE" beside "0 ft")', () => {
    const cursor: StripCursor = { point: QC, kind: 'dot', color: '#1E252C', halo: true };
    const data = snapshot({ position: fix(), cursor });
    expect(CURSOR_BEARING.compute(data, CURSOR_BEARING.defaults, METRIC)).toEqual({
      glyph: 'explore',
      value: '—',
      subject: cursorSubject(cursor),
    });
    const far = snapshot({ position: fix(), cursor: { ...cursor, point: away(300) } });
    expect(CURSOR_BEARING.compute(far, CURSOR_BEARING.defaults, METRIC)?.value).toBe('135°');
  });

  it('bearing to target standing at the target', () => {
    const data = snapshot({ position: fix(), navTarget: { name: 'Camp lac', point: away(2) } });
    expect(TARGET_BEARING.compute(data, TARGET_BEARING.defaults, METRIC)).toMatchObject({
      glyph: 'explore',
      value: '—',
      subject: { name: 'Camp lac' },
    });
  });
});
