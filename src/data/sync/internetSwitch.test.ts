/**
 * The team's internet switch (#705, G7): new teams are created with it on
 * (owner, 2026-10-15), an admin turns it on or off for everyone, a member
 * can't, and every member's phone follows the admins' `net` record.
 */
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { DEFAULT_INVITE, parseAnyInvite, webJoinLink } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import type { CreatedInvite, TeamSession } from '@data/team/teamSession';

import { Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

const phone = (rig: Rig) =>
  new TeamService({
    c: nodeCrypto,
    disk: new MemoryTeamDisk(),
    transport: rig.hub.createTransport(),
    now: rig.now,
    tickMs: 0,
    timers: rig.timers,
  });

const active = (p: TeamService): TeamSession => p.active!;

async function team(rig: Rig, internet?: boolean) {
  const a = phone(rig);
  await a.createTeam({
    name: 'Chic-Chocs',
    myName: 'Marc',
    lifetimeMs: lifetimeMs('14d'),
    ...(internet !== undefined ? { internet } : {}),
  });
  await rig.settle();
  return a;
}

async function join(rig: Rig, admin: TeamService): Promise<TeamService> {
  const b = phone(rig);
  const inv = active(admin).createInvite(DEFAULT_INVITE) as CreatedInvite;
  await active(admin).startMesh();
  await b.startJoin(parseAnyInvite(webJoinLink(inv.payload))!, 'Julie');
  await rig.settle();
  const joined = await b.confirmJoin();
  if (typeof joined === 'string') throw new Error(joined);
  joined.watchFirstLinkMs = 0;
  await active(b).startMesh();
  await rig.settle();
  return b;
}

describe('the team’s internet switch', () => {
  it('is on for a new team unless its creator turned it off', async () => {
    const rig = new Rig();
    expect(active(await team(rig)).internetOn).toBe(true);
    expect(active(await team(rig, false)).internetOn).toBe(false);
  });

  it('an admin turns it off and on for every member; a member can’t', async () => {
    const rig = new Rig();
    const a = await team(rig, false);
    const b = await join(rig, a);
    expect(active(b).internetOn).toBe(false);

    expect(active(b).setInternet(true)).toBe('not-allowed');
    expect(active(a).setInternet(true)).toBeNull();
    expect(active(a).setInternet(true)).toBe('no-change');
    await rig.settle();
    expect(active(b).internetOn).toBe(true);

    expect(active(a).setInternet(false)).toBeNull();
    await rig.settle();
    expect(active(a).internetOn).toBe(false);
    expect(active(b).internetOn).toBe(false);
  });
});
