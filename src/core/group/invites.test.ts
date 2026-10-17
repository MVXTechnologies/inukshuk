import { toB64u } from '../team/bytes';
import { inviteIdOf } from '../team/invite';
import {
  addMember,
  c,
  DAY,
  device,
  invite,
  joinReplica,
  MIN,
  newWorld,
  T0,
} from '../team/testing/fixtures';
import { rotateBody } from '../team/actions';
import { activeMembers, cutFor } from '../team/membership';

import { invitesToRevoke, inviteOpen, inviteRooms, irdvFields, lastRemoval } from './invites';
import { IRDV } from './meta';
import { inviteRendezvousSecret } from './rdv';

function world() {
  const w = newWorld();
  const write = (now: number, token: Parameters<typeof irdvFields>[1]) => {
    const { id, f } = irdvFields(c, token);
    return w.root.write(now, 'e.set', { k: IRDV, id, f });
  };
  return { w, write };
}

describe('invite rooms (G7)', () => {
  it('the irdv record carries the invite’s rendezvous secret under its invite id', () => {
    const { w } = world();
    const inv = invite(w.root, T0);
    const { id, f } = irdvFields(c, inv.token);
    expect(id).toBe(inviteIdOf(c, inv.token));
    expect(f['s']).toBe(toB64u(inviteRendezvousSecret(c, w.teamId, inv.token.seed)));
  });

  it('a member listens in the rooms of open invites with an irdv record', () => {
    const { w, write } = world();
    const a = invite(w.root, T0);
    write(T0 + 1, a.token);
    const b = invite(w.root, T0 + 2); // no irdv: a LAN-only invite (2.6 admin)
    const now = T0 + 3;
    const rooms = inviteRooms(w.root.data(now), w.root.state, now);
    expect(rooms.map((r) => r.inviteId)).toEqual([inviteIdOf(c, a.token)]);
    expect(rooms[0]!.ir).toEqual(inviteRendezvousSecret(c, w.teamId, a.token.seed));
    expect(b.op).toBeDefined();
  });

  it('stops listening once the invite expires, is used up or revoked', () => {
    const { w, write } = world();
    const a = invite(w.root, T0, { expiresAt: T0 + 10 * MIN });
    write(T0 + 1, a.token);
    expect(inviteRooms(w.root.data(T0 + 2), w.root.state, T0 + 2)).toHaveLength(1);
    expect(inviteRooms(w.root.data(T0 + 11 * MIN), w.root.state, T0 + 11 * MIN)).toEqual([]);

    const b = invite(w.root, T0 + 3);
    write(T0 + 4, b.token);
    w.root.control(T0 + 5, 'i.revoke', { inv: inviteIdOf(c, b.token) });
    const inv = w.root.state.invites.get(inviteIdOf(c, b.token))!;
    expect(inviteOpen(inv, T0 + 6)).toBe(false);
    expect(inviteOpen({ ...inv, revoked: false, uses: 1 }, T0 + 6)).toBe(false);
    expect(inviteOpen({ ...inv, revoked: false }, T0 + 6)).toBe(true);
  });

  it('R-INV-3: a removal revokes the invites made before it; a phone already ignores them', () => {
    const { w, write } = world();
    const eve = device();
    addMember(w.root, eve, 'member', T0);
    joinReplica(w, eve, w.root, T0);
    const before = invite(w.root, T0 + MIN);
    write(T0 + MIN + 1, before.token);
    expect(invitesToRevoke(w.root.state, T0 + 2 * MIN)).toEqual([inviteIdOf(c, before.token)]);

    // Eve is removed; until the revokes arrive, her old invite's room is not listened in.
    w.root.control(T0 + 3 * MIN, 'm.remove', { m: eve.id, cut: cutFor(w.root.state, eve.id) });
    expect(lastRemoval(w.root.state)).toBeDefined();
    const now = T0 + 4 * MIN;
    expect(inviteRooms(w.root.data(now), w.root.state, now)).toEqual([]);

    // An invite made after the removal (and the rotation it forces) is listened in.
    w.root.control(
      T0 + 4 * MIN + 1,
      'k.rotate',
      rotateBody(c, w.teamId, activeMembers(w.root.state)).body,
    );
    const after = invite(w.root, T0 + 5 * MIN);
    write(T0 + 5 * MIN + 1, after.token);
    const later = T0 + 6 * MIN;
    expect(inviteRooms(w.root.data(later), w.root.state, later).map((r) => r.inviteId)).toEqual([
      inviteIdOf(c, after.token),
    ]);
  });

  it('ignores an irdv record whose secret is unreadable', () => {
    const { w } = world();
    const a = invite(w.root, T0, { expiresAt: T0 + DAY });
    w.root.write(T0 + 1, 'e.set', { k: IRDV, id: inviteIdOf(c, a.token), f: { s: 'short' } });
    expect(inviteRooms(w.root.data(T0 + 2), w.root.state, T0 + 2)).toEqual([]);
  });
});
