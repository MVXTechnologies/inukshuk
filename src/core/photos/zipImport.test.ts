import type { GpxWaypoint } from '@core/geo/gpx';

import {
  DEFAULT_ZIP_PHOTO_LIMITS,
  planZipPhotoAttach,
  waypointsForNotes,
  zipPhotoCandidate,
  zipPhotoCaption,
} from './zipImport';

const wpt = (name: string, href?: string, extra: Partial<GpxWaypoint> = {}): GpxWaypoint => ({
  latitude: 47.6,
  longitude: -70.6,
  name,
  ...(href ? { type: 'photo', link: { href } } : {}),
  ...extra,
});

const entries = [
  { name: 'Lac.gpx', uncompressedSize: 9_000 },
  { name: 'photos/a.jpg', uncompressedSize: 600_000 },
  { name: 'photos/b.jpg', uncompressedSize: 700_000 },
  { name: 'photos/huge.jpg', uncompressedSize: 90 * 1024 * 1024 },
];

describe('planZipPhotoAttach', () => {
  it('pairs photo waypoints with entries, by lookup only', () => {
    const water = wpt('Water');
    const a = wpt('Lac des Cygnes appears', 'photos/a.jpg', { time: 1000 });
    const b = wpt('Photo 2', './photos/b.jpg');
    const remote = wpt('Remote', 'https://example.com/x.jpg');
    const missing = wpt('Missing', 'photos/none.jpg');
    const plan = planZipPhotoAttach([water, a, b, remote, missing], entries);
    expect(plan.attach.map((x) => [x.key, x.entryName])).toEqual([
      ['zip-0', 'photos/a.jpg'],
      ['zip-1', 'photos/b.jpg'],
    ]);
    expect(plan.attach[0]!.declaredBytes).toBe(600_000);
    expect([...plan.photoWaypoints]).toEqual([a, b]);
    expect(waypointsForNotes([water, a, b, remote, missing], plan.photoWaypoints)).toEqual([
      water,
      remote,
      missing,
    ]);
  });

  it('skips photos over the size cap and past the count cap', () => {
    const wpts = [
      wpt('A', 'photos/a.jpg'),
      wpt('Huge', 'photos/huge.jpg'),
      wpt('B', 'photos/b.jpg'),
    ];
    const plan = planZipPhotoAttach(wpts, entries, { ...DEFAULT_ZIP_PHOTO_LIMITS, maxPhotos: 1 });
    expect(plan.attach.map((x) => x.entryName)).toEqual(['photos/a.jpg']);
    expect(plan).toMatchObject({ tooBig: 1, overCount: 1 });
    // The skipped ones are still photos, not notes.
    expect(plan.photoWaypoints.size).toBe(3);
  });

  it('attaches an entry linked twice only once', () => {
    const plan = planZipPhotoAttach(
      [wpt('A', 'photos/a.jpg'), wpt('A again', 'photos/A.JPG')],
      entries,
    );
    expect(plan.attach).toHaveLength(1);
  });
});

describe('zip photo candidates and captions', () => {
  it('places by the waypoint time and position', () => {
    const [attach] = planZipPhotoAttach([wpt('A', 'photos/a.jpg', { time: 5 })], entries).attach;
    expect(zipPhotoCandidate(attach!)).toEqual({ key: 'zip-0', lngLat: [-70.6, 47.6], takenAt: 5 });
    const [timeless] = planZipPhotoAttach([wpt('A', 'photos/a.jpg')], entries).attach;
    expect(zipPhotoCandidate(timeless!)).not.toHaveProperty('takenAt');
  });

  it('keeps real captions and drops the generic "Photo N"', () => {
    expect(zipPhotoCaption(wpt('Lac des Cygnes appears'))).toBe('Lac des Cygnes appears');
    expect(zipPhotoCaption(wpt('Photo 12'))).toBeUndefined();
    expect(zipPhotoCaption(wpt('  '))).toBeUndefined();
    expect(zipPhotoCaption({ latitude: 0, longitude: 0 })).toBeUndefined();
  });
});
