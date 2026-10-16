/**
 * The group host and its links (2.7.0 G5) over the loopback mesh, on the
 * rig's manual queue, clock and timers: every run is the same, and nothing
 * waits on the wall clock.
 *
 * - two 2.7 phones start in 2.6 framing and upgrade to the link mux;
 * - a second team the two share rides that link as a channel, and syncs
 *   while it is not the team on screen (no alerts from it);
 * - a 2.6 phone keeps raw v1 framing, never sees a 2.7 frame, never strikes,
 *   and syncs both ways, next to two 2.7 phones that upgrade;
 * - one link per pair of phones, whoever dialled.
 */
import type { TeamCrypto } from '@core/team/crypto';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { LINK_CAP } from '@core/teamdraw/caps';
import type { TeamAlert } from '@core/teamui/alerts';
import { DEFAULT_INVITE, parseAnyInvite, webJoinLink } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { LoopbackMeshTransport } from '@data/team/loopbackMesh';
import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import type { CreatedInvite, TeamSession } from '@data/team/teamSession';

import { Phone26, Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

const c: TeamCrypto = nodeCrypto;

function phone(rig: Rig, meshFrameBytes?: number) {
  const disk = new MemoryTeamDisk();
  const service = new TeamService({
    c,
    disk,
    transport: rig.hub.createTransport(),
    now: rig.now,
    tickMs: 0,
    timers: rig.timers,
    ...(meshFrameBytes !== undefined ? { meshFrameBytes } : {}),
  });
  const alerts: { alert: TeamAlert; teamId: string }[] = [];
  service.onAlert((alert, teamId) => alerts.push({ alert, teamId }));
  return { service, disk, alerts };
}
type Phone = ReturnType<typeof phone>;

const active = (p: Phone): TeamSession => {
  const s = p.service.active;
  if (s === null) throw new Error('no active team');
  return s;
};

const invite = (s: TeamSession) => {
  const inv = s.createInvite(DEFAULT_INVITE) as CreatedInvite;
  return parseAnyInvite(webJoinLink(inv.payload))!;
};

async function found(rig: Rig, p: Phone, name: string): Promise<TeamSession> {
  const s = await p.service.createTeam({ name, myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
  await rig.settle();
  return s;
}

/** `p` joins `team` (shown on `admin`) through the 2.6-compatible join flow. */
async function join(rig: Rig, admin: Phone, p: Phone, name: string): Promise<TeamSession> {
  const token = invite(active(admin));
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

const messages = (s: TeamSession | undefined) => (s?.view().messages ?? []).map((m) => m.text);

describe('GroupHost links (2.7.0 G5)', () => {
  it('two 2.7 phones start in 2.6 framing, upgrade to the mux, and keep one link', async () => {
    const rig = new Rig();
    const a = phone(rig);
    const b = phone(rig);
    await found(rig, a, 'Ridge');
    await join(rig, a, b, 'Julie');
    await active(b).startMesh();
    await rig.settle();
    active(a).tick();
    await rig.settle();
    // Both claim the link mux once their team is open.
    const now = rig.now();
    expect(active(a).replica.canReceive(active(b).me, LINK_CAP, now)).toBe(true);
    expect(active(b).replica.canReceive(active(a).me, LINK_CAP, now)).toBe(true);

    for (const [p, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const links = p.service.host.links();
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        framing: 'mux',
        state: 'open',
        identity: active(other).me,
        groups: [active(p).teamId],
      });
      expect(
        active(p)
          .peers()
          .filter((x) => x.phase === 'open'),
      ).toHaveLength(1);
    }

    // Sync still flows both ways over the upgraded link.
    expect(active(b).sendMessage('At the hut')).toBeNull();
    expect(active(a).sendMessage('Coming')).toBeNull();
    await rig.settle();
    expect(messages(active(a))).toEqual(expect.arrayContaining(['At the hut', 'Coming']));
    expect(messages(active(b))).toEqual(expect.arrayContaining(['At the hut', 'Coming']));
    expect(a.alerts.map((x) => x.alert.text)).toContain('At the hut');

    // An SOS is a lane-0 frame (counted, not timed).
    const [before] = a.service.host.links();
    expect(active(a).raiseSos(-71.2, 46.8)).toBeNull();
    await rig.settle();
    const [after] = a.service.host.links();
    expect(after!.sentByLane[0]!).toBeGreaterThan(before!.sentByLane[0]!);
    expect(active(b).soses()).toHaveLength(1);

    await active(a).stopMesh();
    await active(b).stopMesh();
    await rig.settle();
    expect(a.service.host.links()).toEqual([]);
    expect(active(a).peers()).toEqual([]);
  });

  it('carries a second shared team as a channel and syncs it while another team is shown', async () => {
    const rig = new Rig();
    const a = phone(rig);
    const b = phone(rig);
    const t2 = await found(rig, a, 'Second');
    await join(rig, a, b, 'Julie');
    await active(b).stopMesh();
    const t1 = await found(rig, a, 'First');
    await join(rig, a, b, 'Julie');
    expect(active(a).teamId).toBe(t1.teamId);
    expect(active(b).teamId).toBe(t1.teamId);

    await active(b).startMesh();
    await rig.settle();
    active(a).tick();
    await rig.settle();

    const groups = [t1.teamId, t2.teamId].sort();
    expect(a.service.host.links().map((l) => l.groups)).toEqual([groups]);
    expect(b.service.host.links().map((l) => l.groups)).toEqual([groups]);

    // A message in the team not on screen syncs, and rings nobody.
    const bT2 = b.service.host.open(t2.teamId)!;
    expect(bT2.sendMessage('Second team note')).toBeNull();
    await rig.settle();
    expect(messages(a.service.host.open(t2.teamId))).toContain('Second team note');
    expect(a.alerts.filter((x) => x.teamId === t2.teamId)).toEqual([]);

    // Leaving it on one phone ends only its channel.
    await b.service.leave(t2.teamId);
    await rig.settle();
    expect(b.service.host.links().map((l) => l.groups)).toEqual([[t1.teamId]]);
    expect(a.service.host.links().map((l) => l.groups)).toEqual([[t1.teamId]]);
    expect(active(b).sendMessage('Still here')).toBeNull();
    await rig.settle();
    expect(messages(active(a))).toContain('Still here');
  });

  it('a 2.6 phone stays on raw v1, never strikes, and syncs both ways with 2.7 phones', async () => {
    const rig = new Rig();
    const a = phone(rig);
    const b = phone(rig);
    await found(rig, a, 'Mixed');
    await join(rig, a, b, 'Julie');
    await active(b).startMesh();
    await rig.settle();

    // A 2.6 phone joins once both know each other (any member may admit it).
    const old = new Phone26(rig, c);
    await old.join(invite(active(a)));
    old.advertise();
    await old.start();
    await rig.settle();
    active(a).tick();
    active(b).tick();
    old.tick();
    await rig.settle();

    const oldId = old.id;
    for (const p of [a, b]) {
      const links = p.service.host.links();
      const toOld = links.filter((l) => l.identity === oldId);
      const to27 = links.filter((l) => l.identity !== oldId);
      expect(toOld).toHaveLength(1);
      expect(toOld[0]).toMatchObject({ framing: 'v1', groups: [active(p).teamId] });
      expect(to27).toHaveLength(1);
      expect(to27[0]!.framing).toBe('mux');
      expect(active(p).replica.canReceive(oldId, LINK_CAP, rig.now())).toBe(false);
    }
    expect(old.openSessions()).toBe(2);

    // Both ways, and through the 2.6 phone's log too.
    old.say('From the old phone');
    expect(active(a).sendMessage('From the new phone')).toBeNull();
    await rig.settle();
    expect(messages(active(a))).toContain('From the old phone');
    expect(messages(active(b))).toContain('From the old phone');
    const oldTexts = old.replica
      .opsInRange(active(a).me, 1, Number.MAX_SAFE_INTEGER)
      .map((op) => old.replica.decode(op))
      .map((body) => (body as { tx?: unknown } | undefined)?.tx);
    expect(oldTexts).toContain('From the new phone');

    // A kind 2.6 does not know: stored and skipped by the 2.6 phone, no strike.
    const unknown = active(a).store.track(() => ({
      result: active(a).replica.write(rig.now(), 'e.set', { k: 'zzz', id: 'x', f: { a: 1 } }),
      accepted: [],
    })).result!;
    await rig.settle();
    expect(
      old.replica.opsInRange(active(a).me, 1, Number.MAX_SAFE_INTEGER).map((o) => o.id),
    ).toContain(unknown.id);
    // The 2.7 cap record (an unknown field set to it) is stored without a strike.
    expect(old.replica.canReceive(active(a).me, 'pen', rig.now())).toBe(true);
    expect(old.strikes).toEqual([]);
    // Its only endings: the twin links (both phones dialled) the 2.7 side dropped.
    expect(old.closes.every((why) => why === 'duplicate')).toBe(true);
    await old.stop();
  });

  it('keeps the link of the lower member id when both phones dial', async () => {
    const rig = new Rig();
    const a = phone(rig);
    const b = phone(rig);
    await found(rig, a, 'Pair');
    await join(rig, a, b, 'Julie');
    await active(b).startMesh();
    await rig.settle();
    const [la] = a.service.host.links();
    const [lb] = b.service.host.links();
    expect(la!.connId).toBeDefined();
    // The same connection seen from both ends: one dialled, one answered.
    expect(new Set([la!.side, lb!.side])).toEqual(new Set(['initiator', 'responder']));
    const lower = active(a).me < active(b).me ? la! : lb!;
    expect(lower.side).toBe('initiator');
  });

  it('a large catch-up behind a shallow carrier queue arrives whole (frames held, then flushed)', async () => {
    // A 16 KiB frame cap and a queue of two and a half frames (the native
    // clamp keeps at least two): the carrier refuses often.
    const frame = 16 * 1024;
    const rig = new Rig({ maxFrameBytes: frame, maxQueuedBytes: frame * 2.5 });
    const a = phone(rig, frame);
    const b = phone(rig, frame);
    await found(rig, a, 'Backlog');
    await join(rig, a, b, 'Julie');
    const send = jest.spyOn(LoopbackMeshTransport.prototype, 'send');
    const n = 400;
    for (let i = 0; i < n; i++) {
      expect(
        active(a).shareWaypoint({ latitude: 46.8 + i / 1e4, longitude: -71.2, label: `W${i}` }),
      ).toBeNull();
    }
    await active(b).startMesh();
    await rig.settle();
    for (let i = 0; i < 5 && active(b).shares().waypoints.length < n; i++) {
      active(b).tick();
      await rig.settle();
    }
    expect(active(b).shares().waypoints).toHaveLength(n);
    expect(b.service.host.links()[0]!.framing).toBe('mux');
    const refused = send.mock.results.filter(
      (r) => (r.value as { ok: boolean; reason?: string }).reason === 'backpressure',
    ).length;
    expect(refused).toBeGreaterThan(0);
    send.mockRestore();
  });

  it('loads every team at launch; the active team is only what the screens show', async () => {
    const rig = new Rig();
    const a = phone(rig);
    const t1 = await found(rig, a, 'One');
    rig.advance(1_000);
    const t2 = await found(rig, a, 'Two');
    expect(a.service.host.groups()).toEqual([
      { id: t1.teamId, app: 'team', name: 'One', role: 'owner', open: true },
      { id: t2.teamId, app: 'team', name: 'Two', role: 'owner', open: true },
    ]);

    // A relaunch on the same disk: both open, none shown until the screens pick one.
    const again = new TeamService({
      c,
      disk: a.disk,
      transport: rig.hub.createTransport(),
      now: rig.now,
      tickMs: 0,
      timers: rig.timers,
    });
    await again.load();
    expect(again.active).toBeNull();
    expect(again.host.open(t1.teamId)?.view().name).toBe('One');
    expect(again.host.open(t2.teamId)?.view().name).toBe('Two');
    expect(again.lastOpened?.teamId).toBe(t2.teamId);
    const shown = await again.activate(t1.teamId);
    expect(shown).toBe(again.host.open(t1.teamId));
    await expect(again.activate('nope')).rejects.toThrow('Unknown team');
  });
});
