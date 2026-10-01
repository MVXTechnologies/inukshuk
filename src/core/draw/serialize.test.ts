import { parseGpx } from '@core/geo/gpx';
import type { Area, LngLat } from '@core/models';

import {
  areaFileStem,
  areasToGeoJson,
  areaToFeature,
  closedCcwRing,
  plannedRouteGpx,
  plannedRoutePoints,
  sanitizeRoutePlan,
  sanitizeVertices,
} from './serialize';

const SAMPLES: LngLat[] = [
  [-71.21, 46.81],
  [-71.2, 46.815],
  [-71.19, 46.82],
];

describe('plannedRoutePoints / plannedRouteGpx', () => {
  it('makes untimed points with DEM elevation where known', () => {
    const points = plannedRoutePoints(SAMPLES, [100, undefined, 130.5]);
    expect(points).toEqual([
      { latitude: 46.81, longitude: -71.21, time: 0, hasTime: false, altitude: 100 },
      { latitude: 46.815, longitude: -71.2, time: 0, hasTime: false },
      { latitude: 46.82, longitude: -71.19, time: 0, hasTime: false, altitude: 130.5 },
    ]);
  });

  it('round-trips through GPX as an untimed <trk> (the imported-route shape)', () => {
    const xml = plannedRouteGpx('Montmorency loop', plannedRoutePoints(SAMPLES, [100, 110, 120]));
    expect(xml).toContain('<trk>');
    expect(xml).not.toContain('<time>');
    const doc = parseGpx(xml);
    expect(doc.metadata.name).toBe('Montmorency loop');
    expect(doc.points).toHaveLength(3);
    expect(doc.points.every((p) => p.hasTime === false)).toBe(true);
    expect(doc.points.map((p) => p.altitude)).toEqual([100, 110, 120]);
  });

  it('without elevations the points carry none', () => {
    expect(plannedRoutePoints(SAMPLES).every((p) => p.altitude === undefined)).toBe(true);
  });
});

describe('sanitizeVertices / sanitizeRoutePlan', () => {
  it('keeps only finite, in-range [lng, lat] pairs', () => {
    expect(
      sanitizeVertices([[-71, 46], [200, 0], ['a', 1], [1], null, [0, 91], [-71.1, 46.1, 9]]),
    ).toEqual([
      [-71, 46],
      [-71.1, 46.1],
    ]);
    expect(sanitizeVertices('junk')).toEqual([]);
  });

  it('a plan needs two vertices', () => {
    expect(sanitizeRoutePlan({ mode: 'freehand', vertices: SAMPLES })).toEqual({
      mode: 'freehand',
      vertices: SAMPLES,
    });
    expect(sanitizeRoutePlan({ vertices: [SAMPLES[0]] })).toBeNull();
    expect(sanitizeRoutePlan(null)).toBeNull();
    expect(sanitizeRoutePlan('x')).toBeNull();
  });
});

const AREA: Area = {
  id: 'a1',
  name: 'Blueberry slope',
  // Clockwise (north, then east, then south): export must flip it.
  ring: [
    [-71.2, 46.8],
    [-71.2, 46.81],
    [-71.19, 46.81],
    [-71.19, 46.8],
  ],
  color: '#2563EB',
  note: '  Lots of wild blueberries mid-August.  ',
  tags: ['Berries'],
  createdAt: Date.UTC(2026, 9, 1),
};

describe('areaToFeature / areasToGeoJson', () => {
  it('exports a closed counter-clockwise polygon with its properties', () => {
    const f = areaToFeature(AREA);
    expect(f.type).toBe('Feature');
    expect(f.id).toBe('a1');
    const ring = f.geometry.coordinates[0]!;
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(ring[1]).toEqual([-71.19, 46.81]); // reversed to CCW
    expect(f.properties).toMatchObject({
      name: 'Blueberry slope',
      note: 'Lots of wild blueberries mid-August.',
      color: '#2563EB',
      tags: ['Berries'],
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    expect(f.properties.areaM2).toBeGreaterThan(800_000);
    expect(f.properties.perimeterM).toBeGreaterThan(3_000);
  });

  it('leaves out an empty note and empty tags', () => {
    const f = areaToFeature({ ...AREA, note: '   ', tags: [] });
    expect(f.properties.note).toBeUndefined();
    expect(f.properties.tags).toBeUndefined();
  });

  it('a counter-clockwise ring is kept as drawn', () => {
    const ccw: LngLat[] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    expect(closedCcwRing(ccw)).toEqual([...ccw, [0, 0]]);
    expect(closedCcwRing([])).toEqual([]);
  });

  it('a FeatureCollection of every area', () => {
    const fc = JSON.parse(areasToGeoJson([AREA, { ...AREA, id: 'a2' }])) as {
      type: string;
      features: { id: string }[];
    };
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.map((f) => f.id)).toEqual(['a1', 'a2']);
  });
});

describe('areaFileStem', () => {
  it('makes a file-name-safe stem', () => {
    expect(areaFileStem('Blueberry slope')).toBe('Blueberry_slope');
    expect(areaFileStem('Côte/Nord')).toBe('C_te_Nord');
    expect(areaFileStem('...')).toBe('area');
    expect(areaFileStem('')).toBe('area');
  });
});
