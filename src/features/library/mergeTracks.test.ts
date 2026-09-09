import { buildGpx, parseGpx } from '@core/geo/gpx';
import type { TrackPoint, TrackSummary } from '@core/models';
import * as storage from '@data/storage';

import { mergeLibraryTracks } from './mergeTracks';

jest.mock('@data/storage', () => {
  const files = new Map<string, string>();
  let ids = 0;
  return {
    __files: files,
    newId: jest.fn(() => `id${++ids}`),
    readFileText: jest.fn(async (uri: string) => {
      const content = files.get(uri);
      if (content === undefined) throw new Error('Read denied');
      return content;
    }),
    writeTrackGpx: jest.fn((id: string, xml: string) => {
      const uri = `file:///doc/tracks/${id}.gpx`;
      files.set(uri, xml);
      return uri;
    }),
    importPhoto: jest.fn(async (source: string, id: string) => {
      const uri = `file:///doc/photos/${id}.jpg`;
      files.set(uri, `copy of ${source}`);
      return uri;
    }),
    deleteFileAt: jest.fn((uri: string) => files.delete(uri)),
  };
});

const files = (jest.requireMock('@data/storage') as { __files: Map<string, string> }).__files;
const T0 = Date.parse('2024-06-01T08:00:00Z');
const MIN = 60_000;

/** A straight ~111 m northbound leg starting at `lat`, timed from `t0`. */
function leg(lat: number, t0: number): TrackPoint[] {
  return [
    { latitude: lat, longitude: -73, time: t0 },
    { latitude: lat + 0.001, longitude: -73, time: t0 + MIN },
  ];
}

function summary(id: string, points: TrackPoint[], extra: Partial<TrackSummary> = {}) {
  const fileUri = `file:///doc/tracks/${id}.gpx`;
  files.set(fileUri, buildGpx({ points, metadata: { name: id } }));
  const s: TrackSummary = {
    id,
    name: id,
    startedAt: points[0]?.time ?? 0,
    stats: {
      distanceM: 0,
      ascentM: 0,
      descentM: 0,
      durationS: 0,
      movingTimeS: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
      pointCount: points.length,
    },
    fileUri,
    ...extra,
  };
  return s;
}

beforeEach(() => files.clear());

describe('mergeLibraryTracks (#304)', () => {
  it('seeds the sources’ notes with merged distances and copies their photos', async () => {
    // "recorded" — a live waypoint materialized as a note with a photo.
    const recorded = summary('rec', leg(45, T0), {
      notes: [
        {
          id: 'n1',
          distanceM: 30,
          text: 'cairn',
          createdAt: 1,
          photoUri: 'file:///doc/photos/orig.jpg',
        },
      ],
    });
    files.set('file:///doc/photos/orig.jpg', 'ORIGINAL');
    // "imported" — a GPX <wpt> snapped to a note at import time.
    const imported = summary('imp', leg(45.002, T0 + 60 * MIN), {
      notes: [{ id: 'n2', distanceM: 50, text: 'spring', createdAt: 1 }],
    });

    const { track, fileUri, notes } = await mergeLibraryTracks([imported, recorded]);

    const legM = track.stats.distanceM / 3;
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ text: 'cairn', photoUri: 'file:///doc/photos/id1.jpg' });
    expect(notes[0]?.distanceM).toBeCloseTo(30, 6);
    expect(notes[1]).toEqual({ text: 'spring', distanceM: expect.closeTo(2 * legM + 50, 3) });
    // The merged trail owns a COPY: the source keeps its photo, and the copy
    // is a real file the merge wrote.
    expect(storage.importPhoto).toHaveBeenCalledWith('file:///doc/photos/orig.jpg', 'id1');
    expect(files.get('file:///doc/photos/orig.jpg')).toBe('ORIGINAL');
    expect(files.get('file:///doc/photos/id1.jpg')).toBe('copy of file:///doc/photos/orig.jpg');
    expect(parseGpx(files.get(fileUri) ?? '').points).toHaveLength(4);
  });

  it('merges note-less sources to an empty seed list without touching photos', async () => {
    const { notes } = await mergeLibraryTracks([
      summary('a', leg(45, T0)),
      summary('b', leg(46, T0 + MIN)),
    ]);
    expect(notes).toEqual([]);
    expect(storage.importPhoto).not.toHaveBeenCalled();
  });

  it('removes the photo copies it made when a later copy fails, and writes no GPX', async () => {
    const a = summary('a', leg(45, T0), {
      notes: [
        { id: 'n1', distanceM: 1, text: 'ok', createdAt: 1, photoUri: 'file:///doc/photos/p1.jpg' },
        {
          id: 'n2',
          distanceM: 2,
          text: 'bad',
          createdAt: 1,
          photoUri: 'file:///doc/photos/p2.jpg',
        },
      ],
    });
    const b = summary('b', leg(46, T0 + MIN));
    jest
      .mocked(storage.importPhoto)
      .mockImplementationOnce(async () => {
        files.set('file:///doc/photos/copy1.jpg', 'copy');
        return 'file:///doc/photos/copy1.jpg';
      })
      .mockImplementationOnce(async () => {
        throw new Error('disk full');
      });

    await expect(mergeLibraryTracks([a, b])).rejects.toThrow('disk full');
    expect(storage.deleteFileAt).toHaveBeenCalledWith('file:///doc/photos/copy1.jpg');
    expect(files.has('file:///doc/photos/copy1.jpg')).toBe(false);
    expect(storage.writeTrackGpx).not.toHaveBeenCalled();
  });
});
