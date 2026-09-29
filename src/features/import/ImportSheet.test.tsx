/**
 * The Import sheet (#432/#435): which sources show in which states, the
 * preview count, and what the primary button does.
 */
import { newImportJob } from '@core/import/job';
import type { RemoteActivity } from '@core/import/sources';
import type { StravaConnection } from '@core/strava/tokens';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useStravaStore } from '@state/stravaStore';
import { act, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ImportSheet } from './ImportSheet';

const mockStravaList = jest.fn();
const mockStravaSource = { id: 'strava', list: mockStravaList };
const mockHealthList = jest.fn();
const mockStart = jest.fn(async () => undefined);
const mockConnect = jest.fn();
let mockConfigured = true;
let mockHealth: { id: string; list: jest.Mock } | null = null;
const mockAvailability = jest.fn();
const mockRequest = jest.fn();
const mockInstall = jest.fn(async () => undefined);

jest.mock('./importController', () => ({
  sourceFor: (id: string) =>
    id === 'strava' ? mockStravaSource : mockHealth?.id === id ? mockHealth : null,
  startSourceImport: (...args: unknown[]) => mockStart(...(args as [])),
}));
jest.mock('@lib/strava', () => ({
  isStravaConfigured: () => mockConfigured,
  connectStrava: () => mockConnect(),
}));
jest.mock('@lib/health', () => ({
  healthSource: () => mockHealth,
  healthAvailability: () => mockAvailability(),
  requestHealthPermissions: () => mockRequest(),
  openHealthInstall: () => mockInstall(),
}));
jest.mock('@data/storage', () => ({ writeJson: jest.fn(), writeIndex: jest.fn() }));

const connection = (scopes: string[]): StravaConnection => ({
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: 9e9,
  athleteId: 1,
  athleteName: 'Marc',
  scopes,
});

const remote = (i: number, over: Partial<RemoteActivity> = {}): RemoteActivity => ({
  origin: { source: 'strava', externalId: String(i) },
  startedAt: Date.parse('2026-09-01T12:00:00Z') + i * 60_000_000,
  distanceM: 1000 + i,
  hasRoute: true,
  ...over,
});

const onClose = jest.fn();
const onImportFiles = jest.fn();

async function show(initialSource: 'strava' | 'files' | null = null): Promise<RenderResult> {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <ImportSheet
          visible
          initialSource={initialSource}
          onClose={onClose}
          onImportFiles={onImportFiles}
        />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

async function press(node: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(node);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigured = true;
  mockHealth = null;
  useStravaStore.setState({ connection: null });
  useImportStore.setState({ job: null, lastImportAt: {}, healthAllowed: false });
  useLibraryStore.setState({ tracks: [] });
});

it('offers only files when Strava is not configured and there is no Health store', async () => {
  mockConfigured = false;
  const view = await show();
  expect(view.queryByText(/Strava/)).toBeNull();
  expect(view.queryByText(/Health/)).toBeNull();
  expect(view.queryByText('WHICH ACTIVITIES')).toBeNull();
  await press(view.getByText('Choose files'));
  expect(onClose).toHaveBeenCalled();
  expect(onImportFiles).toHaveBeenCalled();
});

it('asks to connect Strava when it is not connected, then selects it', async () => {
  mockConnect.mockImplementation(async () => {
    useStravaStore.setState({ connection: connection(['activity:read_all']) });
    return { ok: true, athleteName: 'Marc' };
  });
  mockStravaList.mockResolvedValue([remote(1)]);
  const view = await show();
  expect(view.getByText('Connect Strava')).toBeOnTheScreen();
  expect(view.getByText('Sign in to import your activities')).toBeOnTheScreen();
  await press(view.getByText('Connect Strava'));
  expect(mockConnect).toHaveBeenCalled();
  await waitFor(() => expect(view.getByText('Import 1')).toBeOnTheScreen());
});

it('asks to reconnect a connection without the read scope', async () => {
  useStravaStore.setState({ connection: connection(['activity:write']) });
  mockConnect.mockResolvedValue({ ok: true, athleteName: 'Marc' });
  const view = await show();
  expect(view.getByText('Allow reading your activities to import them')).toBeOnTheScreen();
  await press(view.getByText('Connect Strava'));
  expect(
    view.getByText('Strava didn’t allow reading your activities. Connect again and allow it.'),
  ).toBeOnTheScreen();
});

it('previews how many activities are new and imports them', async () => {
  useStravaStore.setState({ connection: connection(['activity:read_all', 'activity:write']) });
  useImportStore.setState({ lastImportAt: { strava: new Date(2026, 8, 12, 9).getTime() } });
  const listed = [
    ...Array.from({ length: 41 }, (_, i) => remote(i + 1)),
    remote(100, { hasRoute: false }),
  ];
  mockStravaList.mockResolvedValue(listed);
  const view = await show();

  await waitFor(() => expect(view.getByText('Import 41')).toBeOnTheScreen());
  expect(view.getByText('41 new activities')).toBeOnTheScreen();
  expect(
    view.getByText(/since 12 Sep\. Indoor workouts and ones already in your Library are skipped\./),
  ).toBeOnTheScreen();
  // "Since last import" lists from before the last import (late syncs).
  expect(mockStravaList.mock.calls[0]?.[0]).toBeLessThan(new Date(2026, 8, 12, 9).getTime());

  await press(view.getByText('Import 41'));
  expect(onClose).toHaveBeenCalled();
  expect(mockStart).toHaveBeenCalledWith(
    expect.objectContaining({ source: 'strava', listed, range: expect.any(Object) }),
  );
});

it('changes range and warns that a big Strava history takes a while', async () => {
  useStravaStore.setState({ connection: connection(['activity:read_all']) });
  mockStravaList.mockResolvedValue(Array.from({ length: 301 }, (_, i) => remote(i + 1)));
  const view = await show('strava');
  await waitFor(() => expect(view.getByText('Import 301')).toBeOnTheScreen());
  // First import: "since last import" means everything, without the heads-up.
  expect(view.queryByText(/takes a while/)).toBeNull();
  await press(view.getByText('Everything'));
  await waitFor(() => expect(view.getByText(/takes a while/)).toBeOnTheScreen());
  await press(view.getByText('Last 30 days'));
  await waitFor(() => expect(view.getByText(/in the last 30 days/)).toBeOnTheScreen());
});

it('says when there is nothing new, and when the listing fails', async () => {
  useStravaStore.setState({ connection: connection(['activity:read_all']) });
  mockStravaList.mockResolvedValue([]);
  const view = await show('strava');
  await waitFor(() => expect(view.getByText('Nothing new')).toBeOnTheScreen());
  expect(view.getByRole('button', { name: 'Nothing to import' })).toBeDisabled();

  mockStravaList.mockRejectedValue(new Error('could not reach Strava — check your connection'));
  await press(view.getByText('Everything'));
  await waitFor(() =>
    expect(view.getByText('could not reach Strava — check your connection')).toBeOnTheScreen(),
  );
});

it('does not start a second import while one is under way', async () => {
  useStravaStore.setState({ connection: connection(['activity:read_all']) });
  useImportStore.setState({
    job: newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 1 }),
  });
  const view = await show('strava');
  expect(view.getByText(/already under way/)).toBeOnTheScreen();
  expect(mockStravaList).not.toHaveBeenCalled();
});

describe('Health', () => {
  beforeEach(() => {
    mockConfigured = false;
    mockHealth = { id: 'apple-health', list: mockHealthList };
  });

  it('asks for access on first use, then previews', async () => {
    mockAvailability.mockResolvedValue('available');
    mockRequest.mockResolvedValue('granted');
    mockHealthList.mockResolvedValue([
      remote(1, { origin: { source: 'apple-health', externalId: 'u1' } }),
    ]);
    const view = await show();
    await waitFor(() => expect(view.getByText(/Allow access to import/)).toBeOnTheScreen());
    await press(view.getByText('Apple Health'));
    expect(mockRequest).toHaveBeenCalled();
    expect(useImportStore.getState().healthAllowed).toBe(true);
    await waitFor(() => expect(view.getByText('Import 1')).toBeOnTheScreen());
    expect(view.getByText(/Workouts without a route/)).toBeOnTheScreen();
  });

  it('explains a declined request', async () => {
    mockAvailability.mockResolvedValue('available');
    mockRequest.mockResolvedValue('denied');
    const view = await show();
    await waitFor(() => expect(view.getByText(/Allow access to import/)).toBeOnTheScreen());
    await press(view.getByText('Apple Health'));
    expect(
      view.getByText('Allow Inukshuk to read workouts in Apple Health to import them.'),
    ).toBeOnTheScreen();
  });

  it('offers to install Health Connect when it is missing', async () => {
    mockHealth = { id: 'health-connect', list: mockHealthList };
    mockAvailability.mockResolvedValue('needs-install');
    const view = await show();
    await waitFor(() =>
      expect(view.getByText('Install Health Connect to import from it')).toBeOnTheScreen(),
    );
    await press(view.getByText('Health Connect'));
    expect(mockInstall).toHaveBeenCalled();
  });

  it('hides Health when the device has none', async () => {
    mockAvailability.mockResolvedValue('unavailable');
    const view = await show();
    await waitFor(() => expect(view.queryByText('Apple Health')).toBeNull());
  });
});
