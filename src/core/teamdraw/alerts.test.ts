import { addMember, device, MIN, T0 } from '@core/team/testing/fixtures';

import { DrawAlerts, drawNotifyLevel, type DrawEvent } from './alerts';
import { crew } from './testUtils';

const shape = (author: string, created: number, lifeMs: number | null): DrawEvent => ({
  kind: 'shape',
  author,
  created,
  expires: lifeMs === null ? null : created + lifeMs,
});

describe('drawing alerts', () => {
  it('one snackbar per author per session (no gap over 5 min); a new session alerts again', () => {
    const { w, bob, eve } = crew();
    const s = w.root.state;
    const a = new DrawAlerts();
    const me = w.owner.id;
    expect(a.admit(s, { kind: 'pen', author: bob.id }, me, T0)).toEqual({
      author: bob.id,
      snackbar: true,
      notify: null,
    });
    // The 30 s default: snackbar already shown, no notification (life < 1 min).
    expect(a.admit(s, shape(bob.id, T0 + 1000, 30_000), me, T0 + 1000)).toBeNull();
    expect(a.admit(s, { kind: 'pen', author: bob.id }, me, T0 + 4 * MIN)).toBeNull();
    // Another author has their own session.
    expect(a.admit(s, { kind: 'pen', author: eve.id }, me, T0 + 4 * MIN)?.snackbar).toBe(true);
    // Gaps under 5 min chain the session along; a longer gap starts a new one.
    expect(a.admit(s, { kind: 'pen', author: bob.id }, me, T0 + 8 * MIN)).toBeNull();
    expect(a.admit(s, { kind: 'pen', author: bob.id }, me, T0 + 13 * MIN + 1)?.snackbar).toBe(true);
  });

  it('a system notification only for a life of a minute or more, once per session', () => {
    const { w, bob } = crew();
    const s = w.root.state;
    const a = new DrawAlerts();
    const me = w.owner.id;
    expect(a.admit(s, shape(bob.id, T0, 59_999), me, T0)).toEqual({
      author: bob.id,
      snackbar: true,
      notify: null,
    });
    expect(a.admit(s, shape(bob.id, T0 + 1, 60_000), me, T0 + 1)).toEqual({
      author: bob.id,
      snackbar: false,
      notify: 'badge',
    });
    expect(a.admit(s, shape(bob.id, T0 + 2, null), me, T0 + 2)).toBeNull();
    // Never: notifies in a new session.
    expect(a.admit(s, shape(bob.id, T0 + 20 * MIN, null), me, T0 + 20 * MIN)).toEqual({
      author: bob.id,
      snackbar: true,
      notify: 'badge',
    });
  });

  it('never for an expired shape (not even the session), my own, or when I am not active', () => {
    const { w, bob, eve } = crew();
    const s = w.root.state;
    const a = new DrawAlerts();
    const me = eve.id;
    expect(a.admit(s, shape(bob.id, T0, 30_000), me, T0 + 30_000)).toBeNull();
    expect(a.admit(s, { kind: 'pen', author: bob.id }, me, T0 + 30_001)?.snackbar).toBe(true);
    expect(a.admit(s, { kind: 'pen', author: eve.id }, me, T0)).toBeNull();
    expect(a.admit(s, { kind: 'pen', author: bob.id }, device().id, T0)).toBeNull();
    expect(a.admit(s, { kind: 'pen', author: device().id }, me, T0)).toBeNull();
  });

  it('follows the team-message rules: admin or my lead alerts, a small team badges, a big one is silent', () => {
    const { w, bob, eve } = crew();
    expect(drawNotifyLevel(w.root.state, w.owner.id, eve.id)).toBe('alert');
    expect(drawNotifyLevel(w.root.state, bob.id, eve.id)).toBe('badge');
    expect(drawNotifyLevel(w.root.state, device().id, eve.id)).toBeNull();
    expect(drawNotifyLevel(w.root.state, bob.id, device().id)).toBeNull();
    // A lead of one of my groups alerts.
    w.root.control(T0 + 10, 'g.set', { id: 'g1' });
    const lead = device();
    const mine = device();
    addMember(w.root, lead, 'member', T0 + 11, [{ g: 'g1', lead: true }]);
    addMember(w.root, mine, 'member', T0 + 12, [{ g: 'g1' }]);
    const st = w.root.state;
    expect(st.members.get(lead.id)?.groups).toEqual([{ g: 'g1', lead: true }]);
    expect(drawNotifyLevel(st, lead.id, mine.id)).toBe('alert');
    expect(drawNotifyLevel(st, mine.id, lead.id)).toBe('badge');
    // Past 30 members, a plain member's drawing does not notify.
    for (let i = 0; i < 30; i++) addMember(w.root, device(), 'member', T0 + 100 + i);
    expect(drawNotifyLevel(w.root.state, bob.id, eve.id)).toBeNull();
    expect(drawNotifyLevel(w.root.state, w.owner.id, eve.id)).toBe('alert');
    // There, a long-lived shape still shows the snackbar, and only that.
    const a = new DrawAlerts();
    const big = w.root.state;
    expect(a.admit(big, shape(bob.id, T0 + MIN, null), eve.id, T0 + MIN)).toEqual({
      author: bob.id,
      snackbar: true,
      notify: null,
    });
    expect(a.admit(big, shape(bob.id, T0 + MIN, null), eve.id, T0 + MIN + 1)).toBeNull();
  });
});
