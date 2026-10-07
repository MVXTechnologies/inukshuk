import { audienceMembers, LARGE_TEAM, routeDelivery } from './notify';
import type { TeamReplica } from './replica';
import {
  addMember,
  device,
  exchange,
  joinReplica,
  MIN,
  newWorld,
  T0,
  type Device,
} from './testing/fixtures';

/** Owner + admin + a lead of "north" + members (some in north). */
function event(size: number) {
  const w = newWorld();
  w.root.control(T0 + 1, 'g.set', { id: 'north' });
  w.root.control(T0 + 2, 'g.set', { id: 'south' });
  const admin = device();
  const lead = device();
  addMember(w.root, admin, 'admin', T0 + 3);
  addMember(w.root, lead, 'member', T0 + 4, [{ g: 'north', lead: true }]);
  const members: Device[] = [];
  for (let i = 0; i < size; i++) {
    const d = device();
    addMember(w.root, d, 'member', T0 + 5 + i, [{ g: i % 2 === 0 ? 'north' : 'south' }]);
    members.push(d);
  }
  const ra = joinReplica(w, admin, w.root, T0 + 100);
  const rl = joinReplica(w, lead, w.root, T0 + 100);
  const rm = joinReplica(w, members[0]!, w.root, T0 + 100); // in north
  const rs = joinReplica(w, members[1]!, w.root, T0 + 100); // in south
  return { w, admin, lead, members, ra, rl, rm, rs };
}

const deliver = (r: TeamReplica, opId: string) => {
  const op = r.log.get(opId) ?? r.liveEphemeral(T0 + 99 * MIN).find((o) => o.id === opId)!;
  return routeDelivery(r.state, op, r.decode(op), r.id);
};

describe('routeDelivery', () => {
  it('small team: messages badge, mentions and DMs alert, my own ops are silent to me', () => {
    const { w, rm, rs, members } = event(4);
    const hi = rm.write(T0 + MIN, 'msg', { id: 'a', th: 'team', tx: 'hi' })!;
    const ping = rm.write(T0 + MIN, 'msg', {
      id: 'b',
      th: 'team',
      tx: '@you',
      mn: [members[1]!.id],
    })!;
    const dm = rm.write(
      T0 + MIN,
      'msg',
      { id: 'c', th: `dm:${members[1]!.id}`, tx: 'psst' },
      { sealedTo: [members[1]!.id] },
    )!;
    exchange(rm, rs, T0 + 2 * MIN);
    exchange(rm, w.root, T0 + 2 * MIN);
    expect(deliver(rs, hi.id)).toBe('badge');
    expect(deliver(rs, ping.id)).toBe('alert');
    expect(deliver(rs, dm.id)).toBe('alert');
    expect(deliver(rm, hi.id)).toBe('none');
    // The owner stores the DM but is not a recipient.
    expect(deliver(w.root, dm.id)).toBe('none');
  });

  it('large event: rank-and-file chatter is silent, leads and admins still badge', () => {
    const { rm, rs, rl, ra } = event(LARGE_TEAM + 2);
    const chatter = rm.write(T0 + MIN, 'msg', { id: 'a', th: 'team', tx: 'anyone seen my hat' })!;
    const fromLead = rl.write(T0 + MIN, 'msg', { id: 'b', th: 'team', tx: 'north regroup at 3' })!;
    const fromAdmin = ra.write(T0 + MIN, 'msg', { id: 'c', th: 'team', tx: 'briefing' })!;
    for (const r of [rm, rl, ra]) exchange(r, rs, T0 + 2 * MIN);
    exchange(rs, rm, T0 + 2 * MIN);
    expect(deliver(rs, chatter.id)).toBe('silent');
    expect(deliver(rs, fromAdmin.id)).toBe('badge');
    expect(deliver(rs, fromLead.id)).toBe('silent'); // rs is in south; the lead leads north
    expect(deliver(rm, fromLead.id)).toBe('badge'); // rm is in north
  });

  it('targeting: outside the audience is none; urgent and important escalate', () => {
    const { rm, rs, rl, ra } = event(4);
    const north = rl.write(
      T0 + MIN,
      'msg',
      { id: 'a', th: 'g:north', tx: 'north only' },
      { aud: { g: ['north'] }, pr: 2 },
    )!;
    const important = rm.write(
      T0 + MIN,
      'msg',
      { id: 'b', th: 'team', tx: 'heads up' },
      { pr: 1 },
    )!;
    const adminImportant = ra.write(
      T0 + MIN,
      'msg',
      { id: 'c', th: 'team', tx: 'storm' },
      { pr: 1 },
    )!;
    for (const r of [rl, ra]) {
      exchange(r, rm, T0 + 2 * MIN);
      exchange(r, rs, T0 + 2 * MIN);
    }
    exchange(rm, rs, T0 + 2 * MIN);
    expect(deliver(rm, north.id)).toBe('alert');
    expect(deliver(rs, north.id)).toBe('none');
    expect(deliver(rs, important.id)).toBe('badge');
    expect(deliver(rs, adminImportant.id)).toBe('alert');
  });

  it('positions are silent; a task assigned to me alerts, other edits are silent', () => {
    const { w, rm, rs, members } = event(2);
    const pos = rm.position(T0 + MIN, { la: 46.8, lo: -71.2, at: T0 + MIN })!;
    const task = w.root.write(T0 + MIN, 'e.set', {
      k: 'task',
      id: 't1',
      f: { title: 'Check hut', assignee: members[1]!.id },
    })!;
    const wpt = w.root.write(T0 + MIN, 'e.set', { k: 'wpt', id: 'w1', f: { name: 'Hut' } })!;
    exchange(rm, rs, T0 + 2 * MIN);
    exchange(w.root, rs, T0 + 2 * MIN);
    expect(deliver(rs, pos.id)).toBe('silent');
    expect(deliver(rs, task.id)).toBe('alert');
    expect(deliver(rs, wpt.id)).toBe('silent');
  });

  it('audienceMembers resolves selectors to active members', () => {
    const { w, lead, admin } = event(4);
    expect(audienceMembers(w.root.state, { l: true })).toEqual([lead.id]);
    expect(audienceMembers(w.root.state, { r: ['admin', 'owner'] }).sort()).toEqual(
      [admin.id, w.owner.id].sort(),
    );
    expect(audienceMembers(w.root.state, undefined)).toHaveLength(7);
  });
});
