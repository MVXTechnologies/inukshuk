/** Settings › Connections (#432/#435): Strava states, disconnect-with-delete, Health, Garmin, files. */
import type { TrackSummary } from '@core/models';
import type { StravaConnection } from '@core/strava/tokens';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useStravaStore } from '@state/stravaStore';
import { act, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { ConnectionsSection } from './ConnectionsSection';

const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: mockNavigate }) }));

let mockConfigured = true;
const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
jest.mock('@lib/strava', () => ({
  isStravaConfigured: () => mockConfigured,
  connectStrava: () => mockConnect(),
  disconnectStrava: () => mockDisconnect(),
}));

let mockHealth: { id: string } | null = null;
const mockAvailability = jest.fn();
const mockRequest = jest.fn();
const mockInstall = jest.fn(async () => undefined);
jest.mock('@lib/health', () => ({
  healthSource: () => mockHealth,
  healthAvailability: () => mockAvailability(),
  requestHealthPermissions: () => mockRequest(),
  openHealthInstall: () => mockInstall(),
}));

const mockStop = jest.fn();
const mockDismiss = jest.fn();
jest.mock('../import/importController', () => ({
  stopSourceImport: () => mockStop(),
  dismissImportJob: () => mockDismiss(),
}));

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  deleteFileAt: jest.fn(),
}));

const connection = (scopes: string[]): StravaConnection => ({
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: 9e9,
  athleteId: 1,
  athleteName: 'Marc-André V.',
  scopes,
});

const trail = (id: string, source?: 'strava'): TrackSummary => ({
  id,
  name: id,
  startedAt: 1,
  fileUri: `file:///Documents/tracks/${id}.gpx`,
  stats: {
    distanceM: 0,
    ascentM: 0,
    descentM: 0,
    durationS: 0,
    movingTimeS: 0,
    avgSpeedMps: 0,
    maxSpeedMps: 0,
    pointCount: 1,
  },
  ...(source ? { origin: { source, externalId: id } } : {}),
});

const showSnack = jest.fn();

function show(): Promise<RenderResult> {
  return render(
    <PaperProvider>
      <ConnectionsSection showSnack={showSnack} />
    </PaperProvider>,
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
  useImportStore.setState({
    job: null,
    healthAllowed: false,
    autoImportStrava: true,
    sheetRequest: null,
    lastImportAt: {},
  });
  useLibraryStore.setState({ hydrated: true, tracks: [], activeTrackIds: [] });
});

describe('Strava', () => {
  it('says when the build has no Strava credentials', async () => {
    mockConfigured = false;
    const view = await show();
    expect(view.getByText('Connections')).toBeOnTheScreen();
    expect(view.getByText('Strava is not configured in this build')).toBeOnTheScreen();
    expect(view.getByRole('button', { name: 'Connect Strava' })).toBeDisabled();
  });

  it('connects', async () => {
    mockConnect.mockResolvedValue({ ok: true, athleteName: 'Marc' });
    const view = await show();
    expect(
      view.getByText('Import your activities and push saved trails to Strava'),
    ).toBeOnTheScreen();
    await press(view.getByText('Connect Strava'));
    expect(mockConnect).toHaveBeenCalled();
    expect(showSnack).toHaveBeenCalledWith('Connected to Strava as Marc');
  });

  it('shows who is connected, the granted scopes and the auto-import switch', async () => {
    useStravaStore.setState({ connection: connection(['activity:read_all', 'activity:write']) });
    const view = await show();
    expect(view.getByText('Connected as Marc-André V.')).toBeOnTheScreen();
    expect(view.getByText('Import')).toBeOnTheScreen();
    expect(view.getByText('Upload')).toBeOnTheScreen();
    const toggle = view.getByLabelText('Import new activities automatically');
    await act(async () => {
      fireEvent(toggle, 'valueChange', false);
    });
    expect(useImportStore.getState().autoImportStrava).toBe(false);

    await press(view.getByText('Import activities'));
    expect(useImportStore.getState().sheetRequest).toEqual({ source: 'strava' });
    expect(mockNavigate).toHaveBeenCalledWith('/library');
  });

  it('offers to allow importing on an upload-only connection', async () => {
    useStravaStore.setState({ connection: connection(['activity:write']) });
    mockConnect.mockResolvedValue({ ok: true, athleteName: 'Marc' });
    const view = await show();
    expect(view.queryByText('Import')).toBeNull();
    expect(view.queryByLabelText('Import new activities automatically')).toBeNull();
    await press(view.getByText('Allow importing'));
    expect(mockConnect).toHaveBeenCalled();
  });

  it('disconnects and, when asked, deletes what came from Strava', async () => {
    useStravaStore.setState({ connection: connection(['activity:read_all']) });
    useLibraryStore.setState({
      tracks: [trail('s1', 'strava'), trail('s2', 'strava'), trail('mine')],
    });
    useImportStore.setState({ lastImportAt: { strava: 5 } });
    mockDisconnect.mockImplementation(async () => {
      useStravaStore.setState({ connection: null });
      return { revoked: true };
    });
    const view = await show();
    await press(view.getByText('Disconnect'));
    expect(view.getByText('Disconnect Strava?')).toBeOnTheScreen();
    const box = view.getByRole('checkbox', { name: 'Also delete 2 trails imported from Strava' });
    expect(box).not.toBeChecked();
    await press(box);
    await press(view.getAllByText('Disconnect')[0]!);

    await waitFor(() => expect(mockDisconnect).toHaveBeenCalled());
    await waitFor(() =>
      expect(showSnack).toHaveBeenCalledWith('Disconnected from Strava · 2 trails deleted'),
    );
    expect(useLibraryStore.getState().tracks.map((t) => t.id)).toEqual(['mine']);
    expect(useImportStore.getState().lastImportAt.strava).toBeUndefined();
  });

  it('keeps imported trails by default, and can be cancelled', async () => {
    useStravaStore.setState({ connection: connection(['activity:read_all']) });
    useLibraryStore.setState({ tracks: [trail('s1', 'strava')] });
    mockDisconnect.mockResolvedValue({ revoked: false });
    const view = await show();
    await press(view.getByText('Disconnect'));
    await press(view.getByText('Cancel'));
    expect(view.queryByText('Disconnect Strava?')).toBeNull();

    await press(view.getByText('Disconnect'));
    await press(view.getAllByText('Disconnect')[0]!);
    await waitFor(() =>
      expect(showSnack).toHaveBeenCalledWith(
        'Disconnected — revoke Inukshuk at strava.com/settings/apps if it still appears',
      ),
    );
    expect(useLibraryStore.getState().tracks).toHaveLength(1);
  });

  it('stops a running Strava import on disconnect', async () => {
    useStravaStore.setState({ connection: connection(['activity:read_all']) });
    useImportStore.setState({
      job: { source: 'strava' } as never,
    });
    mockDisconnect.mockResolvedValue({ revoked: true });
    const view = await show();
    await press(view.getByText('Disconnect'));
    await press(view.getAllByText('Disconnect')[0]!);
    expect(mockStop).toHaveBeenCalled();
  });
});

describe('Health', () => {
  it('is hidden without a health store', async () => {
    const view = await show();
    expect(view.queryByText(/Health/)).toBeNull();
  });

  it('asks for access, then offers to import', async () => {
    mockHealth = { id: 'apple-health' };
    mockAvailability.mockResolvedValue('available');
    mockRequest.mockResolvedValue('granted');
    const view = await show();
    await waitFor(() => expect(view.getByText('Not allowed yet')).toBeOnTheScreen());
    await press(view.getByText('Allow'));
    expect(useImportStore.getState().healthAllowed).toBe(true);
    expect(view.getByText('Allowed')).toBeOnTheScreen();
    await press(view.getByText('Import activities'));
    expect(useImportStore.getState().sheetRequest).toEqual({ source: 'apple-health' });
  });

  it('says so when access was declined', async () => {
    mockHealth = { id: 'health-connect' };
    mockAvailability.mockResolvedValue('available');
    mockRequest.mockResolvedValue('denied');
    const view = await show();
    await waitFor(() => expect(view.getByText('Health Connect')).toBeOnTheScreen());
    await press(view.getByText('Allow'));
    expect(view.getByText('Not allowed — turn it on in Health Connect')).toBeOnTheScreen();
  });

  it('offers to install Health Connect', async () => {
    mockHealth = { id: 'health-connect' };
    mockAvailability.mockResolvedValue('needs-install');
    const view = await show();
    await waitFor(() => expect(view.getByText('Install Health Connect')).toBeOnTheScreen());
    await press(view.getByText('Install Health Connect'));
    expect(mockInstall).toHaveBeenCalled();
  });
});

it('explains how to link Garmin to Strava, in the app', async () => {
  const view = await show();
  expect(view.queryByText('Open the Garmin Connect app.')).toBeNull();
  await press(view.getByText('How to link Garmin to Strava'));
  expect(view.getByText('Open the Garmin Connect app.')).toBeOnTheScreen();
  expect(view.getByText('Tap More, then Settings › Connected Apps.')).toBeOnTheScreen();
  await press(view.getByText('Hide the steps'));
  expect(view.queryByText('Open the Garmin Connect app.')).toBeNull();
});

it('imports files through the Library sheet', async () => {
  const view = await show();
  await press(view.getByText('From files'));
  expect(useImportStore.getState().sheetRequest).toEqual({ source: 'files' });
  expect(mockNavigate).toHaveBeenCalledWith('/library');
});
