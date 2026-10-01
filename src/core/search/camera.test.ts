import { cameraTargetFor } from './camera';
import type { Place } from './place';

const base: Place = {
  id: 'x',
  source: 'index',
  type: 'peak',
  name: 'X',
  latitude: 47,
  longitude: -71,
};

describe('cameraTargetFor', () => {
  it('flies to a point at the zoom that suits the type', () => {
    expect(cameraTargetFor({ ...base, type: 'city' })).toEqual({
      kind: 'point',
      center: [-71, 47],
      zoom: 12,
    });
    expect(cameraTargetFor({ ...base, type: 'village' })).toMatchObject({ zoom: 14 });
    expect(cameraTargetFor(base)).toMatchObject({ zoom: 14 });
    expect(cameraTargetFor({ ...base, type: 'campground' })).toMatchObject({ zoom: 15 });
  });

  it('frames a lake by its outline when the index knows it', () => {
    expect(cameraTargetFor({ ...base, type: 'lake', bbox: [-72.4, 48.4, -71.8, 48.9] })).toEqual({
      kind: 'bounds',
      bbox: [-72.4, 48.4, -71.8, 48.9],
    });
  });

  it('ignores an outline for point-like types', () => {
    expect(cameraTargetFor({ ...base, type: 'city', bbox: [-71.5, 46.7, -71.1, 47] }).kind).toBe(
      'point',
    );
  });

  it('flies to the point when the outline is tiny, huge or inverted', () => {
    const lake = { ...base, type: 'lake' as const };
    expect(cameraTargetFor({ ...lake, bbox: [-71, 47, -70.999, 47.001] }).kind).toBe('point');
    expect(cameraTargetFor({ ...lake, bbox: [-100, 20, -60, 60] }).kind).toBe('point');
    expect(cameraTargetFor({ ...lake, bbox: [-70, 47, -71, 47.5] }).kind).toBe('point');
  });
});
