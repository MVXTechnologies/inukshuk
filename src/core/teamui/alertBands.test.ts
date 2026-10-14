import { activeAlerts, bandModel, bandStack, MAX_STACKED_BANDS } from './alertBands';
import type { TeamRally, TeamSos } from './field';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HERE = { latitude: 46.8, longitude: -71.2 };
const names = new Map([
  ['julie', 'Julie Tremblay'],
  ['noe', 'Noé Gagnon'],
  ['sam', 'Sam Bouchard'],
]);

const sos = (owner: string, id: string, over: Partial<TeamSos> = {}): TeamSos => ({
  id,
  owner,
  lat: 46.804,
  lng: -71.195,
  text: '',
  at: NOW - 2 * MIN,
  resolved: false,
  resolvedBy: null,
  ...over,
});
const rally = (owner: string, over: Partial<TeamRally> = {}): TeamRally => ({
  id: 'r1',
  owner,
  lat: 46.81,
  lng: -71.2,
  text: 'Lac-Delage',
  when: null,
  radius: 60,
  at: NOW - 4 * MIN,
  ...over,
});

describe('activeAlerts: ranking', () => {
  it('SOS outranks gather; a teammate’s SOS before mine, newest first; resolved ones drop', () => {
    const list = activeAlerts({
      soses: [
        sos('me', 's0', { at: NOW }),
        sos('julie', 's1', { at: NOW - 5 * MIN }),
        sos('sam', 's2', { at: NOW - MIN }),
        sos('noe', 's3', { resolved: true }),
      ],
      rally: rally('noe'),
      me: 'me',
      names,
      positions: [],
    });
    expect(list.map((a) => a.entity)).toEqual([
      'sos:sam:s2',
      'sos:julie:s1',
      'sos:me:s0',
      'rly:noe:r1',
    ]);
    expect(list[2]).toMatchObject({ mine: true, ownerName: 'You' });
    expect(list[3]).toMatchObject({ kind: 'gather', ref: { kind: 'rly', owner: 'noe', id: 'r1' } });
  });

  it('an SOS follows its raiser’s live position; a gather without a name shows coordinates', () => {
    const [s, g] = activeAlerts({
      soses: [sos('julie', 's1')],
      rally: rally('x', { text: '  ', lat: 46.812345, lng: -71.20456 }),
      me: 'me',
      names,
      positions: [{ id: 'julie', lat: 46.9, lon: -71.3 }],
    });
    expect(s).toMatchObject({ lat: 46.9, lng: -71.3 });
    expect(g).toMatchObject({ place: '46.8123, -71.2046', ownerName: 'A teammate' });
  });
});

describe('bandModel', () => {
  const opts = { here: HERE, now: NOW, receipts: '3 of 5 received', isAdmin: false };
  const [other, mine, gather] = activeAlerts({
    soses: [sos('julie', 's1'), sos('me', 's0', { at: NOW - MIN })],
    rally: rally('noe'),
    me: 'me',
    names,
    positions: [],
  });

  it('others’ SOS: name, distance and direction, age; Navigate and Centre', () => {
    expect(bandModel(other!, opts)).toEqual({
      title: 'SOS · Julie Tremblay',
      sub: '585 m NE · 2 min',
      a11y: 'SOS from Julie Tremblay, 585 m NE · 2 min',
      actions: ['navigate', 'centre'],
    });
    // An admin may resolve it; without my position, only the age.
    expect(bandModel(other!, { ...opts, here: null, isAdmin: true })).toMatchObject({
      sub: '2 min',
      actions: ['navigate', 'resolve'],
    });
  });

  it('my SOS: receipts and Resolve; just now', () => {
    expect(bandModel(mine!, { ...opts, now: mine!.since + 10_000 })).toMatchObject({
      title: 'Your SOS is active',
      sub: '3 of 5 received · just now',
      actions: ['resolve'],
    });
  });

  it('a gather: place, distance, who; its creator sees receipts and End', () => {
    expect(bandModel(gather!, opts)).toMatchObject({
      title: 'Gather · Lac-Delage',
      sub: '1.1 km · by Noé',
      actions: ['navigate'],
    });
    expect(bandModel(gather!, { ...opts, isAdmin: true }).actions).toEqual(['navigate', 'end']);
    expect(bandModel({ ...gather!, mine: true }, { ...opts, receipts: 'Sent' })).toMatchObject({
      sub: 'You called it · Sent',
      actions: ['end'],
    });
  });
});

describe('bandStack', () => {
  const four = activeAlerts({
    soses: [sos('a', '1'), sos('b', '2'), sos('c', '3')],
    rally: rally('d'),
    me: 'me',
    names,
    positions: [],
  });
  it('collapsed: one band and +N; expanded: up to three, the rest left to the panel', () => {
    expect(bandStack([], false)).toEqual({ shown: [], more: 0 });
    expect(bandStack(four.slice(0, 1), false)).toMatchObject({ more: 0 });
    expect(bandStack(four, false)).toMatchObject({ more: 3 });
    expect(bandStack(four, false).shown).toHaveLength(1);
    const open = bandStack(four, true);
    expect(open.shown).toHaveLength(MAX_STACKED_BANDS);
    expect(open.more).toBe(1);
  });
});
