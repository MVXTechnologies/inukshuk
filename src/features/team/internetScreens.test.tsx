/**
 * The team screens that change with the internet (#705, G7 mockup screens
 * 1, 5–9, 11) against a real `TeamService` on the loopback mesh, both
 * themes: New team's switch, Manage team's Connection row, the R-INV-3
 * banner and the provisional share line, the Connection screen (the admin's
 * switch and its sub-option, a member's view), and the join screen's
 * "Can't compare now" and newer-invite states.
 */
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import { appStoreLinks } from '@core/links/appStore';
import { toB64u } from '@core/team/bytes';
import { encodeInvite } from '@core/team/invite';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { lifetimeMs } from '@core/teamui/lifetime';
import { resetAppTeamServiceForTests } from '@data/team/appTeam';
import { LoopbackMeshHub } from '@data/team/loopbackMesh';
import { MemoryTeamDisk } from '@data/team/teamDisk';
import type { JoinState } from '@data/team/teamJoin';
import { TeamService } from '@data/team/teamService';
import { useSettingsStore } from '@state/settingsStore';
import { settleTeamStoreForTests, useTeamStore, wireTeamStore } from '@state/teamStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Linking, Platform } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { ConnectionScreen } from './ConnectionScreen';
import { CreateTeamScreen } from './CreateTeamScreen';
import { JoinScreen } from './JoinScreen';
import { TeamHubScreen } from './TeamHubScreen';

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/',
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@data/storage', () => ({
  newId: () => 'new-id',
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
  deleteFileAt: jest.fn(),
}));
jest.mock('@data/offline', () => ({
  listCompanionPacks: jest.fn(async () => []),
  listRegionPacks: jest.fn(async () => []),
  deleteCompanionPacks: jest.fn(async () => undefined),
  createRegionPack: jest.fn(async () => undefined),
}));
jest.mock('@data/team/teamNotifications', () => ({
  ensureTeamNotifications: async () => undefined,
  notifyTeam: async () => undefined,
  onTeamNotificationTap: () => () => undefined,
  dismissTeamNotification: async () => undefined,
  setInAppAlarm: () => undefined,
  buzzRally: () => undefined,
  SOS_VIBRATION: [0, 900],
}));

const wrap = (children: ReactNode, dark = false) => (
  <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>{children}</PaperProvider>
);
const THEMES = [false, true] as const;

const hub = new LoopbackMeshHub();
let app: TeamService;

beforeEach(async () => {
  mockPush.mockReset();
  mockReplace.mockReset();
  mockParams = {};
  app = new TeamService({
    c: nodeCrypto,
    disk: new MemoryTeamDisk(),
    transport: hub.createTransport(),
    tickMs: 0,
  });
  resetAppTeamServiceForTests(app);
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    extensions: { ...d, team: { ...d.team, installedAt: Date.now() } },
    teamAlwaysRelay: false,
  });
  wireTeamStore();
  await app.load();
});

afterEach(async () => {
  await app.active?.stopMesh();
  await app.cancelJoin();
  settleTeamStoreForTests();
});

async function team(internet = true) {
  await act(async () => {
    await app.createTeam({
      name: 'Chic-Chocs',
      myName: 'Marc',
      lifetimeMs: lifetimeMs('14d'),
      internet,
    });
  });
  settleTeamStoreForTests();
  await act(async () => useTeamStore.getState().refresh());
}

describe('New team: how phones connect', () => {
  it.each(THEMES)(
    'the internet is on by default, and off when switched off (dark: %s)',
    async (dark) => {
      await render(wrap(<CreateTeamScreen />, dark));
      expect(screen.getByTestId('team-create-internet').props.value).toBe(true);
      expect(screen.queryByText(/end-to-end/)).toBeNull();
      await fireEvent.changeText(screen.getByTestId('team-create-name'), 'Gaspésie');
      await fireEvent.changeText(screen.getByTestId('team-create-myname'), 'Marc');
      if (dark) await fireEvent(screen.getByTestId('team-create-internet'), 'valueChange', false);
      await act(async () => {
        await fireEvent.press(screen.getByTestId('team-create-submit'));
      });
      expect(app.active?.internetOn).toBe(!dark);
    },
  );
});

describe('Manage team', () => {
  it.each(THEMES)(
    'a Connection row instead of the Sync section, no encryption note (dark: %s)',
    async (dark) => {
      await team(false);
      await render(wrap(<TeamHubScreen />, dark));
      expect(screen.getByText('Nearby only · the internet is off')).toBeTruthy();
      expect(screen.queryByTestId('team-dial-open')).toBeNull();
      expect(screen.queryByText(/end-to-end/)).toBeNull();
      await fireEvent.press(screen.getByTestId('team-connection-row'));
      expect(mockPush).toHaveBeenCalledWith('/team/connection');
    },
  );

  it('after a removal, one banner: the old invites stopped working (R-INV-3)', async () => {
    await team();
    const s = app.active!;
    s.revokedNotice = { count: 2, name: 'Léa', at: Date.now() };
    await render(wrap(<TeamHubScreen />));
    expect(screen.getByText('2 invites stopped working')).toBeTruthy();
    expect(screen.getByText('They were made before Léa was removed.')).toBeTruthy();
    await fireEvent.press(screen.getByText('New invite'));
    expect(mockPush).toHaveBeenCalledWith('/team/invite');
    expect(s.revokedNotice).toBeNull();
  });

  it('a provisional joiner’s share line says when sharing starts (R-INV-4)', async () => {
    await team();
    const s = app.active!;
    s.updateRecord({
      prefs: { ...s.record.prefs, sharePosition: true },
      provisional: { inviteId: 'x', admittedBy: 'y' },
    });
    await act(async () => useTeamStore.getState().refresh());
    await render(wrap(<TeamHubScreen />));
    expect(screen.getByTestId('team-share-state').props.children).toBe(
      'On · starts once a second teammate’s phone confirms you',
    );
  });
});

describe('the Connection screen', () => {
  it.each(THEMES)(
    'an admin’s switch; "Always use the relay" only while it is on (dark: %s)',
    async (dark) => {
      await team(false);
      await render(wrap(<ConnectionScreen />, dark));
      expect(screen.getByText('Off · only phones nearby sync')).toBeTruthy();
      expect(screen.queryByTestId('team-always-relay-row')).toBeNull();
      expect(screen.getByTestId('team-dial-open')).toBeTruthy();
      await act(async () => {
        await fireEvent(screen.getByTestId('team-internet-switch'), 'valueChange', true);
      });
      expect(app.active!.internetOn).toBe(true);
      expect(screen.getByText('On for the whole team')).toBeTruthy();
      await fireEvent(screen.getByTestId('team-always-relay-switch'), 'valueChange', true);
      expect(useSettingsStore.getState().teamAlwaysRelay).toBe(true);
    },
  );

  it('a member reads the team’s setting, with no switch for it', async () => {
    await team();
    const s = app.active!;
    const real = s.view.bind(s);
    jest.spyOn(s, 'view').mockImplementation(() => ({ ...real(), isAdmin: false }));
    await act(async () => useTeamStore.getState().refresh());
    await render(wrap(<ConnectionScreen />));
    expect(screen.getByText('On for this team · set by its admins')).toBeTruthy();
    expect(screen.queryByTestId('team-internet-switch')).toBeNull();
    expect(screen.getByTestId('team-always-relay-row')).toBeTruthy();
  });
});

describe('Joining over the internet', () => {
  const verify = (via: JoinState['via']): JoinState => ({
    teamId: 't',
    phase: 'verify',
    safetyCode: '482913',
    failure: null,
    hint: null,
    mesh: null,
    dials: [],
    startedAt: Date.now(),
    internet: true,
    via,
  });

  it.each(THEMES)('“Can’t compare now” joins provisionally (dark: %s)', async (dark) => {
    const confirm = jest.spyOn(app, 'confirmJoin').mockResolvedValue('not-member');
    useTeamStore.setState({ join: verify('internet') });
    await render(wrap(<JoinScreen />, dark));
    expect(screen.getByText(/in person or on a call/)).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('team-join-later'));
    });
    expect(confirm).toHaveBeenCalledWith(false);
  });

  it('a nearby join keeps the 2.6 choices only', async () => {
    useTeamStore.setState({ join: verify('nearby') });
    await render(wrap(<JoinScreen />));
    expect(screen.queryByTestId('team-join-later')).toBeNull();
  });

  it('the steps while looking for the team', async () => {
    useTeamStore.setState({ join: { ...verify(null), phase: 'searching' } });
    await render(wrap(<JoinScreen />));
    expect(screen.getByText('Invite checked')).toBeTruthy();
    expect(screen.getByText('Over the internet and on this Wi-Fi')).toBeTruthy();
    expect(screen.getByText('Letting you in')).toBeTruthy();
  });

  it.each(THEMES)(
    'a shared folder’s invite joins a folder, not a team (dark: %s)',
    async (dark) => {
      const token = {
        teamId: `${'F'.repeat(21)}A`,
        seed: new Uint8Array(16).fill(7),
        expiresAt: Date.now() + 3_600_000,
        app: 'lib' as const,
      };
      mockParams = { t: encodeInvite(token, 'link') };
      await render(wrap(<JoinScreen />, dark));
      expect(screen.getByTestId('folder-join-name')).toBeTruthy();
      expect(screen.getByText('You have an invite to a shared folder.')).toBeTruthy();
      expect(
        screen.getByText('People in the folder see this name next to your changes.'),
      ).toBeTruthy();
      expect(screen.queryByText(/your position is shared/)).toBeNull();
    },
  );

  it('an invite from a newer app asks for the update', async () => {
    const b = new Uint8Array(38);
    b[0] = 1;
    b[1] = 4; // a flag this version does not know
    mockParams = { t: toB64u(b) };
    await render(wrap(<JoinScreen />));
    expect(screen.getByText('This invite needs a newer Inukshuk')).toBeTruthy();
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await fireEvent.press(screen.getByText('Update'));
    expect(open).toHaveBeenCalledWith(appStoreLinks(Platform.OS).app);
  });
});
