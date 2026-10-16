/**
 * An SOS from ANY of my teams rings the full alarm (owner decision
 * 2026-10-16), not only from the team on screen; every other kind from a team
 * not on screen stays silent. Real phones on the rig (manual queue, clock and
 * timers): Marc shows "Ridge" while Julie, in "Ridge" and "Hut", raises an
 * SOS in "Hut".
 *
 * The SOS-always-alerts guarantees (#752) hold for that team too: a resolve
 * (here or anywhere) ends the per-raiser alarm window, and a resolve and a
 * re-raise that arrive in one sync still ring.
 */
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { SOS_ALARM_WINDOW_MS, type TeamAlert } from '@core/teamui/alerts';
import { DEFAULT_INVITE, parseAnyInvite, webJoinLink } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import type { CreatedInvite, TeamSession } from '@data/team/teamSession';

import { Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

function phone(rig: Rig) {
  const service = new TeamService({
    c: nodeCrypto,
    disk: new MemoryTeamDisk(),
    transport: rig.hub.createTransport(),
    now: rig.now,
    tickMs: 0,
    timers: rig.timers,
  });
  const alerts: { alert: TeamAlert; teamId: string }[] = [];
  service.onAlert((alert, teamId) => alerts.push({ alert, teamId }));
  return { service, alerts };
}
type Phone = ReturnType<typeof phone>;

const active = (p: Phone): TeamSession => p.service.active!;

async function join(rig: Rig, admin: Phone, p: Phone, name: string): Promise<TeamSession> {
  const inv = active(admin).createInvite(DEFAULT_INVITE) as CreatedInvite;
  if (!active(admin).meshRunning) await active(admin).startMesh();
  await p.service.startJoin(parseAnyInvite(webJoinLink(inv.payload))!, name);
  await rig.settle();
  const joined = await p.service.confirmJoin();
  if (typeof joined === 'string') throw new Error(joined);
  joined.watchFirstLinkMs = 0;
  await rig.settle();
  return joined;
}

/** Marc (owner of both teams, showing Ridge) and Julie, linked; Hut rides the link. */
async function crew() {
  const rig = new Rig();
  const marc = phone(rig);
  const julie = phone(rig);
  const hut = await marc.service.createTeam({
    name: 'Hut',
    myName: 'Marc',
    lifetimeMs: lifetimeMs('14d'),
  });
  await join(rig, marc, julie, 'Julie');
  await active(julie).stopMesh();
  await marc.service.createTeam({ name: 'Ridge', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
  await join(rig, marc, julie, 'Julie');
  await active(julie).startMesh();
  await rig.settle();
  active(marc).tick();
  await rig.settle();
  expect(active(marc).view().name).toBe('Ridge');
  const hutId = hut.teamId;
  const at = (p: Phone) => p.service.host.open(hutId)!;
  expect(marc.service.host.links()[0]!.groups).toContain(hutId);
  return { rig, marc, julie, hutId, at, j: at(julie).me };
}

const sosRings = (p: Phone, teamId: string, raiser: string) =>
  p.alerts.filter(
    (x) =>
      x.teamId === teamId &&
      x.alert.kind === 'sos' &&
      x.alert.level === 'alert' &&
      x.alert.author === raiser,
  ).length;

describe('an SOS from a team not on screen rings the full alarm', () => {
  it('rings with its team, gets a receipt, and its resolve reaches the alarm; other kinds stay silent', async () => {
    const { rig, marc, julie, hutId, at, j } = await crew();
    // A message and a rally point in Hut: silent at Marc (not his team on screen).
    expect(at(julie).sendMessage('At the hut')).toBeNull();
    rig.t += 1_000;
    expect(at(julie).setRally(-71.2, 46.8, 'Here')).toBeNull();
    await rig.settle();
    expect(at(marc).rally()).not.toBeNull();
    expect(marc.alerts.filter((x) => x.teamId === hutId)).toEqual([]);

    // Her SOS rings the full alarm, naming the team it came from.
    rig.t += 1_000;
    expect(at(julie).raiseSos(-71.2, 46.8)).toBeNull();
    await rig.settle();
    expect(sosRings(marc, hutId, j)).toBe(1);
    const raise = marc.alerts.find((x) => x.teamId === hutId)!.alert;
    expect(raise).toMatchObject({ kind: 'sos', level: 'alert', priority: 2, sosPhase: 'raise' });
    // The alarm rang here, so Marc's phone acknowledges it (#708).
    const sos = at(julie).soses()[0]!;
    expect(at(julie).receipts({ kind: 'sos', owner: j, id: sos.id }).received).toBe(1);
    // …but owes nothing for the rally point of a team it never showed.
    const rally = at(julie).rally()!;
    expect(at(julie).receipts({ kind: 'rly', owner: rally.owner, id: rally.id }).received).toBe(0);

    // Her resolve reaches the alarm too (a badge that ends it).
    rig.t += 10_000;
    expect(at(julie).resolveSos(j, sos.id)).toBeNull();
    await rig.settle();
    expect(marc.alerts.filter((x) => x.teamId === hutId).map((x) => x.alert.sosPhase)).toEqual([
      'raise',
      'resolve',
    ]);
    // The team on screen still alerts as before.
    expect(active(julie).sendMessage('Ridge note')).toBeNull();
    await rig.settle();
    expect(marc.alerts.some((x) => x.alert.text === 'Ridge note')).toBe(true);
  });

  it.each([
    ['inside the 60 s cooldown (a reopen)', 20_000],
    ['past the cooldown (a new SOS)', 90_000],
  ])('resolved on THIS phone, then raised again %s: rings again (#752)', async (_what, gap) => {
    const { rig, marc, julie, hutId, at, j } = await crew();
    expect(at(julie).raiseSos(-71.2, 46.8)).toBeNull();
    await rig.settle();
    expect(sosRings(marc, hutId, j)).toBe(1);
    // Marc (an admin of Hut) resolves it from his phone, Hut still not on screen.
    rig.t += 30_000;
    const open = at(marc)
      .soses()
      .find((s) => !s.resolved)!;
    expect(at(marc).resolveSos(j, open.id)).toBeNull();
    await rig.settle();
    expect(
      at(julie)
        .soses()
        .every((s) => s.resolved),
    ).toBe(true);
    rig.t += gap;
    expect(rig.t - open.at).toBeLessThan(SOS_ALARM_WINDOW_MS);
    expect(at(julie).raiseSos(-71.21, 46.81)).toBeNull();
    await rig.settle();
    expect(sosRings(marc, hutId, j)).toBe(2);
    // Synced again, the same SOS never rings twice.
    active(marc).tick();
    await rig.settle();
    expect(sosRings(marc, hutId, j)).toBe(2);
  });

  it('the resolve and the re-raise arrive in one sync (the phone was away): rings again', async () => {
    const { rig, marc, julie, hutId, at, j } = await crew();
    expect(at(julie).raiseSos(-71.2, 46.8)).toBeNull();
    await rig.settle();
    expect(sosRings(marc, hutId, j)).toBe(1);
    // Marc walks out of range; Julie resolves hers and raises again without him.
    await active(marc).stopMesh();
    await active(julie).stopMesh();
    await rig.settle();
    rig.t += 30_000;
    expect(at(julie).resolveSos(j, at(julie).soses()[0]!.id)).toBeNull();
    rig.t += 20_000;
    expect(at(julie).raiseSos(-71.21, 46.81)).toBeNull();
    // Back in range: both writes in one catch-up.
    await active(marc).startMesh();
    await active(julie).startMesh();
    await rig.settle();
    active(marc).tick();
    await rig.settle();
    expect(
      at(marc)
        .soses()
        .some((s) => !s.resolved),
    ).toBe(true);
    expect(sosRings(marc, hutId, j)).toBe(2);
  });
});
