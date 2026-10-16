/**
 * A re-raised SOS after a resolve ALWAYS rings (owner decision, 2.6.1): the
 * per-raiser alarm window (`SOS_ALARM_WINDOW_MS`) ends with the resolve,
 * whoever resolved it and however the resolve reached this phone.
 *
 * Three real phones on the loopback mesh (the real sessions, folds, alert
 * routing and throttle): Marc (owner, admin), Julie (raiser), Noé (member).
 * The clock is the test's, so a re-raise can be inside the 60 s reopen
 * cooldown (a reopen of the same SOS) or past it (a new SOS id) while still
 * inside the 5 min alarm window.
 */
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import type { TeamAlert } from '@core/teamui/alerts';
import { DEFAULT_INVITE, parseAnyInvite, webJoinLink } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { LoopbackMeshHub } from './loopbackMesh';
import { MemoryTeamDisk } from './teamDisk';
import { TeamService } from './teamService';
import type { CreatedInvite, TeamSession } from './teamSession';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

let clock = Date.now();
const now = () => clock;

async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function phone(hub: LoopbackMeshHub) {
  const service = new TeamService({
    c: nodeCrypto,
    disk: new MemoryTeamDisk(),
    transport: hub.createTransport(),
    tickMs: 0,
    now,
  });
  const alerts: TeamAlert[] = [];
  service.onAlert((a) => alerts.push(a));
  return { service, alerts };
}
type Phone = ReturnType<typeof phone>;

const active = (p: Phone): TeamSession => {
  const s = p.service.active;
  if (s === null) throw new Error('no active team');
  return s;
};

async function join(hub: LoopbackMeshHub, admin: Phone, name: string): Promise<Phone> {
  const inv = active(admin).createInvite(DEFAULT_INVITE) as CreatedInvite;
  const p = phone(hub);
  const attempt = await p.service.startJoin(parseAnyInvite(webJoinLink(inv.payload))!, name);
  await until(() => attempt.state().phase === 'verify', `${name} admitted`);
  await p.service.confirmJoin();
  await active(p).startMesh();
  await until(
    () =>
      active(admin)
        .view()
        .members.some((m) => m.name === name && m.active),
    `${name} active`,
  );
  return p;
}

/** Marc (owner), Julie and Noé, all linked. */
async function crew() {
  const hub = new LoopbackMeshHub();
  const marc = phone(hub);
  await marc.service.createTeam({
    name: 'Les Sentiers',
    myName: 'Marc',
    lifetimeMs: lifetimeMs('14d'),
  });
  await active(marc).startMesh();
  const julie = await join(hub, marc, 'Julie');
  const noe = await join(hub, marc, 'Noé');
  await until(
    () =>
      [marc, julie, noe].every(
        (p) =>
          active(p)
            .view()
            .members.filter((m) => m.active).length === 3,
      ),
    'everyone sees everyone',
  );
  const all = [marc, julie, noe];
  return { hub, marc, julie, noe, all };
}

/** The SOS alarms (level `alert`, not a badge) this phone raised for `raiser`. */
const rings = (p: Phone, raiser: string) =>
  p.alerts.filter((a) => a.kind === 'sos' && a.level === 'alert' && a.author === raiser).length;

const openSos = (p: Phone, owner: string) =>
  active(p)
    .soses()
    .find((s) => s.owner === owner && !s.resolved);

/** Let the mesh deliver whatever is in flight (a re-ring arriving late would show). */
const settle = () => new Promise((r) => setTimeout(r, 60));

async function stop(all: Phone[]) {
  for (const p of all) await active(p).stopMesh();
}

beforeEach(() => {
  clock = Date.now();
});

describe('a re-raised SOS after a resolve always rings', () => {
  it.each([
    ['inside the 60 s cooldown (a reopen)', 20_000],
    ['past the cooldown (a new SOS)', 90_000],
  ])('resolved on THIS phone (an admin), then Julie raises again %s', async (_what, gap) => {
    const { marc, julie, noe, all } = await crew();
    const j = active(julie).me;
    expect(active(julie).raiseSos(-71.2, 46.8)).toBeNull();
    await until(() => rings(marc, j) === 1, 'SOS rings at Marc');
    // Marc resolves it here: no resolve alert on this phone (it is his own write).
    clock += 30_000;
    const sos = openSos(marc, j)!;
    expect(active(marc).resolveSos(j, sos.id)).toBeNull();
    await until(
      () =>
        active(julie)
          .soses()
          .every((s) => s.resolved),
      'resolve at Julie',
    );
    clock += gap;
    expect(active(julie).raiseSos(-71.21, 46.81)).toBeNull();
    await until(() => openSos(marc, j) !== undefined, 'second SOS at Marc');
    await settle();
    expect(rings(marc, j)).toBe(2);
    await stop(all);
    expect(noe).toBeDefined();
  });

  it.each([
    ['inside the cooldown', 20_000],
    ['past the cooldown', 90_000],
  ])(
    'resolved by another phone (the admin), received here: Julie raises again %s',
    async (_what, gap) => {
      const { marc, julie, noe, all } = await crew();
      const j = active(julie).me;
      expect(active(julie).raiseSos(-71.2, 46.8)).toBeNull();
      await until(() => rings(noe, j) === 1, 'SOS rings at Noé');
      clock += 30_000;
      expect(active(marc).resolveSos(j, openSos(marc, j)!.id)).toBeNull();
      await until(() => openSos(noe, j) === undefined, 'resolve at Noé');
      await until(
        () =>
          active(julie)
            .soses()
            .every((s) => s.resolved),
        'resolve at Julie',
      );
      clock += gap;
      expect(active(julie).raiseSos(-71.21, 46.81)).toBeNull();
      await until(() => openSos(noe, j) !== undefined, 'second SOS at Noé');
      await settle();
      expect(rings(noe, j)).toBe(2);
      await stop(all);
    },
  );

  it.each([
    ['inside the cooldown', 20_000],
    ['past the cooldown', 90_000],
  ])('Julie resolves her own, then raises again %s', async (_what, gap) => {
    const { marc, julie, all } = await crew();
    const j = active(julie).me;
    expect(active(julie).raiseSos(-71.2, 46.8)).toBeNull();
    await until(() => rings(marc, j) === 1, 'SOS rings at Marc');
    clock += 30_000;
    expect(active(julie).resolveSos(j, openSos(julie, j)!.id)).toBeNull();
    await until(() => openSos(marc, j) === undefined, 'resolve at Marc');
    clock += gap;
    expect(active(julie).raiseSos(-71.21, 46.81)).toBeNull();
    await until(() => openSos(marc, j) !== undefined, 'second SOS at Marc');
    await settle();
    expect(rings(marc, j)).toBe(2);
    await stop(all);
  });

  it.each([
    ['inside the cooldown', 20_000],
    ['past the cooldown', 90_000],
  ])(
    'the resolve and the re-raise reach a phone in the same sync (it was away) %s',
    async (_what, gap) => {
      const { marc, julie, noe, all } = await crew();
      const j = active(julie).me;
      expect(active(julie).raiseSos(-71.2, 46.8)).toBeNull();
      await until(() => rings(noe, j) === 1, 'SOS rings at Noé');
      // Noé walks out of range; the resolve and the new SOS happen without him.
      await active(noe).stopMesh();
      clock += 30_000;
      expect(active(marc).resolveSos(j, openSos(marc, j)!.id)).toBeNull();
      await until(
        () =>
          active(julie)
            .soses()
            .every((s) => s.resolved),
        'resolve at Julie',
      );
      clock += gap;
      expect(active(julie).raiseSos(-71.21, 46.81)).toBeNull();
      await until(() => openSos(marc, j) !== undefined, 'second SOS at Marc');
      // Back in range: both arrive at once.
      await active(noe).startMesh();
      await until(() => openSos(noe, j) !== undefined, 'catch-up at Noé');
      await settle();
      expect(rings(noe, j)).toBe(2);
      await stop(all);
    },
  );

  it('the same SOS synced twice never rings twice (the window still holds)', async () => {
    const { marc, julie, all } = await crew();
    const j = active(julie).me;
    expect(active(julie).raiseSos(-71.2, 46.8)).toBeNull();
    await until(() => rings(marc, j) === 1, 'SOS rings at Marc');
    // Julie moves with her open SOS: a silent write, never a second alarm.
    clock += 10_000;
    active(julie).moveSos(openSos(julie, j)!.id, -71.205, 46.805);
    await until(() => Math.abs((openSos(marc, j)?.lng ?? 0) + 71.205) < 1e-9, 'the move at Marc');
    await settle();
    expect(rings(marc, j)).toBe(1);
    await stop(all);
  });
});
