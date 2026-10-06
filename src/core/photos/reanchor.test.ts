import { lineTrack, offset, T0 } from './__fixtures__/tracks';
import type { TrackPhoto } from './model';
import { reanchorAfterTrim, reanchorOnTrail } from './reanchor';
import { indexTrack } from './trackIndex';

const photo = (id: string, distanceM: number, extra: Partial<TrackPhoto> = {}): TrackPhoto => ({
  id,
  trackId: 'old',
  distanceM,
  lngLat: offset(distanceM),
  elevationM: 500 + distanceM * 0.1,
  placement: 'time',
  file: `photos/old/${id}.jpg`,
  thumb: `photos/old/${id}.sq.jpg`,
  sprite: `photos/old/${id}.map.png`,
  width: 1,
  height: 1,
  bytes: 1,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe('reanchorAfterTrim', () => {
  it('drops photos on the cut ends and shifts the rest onto the trimmed trail', () => {
    // Keep 200–700 m of a 1000 m trail: the trimmed trail starts at the old 200 m.
    const trimmed = indexTrack(lineTrack({ lengthM: 1000 }).slice(20, 71));
    const photos = [
      photo('a', 100),
      photo('b', 200),
      photo('c', 450),
      photo('d', 700.3),
      photo('e', 800),
      photo('x', 900, { deletedAt: 5 }),
    ];
    const { kept, removed } = reanchorAfterTrim(photos, 200, 700, trimmed, 42);
    expect(removed.map((p) => p.id)).toEqual(['a', 'e']);
    expect(kept.map((p) => p.id)).toEqual(['b', 'c', 'd', 'x']);
    const c = kept[1]!;
    expect(c.distanceM).toBeCloseTo(250, 3);
    expect(c.lngLat[0]).toBeCloseTo(offset(450)[0], 7);
    expect(c.elevationM).toBeCloseTo(545, 3);
    expect(c.updatedAt).toBe(42);
    expect(kept[3]).toBe(photos[5]); // tombstones ride along untouched
  });
});

describe('reanchorOnTrail', () => {
  // The merged trail: the same 1000 m walk, but starting 10 min earlier from 300 m further west.
  const merged = indexTrack(
    lineTrack({ lengthM: 1300, startTime: T0 - 300_000 }).map((p, i) => ({
      ...p,
      longitude: offset(i * 10 - 300)[0],
    })),
  );

  it('re-places by time when the new trail covers it', () => {
    const [p] = reanchorOnTrail([photo('t', 400, { takenAt: T0 + 400_000 })], merged, 'new', 7);
    expect(p!.trackId).toBe('new');
    expect(p!.distanceM).toBeCloseTo(700, 0);
    expect(p!.updatedAt).toBe(7);
  });

  it('then by its on-trail position, then at the old distance', () => {
    const [gps, kept, clamped, gone] = reanchorOnTrail(
      [
        photo('g', 400, { placement: 'gps', lngLat: offset(400, 10) }),
        photo('m', 400, { placement: 'manual' }),
        photo('far', 5000, { placement: 'manual' }),
        photo('dead', 1, { deletedAt: 3 }),
      ],
      merged,
      'new',
      7,
    );
    expect(gps!.distanceM).toBeCloseTo(700, 0);
    expect(kept!.distanceM).toBeCloseTo(400, 3);
    expect(clamped!.distanceM).toBeCloseTo(1300, 0);
    expect(gone).toEqual({ ...photo('dead', 1, { deletedAt: 3 }), trackId: 'new' });
  });

  it('uses the position of a capture as its GPS, and falls through when time is not covered', () => {
    const [cap] = reanchorOnTrail(
      [photo('c', 50, { placement: 'capture', takenAt: T0 + 99 * 3_600_000, lngLat: offset(500) })],
      merged,
      'new',
      1,
    );
    expect(cap!.distanceM).toBeCloseTo(800, 0);
  });

  it('re-places a time-placed photo by position when the new trail misses its time', () => {
    const [p] = reanchorOnTrail(
      [photo('t', 50, { takenAt: T0 + 99 * 3_600_000, lngLat: offset(500) })],
      merged,
      'new',
      1,
    );
    expect(p!.distanceM).toBeCloseTo(800, 0);
  });

  it('drops elevation when the new trail has none', () => {
    const flat = indexTrack(lineTrack({ lengthM: 500 }).map(({ altitude: _a, ...p }) => p));
    const [p] = reanchorOnTrail([photo('m', 100, { placement: 'manual' })], flat, 'new', 1);
    expect(p).not.toHaveProperty('elevationM');
  });

  it('leaves a photo alone on an empty trail', () => {
    const p = photo('m', 100, { placement: 'manual' });
    expect(reanchorOnTrail([p], indexTrack([]), 'new', 1)[0]).toEqual({ ...p, trackId: 'new' });
  });
});
