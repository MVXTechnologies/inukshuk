import type { Json } from '@core/team/canonical';
import { activeMembers, cutFor } from '@core/team/membership';
import { routeDelivery } from '@core/team/notify';
import type { TeamReplica } from '@core/team/replica';
import {
  addMember,
  c,
  device,
  exchange,
  joinReplica,
  MIN,
  newWorld,
  T0,
  type World,
} from '@core/team/testing/fixtures';
import { createTeam, rotateBody } from '@core/team/actions';
import { TeamReplica as Replica } from '@core/team/replica';

import { SYS_LEAVE, SYS_PROFILE, SYS_TEAM, nameText } from './system';
import {
  audienceLabel,
  buildTeamView,
  messageDelivery,
  placeholderName,
  type TeamView,
} from './view';

let n = 0;
const nextId = () => `m${++n}`;

function viewOf(r: TeamReplica, now: number): TeamView {
  return buildTeamView({
    state: r.state,
    data: r.data(now),
    me: r.id,
    now,
    labels: (op) => r.labels(op),
  });
}

function say(r: TeamReplica, now: number, tx: string, extra: Record<string, unknown> = {}) {
  const op = r.write(now, 'msg', { id: nextId(), th: 'team', tx }, extra);
  if (!op) throw new Error('no key');
  return op;
}

function profile(r: TeamReplica, now: number, name: string) {
  r.write(now, 'msg', { id: nextId(), th: SYS_PROFILE, tx: nameText(name) });
}

/** A named team: owner Marc-André, admin Julie, member Simon, guest Ana. */
function crew(): {
  w: World;
  owner: TeamReplica;
  julie: TeamReplica;
  simon: TeamReplica;
  ana: TeamReplica;
} {
  const team = createTeam(c, device().keys, T0, { name: 'Relevé MSA' });
  const owner = new Replica(c, team.teamId, team.writer.keys, team.writer.cursor);
  owner.addKey(team.key);
  owner.ingest([team.genesis.env], T0);
  const w: World = {
    teamId: team.teamId,
    owner: { keys: team.writer.keys, id: owner.id, x: '' },
    replicas: new Map([[owner.id, owner]]),
    root: owner,
  };
  const dj = device();
  const ds = device();
  const da = device();
  addMember(owner, dj, 'member', T0 + 1);
  owner.control(T0 + 2, 'm.update', { m: dj.id, r: 'admin' });
  addMember(owner, ds, 'member', T0 + 3);
  addMember(owner, da, 'guest', T0 + 4);
  const julie = joinReplica(w, dj, owner, T0 + 5);
  const simon = joinReplica(w, ds, owner, T0 + 5);
  const ana = joinReplica(w, da, owner, T0 + 5);
  profile(owner, T0 + 10, 'Marc-André');
  profile(julie, T0 + 11, 'Julie Tremblay');
  profile(simon, T0 + 12, 'Simon Gagnon');
  profile(ana, T0 + 13, 'Ana Ruiz');
  for (const r of [julie, simon, ana]) exchange(owner, r, T0 + 20);
  for (const r of [julie, simon, ana]) exchange(owner, r, T0 + 21);
  return { w, owner, julie, simon, ana };
}

describe('buildTeamView: roster', () => {
  it('names, roles, colours and order (me first, then by role)', () => {
    const { owner, simon } = crew();
    const v = viewOf(simon, T0 + MIN);
    expect(v.name).toBe('Relevé MSA');
    expect(v.members.map((m) => [m.name, m.role, m.isMe])).toEqual([
      ['Simon Gagnon', 'member', true],
      ['Marc-André', 'owner', false],
      ['Julie Tremblay', 'admin', false],
      ['Ana Ruiz', 'guest', false],
    ]);
    // Colours follow join order and are the same on every phone.
    const ov = viewOf(owner, T0 + MIN);
    const colour = (view: TeamView, name: string) =>
      view.members.find((m) => m.name === name)!.color;
    for (const name of ['Marc-André', 'Julie Tremblay', 'Simon Gagnon', 'Ana Ruiz']) {
      expect(colour(v, name)).toBe(colour(ov, name));
    }
    expect(new Set(v.members.map((m) => m.color)).size).toBe(4);
    expect(v.members[1]!.initials).toBe('MA'); // hyphenated first names split, like the mockup
    expect(v.members[2]!.initials).toBe('JT');
    expect(v.activeCount).toBe(4);
  });

  it('shows a placeholder until a profile arrives', () => {
    const w = newWorld();
    const d = device();
    addMember(w.root, d, 'member', T0 + 1);
    const v = viewOf(w.root, T0 + 2);
    const row = v.members.find((m) => m.id === d.id)!;
    expect(row.named).toBe(false);
    expect(row.name).toBe(placeholderName(d.id));
    expect(v.name).toBe('Team');
  });

  it('offers exactly the actions the core allows', () => {
    const { owner, julie, simon } = crew();
    const byName = (view: TeamView, name: string) => view.members.find((m) => m.name === name)!;
    const ov = viewOf(owner, T0 + MIN);
    expect(byName(ov, 'Simon Gagnon').actions).toEqual({
      promote: 'admin',
      demote: 'guest',
      remove: true,
      setGroup: false,
    });
    expect(byName(ov, 'Julie Tremblay').actions).toMatchObject({ promote: null, demote: 'member' });
    expect(byName(ov, 'Marc-André').actions.remove).toBe(false); // me, and the owner
    // An admin manages members and guests, never admins, and cannot mint admins.
    const jv = viewOf(julie, T0 + MIN);
    expect(byName(jv, 'Simon Gagnon').actions).toMatchObject({ promote: null, demote: 'guest' });
    expect(byName(jv, 'Ana Ruiz').actions).toMatchObject({ promote: 'member', remove: true });
    expect(byName(jv, 'Marc-André').actions.remove).toBe(false);
    // A member manages nobody.
    const sv = viewOf(simon, T0 + MIN);
    expect(sv.members.every((m) => !m.actions.remove && m.actions.promote === null)).toBe(true);
    expect(sv.isAdmin).toBe(false);
    expect(jv.isAdmin).toBe(true);
  });

  it('never offers to re-promote a demoted admin (v1 rule)', () => {
    const { owner, julie } = crew();
    owner.control(T0 + MIN, 'm.update', {
      m: julie.id,
      r: 'member',
      cut: cutFor(owner.state, julie.id),
    });
    const row = viewOf(owner, T0 + 2 * MIN).members.find((m) => m.id === julie.id)!;
    expect(row.role).toBe('member');
    expect(row.actions.promote).toBeNull();
    expect(row.actions.demote).toBe('guest');
  });

  it('flags a member who posted sys:leave until an admin removes them', () => {
    const { owner, simon } = crew();
    simon.write(T0 + MIN, 'msg', { id: nextId(), th: SYS_LEAVE, tx: '{}' });
    exchange(owner, simon, T0 + MIN);
    expect(viewOf(owner, T0 + MIN).members.find((m) => m.id === simon.id)!.left).toBe(true);
    owner.control(T0 + 2 * MIN, 'm.remove', { m: simon.id, cut: cutFor(owner.state, simon.id) });
    const row = viewOf(owner, T0 + 2 * MIN).members.find((m) => m.id === simon.id)!;
    expect(row.active).toBe(false);
    expect(row.left).toBe(false);
    expect(viewOf(owner, T0 + 2 * MIN).needsRotation).toBe(true);
  });

  it('names the team from sys:team when the genesis key never reached me', () => {
    const { owner, julie } = crew();
    const rotated = rotateBody(c, owner.teamId, activeMembers(owner.state));
    owner.control(T0 + MIN, 'k.rotate', rotated.body);
    julie.ingest(
      owner.log.logged().map((o) => o.env),
      T0 + MIN,
    );
    // An admin re-posts the name under the new key.
    julie.write(T0 + 2 * MIN, 'msg', { id: nextId(), th: SYS_TEAM, tx: nameText('Relevé MSA') });
    const late = device();
    addMember(owner, late, 'member', T0 + 3 * MIN);
    exchange(owner, julie, T0 + 3 * MIN);
    const lateReplica = new Replica(c, owner.teamId, late.keys);
    lateReplica.ingest(
      owner.log.logged().map((o) => o.env),
      T0 + 4 * MIN,
    );
    expect(lateReplica.labels(lateReplica.state.genesis!)).toBeUndefined();
    expect(viewOf(lateReplica, T0 + 4 * MIN).name).toBe('Relevé MSA');
  });
});

describe('buildTeamView: groups', () => {
  it('lists the tree depth-first with names and member counts', () => {
    const { owner, simon } = crew();
    owner.control(T0 + MIN, 'g.set', { id: 'crew' }, { name: 'Trail crew' });
    owner.control(T0 + MIN + 1, 'g.set', { id: 'north', p: 'crew' }, { name: 'North loop' });
    owner.control(T0 + MIN + 2, 'g.set', { id: 'aid' }, { name: 'Aid station' });
    owner.control(T0 + MIN + 3, 'm.update', { m: simon.id, g: [{ g: 'north', lead: true }] });
    const v = viewOf(owner, T0 + 2 * MIN);
    expect(v.groups.map((g) => [g.name, g.depth, g.members])).toEqual([
      ['Aid station', 0, 0],
      ['Trail crew', 0, 0],
      ['North loop', 1, 1],
    ]);
    const row = v.members.find((m) => m.id === simon.id)!;
    expect(row.groups).toEqual([{ id: 'north', name: 'North loop', lead: true }]);
    expect(row.actions.setGroup).toBe(true);
  });
});

describe('buildTeamView: messages', () => {
  it('shows the team channel in order, hides sys: threads and audiences I am not in', () => {
    const { owner, julie, simon } = crew();
    say(owner, T0 + MIN, 'Départ 9 h au stationnement');
    say(julie, T0 + MIN + 1, 'Admins only', { aud: { r: ['admin', 'owner'] } });
    say(simon, T0 + MIN + 2, 'Je pars du sentier nord', { mn: [owner.id] } as never);
    for (const r of [julie, simon]) exchange(owner, r, T0 + 2 * MIN);
    for (const r of [julie, simon]) exchange(owner, r, T0 + 2 * MIN);
    const sv = viewOf(simon, T0 + 3 * MIN);
    expect(sv.messages.map((m) => m.text)).toEqual([
      'Départ 9 h au stationnement',
      'Je pars du sentier nord',
    ]);
    const ov = viewOf(owner, T0 + 3 * MIN);
    expect(ov.messages.map((m) => [m.text, m.audience, m.mine])).toEqual([
      ['Départ 9 h au stationnement', null, true],
      ['Admins only', 'Admins', false],
      ['Je pars du sentier nord', null, false],
    ]);
    expect(ov.messages[1]!.authorName).toBe('Julie Tremblay');
  });
});

describe('audienceLabel', () => {
  const g = (id: string) => ({ crew: 'Trail crew' })[id] ?? 'Group';
  const m = (id: string) => `@${id}`;
  it('reads like a recipient line', () => {
    expect(audienceLabel(undefined, g, m)).toBeNull();
    expect(audienceLabel({ r: ['admin', 'owner'] }, g, m)).toBe('Admins');
    expect(audienceLabel({ g: ['crew'] }, g, m)).toBe('Trail crew');
    expect(audienceLabel({ g: ['crew'], l: true }, g, m)).toBe('Trail crew leads');
    expect(audienceLabel({ l: true }, g, m)).toBe('Group leads');
    expect(audienceLabel({ r: ['guest'], m: ['abc'] }, g, m)).toBe('Guests, @abc');
  });
});

describe('messageDelivery agrees with the core routing', () => {
  it('for small and >30-member teams, admins, leads, priorities and mentions', () => {
    const w = newWorld();
    const people = Array.from({ length: 34 }, () => device());
    people.forEach((d, i) => addMember(w.root, d, i === 0 ? 'admin' : 'member', T0 + 1 + i));
    const me = joinReplica(w, people[5]!, w.root, T0 + 100);
    const admin = joinReplica(w, people[0]!, w.root, T0 + 100);
    const member = joinReplica(w, people[9]!, w.root, T0 + 100);
    const cases: [TeamReplica, Record<string, unknown>, Json][] = [
      [member, {}, { id: 'a', th: 'team', tx: 'chatter' }],
      [admin, {}, { id: 'b', th: 'team', tx: 'from admin' }],
      [member, { pr: 1 }, { id: 'c', th: 'team', tx: 'important' }],
      [member, { pr: 2 }, { id: 'd', th: 'team', tx: 'urgent' }],
      [member, {}, { id: 'e', th: 'team', tx: 'hey', mn: [me.id] }],
      [member, { aud: { m: [me.id, member.id] } }, { id: 'f', th: 'team', tx: 'narrow' }],
      [member, { aud: { r: ['admin'] } }, { id: 'g', th: 'team', tx: 'not me' }],
    ];
    for (const [from, opts, body] of cases) {
      const op = from.write(T0 + 200, 'msg', body, opts)!;
      me.ingest(
        from.log.logged().map((o) => o.env),
        T0 + 201,
      );
      const core = routeDelivery(me.state, op, body, me.id);
      const b = body as { mn?: string[] };
      const mine = messageDelivery(
        me.state,
        {
          owner: op.env.au,
          ...(op.env.aud ? { aud: op.env.aud } : {}),
          ...(op.env.pr ? { pr: op.env.pr } : {}),
          mentions: b.mn ?? [],
        },
        me.id,
      );
      expect([body, mine]).toEqual([body, core]);
    }
    // The 30-member rule: plain chatter in this 35-person team is silent.
    const chatter = member.write(T0 + 300, 'msg', { id: 'z', th: 'team', tx: 'x' })!;
    expect(routeDelivery(me.state, chatter, { id: 'z', th: 'team', tx: 'x' }, me.id)).toBe(
      'silent',
    );
  });
});
