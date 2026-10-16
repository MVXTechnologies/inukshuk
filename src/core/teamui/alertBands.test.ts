import { formatCoordinate } from '@core/convert/coordinateDisplay';
import { IMPERIAL, METRIC, NAUTICAL } from '@core/format';

import {
  activeAlerts,
  alertBandPlace,
  bandModel,
  bandStack,
  gatherBadge,
  gatherEtas,
  gatherPanelModel,
  mapBandAlerts,
  MAX_STACKED_BANDS,
  stripBandLayout,
} from './alertBands';
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
      coordinateFormat: 'dd',
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
      coordinateFormat: 'dd',
    });
    expect(s).toMatchObject({ lat: 46.9, lng: -71.3 });
    // The app-wide 6-decimal readout (#701).
    expect(g).toMatchObject({ place: '46.812345, -71.204560', ownerName: 'A teammate' });
  });

  it("an unnamed gather's coordinates follow the user's coordinate format", () => {
    const place = (coordinateFormat: 'dd' | 'dms' | 'ddm' | 'utm' | 'mgrs') =>
      activeAlerts({
        soses: [],
        rally: rally('x', { text: '', lat: 46.812345, lng: -71.20456 }),
        me: 'me',
        names,
        positions: [],
        coordinateFormat,
      })[0]?.place;
    // The same `formatCoordinate` the coordinates readout uses.
    expect(place('dms')).toBe('46°48′44.44″N, 71°12′16.42″W');
    expect(place('ddm')).toBe('46°48.7407′N, 71°12.2736′W');
    expect(place('utm')).toBe('19T 331813.7 5186670.7');
    expect(place('mgrs')).toBe('19T CM 31813 86670');
    for (const f of ['dd', 'dms', 'ddm', 'utm', 'mgrs'] as const)
      expect(place(f)).toBe(formatCoordinate(46.812345, -71.20456, f));
  });
});

describe('bandModel', () => {
  const opts = {
    here: HERE,
    now: NOW,
    receipts: '3 of 5 received',
    isAdmin: false,
    units: METRIC,
  };
  const [other, mine, gather] = activeAlerts({
    soses: [sos('julie', 's1'), sos('me', 's0', { at: NOW - MIN })],
    rally: rally('noe'),
    me: 'me',
    names,
    positions: [],
    coordinateFormat: 'dd',
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
      sub: 'By you · Sent',
      actions: ['end'],
    });
  });

  it('an unnamed gather: a short title; the coordinates only where there is room (QA 2.6.1)', () => {
    const [unnamed] = activeAlerts({
      soses: [],
      rally: rally('me', { text: '', lat: 46.802998, lng: -71.216574 }),
      me: 'me',
      names,
      positions: [],
      coordinateFormat: 'dd',
    });
    const m = bandModel(unnamed!, { ...opts, receipts: '3 of 3 received' });
    // The band's lines stay short on a 360 dp phone: no coordinates in them.
    expect(m.title).toBe('Gather point');
    expect(m.sub).toBe('By you · 3 of 3 received');
    expect(m.title.length).toBeLessThanOrEqual(24);
    expect(m.sub.length).toBeLessThanOrEqual(24);
    // The full coordinates: the screen-reader label and the expanded list.
    expect(m.a11y).toBe('Gather at 46.802998, -71.216574, By you · 3 of 3 received');
    expect(unnamed).toMatchObject({ named: false, coords: '46.802998, -71.216574' });
    // A named one keeps its name and still knows its coordinates.
    expect(gather).toMatchObject({ named: true, place: 'Lac-Delage' });
    expect(bandModel(gather!, opts).a11y).toBe('Gather at Lac-Delage, 1.1 km · by Noé');
  });

  it('distances in the user’s units (#702)', () => {
    expect(bandModel(other!, { ...opts, units: IMPERIAL }).sub).toBe('0.4 mi NE · 2 min');
    expect(bandModel(gather!, { ...opts, units: IMPERIAL }).sub).toBe('0.7 mi · by Noé');
    expect(bandModel(gather!, { ...opts, units: NAUTICAL }).sub).toBe('0.6 NM · by Noé');
  });
});

describe('gatherEtas (the old rally pill’s ETA list)', () => {
  const r = rally('noe', { lat: 46.81, lng: -71.2, radius: 60 });
  const members = [
    { id: 'me', name: 'Marc', isMe: true, active: true },
    { id: 'julie', name: 'Julie Tremblay', isMe: false, active: true },
    { id: 'noe', name: 'Noé Gagnon', isMe: false, active: true },
    { id: 'sam', name: 'Sam Bouchard', isMe: false, active: true },
    { id: 'lea', name: 'Léa Pelletier', isMe: false, active: true },
    { id: 'gone', name: 'Gone', isMe: false, active: false },
  ];
  const positions = [
    { id: 'julie', lat: 46.8, lon: -71.2, ageMs: 0 },
    { id: 'noe', lat: 46.8101, lon: -71.2, ageMs: 30_000 },
    // 34 min old: not recent.
    { id: 'lea', lat: 46.809, lon: -71.2, ageMs: 34 * MIN },
  ];

  it('arrived first, then by ETA; no recent position last with "—"; never the inactive', () => {
    const rows = gatherEtas(r, members, positions, { latitude: 46.79, longitude: -71.2 }, METRIC);
    expect(rows.map((x) => x.id)).toEqual(['noe', 'julie', 'me', 'lea', 'sam']);
    expect(rows[0]).toMatchObject({ arrived: true, eta: 'there', distance: '11 m' });
    expect(rows[1]).toMatchObject({ eta: '~15 min', distance: '1.1 km' });
    expect(rows[2]).toMatchObject({ name: 'You', isMe: true, eta: '~31 min', distance: '2.2 km' });
    expect(rows[3]).toMatchObject({ eta: '—', distance: '—', distanceM: null, etaMin: null });
    expect(rows[4]).toMatchObject({ eta: '—', distance: '—' });
  });

  it('without my fix, my row is "—" too', () => {
    const rows = gatherEtas(r, members, positions, null, METRIC);
    expect(rows.find((x) => x.isMe)).toMatchObject({ eta: '—', distance: '—' });
  });

  it('distances in the user’s units (#702)', () => {
    const here = { latitude: 46.79, longitude: -71.2 };
    const imperial = gatherEtas(r, members, positions, here, IMPERIAL);
    expect(imperial.map((x) => x.distance)).toEqual(['36 ft', '0.7 mi', '1.4 mi', '—', '—']);
    const nautical = gatherEtas(r, members, positions, here, NAUTICAL);
    expect(nautical.map((x) => x.distance)).toEqual(['11 m', '0.6 NM', '1.2 NM', '—', '—']);
  });
});

describe('bandStack', () => {
  const four = activeAlerts({
    soses: [sos('a', '1'), sos('b', '2'), sos('c', '3')],
    rally: rally('d'),
    me: 'me',
    names,
    positions: [],
    coordinateFormat: 'dd',
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

describe('where the active band shows (QA 2.6.1, #708)', () => {
  it('in the bar while it shows, else in the strip area; never nowhere in team mode', () => {
    expect(alertBandPlace({ teamMode: true, barShown: true })).toBe('bar');
    // Draw mode, an area being drawn, a shown trail…: the bar is away.
    expect(alertBandPlace({ teamMode: true, barShown: false })).toBe('strip');
    expect(alertBandPlace({ teamMode: false, barShown: false })).toBe('none');
    expect(alertBandPlace({ teamMode: false, barShown: true })).toBe('none');
  });

  it('sits above the bottom chrome, beside the SOS button only when it shows', () => {
    const base = { fabBottom: 120, drawChromeTop: 300 };
    expect(stripBandLayout({ ...base, drawMode: false, sosButtonShown: true })).toEqual({
      bottom: 128,
      right: 88,
      overDraw: false,
    });
    // A card or an area being drawn hides the SOS button: the band takes the width.
    expect(stripBandLayout({ ...base, drawMode: false, sosButtonShown: false }).right).toBe(16);
  });

  it('in Draw mode: above the tool bar and its ⓘ, over the canvas', () => {
    expect(
      stripBandLayout({
        fabBottom: 120,
        drawChromeTop: 300,
        drawMode: true,
        sosButtonShown: false,
      }),
    ).toEqual({ bottom: 308, right: 16, overDraw: true });
  });
});

describe('the gather leaves the map for the pill and the panel (#743)', () => {
  const opts = { here: HERE, receipts: '3 of 5 received', isAdmin: false, units: METRIC };
  const all = activeAlerts({
    soses: [sos('julie', 's1')],
    rally: rally('noe'),
    me: 'me',
    names,
    positions: [],
    coordinateFormat: 'dd',
  });
  const gather = all.find((a) => a.kind === 'gather')!;

  it('the map keeps SOS bands only; the pill’s "!" follows the gather', () => {
    expect(mapBandAlerts(all).map((a) => a.kind)).toEqual(['sos']);
    expect(gatherBadge(all)).toBe(true);
    expect(gatherBadge(mapBandAlerts(all))).toBe(false);
    expect(gatherBadge([])).toBe(false);
  });

  it('the panel’s head: distance and direction, who called it; End for its creator or an admin', () => {
    expect(gatherPanelModel(gather, opts)).toEqual({
      title: 'Gather · Lac-Delage',
      sub: '1.1 km N · by Noé',
      a11y: 'Gather at Lac-Delage, 1.1 km N · by Noé',
      canEnd: false,
    });
    expect(gatherPanelModel(gather, { ...opts, isAdmin: true }).canEnd).toBe(true);
    expect(gatherPanelModel(gather, { ...opts, here: null }).sub).toBe('by Noé');
    expect(gatherPanelModel(gather, { ...opts, units: IMPERIAL }).sub).toBe('0.7 mi N · by Noé');
    expect(
      gatherPanelModel({ ...gather, mine: true, named: false, place: '46.81, -71.2' }, opts),
    ).toEqual({
      title: 'Gather point',
      sub: 'By you · 3 of 5 received',
      a11y: 'Gather at 46.81, -71.2, By you · 3 of 5 received',
      canEnd: true,
    });
  });
});
