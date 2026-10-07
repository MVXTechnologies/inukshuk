import { buildGpx, parseGpx } from '@core/geo/gpx';
import { buildImportedTrack } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import * as storage from '@data/storage';

import { overwriteWithTrim } from './trimTrack';

jest.mock('@data/storage', () => {
  const files = new Map<string, string>();
  return {
    __files: files,
    newId: () => 'revision',
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
    deleteFileAt: jest.fn((uri: string) => files.delete(uri)),
  };
});

jest.mock('@data/photos/sidecarStore', () => ({ readWritableSidecar: jest.fn(async () => ({})) }));
jest.mock('@data/photos/trailPhotos', () => ({ onTrailTrimmed: jest.fn(async () => 2) }));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
const sidecars = jest.requireMock('@data/photos/sidecarStore') as {
  readWritableSidecar: jest.Mock;
};
const trailPhotos = jest.requireMock('@data/photos/trailPhotos') as { onTrailTrimmed: jest.Mock };

const files = (jest.requireMock('@data/storage') as { __files: Map<string, string> }).__files;
const points: TrackPoint[] = [0, 1, 2, 3].map((i) => ({
  latitude: 45 + i / 1000,
  longitude: -73,
  time: 1000 + i * 60000,
}));
const original = buildGpx({ points, waypoints: [{ latitude: 45, longitude: -73, name: 'Water' }] });
const summary: TrackSummary = {
  ...buildImportedTrack({
    id: 'original',
    points,
    name: 'Trip',
    fallbackName: 'Trip',
    fallbackTime: 1,
  }),
  fileUri: 'file:///doc/tracks/original.gpx',
  notes: [
    {
      id: 'dropped',
      distanceM: 0,
      text: 'Start',
      createdAt: 1,
      photoUri: 'file:///doc/photos/start.jpg',
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  files.clear();
  files.set(summary.fileUri, original);
  files.set('file:///doc/photos/start.jpg', 'photo');
});

it('preserves the original GPX and dropped photos if metadata cannot be saved', async () => {
  const commit = jest.fn(() => {
    throw new Error('Index full');
  });
  await expect(overwriteWithTrim(summary, points, 1, 2, commit)).rejects.toThrow('Index full');
  expect(files.get(summary.fileUri)).toBe(original);
  expect(files.get('file:///doc/photos/start.jpg')).toBe('photo');
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
  // A failed index promotion can still leave a recoverable index stage using this revision.
  expect(parseGpx(files.get('file:///doc/tracks/revision.gpx') ?? '').points).toHaveLength(2);
});

it('commits the new revision before removing old assets and preserves source waypoints', async () => {
  let published: Partial<TrackSummary> | undefined;
  const result = await overwriteWithTrim(summary, points, 1, 2, (patch) => {
    expect(files.get(summary.fileUri)).toBe(original);
    expect(files.get('file:///doc/photos/start.jpg')).toBe('photo');
    expect(parseGpx(files.get(patch.fileUri) ?? '').points).toHaveLength(2);
    published = patch;
  });
  expect(published?.fileUri).toBe('file:///doc/tracks/revision.gpx');
  expect(result.patch).toEqual(published);
  expect(files.has(summary.fileUri)).toBe(false);
  expect(files.has('file:///doc/photos/start.jpg')).toBe(false);
  expect(parseGpx(files.get(result.patch.fileUri) ?? '').waypoints[0]?.name).toBe('Water');
});

it('does not replace an unreadable source and silently discard its waypoints', async () => {
  files.delete(summary.fileUri);
  const commit = jest.fn();
  await expect(overwriteWithTrim(summary, points, 1, 2, commit)).rejects.toThrow('Read denied');
  expect(commit).not.toHaveBeenCalled();
  expect(storage.writeTrackGpx).not.toHaveBeenCalled();
});

it('retains the committed revision if old-file cleanup fails', async () => {
  jest.mocked(storage.deleteFileAt).mockImplementationOnce(() => {
    throw new Error('Delete denied');
  });
  const commit = jest.fn();
  await expect(overwriteWithTrim(summary, points, 1, 2, commit)).resolves.toMatchObject({
    patch: { fileUri: 'file:///doc/tracks/revision.gpx' },
  });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(files.has('file:///doc/tracks/revision.gpx')).toBe(true);
});

it('waits for an asynchronous metadata commit before deleting the original', async () => {
  let finishCommit: () => void = () => {};
  let beginCommit: () => void = () => {};
  const begun = new Promise<void>((resolve) => {
    beginCommit = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finishCommit = resolve;
  });
  const saving = overwriteWithTrim(summary, points, 1, 2, () => {
    beginCommit();
    return pending;
  });
  await begun;
  expect(files.get(summary.fileUri)).toBe(original);
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
  finishCommit();
  await saving;
  expect(files.has(summary.fileUri)).toBe(false);
});

it('does not publish metadata or delete assets when writing the new revision fails', async () => {
  jest.mocked(storage.writeTrackGpx).mockImplementationOnce(() => {
    throw new Error('ENOSPC');
  });
  const commit = jest.fn();
  await expect(overwriteWithTrim(summary, points, 1, 2, commit)).rejects.toThrow('ENOSPC');
  expect(commit).not.toHaveBeenCalled();
  expect(files.get(summary.fileUri)).toBe(original);
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
});

describe('trail photos (#587)', () => {
  it('moves the photos with the trim, after the commit', async () => {
    const commit = jest.fn();
    const result = await overwriteWithTrim(summary, points, 1, 2, commit);
    expect(result.photosRemoved).toBe(2);
    const [id, startM, endM, kept] = trailPhotos.onTrailTrimmed.mock.calls[0] as [
      string,
      number,
      number,
      TrackPoint[],
    ];
    expect(id).toBe('original');
    // Points are ~111 m apart: the kept window is [111, 222] m of the old trail.
    expect(startM).toBeCloseTo(111.2, 0);
    expect(endM).toBeCloseTo(222.4, 0);
    expect(kept).toHaveLength(2);
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
      trailPhotos.onTrailTrimmed.mock.invocationCallOrder[0]!,
    );
  });

  it('blocks the trim before any change when the photo list cannot be rewritten', async () => {
    sidecars.readWritableSidecar.mockRejectedValueOnce(new Error('newer version'));
    const commit = jest.fn();
    await expect(overwriteWithTrim(summary, points, 1, 2, commit)).rejects.toThrow(
      'newer version',
    );
    expect(storage.writeTrackGpx).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps a committed trim when moving the photos fails', async () => {
    trailPhotos.onTrailTrimmed.mockRejectedValueOnce(new Error('io'));
    const result = await overwriteWithTrim(summary, points, 1, 2, jest.fn());
    expect(result).toMatchObject({ photosRemoved: 0, patch: { fileUri: expect.any(String) } });
  });
});
