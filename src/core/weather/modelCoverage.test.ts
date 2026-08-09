import {
  coversPoint,
  HRDPS_COVERAGE,
  MODEL_COVERAGE,
  normalizeLongitude,
  radarAvailableAt,
  RDPS_COVERAGE,
  resolveEffectiveModel,
} from './modelCoverage';

const QUEBEC = { latitude: 46.813, longitude: -71.208 };
const BOSTON = { latitude: 42.36, longitude: -71.06 }; // New England — inside everything
const MEXICO_CITY = { latitude: 19.43, longitude: -99.13 }; // south of HRDPS, inside RDPS
const PARIS = { latitude: 48.86, longitude: 2.35 };
const TOKYO = { latitude: 35.68, longitude: 139.69 };

describe('normalizeLongitude', () => {
  it('leaves in-range longitudes alone', () => {
    expect(normalizeLongitude(-71.2)).toBeCloseTo(-71.2);
    expect(normalizeLongitude(179.9)).toBeCloseTo(179.9);
  });

  it('wraps longitudes past the antimeridian (MapLibre pans can exceed ±180)', () => {
    expect(normalizeLongitude(-431.2)).toBeCloseTo(-71.2); // -360 - 71.2
    expect(normalizeLongitude(288.8)).toBeCloseTo(-71.2); // 360 - 71.2
    expect(normalizeLongitude(180)).toBe(-180);
    expect(normalizeLongitude(360)).toBe(0);
  });
});

describe('coversPoint', () => {
  it('a null bbox covers everywhere (the global-model convention)', () => {
    expect(coversPoint(null, TOKYO)).toBe(true);
  });

  it('includes interior points and the exact edges', () => {
    expect(coversPoint(HRDPS_COVERAGE, QUEBEC)).toBe(true);
    expect(coversPoint(HRDPS_COVERAGE, { latitude: HRDPS_COVERAGE.south, longitude: -100 })).toBe(
      true,
    );
    expect(coversPoint(HRDPS_COVERAGE, { latitude: 50, longitude: HRDPS_COVERAGE.west })).toBe(
      true,
    );
  });

  it('excludes points beyond any edge', () => {
    expect(coversPoint(HRDPS_COVERAGE, MEXICO_CITY)).toBe(false); // south of the domain
    expect(coversPoint(HRDPS_COVERAGE, PARIS)).toBe(false);
    expect(coversPoint(RDPS_COVERAGE, PARIS)).toBe(false);
    expect(coversPoint(RDPS_COVERAGE, TOKYO)).toBe(false);
  });

  it('handles wrapped longitudes', () => {
    expect(coversPoint(HRDPS_COVERAGE, { latitude: 46.8, longitude: -71.2 + 360 })).toBe(true);
  });
});

describe('the coverage catalog', () => {
  it('marks GDPS global and the regional models bounded', () => {
    expect(MODEL_COVERAGE.gdps).toBeNull();
    expect(MODEL_COVERAGE.hrdps).not.toBeNull();
    expect(MODEL_COVERAGE.rdps).not.toBeNull();
  });

  it('RDPS reaches farther south than HRDPS (Mexico City is the seam case)', () => {
    expect(coversPoint(MODEL_COVERAGE.rdps, MEXICO_CITY)).toBe(true);
    expect(coversPoint(MODEL_COVERAGE.hrdps, MEXICO_CITY)).toBe(false);
  });
});

describe('resolveEffectiveModel', () => {
  it('keeps the selection inside its domain — Québec/New England stay HRDPS', () => {
    expect(resolveEffectiveModel('hrdps', QUEBEC)).toEqual({ model: 'hrdps', fallback: false });
    expect(resolveEffectiveModel('hrdps', BOSTON)).toEqual({ model: 'hrdps', fallback: false });
    expect(resolveEffectiveModel('rdps', MEXICO_CITY)).toEqual({ model: 'rdps', fallback: false });
  });

  it('falls back to GDPS outside the selected domain (the Windy worldwide fix)', () => {
    expect(resolveEffectiveModel('hrdps', PARIS)).toEqual({ model: 'gdps', fallback: true });
    expect(resolveEffectiveModel('hrdps', MEXICO_CITY)).toEqual({ model: 'gdps', fallback: true });
    expect(resolveEffectiveModel('rdps', TOKYO)).toEqual({ model: 'gdps', fallback: true });
  });

  it('never flags GDPS itself — it is global', () => {
    expect(resolveEffectiveModel('gdps', TOKYO)).toEqual({ model: 'gdps', fallback: false });
    expect(resolveEffectiveModel('gdps', null)).toEqual({ model: 'gdps', fallback: false });
  });

  it('never switches blind: an unknown centre keeps the selection', () => {
    expect(resolveEffectiveModel('hrdps', null)).toEqual({ model: 'hrdps', fallback: false });
  });
});

describe('radarAvailableAt', () => {
  it('is available across the North American composite', () => {
    expect(radarAvailableAt(QUEBEC)).toBe(true);
    expect(radarAvailableAt(BOSTON)).toBe(true);
  });

  it('is unavailable outside it', () => {
    expect(radarAvailableAt(PARIS)).toBe(false);
    expect(radarAvailableAt(TOKYO)).toBe(false);
  });

  it('gives an unknown centre the benefit of the doubt (no hint flash at launch)', () => {
    expect(radarAvailableAt(null)).toBe(true);
  });
});
