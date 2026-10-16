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
const mockBuzz = jest.fn();
jest.mock('@data/team/teamNotifications', () => ({
  buzzRally: () => mockBuzz(),
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
const { resetRallyBuzzForTests, useTeamStore, wireTeamStore } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./teamStore') as typeof import('./teamStore');

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
  mockBuzz.mockClear();
  resetRallyBuzzForTests();
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

describe('the in-app rally buzz (#743)', () => {
  const rallyPoint = (owner: string, id: string): TeamRally => ({
    id,
    owner,
    lat: 46.8,
    lng: -71.2,
    text: '',
    when: null,
    radius: 60,
    at: 1,
  });
  const rallyAlert = (owner: string, id: string): TeamAlert => ({
    key: `rly:${owner}:${id}:op`,
    author: owner,
    level: 'alert',
    kind: 'rally',
    text: 'Gather at their position',
    priority: 1,
    url: `/team/rally/${owner}/${id}`,
    entity: `rly:${owner}:${id}`,
  });
  const call = (owner: string, id: string) => {
    state.rally = rallyPoint(owner, id);
    useTeamStore.getState().refresh();
    emit(rallyAlert(owner, id));
  };
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    jest.setSystemTime(Date.UTC(2026, 9, 16, 14));
    state.soses = [];
  });
  afterEach(() => {
    state.rally = null;
    useTeamStore.getState().refresh();
    jest.useRealTimers();
  });

  it('a teammate’s rally buzzes this phone once, with its notification', () => {
    call('noe', 'r1');
    expect(mockBuzz).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    // A resync brings it again: no second buzz (once per rally point).
    emit(rallyAlert('noe', 'r1'));
    expect(mockBuzz).toHaveBeenCalledTimes(1);
  });

  it('one raiser: at most one buzz a minute; another raiser buzzes at once', () => {
    call('noe', 'r1');
    jest.advanceTimersByTime(20_000);
    call('noe', 'r2');
    expect(mockNotify).toHaveBeenCalledTimes(2);
    expect(mockBuzz).toHaveBeenCalledTimes(1);
    call('julie', 'r3');
    expect(mockBuzz).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(40_000);
    call('noe', 'r4');
    expect(mockBuzz).toHaveBeenCalledTimes(3);
  });

  it('never my own; never over a sounding SOS alarm', () => {
    call('me', 'mine');
    expect(mockBuzz).not.toHaveBeenCalled();
    state.soses = [
      {
        id: 's9',
        owner: 'julie',
        lat: 46.8,
        lng: -71.2,
        text: '',
        at: 1,
        resolved: false,
        resolvedBy: null,
      },
    ];
    useTeamStore.getState().refresh();
    emit({ ...rallyAlert('julie', 's9'), kind: 'sos', entity: 'sos:julie:s9', key: 'sos:x' });
    expect(useTeamStore.getState().sosAlarm).not.toBeNull();
    call('noe', 'r5');
    expect(mockNotify).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'rally' }));
    expect(mockBuzz).not.toHaveBeenCalled();
    useTeamStore.getState().acknowledgeAlarm();
    state.soses = [];
  });
});

describe('a re-raised SOS rings again on this phone (#752)', () => {
  const reopenAlert = (owner: string, id: string, op: string): TeamAlert => ({
    ...sosAlert(owner, id, op),
    sosPhase: 'reopen',
  });

  it.each([
    ['acknowledged first', true],
    ['still sounding', false],
  ])('resolved here (%s), then raised again: same SOS reopened, or a new one', (_what, ack) => {
    state.soses = [sos('julie', 'r1')];
    useTeamStore.getState().refresh();
    emit(sosAlert('julie', 'r1', 'a'));
    expect(useTeamStore.getState().sosAlarm?.entity).toBe('sos:julie:r1');
    if (ack) useTeamStore.getState().acknowledgeAlarm();
    // This phone resolves it (the band's hold): the store refreshes.
    state.soses = [sos('julie', 'r1', true)];
    useTeamStore.getState().refresh();
    expect(useTeamStore.getState().sosAlarm).toBeNull();
    mockNotify.mockClear();
    mockInApp.mockClear();
    // Julie reopens the same SOS: the banner and the tone again.
    state.soses = [sos('julie', 'r1')];
    useTeamStore.getState().refresh();
    emit(reopenAlert('julie', 'r1', 'b'));
    expect(useTeamStore.getState().sosAlarm?.entity).toBe('sos:julie:r1');
    expect(mockInApp).toHaveBeenLastCalledWith(true);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'sos', identifier: 'sos:julie:r1' }),
    );
    // Resolved here again, then a NEW SOS (past the reopen cooldown): again.
    state.soses = [sos('julie', 'r1', true)];
    useTeamStore.getState().refresh();
    mockNotify.mockClear();
    state.soses = [sos('julie', 'r1', true), sos('julie', 'r2')];
    useTeamStore.getState().refresh();
    emit(sosAlert('julie', 'r2', 'c'));
    expect(useTeamStore.getState().sosAlarm?.entity).toBe('sos:julie:r2');
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'sos', identifier: 'sos:julie:r2' }),
    );
    useTeamStore.getState().acknowledgeAlarm();
    state.soses = [];
    useTeamStore.getState().refresh();
  });
});
