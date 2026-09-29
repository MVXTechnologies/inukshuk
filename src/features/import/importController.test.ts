/**
 * The import controller: start → done marks the source's last import; stop;
 * a Health import pauses in the background and resumes in the foreground;
 * dismiss puts the card away.
 */
import { newImportJob } from '@core/import/job';
import type { ActivityRoute, ActivitySource, RemoteActivity } from '@core/import/sources';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { AppState, type AppStateStatus } from 'react-native';

import {
  dismissImportJob,
  isImportRunning,
  resetImportControllerForTests,
  resumeSourceImport,
  sourceFor,
  startSourceImport,
  stopSourceImport,
} from './importController';

const mockStrava = { id: 'strava', list: jest.fn(), fetchRoute: jest.fn() };
const mockHealth = { id: 'apple-health', list: jest.fn(), fetchRoute: jest.fn() };

jest.mock('@lib/stravaSource', () => ({ createStravaSource: () => mockStrava }));
jest.mock('@lib/health', () => ({ healthSource: () => mockHealth }));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  newId: () => 'n_' + Math.random().toString(36).slice(2, 8),
  writeTrackGpx: (id: string) => `file:///Documents/tracks/${id}.gpx`,
  writeIndex: jest.fn(),
  writeJson: jest.fn(),
  deleteFileAt: jest.fn(),
}));

let appStateListener: ((s: AppStateStatus) => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateListener = listener as (s: AppStateStatus) => void;
  return { remove: () => (appStateListener = null) } as ReturnType<
    typeof AppState.addEventListener
  >;
});

const T0 = Date.parse('2026-09-01T12:00:00Z');

const remote = (source: 'strava' | 'apple-health', id: string): RemoteActivity => ({
  origin: { source, externalId: id },
  startedAt: T0 + Number(id) * 86_400_000,
  distanceM: 0,
  hasRoute: true,
});

const route = (a: RemoteActivity): ActivityRoute => ({
  points: [
    { latitude: 46.8, longitude: -71.2, time: a.startedAt },
    { latitude: 46.81, longitude: -71.2, time: a.startedAt + 60_000 },
  ],
  segmentStarts: [],
});

beforeEach(() => {
  resetImportControllerForTests();
  useImportStore.setState({ job: null, lastImportAt: {}, hydrated: true });
  useLibraryStore.setState({ hydrated: true, tracks: [], activeTrackIds: [] });
  for (const s of [mockStrava, mockHealth]) {
    s.list.mockReset();
    s.fetchRoute.mockReset().mockImplementation(async (a: RemoteActivity) => route(a));
  }
});

it('knows its sources', () => {
  expect(sourceFor('strava')).toBe(mockStrava);
  expect(sourceFor('apple-health')).toBe(mockHealth);
  expect(sourceFor('health-connect')).toBeNull();
});

it('runs an import to done and records the last import', async () => {
  mockStrava.list.mockResolvedValue([remote('strava', '1'), remote('strava', '2')]);
  await startSourceImport({ source: 'strava', range: { kind: 'everything' } });
  const { job, lastImportAt } = useImportStore.getState();
  expect(job).toMatchObject({ status: 'done', imported: 2 });
  expect(lastImportAt.strava).toBe(job?.startedAt);
  expect(useLibraryStore.getState().tracks).toHaveLength(2);
  expect(isImportRunning()).toBe(false);

  dismissImportJob();
  expect(useImportStore.getState().job).toBeNull();
});

it('reuses a preview listing', async () => {
  await startSourceImport({
    source: 'strava',
    range: { kind: 'last-days', days: 30 },
    listed: [remote('strava', '1')],
  });
  expect(mockStrava.list).not.toHaveBeenCalled();
  expect(useImportStore.getState().job?.imported).toBe(1);
});

it('reports an unavailable source as an error', async () => {
  await startSourceImport({ source: 'health-connect', range: { kind: 'everything' } });
  expect(useImportStore.getState().job).toMatchObject({
    status: 'error',
    message: 'Health Connect isn’t available on this phone',
  });
});

it('stops a running import, and resumes it later', async () => {
  let release: () => void = () => undefined;
  mockStrava.list.mockResolvedValue([remote('strava', '1'), remote('strava', '2')]);
  mockStrava.fetchRoute.mockImplementationOnce(
    (a: RemoteActivity, signal: AbortSignal) =>
      new Promise((resolve, reject) => {
        release = () => resolve(route(a));
        signal.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  );
  const running = startSourceImport({ source: 'strava', range: { kind: 'everything' } });
  await new Promise((r) => setTimeout(r, 5));
  expect(isImportRunning()).toBe(true);
  // A second start while one runs is ignored.
  await startSourceImport({ source: 'strava', range: { kind: 'everything' } });
  stopSourceImport();
  await running;
  release();
  expect(useImportStore.getState().job).toMatchObject({ status: 'stopped', imported: 0 });

  await resumeSourceImport();
  expect(useImportStore.getState().job).toMatchObject({ status: 'done', imported: 2 });
});

it('gives up on a paused job when stopped', () => {
  useImportStore.setState({
    job: {
      ...newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 1 }),
      status: 'paused',
      listing: false,
      pausedReason: 'daily-limit',
      resumeAt: 5,
      remaining: ['2'],
    },
  });
  stopSourceImport();
  expect(useImportStore.getState().job).toMatchObject({ status: 'stopped', pausedReason: null });
});

it('pauses a Health import in the background and resumes it in the foreground', async () => {
  mockHealth.list.mockResolvedValue([remote('apple-health', '1'), remote('apple-health', '2')]);
  mockHealth.fetchRoute.mockImplementationOnce(
    (_a: RemoteActivity, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  );
  const running = startSourceImport({ source: 'apple-health', range: { kind: 'everything' } });
  await new Promise((r) => setTimeout(r, 5));
  appStateListener?.('background');
  await running;
  expect(useImportStore.getState().job).toMatchObject({
    status: 'paused',
    pausedReason: 'background',
  });

  appStateListener?.('active');
  await new Promise((r) => setTimeout(r, 20));
  expect(useImportStore.getState().job).toMatchObject({ status: 'done', imported: 2 });
});

it('leaves a running Strava import alone in the background', async () => {
  mockStrava.list.mockResolvedValue([remote('strava', '1')]);
  const running = startSourceImport({ source: 'strava', range: { kind: 'everything' } });
  appStateListener?.('background');
  await running;
  expect(useImportStore.getState().job?.status).toBe('done');
});

it('ignores resume and dismiss when there is nothing to do', async () => {
  await resumeSourceImport();
  dismissImportJob();
  stopSourceImport();
  expect(useImportStore.getState().job).toBeNull();
  // Sources are typed as ActivitySource.
  const s: ActivitySource | null = sourceFor('strava');
  expect(s).not.toBeNull();
});
