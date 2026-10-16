import {
  areaFields,
  areaFrom,
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

  it('writes a whole trail: revision, part count and type; it comes back exact', () => {
    const points = Array.from({ length: 5_000 }, (_, i) => ({
      latitude: Math.round((46.8 + i * 0.0000123) * 1e7) / 1e7,
      longitude: Math.round((-71.2 + i * 0.0000171) * 1e7) / 1e7,
      altitude: Math.round((50 + Math.sin(i / 40) * 12) * 100) / 100,
      time: 1_790_000_000_000 + i * 1000,
    }));
    const { fields, encoded } = trackFields('t1', {
      name: 'Run',
      points,
      segmentStarts: [2_500],
      category: 'run',
    });
    expect(fields).toMatchObject({ t: 'trk', n: 'Run', ty: 'run', tc: 3 });
    expect(validFields('lit', fields)).toBe(true);
    const back = trackFrom(fields, encoded)!;
    expect(back.category).toBe('run');
    expect(back.segmentStarts).toEqual([2_500]);
    expect(back.points).toEqual(points);
    expect(trackFrom(fields, undefined)).toBeUndefined();
    // A custom type stays on its phone; an empty trail is written by name only.
    expect(trackFields('t2', { name: 'X', points, category: 'custom-123' }).fields['ty']).toBe(
      undefined,
    );
    expect(trackFields('t3', { name: 'Empty', points: [] })).toEqual({
      fields: { t: 'trk', n: 'Empty' },
    });
    expect(representable(fields)).toBe(false);
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
