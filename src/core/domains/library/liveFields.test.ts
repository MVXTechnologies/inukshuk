import { MAX_INLINE_GEOMETRY } from './kinds';
import {
  areaFields,
  areaFrom,
  fitTrack,
  folderFields,
  localKindOf,
  mapFields,
  representable,
  trackFields,
  trackFrom,
  waypointFields,
  waypointFrom,
} from './liveFields';
import { validFields } from './writes';

describe('liveFields', () => {
  it('round-trips a waypoint, with what the fold accepts', () => {
    const f = waypointFields({
      label: ' Refuge ',
      latitude: 48.9213,
      longitude: -66.1879,
      note: 'Roof leaks',
      icon: 'cottage',
      color: '#E07B39',
      size: 'L',
      elevation: 892,
    });
    expect(f).toEqual({
      t: 'wpt',
      n: 'Refuge',
      ll: [-66.1879, 48.9213],
      d: 'Roof leaks',
      ic: 'cottage',
      el: 892,
      sty: { c: '#E07B39', s: 'L' },
    });
    expect(validFields('lit', f)).toBe(true);
    expect(waypointFrom(f)).toEqual({
      label: 'Refuge',
      latitude: 48.9213,
      longitude: -66.1879,
      note: 'Roof leaks',
      icon: 'cottage',
      color: '#E07B39',
      size: 'L',
      elevation: 892,
    });
  });

  it('drops what the fold would refuse instead of writing it', () => {
    const f = waypointFields({
      label: '',
      latitude: 1,
      longitude: 2,
      icon: 'Bad Icon!',
      color: 'red',
    });
    expect(f).toEqual({ t: 'wpt', n: 'Untitled', ll: [2, 1] });
    expect(validFields('lit', f)).toBe(true);
    expect(waypointFrom({ t: 'wpt', n: 'x' })).toBeUndefined();
  });

  it('round-trips an area (precision 5)', () => {
    const ring: [number, number][] = [
      [-71.2, 46.8],
      [-71.19, 46.81],
      [-71.18, 46.8],
    ];
    const f = areaFields({ name: 'Bleuetière', ring, color: '#6E9F32', note: 'Private' });
    expect(validFields('lit', f)).toBe(true);
    const a = areaFrom(f, '#000000')!;
    expect(a.name).toBe('Bleuetière');
    expect(a.color).toBe('#6E9F32');
    expect(a.note).toBe('Private');
    expect(a.ring).toHaveLength(3);
    a.ring.forEach(([lng, lat], i) => {
      expect(lng).toBeCloseTo(ring[i]![0], 5);
      expect(lat).toBeCloseTo(ring[i]![1], 5);
    });
    expect(areaFrom({ t: 'area', n: 'x' }, '#000000')).toBeUndefined();
  });

  it('fits a long trail by simplifying it, and gives up past the last step', () => {
    // A 1 Hz walk of 20 000 fixes wobbling ~1 m: far over the cap unsimplified.
    const pts = Array.from({ length: 20_000 }, (_, i) => ({
      latitude: 46.8 + i * 0.00001 + (i % 2 ? 0.000004 : 0),
      longitude: -71.2 + i * 0.00001,
    }));
    const g = fitTrack(pts)!;
    expect(g.length).toBeLessThanOrEqual(MAX_INLINE_GEOMETRY);
    const f = trackFields({ name: 'Walk', points: pts });
    expect(validFields('lit', f)).toBe(true);
    expect(trackFrom(f)!.points.length).toBeGreaterThan(1);
    // Noise far above every tolerance: no simplification fits it.
    const noisy = Array.from({ length: 20_000 }, (_, i) => ({
      latitude: 46.8 + (i % 2 ? 0.01 : 0),
      longitude: -71.2 + i * 0.001,
    }));
    expect(fitTrack(noisy)).toBeUndefined();
    expect(trackFields({ name: 'Noise', points: noisy })).toEqual({ t: 'trk', n: 'Noise' });
    expect(fitTrack([{ latitude: 1, longitude: 1 }])).toBeUndefined();
  });

  it('writes a catalog map by its id only, an imported PDF by its name', () => {
    expect(mapFields({ name: 'Rivière du Berger', sourceItemId: 'cpa-berger' })).toEqual({
      t: 'map',
      n: 'Rivière du Berger',
      cat: 'cpa-berger',
    });
    expect(mapFields({ name: 'Mont-Albert' })).toEqual({ t: 'map', n: 'Mont-Albert' });
    expect(representable({ t: 'map', n: 'x', cat: 'cpa-berger' })).toBe(false);
  });

  it('names local kinds, and knows what it can hold', () => {
    expect(localKindOf({ t: 'trk' })).toBe('track');
    expect(localKindOf({ t: 'wpt' })).toBe('waypoint');
    expect(localKindOf({ t: 'area' })).toBe('area');
    expect(localKindOf({ t: 'map' })).toBe('map');
    expect(localKindOf({ t: 'boat' })).toBeUndefined();
    expect(representable({ t: 'trk', n: 'x' })).toBe(false);
    expect(representable({ t: 'boat', n: 'x' })).toBe(false);
    expect(folderFields({ name: '  Gaspésie ' })).toEqual({ n: 'Gaspésie' });
  });
});
