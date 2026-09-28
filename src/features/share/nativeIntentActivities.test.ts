import type { Track } from '@core/models';
import {
  activityImportMessage,
  importActivitiesFromUri,
  openImportedUri,
  type ActivityImportSummary,
} from '@features/library/importActivities';
import { importGpxFromUri } from '@features/library/importGpx';
import { useLibraryStore } from '@state/libraryStore';

import { redirectSystemPath } from '../../../app/+native-intent';

const mockShow = jest.fn();
const addTracks = jest.fn();
const dispose = jest.fn();

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));
jest.mock('@lib/strava', () => ({ handleStravaAuthRedirect: () => false }));
jest.mock('@state/importFeedbackStore', () => ({
  useImportFeedbackStore: { getState: () => ({ show: mockShow }) },
}));
jest.mock('@state/libraryStore', () => ({ useLibraryStore: { getState: jest.fn() } }));
jest.mock('@features/library/importGpx', () => ({ importGpxFromUri: jest.fn() }));
jest.mock('@features/library/importActivities', () => ({
  openImportedUri: jest.fn(),
  importActivitiesFromUri: jest.fn(),
  activityImportMessage: jest.fn(() => 'summary'),
}));
jest.mock('@data/storage', () => ({ deleteFileAt: jest.fn() }));

const item = (id: string) => ({
  track: { id, name: `Trail ${id}` } as Track,
  fileUri: `file:///doc/tracks/${id}.gpx`,
  notes: [],
});
const summary = (over: Partial<ActivityImportSummary>): ActivityImportSummary => ({
  items: [],
  duplicates: 0,
  failed: 0,
  limitReached: false,
  ...over,
});

beforeEach(() => {
  jest.mocked(useLibraryStore.getState).mockReturnValue({
    tracks: [],
    hydrate: async () => {},
    addTracks,
  } as unknown as ReturnType<typeof useLibraryStore.getState>);
  jest
    .mocked(openImportedUri)
    .mockResolvedValue({ uri: 'file:///cache/imports/c.import', format: 'fit', dispose });
  jest.mocked(activityImportMessage).mockReturnValue('summary');
});

const open = () => redirectSystemPath({ path: 'content://media/42', initial: false });

it('opens a single imported activity in its trail view', async () => {
  jest.mocked(importActivitiesFromUri).mockResolvedValue(summary({ items: [item('a')] }));
  await expect(open()).resolves.toBe('/trail3d/a');
  expect(importActivitiesFromUri).toHaveBeenCalledWith(
    'file:///cache/imports/c.import',
    'Imported activity',
    [],
    expect.any(Function),
  );
  expect(addTracks).toHaveBeenCalledWith([item('a')]);
  expect(mockShow).toHaveBeenLastCalledWith('Imported Trail a');
  expect(dispose).toHaveBeenCalled();
  expect(importGpxFromUri).not.toHaveBeenCalled();
});

it('lands an archive on the Library with a summary, reporting progress', async () => {
  jest.mocked(openImportedUri).mockResolvedValue({ uri: 'u', format: 'zip', dispose });
  jest.mocked(importActivitiesFromUri).mockImplementation(async (_u, _n, _t, onProgress) => {
    onProgress?.(1, 5); // too few to report
    onProgress?.(3, 50);
    onProgress?.(4, 50); // throttled
    return summary({ items: [item('a'), item('b')], duplicates: 1 });
  });
  await expect(open()).resolves.toBe('/(tabs)/library');
  expect(mockShow).toHaveBeenCalledWith('Importing activities… 3 of 50');
  expect(mockShow).not.toHaveBeenCalledWith('Importing activities… 4 of 50');
  expect(mockShow).toHaveBeenLastCalledWith('summary');
});

it('says so when everything was already in the library', async () => {
  jest.mocked(importActivitiesFromUri).mockResolvedValue(summary({ duplicates: 3 }));
  await expect(open()).resolves.toBe('/(tabs)/library');
  expect(mockShow).toHaveBeenLastCalledWith('Already in your library');
});

it('reports a file with no readable activities as a failed import', async () => {
  jest.mocked(importActivitiesFromUri).mockResolvedValue(summary({ failed: 1 }));
  await expect(open()).resolves.toBe('/(tabs)/library');
  expect(mockShow).toHaveBeenLastCalledWith('Could not import that file');
  expect(dispose).toHaveBeenCalled();
});
