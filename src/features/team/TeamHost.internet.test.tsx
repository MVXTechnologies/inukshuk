/**
 * TeamHost keeps the phone in its teams' internet rooms only while the app
 * is in use (#705, R-META-4): foreground, or recording in the background;
 * never with team mode off or during a join. "Always use the relay" follows
 * this phone's setting.
 */
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { act, render } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { internetWanted, TeamHost } from './TeamHost';

const mockHost = { setInternetOnline: jest.fn(), setAlwaysRelay: jest.fn() };
const mockService = { host: mockHost, active: null, lastOpened: null };

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));
jest.mock('@state/teamStore', () => ({
  ...jest.requireActual('@state/teamStore'),
  teamService: () => mockService,
  wireTeamStore: () => undefined,
}));
jest.mock('@data/team/teamNotifications', () => ({ onTeamNotificationTap: () => () => undefined }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

let appStateListener: ((s: AppStateStatus) => void) | null = null;

beforeEach(() => {
  mockHost.setInternetOnline.mockClear();
  mockHost.setAlwaysRelay.mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, fn) => {
    appStateListener = fn as (s: AppStateStatus) => void;
    return { remove: () => (appStateListener = null) } as never;
  });
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    teamAlwaysRelay: false,
    extensions: { ...d, team: { ...d.team, installedAt: 1, show: true } },
  });
  useTeamStore.setState({ loaded: true, activeId: null, join: null });
  useRecorderStore.setState({ status: 'idle' } as never);
});

const last = () => mockHost.setInternetOnline.mock.calls.at(-1)?.[0];

it('is online in the foreground, offline in the background, online again while recording', async () => {
  await render(<TeamHost />);
  expect(last()).toBe(true);
  await act(async () => appStateListener?.('background'));
  expect(last()).toBe(false);
  await act(async () => useRecorderStore.setState({ status: 'recording' } as never));
  expect(last()).toBe(true);
});

it('follows "Always use the relay"', async () => {
  await render(<TeamHost />);
  expect(mockHost.setAlwaysRelay).toHaveBeenLastCalledWith(false);
  await act(async () => useSettingsStore.setState({ teamAlwaysRelay: true }));
  expect(mockHost.setAlwaysRelay).toHaveBeenLastCalledWith(true);
});

it('stays off with team mode off or while a join runs', () => {
  const base = { enabled: true, joining: false, foreground: true, recording: false };
  expect(internetWanted(base)).toBe(true);
  expect(internetWanted({ ...base, enabled: false })).toBe(false);
  expect(internetWanted({ ...base, joining: true })).toBe(false);
  expect(internetWanted({ ...base, foreground: false })).toBe(false);
  expect(internetWanted({ ...base, foreground: false, recording: true })).toBe(true);
});
