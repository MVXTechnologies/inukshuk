import { IMPERIAL, METRIC, NAUTICAL } from '@core/format';
import { WEATHER_LAYERS } from '@core/geo/weatherLayers';
import {
  compareCellText,
  compareUnitLabel,
  DEFAULT_WEATHER_MODEL,
  isWeatherModelId,
  modelCapabilitiesUrl,
  modelCaption,
  modelVariableForLayer,
  resolveModelWmsLayer,
  sanitizeWeatherModel,
  WEATHER_MODELS,
  weatherModelById,
} from './weatherModels';

describe('weather model catalog', () => {
  it('ships exactly the three launch models, HRDPS first (the default)', () => {
    expect(WEATHER_MODELS.map((m) => m.id)).toEqual(['hrdps', 'rdps', 'gdps']);
    expect(DEFAULT_WEATHER_MODEL).toBe('hrdps');
  });

  it('keeps labels regex-metacharacter-free (Maestro matchers are regexes)', () => {
    for (const m of WEATHER_MODELS) {
      expect(m.label).toMatch(/^[\w .-]+$/);
    }
  });

  it('resolves HRDPS drapes to the catalog ids verbatim (wind = the M3 speed gradient)', () => {
    // Temp/precip stay byte-identical to shipped M1 behaviour; wind swapped
    // to the scalar speed ramp for the particle underlay (M3, owner spec:
    // smooth gradient, no arrows).
    expect(resolveModelWmsLayer('temp', 'hrdps')).toBe('HRDPS.CONTINENTAL_TT');
    expect(resolveModelWmsLayer('wind', 'hrdps')).toBe('HRDPS.CONTINENTAL_WSPD');
    expect(resolveModelWmsLayer('precip', 'hrdps')).toBe('HRDPS.CONTINENTAL_PR');
  });

  it('resolves RDPS/GDPS to the live new-scheme ids (verified 2026-08-09)', () => {
    expect(resolveModelWmsLayer('temp', 'rdps')).toBe('RDPS_10km_AirTemp_2m');
    expect(resolveModelWmsLayer('wind', 'rdps')).toBe('RDPS_10km_WindSpeed_10m');
    expect(resolveModelWmsLayer('precip', 'rdps')).toBe('RDPS_10km_Precip-Accum');
    expect(resolveModelWmsLayer('temp', 'gdps')).toBe('GDPS_15km_AirTemp_2m');
    expect(resolveModelWmsLayer('wind', 'gdps')).toBe('GDPS_15km_WindSpeed_10m');
    expect(resolveModelWmsLayer('precip', 'gdps')).toBe('GDPS_15km_Precip-Accum');
  });

  it('keeps radar layers model-less: every model resolves them to the catalog id', () => {
    for (const m of WEATHER_MODELS) {
      expect(resolveModelWmsLayer('radar-rain', m.id)).toBe('RADAR_1KM_RRAI');
      expect(resolveModelWmsLayer('radar-snow', m.id)).toBe('RADAR_1KM_RSNO');
    }
  });

  it('maps every catalog layer to a variable or explicitly to none', () => {
    for (const l of WEATHER_LAYERS) {
      const v = modelVariableForLayer(l.id);
      if (l.timeline === 'forecast') expect(v).not.toBeNull();
      else expect(v).toBeNull();
    }
  });

  it('queries comparable table variables: scalar wind speed and 1 h precip accumulation', () => {
    // Total accumulation is NOT comparable across horizons; the table must
    // use the interval accumulation, and wind the scalar m/s layer.
    expect(weatherModelById('hrdps').info.wind).toBe('HRDPS.CONTINENTAL_WSPD');
    expect(weatherModelById('hrdps').info.precip).toBe('HRDPS.CONTINENTAL.DIAG_PR_PT1H');
    expect(weatherModelById('rdps').info.precip).toBe('RDPS_10km_Precip-Accum1h');
    expect(weatherModelById('gdps').info.precip).toBe('GDPS_15km_Precip-Accum1h');
  });

  it('encodes the GDPS cadence change and the per-model horizons', () => {
    expect(weatherModelById('hrdps')).toMatchObject({ horizonHours: 48, cadenceChangeHours: null });
    expect(weatherModelById('rdps')).toMatchObject({ horizonHours: 84, cadenceChangeHours: null });
    expect(weatherModelById('gdps')).toMatchObject({
      horizonHours: 240,
      cadenceChangeHours: 84,
      stepHoursAfterChange: 3,
    });
  });
});

describe('sanitizeWeatherModel', () => {
  it('passes valid ids through', () => {
    expect(sanitizeWeatherModel('gdps')).toBe('gdps');
    expect(isWeatherModelId('rdps')).toBe(true);
  });

  it.each([[null], [undefined], [42], ['ecmwf'], [{ id: 'hrdps' }], [['hrdps']]])(
    'collapses junk %p to the HRDPS default',
    (junk) => {
      expect(sanitizeWeatherModel(junk)).toBe(DEFAULT_WEATHER_MODEL);
    },
  );
});

describe('model URL builders', () => {
  it('scopes capabilities to the resolved model layer', () => {
    expect(modelCapabilitiesUrl('temp', 'gdps')).toContain('layer=GDPS_15km_AirTemp_2m');
    expect(modelCapabilitiesUrl('radar-rain', 'gdps')).toContain('layer=RADAR_1KM_RRAI');
  });
});

describe('modelCaption', () => {
  it('reads like the Windy subscript, e.g. "2.5 km · 48 h"', () => {
    expect(modelCaption(weatherModelById('hrdps'))).toBe('2.5 km · 48 h');
    expect(modelCaption(weatherModelById('gdps'))).toBe('15 km · 10 d');
  });
});

describe('compareCellText / compareUnitLabel', () => {
  it('formats temperature in whole degrees, both unit systems', () => {
    expect(compareCellText('temp', 20.805811, METRIC)).toBe('21°');
    expect(compareCellText('temp', 0, IMPERIAL)).toBe('32°');
    expect(compareUnitLabel('temp', METRIC)).toBe('°C');
    expect(compareUnitLabel('temp', IMPERIAL)).toBe('°F');
  });

  it('converts wind m/s to whole km/h or mph', () => {
    expect(compareCellText('wind', 5, METRIC)).toBe('18');
    expect(compareCellText('wind', 5, IMPERIAL)).toBe('11');
    expect(compareUnitLabel('wind', METRIC)).toBe('km/h');
    expect(compareUnitLabel('wind', IMPERIAL)).toBe('mph');
  });

  it('follows the distance unit to knots, and keeps °F to miles + feet (#702)', () => {
    expect(compareCellText('wind', 5, NAUTICAL)).toBe('10');
    expect(compareUnitLabel('wind', NAUTICAL)).toBe('kn');
    expect(compareCellText('temp', 0, { distance: 'mi', elevation: 'm' })).toBe('0°');
    expect(compareUnitLabel('temp', NAUTICAL)).toBe('°C');
  });

  it('keeps precip in mm with one decimal, zero-flooring drizzle noise', () => {
    expect(compareCellText('precip', 0.04, METRIC)).toBe('0');
    expect(compareCellText('precip', 0.449, IMPERIAL)).toBe('0.4');
    expect(compareCellText('precip', 12.06, METRIC)).toBe('12.1');
    expect(compareUnitLabel('precip', IMPERIAL)).toBe('mm');
  });
});
