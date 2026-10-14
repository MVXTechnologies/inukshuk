/**
 * SOS and rally alerts in the store (#708): their own channels, once per
 * entity across resyncs, never my own, cleared on resolve or end, and the
 * in-app alarm until Acknowledge. The service is a fake that emits alerts.
 */
import type { TeamAlert } from '@core/teamui/alerts';
import type { TeamRally, TeamSos } from '@core/teamui/field';

const mockNotify = jest.fn();
const mockDismiss = jest.fn();
const mockInApp = jest.fn();
jest.mock('@data/team/teamNotifications', () => ({
  notifyTeam: (n: unknown) => mockNotify(n),
  dismissTeamNotification: (id: string) => mockDismiss(id),
  setInAppAlarm: (on: boolean) => mockInApp(on),
}));

const state: { soses: TeamSos[]; rally: TeamRally | null } = { soses: [], rally: null };
let emit: (a: TeamAlert) => void = () => undefined;
const session = {
  me: 'me',
  teamId: 't',
  record: null,
  view: () => ({
    name: 'Chic-Chocs crew',
    me: 'me',
    members: [
      { id: 'julie', name: 'Julie Tremblay' },
      { id: 'noe', name: 'Noé Gagnon' },
    ],
  }),
  unread: () => 0,
  positions: () => [],
  shares: () => ({ waypoints: [], tracks: [] }),
  photos: () => [],
  pins: () => [],
  tasks: () => [],
  statuses: () => new Map(),
  resolved: () => new Set(),
  threads: () => [],
  soses: () => state.soses,
  teamTrails: () => [],
  editors: () => new Map(),
  rally: () => state.rally,
  draw: { shapes: () => [], live: () => [] },
  photoThreads: () => new Map(),
  dataVersion: '1',
  peers: () => [],
  meshStatus: () => null,
  meshRunning: true,
  joinNotices: [],
};
const mockService = {
  active: session,
  teams: [],
  join: null,
  subscribe: () => () => undefined,
  onAlert: (cb: (a: TeamAlert) => void) => {
    emit = cb;
    return () => undefined;
  },
  onDraw: () => () => undefined,
  onDrawAlert: () => () => undefined,
  load: () => new Promise<void>(() => undefined),
};
jest.mock('@data/team/appTeam', () => ({ appTeamService: () => mockService }));

// Loaded after the fakes above exist (a static import would run first).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useTeamStore, wireTeamStore } = require('./teamStore') as typeof import('./teamStore');

const sos = (owner: string, id: string, resolved = false): TeamSos => ({
  id,
  owner,
  lat: 46.8,
  lng: -71.2,
  text: '',
  at: 1,
  resolved,
  resolvedBy: null,
});
const sosAlert = (owner: string, id: string, op = 'op1'): TeamAlert => ({
  key: `sos:${op}`,
  author: owner,
  level: 'alert',
  kind: 'sos',
  text: 'SOS · needs help',
  priority: 2,
  url: `/team/sos/${owner}/${id}`,
  entity: `sos:${owner}:${id}`,
});

beforeAll(() => {
  wireTeamStore();
});
beforeEach(() => {
  mockNotify.mockClear();
  mockDismiss.mockClear();
  mockInApp.mockClear();
});

describe('team alerts in the store (#708)', () => {
  it('an SOS: the Team SOS channel once, the in-app alarm; cleared on resolve', () => {
    state.soses = [sos('julie', 's1')];
    useTeamStore.getState().refresh();
    emit(sosAlert('julie', 's1'));
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0]![0]).toMatchObject({
      title: 'SOS · Julie Tremblay',
      body: 'Needs help · Chic-Chocs crew',
      channel: 'sos',
      identifier: 'sos:julie:s1',
      url: '/team/sos/julie/s1',
    });
    expect(useTeamStore.getState().sosAlarm).toMatchObject({
      entity: 'sos:julie:s1',
      authorName: 'Julie Tremblay',
    });
    expect(mockInApp).toHaveBeenLastCalledWith(true);
    // No small banner for it: the alarm banner is its banner.
    expect(useTeamStore.getState().banner).toBeNull();
    // A resync brings the same SOS again (another op of it): nothing.
    emit(sosAlert('julie', 's1', 'op2'));
    useTeamStore.getState().refresh();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockDismiss).not.toHaveBeenCalled();
    // Resolved: the notification and the alarm go.
    state.soses = [sos('julie', 's1', true)];
    useTeamStore.getState().refresh();
    expect(mockDismiss).toHaveBeenCalledWith('sos:julie:s1');
    expect(useTeamStore.getState().sosAlarm).toBeNull();
    expect(mockInApp).toHaveBeenLastCalledWith(false);
  });

  it('Acknowledge stops the alarm; the SOS stays active (and is not re-alarmed)', () => {
    state.soses = [sos('noe', 's2')];
    useTeamStore.getState().refresh();
    emit(sosAlert('noe', 's2'));
    expect(useTeamStore.getState().sosAlarm).not.toBeNull();
    useTeamStore.getState().acknowledgeAlarm();
    expect(useTeamStore.getState().sosAlarm).toBeNull();
    useTeamStore.getState().refresh();
    emit(sosAlert('noe', 's2', 'again'));
    expect(useTeamStore.getState().sosAlarm).toBeNull();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    state.soses = [];
    useTeamStore.getState().refresh();
    expect(mockDismiss).toHaveBeenCalledWith('sos:noe:s2');
  });

  it('never for my own SOS or rally point', () => {
    state.soses = [sos('me', 's3')];
    useTeamStore.getState().refresh();
    emit(sosAlert('me', 's3'));
    emit({ ...sosAlert('me', 'r'), kind: 'rally', entity: 'rly:me:r' });
    expect(mockNotify).not.toHaveBeenCalled();
    expect(useTeamStore.getState().sosAlarm).toBeNull();
  });

  it('a rally point: the Team rally channel once, cleared when it ends', () => {
    state.soses = [];
    state.rally = {
      id: 'r1',
      owner: 'noe',
      lat: 46.8,
      lng: -71.2,
      text: 'Lac-Delage',
      when: null,
      radius: 60,
      at: 1,
    };
    useTeamStore.getState().refresh();
    const rally: TeamAlert = {
      key: 'rly:op',
      author: 'noe',
      level: 'alert',
      kind: 'rally',
      text: 'Gather · Lac-Delage',
      priority: 1,
      url: '/team/rally/noe/r1',
      entity: 'rly:noe:r1',
    };
    emit(rally);
    emit(rally);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0]![0]).toMatchObject({
      title: 'Gather · Lac-Delage',
      body: 'Noé Gagnon calls everyone there · Chic-Chocs crew',
      channel: 'rally',
      identifier: 'rly:noe:r1',
    });
    expect(useTeamStore.getState().sosAlarm).toBeNull();
    state.rally = null;
    useTeamStore.getState().refresh();
    expect(mockDismiss).toHaveBeenCalledWith('rly:noe:r1');
  });

  it('other alerts keep the shared channel and the small banner', () => {
    emit({
      key: 'k',
      author: 'julie',
      level: 'alert',
      kind: 'message',
      text: '@Marc look',
      priority: 0,
      url: '/team/chat',
    });
    expect(mockNotify.mock.calls[0]![0]).toMatchObject({
      title: 'Julie Tremblay · Chic-Chocs crew',
    });
    expect(mockNotify.mock.calls[0]![0].channel).toBeUndefined();
    expect(useTeamStore.getState().banner).toMatchObject({ text: '@Marc look' });
  });
});
