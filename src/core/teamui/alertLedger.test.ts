import { exchange, MIN, T0 } from '@core/team/testing/fixtures';
import { crew } from '@core/teamdraw/testUtils';

import {
  activeEntities,
  alertChannel,
  AlertLedger,
  RALLY_BUZZ_GAP_MS,
  rallyEntity,
  RallyBuzzGate,
  sosEntity,
} from './alertLedger';
import { alertContext, alertFor, type TeamAlert } from './alerts';
import { teamRally, teamSos } from './field';

const alert = (over: Partial<TeamAlert>): TeamAlert => ({
  key: 'k',
  author: 'julie',
  level: 'alert',
  kind: 'message',
  text: 'hi',
  priority: 0,
  url: '/team/chat',
  ...over,
});

describe('alertChannel', () => {
  it('SOS → Team SOS, rally → Team rally, other alerts → team, badges → none', () => {
    expect(alertChannel({ kind: 'sos', level: 'alert' })).toBe('sos');
    expect(alertChannel({ kind: 'rally', level: 'alert' })).toBe('rally');
    expect(alertChannel({ kind: 'message', level: 'alert' })).toBe('team');
    expect(alertChannel({ kind: 'task', level: 'alert' })).toBe('team');
    expect(alertChannel({ kind: 'sos', level: 'badge' })).toBeNull();
  });
});

describe('AlertLedger', () => {
  it('one notification per entity across resyncs; never my own; settles on resolve', () => {
    const l = new AlertLedger();
    const s = alert({ kind: 'sos', entity: 'sos:julie:s1' });
    expect(l.route(s, 'me')).toEqual({ channel: 'sos', id: 'sos:julie:s1' });
    // The same SOS again (a resync, a reconnect): nothing.
    expect(l.route({ ...s, key: 'other-op' }, 'me')).toBeNull();
    expect(l.route(s, 'me')).toBeNull();
    // My own, or an SOS/rally without an entity: nothing.
    expect(l.route(alert({ kind: 'rally', entity: 'rly:me:r', author: 'me' }), 'me')).toBeNull();
    expect(l.route(alert({ kind: 'rally' }), 'me')).toBeNull();
    // Messages are not deduplicated here (the core routes them per op).
    expect(l.route(alert({}), 'me')).toEqual({ channel: 'team', id: null });
    expect(l.route(alert({}), 'me')).toEqual({ channel: 'team', id: null });
    expect(l.route(alert({ kind: 'rally', entity: 'rly:noe:r1' }), 'me')).toEqual({
      channel: 'rally',
      id: 'rly:noe:r1',
    });
    // Resolved SOS, rally still on: the SOS is cleared and may alarm again if reopened.
    expect(l.settle(new Set(['rly:noe:r1']))).toEqual(['sos:julie:s1']);
    expect(l.has('sos:julie:s1')).toBe(false);
    expect(l.settle(new Set(['rly:noe:r1']))).toEqual([]);
    expect(l.route(s, 'me')).toEqual({ channel: 'sos', id: 'sos:julie:s1' });
  });

  it('activeEntities: open SOS and the live rally point', () => {
    const { w, eve, bob, rb, re, sync } = crew();
    re.write(T0 + MIN, 'e.set', { k: 'sos', id: 's1', f: { la: 46.8, lo: -71.2 } });
    rb.write(T0 + MIN, 'e.set', { k: 'sos', id: 's2', f: { la: 46.8, lo: -71.2 } });
    rb.write(T0 + MIN + 1, 'e.set', { k: 'rly', id: 'r1', f: { la: 46.8, lo: -71.2 } });
    sync(T0 + 2 * MIN);
    rb.write(T0 + 3 * MIN, 'e.set', {
      k: 'sos',
      id: 's2',
      f: { res: true, rby: bob.id, rat: T0 + 3 * MIN },
    });
    sync(T0 + 4 * MIN);
    const data = w.root.data(T0 + 4 * MIN);
    const set = activeEntities(teamSos(data), teamRally(data));
    expect([...set].sort()).toEqual(
      [sosEntity({ owner: eve.id, id: 's1' }), rallyEntity({ owner: bob.id, id: 'r1' })].sort(),
    );
  });
});

describe('rally routing (#708)', () => {
  it('a teammate’s new rally point alerts everyone else on the rally channel, once', () => {
    const { w, bob, eve, rb, re, sync } = crew();
    sync(T0 + MIN);
    const body = { k: 'rly', id: 'r1', f: { la: 46.8, lo: -71.2, r: 60, at: null } };
    const op = rb.write(T0 + 2 * MIN, 'e.set', body)!;
    sync(T0 + 2 * MIN);
    const ctx = alertContext(re.state, re.data(T0 + 2 * MIN));
    const a = alertFor(re.state, op, body, eve.id, ctx)!;
    expect(a).toMatchObject({
      kind: 'rally',
      level: 'alert',
      author: bob.id,
      text: 'Gather at their position',
      url: `/team/rally/${bob.id}/r1`,
      entity: `rly:${bob.id}:r1`,
    });
    expect(alertChannel(a)).toBe('rally');
    // Never to its creator.
    expect(alertFor(rb.state, op, body, bob.id, alertContext(rb.state, rb.data()))).toBeNull();
    // Editing it later (a move, a text) is silent.
    const move = { k: 'rly', id: 'r1', f: { la: 46.81, lo: -71.2, tx: 'Lac' } };
    const m = rb.write(T0 + 3 * MIN, 'e.set', move)!;
    exchange(w.root, rb, T0 + 3 * MIN);
    exchange(w.root, re, T0 + 3 * MIN);
    expect(alertFor(re.state, m, move, eve.id, alertContext(re.state, re.data()))).toBeNull();
    // A named one says where.
    const named = { k: 'rly', id: 'r2', f: { la: 46.8, lo: -71.2, tx: 'Lac-Delage' } };
    const n = rb.write(T0 + 4 * MIN, 'e.set', named)!;
    sync(T0 + 4 * MIN);
    expect(alertFor(re.state, n, named, eve.id, alertContext(re.state, re.data()))).toMatchObject({
      text: 'Gather · Lac-Delage',
    });
  });

  it('an SOS alert carries its entity', () => {
    const { w, eve, re, sync } = crew();
    const body = { k: 'sos', id: 's1', f: { la: 46.8, lo: -71.2 } };
    const op = re.write(T0 + MIN, 'e.set', body)!;
    sync(T0 + MIN);
    const a = alertFor(
      w.root.state,
      op,
      body,
      w.owner.id,
      alertContext(w.root.state, w.root.data()),
    );
    expect(a).toMatchObject({ kind: 'sos', entity: `sos:${eve.id}:s1` });
    expect(alertChannel(a!)).toBe('sos');
  });
});

describe('RallyBuzzGate (#743)', () => {
  it('one buzz per raiser per minute; raisers apart; a clock set back never mutes', () => {
    const g = new RallyBuzzGate();
    expect(g.admit('noe', T0)).toBe(true);
    expect(g.admit('noe', T0 + 10_000)).toBe(false);
    expect(g.admit('julie', T0 + 10_000)).toBe(true);
    expect(g.admit('noe', T0 + RALLY_BUZZ_GAP_MS - 1)).toBe(false);
    expect(g.admit('noe', T0 + RALLY_BUZZ_GAP_MS)).toBe(true);
    // The phone's clock jumped back: buzz rather than stay silent for an hour.
    expect(g.admit('julie', T0 - 60 * MIN)).toBe(true);
    expect(new RallyBuzzGate(0).admit('noe', T0)).toBe(true);
  });
});
