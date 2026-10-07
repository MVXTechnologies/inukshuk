/**
 * Team mode screens (#589) against a real `TeamService` on the loopback mesh
 * (Node crypto double, memory disk): Settings entry, the team hub's warnings
 * and sharing switch, the join screen's safety code, and the map card.
 */
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { DEFAULT_INVITE } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';
import { resetAppTeamServiceForTests } from '@data/team/appTeam';
import { LoopbackMeshHub } from '@data/team/loopbackMesh';
import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import type { CreatedInvite } from '@data/team/teamSession';
import { ExtensionsSection } from '@features/settings/ExtensionsSection';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore, wireTeamStore } from '@state/teamStore';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Linking } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { JoinScreen } from './JoinScreen';
import { TeamMapOverlay, useTeamMapSelection } from './map/TeamMapOverlay';
import { TeamHubScreen } from './TeamHubScreen';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack, replace: mockReplace }),
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
jest.mock('@data/gnss/link', () => ({
  ...jest.requireActual('@data/gnss/link'),
  gnssLinkAvailable: () => false,
}));

function wrap(children: ReactNode, dark = false) {
  return <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>{children}</PaperProvider>;
}

function setTeamExtension(installedAt: number) {
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({ extensions: { ...d, team: { ...d.team, installedAt } } });
}

const hub = new LoopbackMeshHub();
const phone = () =>
  new TeamService({
    c: nodeCrypto,
    disk: new MemoryTeamDisk(),
    transport: hub.createTransport(),
    tickMs: 0,
  });

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1600 && !cond(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  if (!cond()) throw new Error('timed out');
}

let app: TeamService;

beforeEach(async () => {
  mockPush.mockReset();
  mockReplace.mockReset();
  mockParams = {};
  app = phone();
  resetAppTeamServiceForTests(app);
  setTeamExtension(Date.now());
  wireTeamStore();
  await app.load();
});

afterEach(async () => {
  await app.active?.stopMesh();
  await app.cancelJoin();
});

describe('Settings → Extensions: Team mode', () => {
  it('offers Get before the install, then Create / Join and the privacy line', async () => {
    setTeamExtension(0);
    await render(wrap(<ExtensionsSection />));
    expect(screen.getByLabelText('Get Team mode')).toBeTruthy();
    setTeamExtension(Date.now());
    await act(async () => {
      await app.createTeam({ name: 'Relevé MSA', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
      useTeamStore.getState().refresh();
    });
    // The compact list: the row says which team, then opens on tap.
    await fireEvent.press(screen.getByLabelText(/^Team mode, Relevé MSA/));
    expect(screen.getByText('Relevé MSA')).toBeTruthy();
    expect(screen.getByTestId('team-create-row')).toBeTruthy();
    expect(screen.getByTestId('team-join-row')).toBeTruthy();
    expect(screen.getByText(/shared only while you turn sharing on/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('team-open-row'));
    expect(mockPush).toHaveBeenCalledWith('/team');
  });
});

describe('the team hub', () => {
  beforeEach(async () => {
    await app.createTeam({ name: 'Relevé MSA', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
    useTeamStore.getState().refresh();
  });

  it('states that sharing is off until switched on, in both themes', async () => {
    for (const dark of [false, true]) {
      const r = await render(wrap(<TeamHubScreen />, dark));
      expect(screen.getByTestId('team-share-state').props.children).toBe(
        'Off · nobody in the team sees where you are',
      );
      await r.unmount();
    }
    await render(wrap(<TeamHubScreen />));
    await fireEvent(screen.getByTestId('team-share-switch'), 'valueChange', true);
    await act(() => useTeamStore.getState().refresh());
    expect(app.active!.record.prefs.sharePosition).toBe(true);
    expect(screen.getByTestId('team-share-state').props.children).toBe(
      'On while you record · teammates see where you are',
    );
  });

  it('shows rotation advice with Rotate now for admins, and the Local Network denial', async () => {
    const rotate = jest.spyOn(app.active!, 'rotateKey');
    const view = useTeamStore.getState().view!;
    await act(() =>
      useTeamStore.setState({
        view: { ...view, rotationAdvised: true },
        mesh: {
          running: false,
          port: null,
          advertising: false,
          browsing: false,
          localNetwork: 'denied',
          discovered: 0,
          error: null,
        },
      }),
    );
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await render(wrap(<TeamHubScreen />));
    expect(screen.getByTestId('team-rotation-advised')).toBeTruthy();
    expect(screen.getByTestId('team-local-network-denied')).toBeTruthy();
    await fireEvent.press(screen.getByText('Settings'));
    expect(open).toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Rotate now'));
    expect(rotate).toHaveBeenCalled();
  });

  it('lists members with roles, and extends the team', async () => {
    await render(wrap(<TeamHubScreen />));
    expect(screen.getByText('Marc (you)')).toBeTruthy();
    expect(screen.getByText('Organizer')).toBeTruthy();
    const before = app.active!.view().expiresAt;
    await fireEvent.press(screen.getByTestId('team-extend-7d'));
    expect(app.active!.view().expiresAt).toBeGreaterThan(before);
  });
});

describe('joining', () => {
  it('opens an inukshuk:// link, shows the safety code, and keeps the team when it matches', async () => {
    const admin = phone();
    const session = await admin.createTeam({
      name: 'Relevé MSA',
      myName: 'Julie',
      lifetimeMs: lifetimeMs('14d'),
    });
    await session.startMesh();
    const inv = session.createInvite(DEFAULT_INVITE) as CreatedInvite;
    mockParams = { t: inv.payload };
    await render(wrap(<JoinScreen />));
    await fireEvent.changeText(screen.getByTestId('team-join-myname'), 'Simon');
    await act(async () => {
      await fireEvent.press(screen.getByTestId('team-join-start'));
    });
    await until(() => useTeamStore.getState().join?.phase === 'verify');
    await waitFor(() => expect(screen.getByTestId('team-join-code')).toBeTruthy());
    const code = session.joinNotices[0]!.code;
    expect(screen.getByTestId('team-join-code').props.children.join('')).toBe(
      `${code.slice(0, 3)} ${code.slice(3)}`,
    );
    await act(async () => {
      await fireEvent.press(screen.getByTestId('team-join-match'));
    });
    await until(() => mockReplace.mock.calls.length > 0);
    expect(mockReplace).toHaveBeenCalledWith('/team');
    expect(app.teams.map((t) => t.teamId)).toEqual([session.teamId]);
    await session.stopMesh();
  });
});

describe('the map card', () => {
  it('shows a teammate’s distance, bearing and age', async () => {
    const admin = phone();
    const session = await admin.createTeam({
      name: 'T',
      myName: 'Julie',
      lifetimeMs: lifetimeMs('14d'),
    });
    await session.startMesh();
    const inv = session.createInvite(DEFAULT_INVITE) as CreatedInvite;
    await app.startJoin(inv.token, 'Simon');
    await until(() => app.join?.state().phase === 'verify');
    await app.confirmJoin();
    await app.active!.startMesh();
    session.updateRecord({ prefs: { ...session.record.prefs, sharePosition: true } });
    session.sharePosition({ latitude: 47.01, longitude: -71, accuracy: 5, at: Date.now() });
    await until(() => app.active!.positions().length === 1);
    await act(() => {
      useTeamStore.getState().refresh();
      useTeamMapSelection.getState().select({ kind: 'member', id: session.me });
    });
    await render(
      wrap(
        <TeamMapOverlay
          here={{ latitude: 47, longitude: -71 }}
          cardSlotFree
          cardStyle={{}}
          fabBottom={72}
          onNavigate={jest.fn()}
          onPointActions={jest.fn()}
        />,
      ),
    );
    // The popup: position age, accuracy, distance and direction; its actions.
    expect(screen.getByTestId('team-card-range').props.children).toBe('just now · ±5 m · 1.1 km N');
    expect(screen.getByText('Julie')).toBeTruthy();
    expect(screen.getByTestId('team-member-where')).toBeTruthy();
    // Signal mode (the extension switch on, a team open): the team button.
    expect(screen.getByTestId('team-fab')).toBeTruthy();
    await session.stopMesh();
  });
});
