/**
 * Share live's group side (2.7.0 G10, #712) over the loopback mesh, on the
 * rig's manual queue, clock and timers:
 *
 * - a folder shared with a team is its own group, its members seeded from
 *   the team's roster with no invite;
 * - a teammate's phone picks it up ("Joining…") through the team's link,
 *   **whichever side dialled** (G6's open risk: only the dialling side used
 *   to open channels, so a joiner that answered never got it);
 * - the folder follows the team (a later member is added by the manager's phone);
 * - leaving forgets it and never picks it up again; stopping ends it everywhere.
 */
import { libraryView } from '@core/domains/library/tree';
import { newFolder, newItem } from '@core/domains/library/writes';
import type { TeamCrypto } from '@core/team/crypto';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { DEFAULT_INVITE, parseAnyInvite, webJoinLink } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import type { CreatedInvite, TeamSession } from '@data/team/teamSession';

import { LibraryGroups } from './libraryGroups';
import { Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

const c: TeamCrypto = nodeCrypto;

function phone(rig: Rig) {
  const disk = new MemoryTeamDisk();
  const service = new TeamService({
    c,
    disk,
    transport: rig.hub.createTransport(),
    now: rig.now,
    tickMs: 0,
    timers: rig.timers,
  });
  return { service, disk, lib: new LibraryGroups(service.host) };
}
type Phone = ReturnType<typeof phone>;

const active = (p: Phone): TeamSession => {
  const s = p.service.active;
  if (s === null) throw new Error('no active team');
  return s;
};

async function join(rig: Rig, admin: Phone, p: Phone, name: string): Promise<TeamSession> {
  const inv = active(admin).createInvite(DEFAULT_INVITE) as CreatedInvite;
  const token = parseAnyInvite(webJoinLink(inv.payload))!;
  if (!active(admin).meshRunning) await active(admin).startMesh();
  const attempt = await p.service.startJoin(token, name);
  await rig.settle();
  expect(attempt.state().phase).toBe('verify');
  const joined = await p.service.confirmJoin();
  if (typeof joined === 'string') throw new Error(joined);
  joined.watchFirstLinkMs = 0;
  await rig.settle();
  return joined;
}

/** A team of `a` (owner) and `b`, both on the LAN with the link upgraded. */
async function team(rig: Rig) {
  const a = phone(rig);
  const b = phone(rig);
  await a.service.createTeam({ name: 'Chic-Chocs', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
  await rig.settle();
  await join(rig, a, b, 'Julie');
  await active(b).startMesh();
  await rig.settle();
  active(a).tick();
  await rig.settle();
  return { a, b };
}

/** Run every phone's scan and ticks until the rig is quiet. */
async function round(rig: Rig, phones: Phone[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    for (const p of phones) await p.lib.scan();
    for (const p of phones) p.service.host.tick();
    await rig.settle();
  }
}

/** Phone `p`'s side of its one link (who dialled). */
const side = (p: Phone) => p.service.host.links()[0]?.side;

async function shareFolder(a: Phone): Promise<TeamSession> {
  const f = await a.lib.share({ name: 'Gaspésie 2026', root: 'gasp', team: active(a).teamId });
  if (typeof f === 'string') throw new Error(f);
  expect(f.writeData('e.set', newFolder('gasp', 'Gaspésie 2026') as never)).toEqual(
    expect.any(String),
  );
  expect(
    f.writeData('e.set', newItem('w1', 'wpt', 'Refuge', 'gasp', { ll: [-66.18, 48.92] }) as never),
  ).toEqual(expect.any(String));
  return f;
}

const libItems = (s: TeamSession | undefined) =>
  s === undefined ? [] : [...libraryView(s.replica.data(Date.now() + 1e12)).items.keys()].sort();

describe('Share live groups (2.7.0 G10)', () => {
  it('seeds the folder from the team: members added with no invite, a gref in the team', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    const f = await shareFolder(a);
    expect(f.record).toMatchObject({ app: 'lib', parent: active(a).teamId });
    expect(f.replica.isActiveMember(active(b).me)).toBe(true);
    expect(f.replica.state.members.get(active(b).me)?.role).toBe('member');
    expect(a.lib.meta(f)).toMatchObject({ app: 'lib', root: 'gasp', follow: true });
    // Shared folders are not teams on the team screens.
    expect(a.service.teams.map((t) => t.teamId)).toEqual([active(a).teamId]);
  });

  // Each phone's member id is random, so which side dials varies: run until
  // both cases happened (the lower member id's dial is the link kept).
  it.each(['initiator', 'responder'] as const)(
    'a teammate picks the folder up when it is the link %s',
    async (want) => {
      let done = false;
      for (let attempt = 0; attempt < 12 && !done; attempt++) {
        const rig = new Rig();
        const { a, b } = await team(rig);
        if (side(b) !== want) continue;
        done = true;
        const f = await shareFolder(a);
        await rig.settle();
        await round(rig, [a, b]);
        const picked = b.service.host.open(f.teamId);
        expect(picked).toBeDefined();
        expect(picked!.record).toMatchObject({ app: 'lib', parent: active(b).teamId });
        expect(picked!.pickupParent()).toBeUndefined();
        expect(picked!.replica.isActiveMember(active(b).me)).toBe(true);
        expect(libItems(picked)).toEqual(['w1']);
        // Edits now flow both ways on the folder's own channel.
        expect(
          picked!.writeData(
            'e.set',
            newItem('w2', 'wpt', 'Source', 'gasp', { ll: [-66.15, 48.93] }) as never,
          ),
        ).toEqual(expect.any(String));
        await round(rig, [a, b]);
        expect(libItems(f)).toEqual(['w1', 'w2']);
        expect(b.service.teams.map((t) => t.teamId)).toEqual([active(b).teamId]);
      }
      expect(done).toBe(true);
    },
  );

  it('follows the team: someone who joins the team later gets the folder', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    const f = await shareFolder(a);
    await round(rig, [a, b]);
    const d = phone(rig);
    await join(rig, a, d, 'Noé');
    await active(d).startMesh();
    await rig.settle();
    expect(a.lib.waitingMembers(f.teamId)).toEqual([active(d).me]);
    await round(rig, [a, b, d]);
    expect(f.replica.isActiveMember(active(d).me)).toBe(true);
    expect(a.lib.waitingMembers(f.teamId)).toEqual([]);
    await round(rig, [a, b, d]);
    expect(libItems(d.service.host.open(f.teamId))).toEqual(['w1']);
  });

  it('leaving forgets the folder and never picks it up again', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    const f = await shareFolder(a);
    await round(rig, [a, b]);
    await b.lib.leave(f.teamId);
    expect(b.service.host.open(f.teamId)).toBeUndefined();
    await round(rig, [a, b]);
    expect(b.service.host.open(f.teamId)).toBeUndefined();
    expect(b.service.host.libraries).toEqual([]);
  });

  it('stopping a share ends it on every phone', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    const f = await shareFolder(a);
    await round(rig, [a, b]);
    const id = f.teamId;
    expect(await a.lib.stop(id)).toBeNull();
    // The close was pushed to B before A forgot the group.
    await rig.settle();
    const ended = await b.lib.scan();
    expect(ended).toEqual([{ groupId: id, why: 'stopped' }]);
    expect(a.service.host.open(id)).toBeUndefined();
  });

  it('a pickup the sharer never added stays waiting and costs no strike', async () => {
    const rig = new Rig();
    const { a, b } = await team(rig);
    // A folder shared with nobody, announced in the team anyway.
    const f = await a.lib.share({ name: 'Mine', root: 'mine' });
    if (typeof f === 'string') throw new Error(f);
    active(a).writeData('e.set', { k: 'gref', id: f.teamId, f: { app: 'lib', name: 'Mine' } });
    await rig.settle();
    await round(rig, [a, b]);
    const pending = b.service.host.open(f.teamId);
    expect(pending?.pickupParent()).toBe(active(b).teamId);
    expect(libItems(pending)).toEqual([]);
    expect(b.service.host.links()).toHaveLength(1);
  });
});
