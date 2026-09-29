/**
 * Strava auto-import triggers (#432): launch once loaded, foreground, the
 * 15-minute throttle, and every reason not to (switch off, not connected,
 * no read scope, a job on screen, offline mode, no import yet).
 */
import { AUTO_IMPORT_INTERVAL_MS } from '@core/import/auto';
import { newImportJob } from '@core/import/job';
import type { StravaConnection } from '@core/strava/tokens';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useStravaStore } from '@state/stravaStore';
import { AppState, type AppStateStatus } from 'react-native';

import {
  installStravaAutoImport,
  maybeAutoImportStrava,
  resetAutoImportForTests,
} from './autoImport';

const mockStart = jest.fn(async () => undefined);
let mockRunning = false;
jest.mock('./importController', () => ({
  startSourceImport: (...args: unknown[]) => mockStart(...(args as [])),
  isImportRunning: () => mockRunning,
}));
let mockNetwork = true;
jest.mock('@data/storage', () => ({
  isNetworkAllowed: () => mockNetwork,
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
}));

let appStateListener: ((s: AppStateStatus) => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateListener = listener as (s: AppStateStatus) => void;
  return { remove: () => (appStateListener = null) } as ReturnType<
    typeof AppState.addEventListener
  >;
});

const connection = (scopes: string[]): StravaConnection => ({
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: 9e9,
  athleteId: 1,
  athleteName: 'Marc',
  scopes,
});

const LAST = Date.parse('2026-09-20T10:00:00Z');

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(Date.parse('2026-09-28T12:00:00Z'));
  resetAutoImportForTests();
  mockStart.mockClear();
  mockRunning = false;
  mockNetwork = true;
  useImportStore.setState({
    hydrated: true,
    job: null,
    lastImportAt: { strava: LAST },
    autoImportStrava: true,
  });
  useStravaStore.setState({ hydrated: true, connection: connection(['activity:read_all']) });
  useLibraryStore.setState({ hydrated: true });
});

afterEach(() => jest.useRealTimers());

it('starts a quiet "since last import" Strava import', () => {
  expect(maybeAutoImportStrava()).toBe(true);
  expect(mockStart).toHaveBeenCalledWith({
    source: 'strava',
    range: { kind: 'since', after: expect.any(Number) },
    quiet: true,
  });
  const range = (mockStart.mock.calls[0] as unknown as [{ range: { after: number } }])[0].range;
  expect(range.after).toBeLessThan(LAST);
});

it('checks at most once per 15 minutes', () => {
  expect(maybeAutoImportStrava()).toBe(true);
  jest.advanceTimersByTime(AUTO_IMPORT_INTERVAL_MS - 1000);
  expect(maybeAutoImportStrava()).toBe(false);
  jest.advanceTimersByTime(1000);
  expect(maybeAutoImportStrava()).toBe(true);
  expect(mockStart).toHaveBeenCalledTimes(2);
});

it.each<[string, () => void]>([
  ['the switch is off', () => useImportStore.setState({ autoImportStrava: false })],
  ['Strava is not connected', () => useStravaStore.setState({ connection: null })],
  [
    'the connection cannot read activities',
    () => useStravaStore.setState({ connection: connection(['activity:write']) }),
  ],
  [
    'a job is on screen (even one the user stopped)',
    () =>
      useImportStore.setState({
        job: {
          ...newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 1 }),
          status: 'stopped',
        },
      }),
  ],
  [
    'an import is running',
    () => {
      mockRunning = true;
    },
  ],
  ['the network is off', () => (mockNetwork = false)],
  ['nothing was ever imported', () => useImportStore.setState({ lastImportAt: {} })],
  ['the Library is still loading', () => useLibraryStore.setState({ hydrated: false })],
])('does nothing when %s', (_why, arrange) => {
  arrange();
  expect(maybeAutoImportStrava()).toBe(false);
  expect(mockStart).not.toHaveBeenCalled();
});

it('checks once the stores load, and on every return to the foreground', () => {
  useStravaStore.setState({ hydrated: false });
  const uninstall = installStravaAutoImport();
  expect(mockStart).not.toHaveBeenCalled();

  useStravaStore.setState({ hydrated: true });
  expect(mockStart).toHaveBeenCalledTimes(1);

  // Back from the background within 15 minutes: throttled.
  jest.advanceTimersByTime(5 * 60_000);
  appStateListener?.('active');
  expect(mockStart).toHaveBeenCalledTimes(1);

  jest.advanceTimersByTime(AUTO_IMPORT_INTERVAL_MS);
  appStateListener?.('background');
  expect(mockStart).toHaveBeenCalledTimes(1);
  appStateListener?.('active');
  expect(mockStart).toHaveBeenCalledTimes(2);

  uninstall();
  expect(appStateListener).toBeNull();
});
