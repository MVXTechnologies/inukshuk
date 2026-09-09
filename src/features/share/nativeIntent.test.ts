import { buildGpx, parseGpx, type GpxWaypoint } from '@core/geo/gpx';
import { buildImportedTrack, snapWaypointsToNotes } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import { importGpxFromUri } from '@features/library/importGpx';
import { useLibraryStore } from '@state/libraryStore';

import { redirectSystemPath } from '../../../app/+native-intent';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));
jest.mock('@lib/strava', () => ({ handleStravaAuthRedirect: () => false }));
jest.mock('@state/importFeedbackStore', () => ({
  useImportFeedbackStore: { getState: () => ({ show: jest.fn() }) },
}));
jest.mock('@state/libraryStore', () => ({ useLibraryStore: { getState: jest.fn() } }));
jest.mock('@features/library/importGpx', () => ({ importGpxFromUri: jest.fn() }));
jest.mock('@data/storage', () => ({ readFileText: jest.fn(), deleteFileAt: jest.fn() }));

const points: TrackPoint[] = [0, 1].map((i) => ({
  latitude: 45 + i / 1000,
  longitude: -73,
  time: 1000 + i * 60000,
}));
const xml = (pts = points, waypoints: GpxWaypoint[] = []) =>
  buildGpx({ points: pts, metadata: { name: 'Daily walk' }, waypoints });
const files = new Map<string, string>();
const addTrack = jest.fn();
let saved: TrackSummary;

beforeEach(() => {
  jest.resetAllMocks();
  files.clear();
  const track = buildImportedTrack({
    id: 'saved',
    points,
    name: 'Daily walk',
    fallbackName: 'Daily walk',
    fallbackTime: 1,
  });
  saved = { ...track, fileUri: 'file:///doc/tracks/saved.gpx' };
  files.set(saved.fileUri, xml());
  jest.mocked(useLibraryStore.getState).mockReturnValue({
    tracks: [saved],
    hydrate: async () => {},
    addTrack,
  } as unknown as ReturnType<typeof useLibraryStore.getState>);
  jest.mocked(storage.readFileText).mockImplementation(async (uri) => {
    const value = files.get(uri);
    if (value === undefined) throw new Error('Read denied');
    return value;
  });
});

function incoming(text: string) {
  const parsed = parseGpx(text);
  const track = buildImportedTrack({
    id: 'incoming',
    points: parsed.points,
    name: 'Daily walk',
    fallbackName: 'Daily walk',
    fallbackTime: 1,
  });
  const fileUri = 'file:///doc/tracks/incoming.gpx';
  files.set(fileUri, text);
  jest.mocked(importGpxFromUri).mockResolvedValue({
    track,
    fileUri,
    notes: snapWaypointsToNotes(parsed.points, parsed.waypoints),
  });
}

it.each(['geometry', 'time', 'waypoint', 'elevation'])(
  'retains a distinct incoming GPX with the same summary but changed %s',
  async (difference) => {
    const changed = points.map((p) => ({ ...p }));
    if (difference === 'geometry')
      changed.forEach((p) => {
        p.longitude += 1;
      });
    if (difference === 'time')
      changed.forEach((p) => {
        p.time += 86400000;
      });
    if (difference === 'elevation')
      changed.forEach((p) => {
        p.altitude = 123;
      });
    incoming(
      xml(
        changed,
        difference === 'waypoint' ? [{ latitude: 45, longitude: -73, name: 'Spring' }] : [],
      ),
    );
    await expect(redirectSystemPath({ path: 'content://incoming', initial: false })).resolves.toBe(
      '/trail3d/incoming',
    );
    expect(addTrack).toHaveBeenCalledTimes(1);
    expect(storage.deleteFileAt).not.toHaveBeenCalled();
  },
);

it('opens an existing GPX only when its complete source content matches', async () => {
  incoming(xml());
  await expect(redirectSystemPath({ path: 'content://incoming', initial: false })).resolves.toBe(
    '/trail3d/saved',
  );
  expect(addTrack).not.toHaveBeenCalled();
  expect(storage.deleteFileAt).toHaveBeenCalledWith('file:///doc/tracks/incoming.gpx');
});

it('retains incoming content when the candidate GPX cannot be read', async () => {
  files.delete(saved.fileUri);
  incoming(xml());
  await expect(redirectSystemPath({ path: 'content://incoming', initial: false })).resolves.toBe(
    '/trail3d/incoming',
  );
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
});

it('preserves incoming notes absent from the saved summary even if source XML matches', async () => {
  const text = xml(points, [{ latitude: 45, longitude: -73, name: 'Spring' }]);
  files.set(saved.fileUri, text);
  incoming(text);
  await expect(redirectSystemPath({ path: 'content://incoming', initial: false })).resolves.toBe(
    '/trail3d/incoming',
  );
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
});

it('distinguishes untimed geometry from an explicitly timed epoch-zero recording', async () => {
  files.set(saved.fileUri, xml(points.map((point) => ({ ...point, time: 0, hasTime: false }))));
  incoming(xml(points.map((point) => ({ ...point, time: 0, hasTime: true }))));
  await expect(redirectSystemPath({ path: 'content://incoming', initial: false })).resolves.toBe(
    '/trail3d/incoming',
  );
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
});

it('recognizes an identical GPX whose imported waypoint notes are already retained', async () => {
  const text = xml(points, [{ latitude: 45, longitude: -73, name: 'Spring' }]);
  files.set(saved.fileUri, text);
  saved.notes = [{ id: 'saved-note', distanceM: 0, text: 'Spring', createdAt: 1 }];
  incoming(text);
  await expect(redirectSystemPath({ path: 'content://incoming', initial: false })).resolves.toBe(
    '/trail3d/saved',
  );
  expect(addTrack).not.toHaveBeenCalled();
  expect(storage.deleteFileAt).toHaveBeenCalledWith('file:///doc/tracks/incoming.gpx');
});

it('retains different unknown GPX extensions even when all parsed fields match', async () => {
  const withExtension = (value: string) =>
    xml().replace(
      '</gpx>',
      `<extensions><custom:equipment xmlns:custom="urn:custom">${value}</custom:equipment></extensions></gpx>`,
    );
  files.set(saved.fileUri, withExtension('snowshoes'));
  incoming(withExtension('skis'));
  await expect(redirectSystemPath({ path: 'content://incoming', initial: false })).resolves.toBe(
    '/trail3d/incoming',
  );
  expect(addTrack).toHaveBeenCalledTimes(1);
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
});

it('conservatively retains formatting variants rather than normalize away unknown XML data', async () => {
  incoming(xml().replace(/\n/g, '\n  '));
  await expect(redirectSystemPath({ path: 'content://incoming', initial: false })).resolves.toBe(
    '/trail3d/incoming',
  );
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
});

it.each(['removed', 'replaced'] as const)(
  'retains the incoming GPX when its duplicate candidate is %s during comparison',
  async (change) => {
    incoming(xml());
    let finishRead: ((text: string) => void) | undefined;
    const originalRead = jest.mocked(storage.readFileText).getMockImplementation()!;
    jest.mocked(storage.readFileText).mockImplementation((uri) =>
      uri === saved.fileUri
        ? new Promise<string>((resolve) => {
            finishRead = resolve;
          })
        : originalRead(uri),
    );
    const redirect = redirectSystemPath({ path: 'content://incoming', initial: false });
    // Advance to the candidate read, without resolving it.
    for (let i = 0; i < 10 && !finishRead; i++) await Promise.resolve();
    expect(finishRead).toBeDefined();
    jest.mocked(useLibraryStore.getState).mockReturnValue({
      tracks: change === 'removed' ? [] : [{ ...saved, fileUri: 'file:///new-revision.gpx' }],
      hydrate: async () => {},
      addTrack,
    } as unknown as ReturnType<typeof useLibraryStore.getState>);
    finishRead!(xml());
    await expect(redirect).resolves.toBe('/trail3d/incoming');
    expect(addTrack).toHaveBeenCalledTimes(1);
    expect(storage.deleteFileAt).not.toHaveBeenCalled();
  },
);
