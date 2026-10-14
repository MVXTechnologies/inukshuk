import { declinationAt } from '@core/geo/wmm';

import { fix, IMPERIAL, METRIC, NOW, QC, snapshot } from '../testUtils';
import type { DatumView } from '../types';
import {
  ACCURACY,
  ALTITUDE,
  COORDS,
  DECLINATION,
  declinationHere,
  ELEVATION,
  herePoint,
  type CoordsParams,
} from './position';

const P = (over: Partial<CoordsParams> = {}): CoordsParams => ({ ...COORDS.defaults, ...over });
const YOU = { latitude: 46.81211, longitude: -71.20903 };

describe('coords', () => {
  it('shows the map centre in the Settings format (2.5.1)', () => {
    expect(COORDS.compute(snapshot({ centre: QC }), P(), METRIC)).toEqual({
      glyph: 'filter_center_focus',
      value: '46.81394, -71.20761',
    });
    expect(
      COORDS.compute(snapshot({ centre: QC, coordinateFormat: 'mgrs' }), P(), METRIC)?.value,
    ).toMatch(/^19T /);
  });

  it('uses its own format when set (DDM, the owner reference)', () => {
    expect(COORDS.compute(snapshot({ centre: QC }), P({ format: 'ddm' }), METRIC)?.value).toBe(
      '46°48.836′N, 71°12.457′W',
    );
  });

  it('is you while the map follows you, with your glyph', () => {
    const data = snapshot({ centre: QC, followsUser: true, position: fix(YOU) });
    expect(COORDS.compute(data, P(), METRIC)).toEqual({
      glyph: 'my_location',
      value: '46.81211, -71.20903',
    });
  });

  it('point "you" needs a fix', () => {
    expect(COORDS.compute(snapshot({ centre: QC }), P({ point: 'you' }), METRIC)).toBeNull();
    expect(
      COORDS.compute(snapshot({ position: fix(YOU) }), P({ point: 'you' }), METRIC)?.glyph,
    ).toBe('my_location');
  });

  it('has nothing to show before the first camera settle', () => {
    expect(COORDS.compute(snapshot(), P(), METRIC)).toBeNull();
  });

  it('shows the accuracy for you, never for the centre', () => {
    const data = snapshot({ centre: QC, position: fix({ ...YOU, accuracyM: 0.02 }) });
    expect(COORDS.compute(data, P({ point: 'you', showAccuracy: true }), METRIC)?.unit).toBe(
      '±2.0 cm',
    );
    expect(COORDS.compute(data, P({ showAccuracy: true }), METRIC)?.unit).toBeUndefined();
    const noAcc = snapshot({ position: fix({ accuracyM: null }) });
    expect(
      COORDS.compute(noAcc, P({ point: 'you', showAccuracy: true }), METRIC)?.unit,
    ).toBeUndefined();
  });

  it("shows another datum's conversion with its tag, or WGS 84 tagged as such", () => {
    const csrs: DatumView = {
      label: 'NAD83(CSRS) 2010.0',
      tag: 'CSRS',
      centre: { latitude: 46.813935, longitude: -71.207595 },
      you: null,
    };
    const data = snapshot({ centre: QC, position: fix(YOU), datums: { csrs } });
    expect(COORDS.compute(data, P({ datum: 'csrs', format: 'dd' }), METRIC)).toEqual({
      glyph: 'filter_center_focus',
      tag: 'CSRS',
      value: '46.81394, -71.20759',
    });
    // No conversion for you: the WGS 84 value, never under the CSRS name.
    expect(COORDS.compute(data, P({ datum: 'csrs', point: 'you' }), METRIC)?.tag).toBe('WGS 84');
    // No project datum view at all.
    expect(COORDS.compute(data, P({ datum: 'project' }), METRIC)?.tag).toBe('WGS 84');
  });
});

describe('elevation', () => {
  it("is the centre's DEM value, ≈ marked", () => {
    const data = snapshot({ centre: QC, centreElevationM: 211.6 });
    expect(ELEVATION.compute(data, {}, METRIC)).toEqual({
      glyph: 'terrain',
      value: '≈212',
      unit: 'm',
    });
    expect(ELEVATION.compute(data, {}, IMPERIAL)?.unit).toBe('ft');
  });

  it("is your fix's altitude, unmarked, while the map follows you", () => {
    const data = snapshot({
      centreElevationM: 211.6,
      followsUser: true,
      position: fix({ altitudeM: 412.4 }),
    });
    expect(ELEVATION.compute(data, {}, METRIC)).toEqual({
      glyph: 'terrain',
      value: '412',
      unit: 'm',
    });
  });

  it('falls back to the DEM when the fix has no altitude, else leaves out', () => {
    const data = snapshot({ followsUser: true, position: fix({ altitudeM: null }) });
    expect(ELEVATION.compute(data, {}, METRIC)).toBeNull();
    expect(ELEVATION.compute({ ...data, centreElevationM: 10 }, {}, METRIC)?.value).toBe('≈10');
  });
});

describe('altitude', () => {
  it("is your fix's altitude", () => {
    expect(ALTITUDE.compute(snapshot({ position: fix() }), {}, METRIC)).toEqual({
      glyph: 'landscape',
      value: '212',
      unit: 'm',
    });
    expect(
      ALTITUDE.compute(snapshot({ position: fix({ altitudeM: null }) }), {}, METRIC),
    ).toBeNull();
    expect(ALTITUDE.compute(snapshot(), {}, METRIC)).toBeNull();
  });
});

describe('accuracy', () => {
  it('reads the fix accuracy; sage under a metre', () => {
    expect(ACCURACY.compute(snapshot({ position: fix({ accuracyM: 4 }) }), {}, METRIC)).toEqual({
      glyph: 'gps_fixed',
      value: '±4.0',
      unit: 'm',
    });
    expect(
      ACCURACY.compute(snapshot({ position: fix({ accuracyM: 0.02 }) }), {}, METRIC),
    ).toMatchObject({ value: '±2.0', unit: 'cm', tone: 'ok' });
    expect(
      ACCURACY.compute(snapshot({ position: fix({ accuracyM: null }) }), {}, METRIC),
    ).toBeNull();
  });
});

describe('declination', () => {
  it('is the WMM value here, west negative', () => {
    const v = DECLINATION.compute(snapshot({ position: fix() }), {}, METRIC);
    const expected = declinationAt(QC.latitude, QC.longitude, NOW);
    expect(v?.tag).toBe('δ');
    expect(v?.value).toBe(`−${Math.abs(expected).toFixed(1)}°`);
    expect(v?.tone).toBeUndefined();
  });

  it('uses the map centre without a fix, and nothing with neither', () => {
    expect(DECLINATION.compute(snapshot({ centre: QC }), {}, METRIC)?.value).toMatch(/^−1\d\.\d°$/);
    expect(DECLINATION.compute(snapshot(), {}, METRIC)).toBeNull();
  });

  it('turns amber once the model has expired (after 2030.0)', () => {
    const data = snapshot({ centre: QC, nowMs: Date.UTC(2031, 0, 1) });
    expect(DECLINATION.compute(data, {}, METRIC)?.tone).toBe('warn');
  });

  it('helpers: here is you first, then the centre', () => {
    expect(herePoint(snapshot({ centre: QC, position: fix(YOU) }))).toMatchObject(YOU);
    expect(herePoint(snapshot({ centre: QC }))).toBe(QC);
    expect(declinationHere(snapshot())).toBeNull();
    expect(declinationHere(snapshot({ centre: QC }))).toBeCloseTo(
      declinationAt(QC.latitude, QC.longitude, NOW),
    );
  });
});
