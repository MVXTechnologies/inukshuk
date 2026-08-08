import type { LatLng } from '@core/models';
import fixture from './__fixtures__/citypage-collection.json';
import {
  citypageItemsUrl,
  MAX_FORECAST_PERIODS,
  parseCitypageCollection,
  parseCitypageFeature,
} from './forecast';

// The fixture is a trimmed capture of the real citypageweather-realtime
// response for the Québec City area (2026-08-08): two sites — Bernières
// (Lévis area, no `condition` field) and Vanier (Québec area, full record).
const QUEBEC_CITY: LatLng = { latitude: 46.8139, longitude: -71.208 };
const LEVIS: LatLng = { latitude: 46.7, longitude: -71.36 };

const bboxOf = (url: string): number[] =>
  (/bbox=([^&]+)/.exec(url)?.[1] ?? '').split(',').map(Number);

describe('citypageItemsUrl', () => {
  it('queries a bbox around the point with EN json output', () => {
    const url = citypageItemsUrl(QUEBEC_CITY);
    expect(url).toContain('citypageweather-realtime/items?');
    expect(url).toContain('f=json');
    expect(url).toContain('lang=en');
    const [minLng, minLat, maxLng, maxLat] = bboxOf(url);
    expect(minLng).toBeCloseTo(-72.208, 6);
    expect(minLat).toBeCloseTo(45.8139, 6);
    expect(maxLng).toBeCloseTo(-70.208, 6);
    expect(maxLat).toBeCloseTo(47.8139, 6);
  });

  it('clamps the bbox at the poles', () => {
    const [, minLat, , maxLat] = bboxOf(citypageItemsUrl({ latitude: 89.5, longitude: 0 }, 1));
    expect(minLat).toBeCloseTo(88.5, 6);
    expect(maxLat).toBe(90);
  });
});

describe('parseCitypageCollection', () => {
  it('picks the nearest site to the tapped point', () => {
    expect(parseCitypageCollection(fixture, QUEBEC_CITY)?.site).toBe('Vanier');
    expect(parseCitypageCollection(fixture, LEVIS)?.site).toBe('Bernières');
  });

  it('builds the full view model from a real feature', () => {
    const f = parseCitypageCollection(fixture, QUEBEC_CITY);
    expect(f).not.toBeNull();
    expect(f?.region).toBe('Québec area');
    expect(f?.updatedAtMs).toBe(Date.parse('2026-08-08T21:02:19Z'));
    expect(f?.current).toEqual({
      temperatureC: 24.1,
      condition: 'Light Rainshower',
      relativeHumidityPct: 77,
      windSummary: 'WNW 8 km/h, gusts 27',
      observedAtMs: Date.parse('2026-08-08T21:00:00Z'),
    });
    expect(f?.periods).toEqual([
      { name: 'Tonight', summary: 'Chance of showers', temperatureSummary: 'Low 19.' },
      { name: 'Sunday', summary: 'Chance of showers', temperatureSummary: 'High 27.' },
      { name: 'Sunday night', summary: 'Partly cloudy', temperatureSummary: 'Low 15.' },
    ]);
    expect(f?.distanceM).toBeGreaterThan(0);
    expect(f?.distanceM).toBeLessThan(10_000);
  });

  it('tolerates sites without a current condition (Bernières has none)', () => {
    const f = parseCitypageCollection(fixture, LEVIS);
    expect(f?.current?.condition).toBeNull();
    expect(f?.current?.temperatureC).toBe(25.5);
  });

  it.each([
    ['not an object', 42],
    ['no features', {}],
    ['empty features', { features: [] }],
    ['only unusable features', { features: [null, {}, { properties: {} }] }],
  ])('returns null for %s', (_name, json) => {
    expect(parseCitypageCollection(json, QUEBEC_CITY)).toBeNull();
  });
});

describe('parseCitypageFeature', () => {
  const minimal = (over: Record<string, unknown> = {}) => ({
    geometry: { type: 'Point', coordinates: [-71.27, 46.82] },
    properties: { name: { en: 'Vanier', fr: 'Vanier' }, ...over },
  });

  it('requires a name and point geometry', () => {
    expect(parseCitypageFeature(minimal(), QUEBEC_CITY)?.site).toBe('Vanier');
    expect(parseCitypageFeature({ properties: { name: { en: 'X' } } }, QUEBEC_CITY)).toBeNull();
    expect(
      parseCitypageFeature(
        { geometry: { coordinates: ['a', 'b'] }, properties: { name: { en: 'X' } } },
        QUEBEC_CITY,
      ),
    ).toBeNull();
  });

  it('degrades gracefully when optional sections are junk', () => {
    const f = parseCitypageFeature(
      minimal({
        lastUpdated: 'not-a-date',
        currentConditions: 'junk',
        forecastGroup: { forecasts: 'junk' },
      }),
      QUEBEC_CITY,
    );
    expect(f).toMatchObject({ site: 'Vanier', updatedAtMs: null, current: null, periods: [] });
  });

  it('drops periods without a name and caps the list', () => {
    const period = (name: string) => ({
      period: { textForecastName: { en: name, fr: name } },
      abbreviatedForecast: { textSummary: { en: 'Sunny', fr: 'Ensoleillé' } },
    });
    const f = parseCitypageFeature(
      minimal({
        forecastGroup: {
          forecasts: [
            { period: {} }, // nameless → dropped
            'junk',
            ...['A', 'B', 'C', 'D', 'E', 'F'].map(period),
          ],
        },
      }),
      QUEBEC_CITY,
    );
    expect(f?.periods.map((p) => p.name)).toEqual(
      ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, MAX_FORECAST_PERIODS),
    );
  });

  it('summarizes wind without a direction or without gusts', () => {
    const wind = (over: Record<string, unknown>) =>
      parseCitypageFeature(
        minimal({
          currentConditions: {
            wind: { speed: { value: { en: 10 }, units: { en: 'km/h' } }, ...over },
          },
        }),
        QUEBEC_CITY,
      )?.current?.windSummary;
    expect(wind({})).toBe('10 km/h');
    expect(wind({ direction: { value: { en: 'NE' } } })).toBe('NE 10 km/h');
    // A gust at or below the sustained speed is noise, not news.
    expect(wind({ gust: { value: { en: 10 } } })).toBe('10 km/h');
    expect(wind({ gust: { value: { en: 25 } } })).toBe('10 km/h, gusts 25');
  });
});
