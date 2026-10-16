import { admitBody } from '../team/actions';
import { makeJoinProof } from '../team/invite';
import {
  addMember,
  c,
  device,
  exchange,
  invite,
  joinReplica,
  MIN,
  newWorld,
  T0,
} from '../team/testing/fixtures';
import { TeamReplica } from '../team/replica';

import { joinConfirmed, provisionalJoinOf } from './provisional';

/**
 * A team with an owner, an admin (Ana) and a member (Bob). Bob's phone
 * admits Jo with the owner's invite; Jo's replica holds what Bob served.
 */
function scene() {
  const w = newWorld();
  const ana = device();
  const bob = device();
  addMember(w.root, ana, 'admin', T0);
  addMember(w.root, bob, 'member', T0 + 1);
  const ra = joinReplica(w, ana, w.root, T0 + 2);
  const rb = joinReplica(w, bob, w.root, T0 + 2);
  const inv = invite(w.root, T0 + MIN);
  exchange(w.root, rb, T0 + MIN + 1);
  const jo = device();
  rb.control(
    T0 + 2 * MIN,
    'm.admit',
    admitBody(c, w.teamId, makeJoinProof(c, inv.token, jo.keys), rb.sendKey()!),
  );
  const rj = new TeamReplica(c, w.teamId, jo.keys);
  exchange(rb, rj, T0 + 2 * MIN + 1);
  return { w, ana, bob, jo, ra, rb, rj };
}

describe('R-INV-4: a join over the internet is provisional', () => {
  it('names the invite and the admitting phone', () => {
    const { bob, jo, rj, w } = scene();
    expect(provisionalJoinOf(rj.state, jo.id)).toEqual({
      inviteId: expect.any(String),
      admittedBy: bob.id,
    });
    // The owner (genesis) and members added by hand are never provisional.
    expect(provisionalJoinOf(w.root.state, w.owner.id)).toBeUndefined();
    expect(provisionalJoinOf(rj.state, bob.id)).toBeUndefined();
  });

  it('the admitting phone alone confirms nothing, however recent its ops', () => {
    const { bob, jo, rb, rj } = scene();
    const join = provisionalJoinOf(rj.state, jo.id)!;
    rb.write(T0 + 3 * MIN, 'msg', { id: 'm1', th: 'team', tx: 'Welcome' });
    exchange(rb, rj, T0 + 3 * MIN + 1);
    expect(joinConfirmed(rj.state, join, [bob.id])).toBe(false);
  });

  it('a session with a second active member confirms it', () => {
    const { ana, bob, jo, rj } = scene();
    const join = provisionalJoinOf(rj.state, jo.id)!;
    expect(joinConfirmed(rj.state, join, [bob.id, ana.id])).toBe(true);
    expect(joinConfirmed(rj.state, join, ['not-a-member'])).toBe(false);
  });

  it('an op by another admin made after the invite confirms it; one made before doesn’t', () => {
    const { ra, jo, rb, rj, w } = scene();
    const join = provisionalJoinOf(rj.state, jo.id)!;
    // The owner's and Ana's ops so far all predate the invite.
    expect(joinConfirmed(rj.state, join, [])).toBe(false);
    exchange(w.root, ra, T0 + 3 * MIN);
    ra.write(T0 + 4 * MIN, 'msg', { id: 'a1', th: 'team', tx: 'Hi Jo' });
    exchange(ra, rb, T0 + 4 * MIN + 1);
    exchange(rb, rj, T0 + 4 * MIN + 2);
    expect(joinConfirmed(rj.state, join, [])).toBe(true);
  });
});
