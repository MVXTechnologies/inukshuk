import { legKey, legMidpointHandles, legViews, type LegResult } from '@core/draw/legs';
import type { LngLat } from '@core/models';

import { drawShapeGeoJson } from './DrawLayers';

jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: () => null,
  Layer: () => null,
}));

const A: LngLat = [-71.2047, 46.8119];
const B: LngLat = [-71.2125, 46.8115];
const C: LngLat = [-71.2141, 46.8088];

type Feature = { properties: Record<string, unknown>; geometry: { coordinates: unknown } };

describe('drawShapeGeoJson with legs (#515)', () => {
  it('draws one line per leg, tagged with its state, and a warning dot on a failed leg', () => {
    const results = new Map<string, LegResult>([
      [legKey('trails', A, B), { status: 'routed', coords: [A, [-71.208, 46.813], B] }],
      [legKey('roads', B, C), { status: 'failed', reason: 'offline' }],
    ]);
    const legs = legViews([A, B, C], ['trails', 'roads'], results);
    const mids = legMidpointHandles(legs);
    const { features } = drawShapeGeoJson('route', [A, B, C], null, legs, mids) as {
      features: Feature[];
    };
    const lines = features.filter((f) => f.properties.role === 'line');
    expect(lines.map((f) => f.properties.leg)).toEqual(['routed', 'failed']);
    expect(lines[0]?.geometry.coordinates).toHaveLength(3);
    expect(features.filter((f) => f.properties.role === 'warn')).toHaveLength(1);
    // The insert handles are the ones given (on the drawn legs).
    const handles = features.filter((f) => f.properties.role === 'mid');
    expect(handles.map((f) => f.geometry.coordinates)).toEqual(mids.map((m) => [m.at[0], m.at[1]]));
    expect(features.filter((f) => f.properties.role === 'vertex')).toHaveLength(3);
  });

  it('without legs, a route is one straight line', () => {
    const { features } = drawShapeGeoJson('route', [A, B, C]) as { features: Feature[] };
    const lines = features.filter((f) => f.properties.role === 'line');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.properties.leg).toBe('straight');
  });
});
