import type { LngLat } from '@core/models';

import { failureNotice, legResultFromResponse, routeRequestBody } from './routing';

const A: LngLat = [-71.2047, 46.8119];
const B: LngLat = [-71.2125, 46.8115];

describe('routeRequestBody', () => {
  it('asks for one leg: trails → hiking trail profile, roads → walking road profile', () => {
    expect(routeRequestBody('trails', A, B)).toEqual({
      mode: 'trail',
      profile: 'hike',
      points: [A, B],
    });
    expect(routeRequestBody('roads', A, B)).toEqual({
      mode: 'road',
      profile: 'foot',
      points: [A, B],
    });
    expect(routeRequestBody('freehand', A, B)).toBeNull();
  });
});

describe('legResultFromResponse', () => {
  it('reads the LineString, dropping elevation and junk coordinates', () => {
    const body = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-71.2047, 46.8119, 66.9],
          ['x', 1],
          [-71.208, 46.811],
          [-71.2125, 46.8115],
        ],
      },
    };
    expect(legResultFromResponse(200, body)).toEqual({
      status: 'routed',
      coords: [
        [-71.2047, 46.8119],
        [-71.208, 46.811],
        [-71.2125, 46.8115],
      ],
    });
  });

  it('a 200 without a usable line is an error', () => {
    expect(legResultFromResponse(200, null)).toEqual({ status: 'failed', reason: 'error' });
    expect(legResultFromResponse(200, { geometry: { coordinates: [[0, 0]] } })).toMatchObject({
      reason: 'error',
    });
  });

  it.each([
    [422, { code: 'no_route' }, 'no_route'],
    [422, { code: 'too_long' }, 'too_long'],
    [429, { code: 'rate_limited' }, 'busy'],
    [503, { code: 'busy' }, 'busy'],
    [503, null, 'busy'],
    [502, { code: 'upstream' }, 'error'],
    [504, { code: 'timeout' }, 'error'],
    [500, 'html', 'error'],
  ])('maps %i %j to %s', (status, body, reason) => {
    expect(legResultFromResponse(status, body)).toEqual({ status: 'failed', reason });
  });
});

describe('failureNotice', () => {
  it('counts the straight legs and names one shared cause', () => {
    expect(failureNotice([])).toBeNull();
    expect(failureNotice(['offline'])).toBe('One leg drawn straight (no connection)');
    expect(failureNotice(['no_route', 'no_route'])).toBe(
      '2 legs drawn straight (no trail or road found)',
    );
    expect(failureNotice(['busy'])).toMatch(/busy/);
    expect(failureNotice(['too_long'])).toMatch(/too long/);
    expect(failureNotice(['offline', 'no_route'])).toBe('2 legs drawn straight (routing failed)');
  });
});
