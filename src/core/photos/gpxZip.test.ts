import { buildGpx, parseGpx } from '@core/geo/gpx';

import { lineTrack, T0 } from './__fixtures__/tracks';
import {
  gpxWithPhotoWaypoints,
  linkedPhotos,
  PHOTO_WPT_TYPE,
  photoWaypoints,
  planTrailPhotoZip,
  zipPhotoPath,
} from './gpxZip';
import type { TrackPhoto } from './model';

const photo = (
  id: string,
  takenAt: number | undefined,
  extra: Partial<TrackPhoto> = {},
): TrackPhoto => ({
  id,
  trackId: 't1',
  distanceM: 100,
  lngLat: [-70.6, 47.6],
  placement: 'time',
  ...(takenAt === undefined ? {} : { takenAt }),
  file: `photos/t1/${id}.jpg`,
  thumb: `photos/t1/${id}.sq.jpg`,
  sprite: `photos/t1/${id}.map.png`,
  width: 2048,
  height: 1536,
  bytes: 1,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

const photos = [
  photo('late', T0 + 2000, { caption: 'Summit' }),
  photo('early', T0 + 1000),
  photo('hidden', T0, { hidden: true }),
  photo('gone', T0, { deletedAt: 1 }),
  photo('notime', undefined, { distanceM: 900 }),
  // A trail note's photo seen through noteToPhoto: the user's own, unstripped file.
  photo('note:n1', T0 + 1500, { file: 'photos/n1.jpg', caption: 'Note' }),
];

describe('photoWaypoints', () => {
  it('one photo waypoint per visible photo, in time order', () => {
    const w = photoWaypoints(photos);
    expect(w.map((x) => x.name)).toEqual(['Photo 1', 'Summit', 'Photo 3']);
    expect(w[1]).toEqual({
      latitude: 47.6,
      longitude: -70.6,
      name: 'Summit',
      time: T0 + 2000,
      type: PHOTO_WPT_TYPE,
      link: { href: 'photos/late.jpg', mimeType: 'image/jpeg', text: 'Summit' },
    });
    expect(w[2]).not.toHaveProperty('time');
  });
});

describe('gpxWithPhotoWaypoints', () => {
  const gpx = buildGpx({
    points: lineTrack({ lengthM: 100 }),
    metadata: { name: 'Mont du Lac des Cygnes' },
    waypoints: [{ latitude: 47.6, longitude: -70.6, name: 'Parking', symbol: 'Parking Area' }],
    segmentStarts: [5],
  });

  it('adds the photo waypoints and keeps the trail, segments and other waypoints', () => {
    const out = parseGpx(gpxWithPhotoWaypoints(gpx, photos));
    expect(out.points).toHaveLength(11);
    expect(out.segmentStarts).toEqual([5]);
    expect(out.metadata.name).toBe('Mont du Lac des Cygnes');
    expect(out.waypoints.map((w) => w.name)).toEqual(['Parking', 'Photo 1', 'Summit', 'Photo 3']);
    expect(out.waypoints[2]!.link).toEqual({
      href: 'photos/late.jpg',
      mimeType: 'image/jpeg',
      text: 'Summit',
    });
    expect(out.waypoints[2]!.type).toBe('photo');
  });

  it('replaces photo waypoints from an earlier export instead of doubling them', () => {
    const twice = gpxWithPhotoWaypoints(gpxWithPhotoWaypoints(gpx, photos), photos.slice(0, 1));
    expect(parseGpx(twice).waypoints.map((w) => w.name)).toEqual(['Parking', 'Summit']);
  });
});

describe('planTrailPhotoZip', () => {
  it('never ships a trail-note photo (unstripped, and `note:` is no file name)', () => {
    const plan = planTrailPhotoZip('T', photos);
    expect(plan.entries.map((e) => e.photoId)).not.toContain('note:n1');
    expect(plan.entries.some((e) => e.zipPath.includes(':'))).toBe(false);
    expect(photoWaypoints(photos).map((w) => w.name)).not.toContain('Note');
  });

  it('names the archive after the trail and lists the copies to store', () => {
    const plan = planTrailPhotoZip('Mont du Lac des Cygnes', photos);
    expect(plan.zipName).toBe('Mont du Lac des Cygnes.zip');
    expect(plan.gpxName).toBe('Mont du Lac des Cygnes.gpx');
    expect(plan.entries).toEqual([
      { zipPath: 'photos/early.jpg', sourcePath: 'photos/t1/early.jpg', photoId: 'early' },
      { zipPath: 'photos/late.jpg', sourcePath: 'photos/t1/late.jpg', photoId: 'late' },
      { zipPath: 'photos/notime.jpg', sourcePath: 'photos/t1/notime.jpg', photoId: 'notime' },
    ]);
  });

  it('makes a safe name from anything', () => {
    expect(planTrailPhotoZip('Côte/Nord: day 1.gpx', []).zipName).toBe('Côte-Nord- day 1.zip');
    expect(planTrailPhotoZip('..hidden\u0007', []).zipName).toBe('hidden.zip');
    expect(planTrailPhotoZip('   ', []).zipName).toBe('Trail.zip');
    expect(zipPhotoPath({ id: 'x' })).toBe('photos/x.jpg');
  });
});

describe('linkedPhotos', () => {
  const doc = {
    waypoints: [
      { latitude: 1, longitude: 2, name: 'a', link: { href: './photos/A.jpg' } },
      { latitude: 1, longitude: 2, name: 'b', link: { href: '/photos/b%20c.JPG' } },
      { latitude: 1, longitude: 2, name: 'remote', link: { href: 'https://example.com/x.jpg' } },
      { latitude: 1, longitude: 2, name: 'missing', link: { href: 'photos/none.jpg' } },
      { latitude: 1, longitude: 2, name: 'nolink' },
      { latitude: 1, longitude: 2, name: 'win', link: { href: 'photos\\d.jpg' } },
      { latitude: 1, longitude: 2, name: 'bad-escape', link: { href: 'photos/%E0%A4%A.jpg' } },
    ],
  };
  const entries = [
    'Trail.gpx',
    'photos/a.jpg',
    'photos/b c.jpg',
    'photos/d.jpg',
    'photos/%E0%A4%A.jpg',
    'notes.txt',
  ];

  it('pairs relative links with image entries, tolerant of spelling', () => {
    expect(linkedPhotos(doc, entries).map((l) => [l.waypoint.name, l.entryName])).toEqual([
      ['a', 'photos/a.jpg'],
      ['b', 'photos/b c.jpg'],
      ['win', 'photos/d.jpg'],
      ['bad-escape', 'photos/%E0%A4%A.jpg'],
    ]);
  });
});
