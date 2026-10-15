/**
 * Two (and three) phones in one Jest process over the loopback mesh (#589):
 * create → invite → join with the safety code → sync → message → position →
 * remove → rotate, plus a restart from disk. The real session host, sync
 * sessions, persistence wrapper and service; only the radio is simulated.
 */
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { reportError } from '@lib/errorReporting';
import { nobleCrypto } from '@core/team/testing/noble';
import type { TeamCrypto } from '@core/team/crypto';
import type { TeamAlert } from '@core/teamui/alerts';
import { DEFAULT_INVITE, parseAnyInvite, webJoinLink } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { LoopbackMeshHub } from './loopbackMesh';
import { MemoryTeamDisk } from './teamDisk';
import { TeamService } from './teamService';
import type { CreatedInvite, TeamSession } from './teamSession';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function phone(hub: LoopbackMeshHub, c: TeamCrypto = nodeCrypto) {
  const disk = new MemoryTeamDisk();
  const service = new TeamService({ c, disk, transport: hub.createTransport(), tickMs: 0 });
  const alerts: TeamAlert[] = [];
  service.onAlert((a) => alerts.push(a));
  return { service, disk, alerts };
}

const active = (p: { service: TeamService }): TeamSession => {
  const s = p.service.active;
  if (s === null) throw new Error('no active team');
  return s;
};

async function founded(hub: LoopbackMeshHub, c?: TeamCrypto) {
  const a = phone(hub, c);
  await a.service.createTeam({
    name: 'Relevé MSA',
    myName: 'Marc-André',
    lifetimeMs: lifetimeMs('14d'),
  });
  await active(a).startMesh();
  return a;
}

async function joined(
  hub: LoopbackMeshHub,
  admin: ReturnType<typeof phone>,
  name: string,
  c?: TeamCrypto,
) {
  const inv = active(admin).createInvite(DEFAULT_INVITE) as CreatedInvite;
  expect(typeof inv).toBe('object');
  // What the SMS carries, parsed back the way the join screen does.
  const token = parseAnyInvite(webJoinLink(inv.payload))!;
  const b = phone(hub, c);
  const attempt = await b.service.startJoin(token, name);
  await until(() => attempt.state().phase === 'verify', `${name} admitted`);
  // Both phones show the same six digits.
  const code = attempt.state().safetyCode;
  expect(code).toMatch(/^\d{6}$/);
  await until(() => active(admin).joinNotices.length > 0, 'join notice');
  expect(active(admin).joinNotices[0]!.code).toBe(code);
  await b.service.confirmJoin();
  await active(b).startMesh();
  return { b, inv };
}

const names = (s: TeamSession) =>
  s
    .view()
    .members.filter((m) => m.active)
    .map((m) => `${m.name}:${m.role}`)
    .sort();

describe('team mode over the loopback mesh', () => {
  it('creates, invites, joins with matching safety codes and syncs both ways', async () => {
    const hub = new LoopbackMeshHub();
    const a = await founded(hub);
    const { b } = await joined(hub, a, 'Julie');

    await until(() => names(active(a)).includes('Julie:member'), 'A sees Julie');
    await until(() => active(b).view().name === 'Relevé MSA', 'B sees the team name');
    expect(names(active(b))).toEqual(['Julie:member', 'Marc-André:owner']);
    expect(b.service.teams.map((t) => t.name)).toEqual(['Relevé MSA']);

    // A message from B reaches A and is routed (small team → badge).
    expect(active(b).sendMessage('Arrivée au refuge')).toBeNull();
    await until(() => active(a).view().messages.length === 1, 'message at A');
    expect(active(a).view().messages[0]).toMatchObject({
      text: 'Arrivée au refuge',
      authorName: 'Julie',
    });
    expect(a.alerts.map((x) => x.level)).toEqual(['badge']);
    expect(active(a).unread()).toBe(1);
    active(a).markRead();
    expect(active(a).unread()).toBe(0);

    // Positions only while sharing is on.
    expect(active(b).sharePosition({ latitude: 47.07, longitude: -70.9, at: Date.now() })).toBe(
      'not-allowed',
    );
    active(b).updateRecord({ prefs: { ...active(b).record.prefs, sharePosition: true } });
    expect(
      active(b).sharePosition({ latitude: 47.07, longitude: -70.9, accuracy: 4, at: Date.now() }),
    ).toBeNull();
    await until(() => active(a).positions().length === 1, 'position at A');
    expect(active(a).positions()[0]).toMatchObject({ name: 'Julie', band: 'fresh', accuracy: 4 });

    // Shared waypoint, from A to B.
    expect(active(a).shareWaypoint({ latitude: 47.1, longitude: -70.95, label: 'Culvert' })).toBe(
      null,
    );
    await until(() => active(b).shares().waypoints.length === 1, 'waypoint at B');

    // Per-peer status: one open session each way, no duplicates.
    await until(
      () =>
        active(a)
          .peers()
          .filter((p) => p.phase === 'open').length === 1,
      'one link A↔B',
    );
    expect(active(a).peers()[0]!.memberId).toBe(active(b).me);
    await active(a).stopMesh();
    await active(b).stopMesh();
  });

  it('removes a member, rotates at once, and the removed phone cannot read what follows', async () => {
    const hub = new LoopbackMeshHub();
    const a = await founded(hub);
    const { b } = await joined(hub, a, 'Julie');
    const { b: c } = await joined(hub, a, 'Simon');
    // Synced means each phone knows all three by name (a member's name comes
    // in its own profile message, after the membership itself: counting
    // members alone let the removal race Julie's name on a slow runner).
    const knowsAll = (x: ReturnType<typeof phone>) => {
      const n = names(active(x));
      return n.length === 3 && n.includes('Julie:member') && n.includes('Simon:member');
    };
    await until(() => knowsAll(a) && knowsAll(b) && knowsAll(c), 'all synced, names included');
    const julie = active(b).me;

    expect(active(a).removeMember(active(b).me)).toBeNull();
    const viewA = active(a).view();
    expect(viewA.needsRotation).toBe(false);
    expect(viewA.members.find((m) => m.id === julie)?.active).toBe(false);

    // A pure predicate (no `!` inside a poll), by identity rather than name.
    await until(
      () =>
        active(c)
          .view()
          .members.find((m) => m.id === julie)?.active === false,
      'C sees removal',
    );
    const newKey = active(a).replica.state.sendKeyId!;
    await until(() => active(c).replica.key(newKey) !== undefined, 'C got the new key');
    expect(active(b).replica.key(newKey)).toBeUndefined();

    expect(active(a).sendMessage('Après la rotation')).toBeNull();
    await until(
      () =>
        active(c)
          .view()
          .messages.some((m) => m.text === 'Après la rotation'),
      'C reads',
    );
    expect(
      active(b)
        .view()
        .messages.some((m) => m.text === 'Après la rotation'),
    ).toBe(false);
    // The removed phone's own writes are refused by the others.
    active(b).sendMessage('encore là ?');
    await new Promise((r) => setTimeout(r, 50));
    expect(
      active(a)
        .view()
        .messages.some((m) => m.text === 'encore là ?'),
    ).toBe(false);
    for (const p of [a, b, c]) await active(p).stopMesh();
  });

  it('promotes, demotes and admin-rotates; never offers re-promotion', async () => {
    const hub = new LoopbackMeshHub();
    const a = await founded(hub);
    const { b } = await joined(hub, a, 'Julie');
    const julie = active(b).me;
    expect(active(a).setRole(julie, 'admin')).toBeNull();
    await until(() => active(b).view().isAdmin, 'B is admin');
    expect(active(b).rotateKey()).toBeNull();
    await until(() => active(a).replica.state.keyOrder.length === 2, 'A sees the rotation');
    expect(active(a).setRole(julie, 'member')).toBeNull();
    const row = active(a)
      .view()
      .members.find((m) => m.id === julie)!;
    expect(row.role).toBe('member');
    expect(row.actions.promote).toBeNull();
    expect(active(a).extend(7)).toBeNull();
    for (const p of [a, b]) await active(p).stopMesh();
  });

  it('restarts from disk without forking its chain', async () => {
    const hub = new LoopbackMeshHub();
    const a = await founded(hub);
    const { b } = await joined(hub, a, 'Julie');
    active(a).sendMessage('avant le redémarrage');
    const seq = active(a).replica.writer.cursor.seq;
    // Every own op is on disk before its cursor (write-ahead order).
    const journal = a.disk.journal;
    expect(journal.indexOf(`cursor:${seq}`)).toBeGreaterThan(-1);
    await active(a).stopMesh();

    // "Crash" after an append but before the cursor save: drop the cursor back.
    a.disk.cursors.set(active(a).teamId, { seq: 1, hlc: { wall: 0, counter: 0 } });
    const again = new TeamService({
      c: nodeCrypto,
      disk: a.disk,
      transport: hub.createTransport(),
      tickMs: 0,
    });
    await again.load();
    const s = await again.activate(active(a).teamId);
    expect(s.replica.writer.cursor.seq).toBe(seq);
    expect(s.view().messages.map((m) => m.text)).toEqual(['avant le redémarrage']);
    await s.startMesh();
    expect(s.sendMessage('après')).toBeNull();
    await until(
      () =>
        active(b)
          .view()
          .messages.some((m) => m.text === 'après'),
      'B reads after restart',
    );
    expect(active(b).replica.log.equivocations).toEqual([]);
    await s.stopMesh();
    await active(b).stopMesh();
  });

  it('refuses a second use of a single-use invite', async () => {
    const hub = new LoopbackMeshHub();
    const a = await founded(hub);
    const { inv } = await joined(hub, a, 'Julie');
    const late = phone(hub);
    const attempt = await late.service.startJoin(inv.token, 'Luc');
    await until(() => attempt.state().phase === 'failed', 'refused');
    expect(attempt.state().failure).toBe('used');
    await late.service.cancelJoin();
    expect(late.service.teams).toEqual([]);
    expect(late.disk.ops.size).toBe(0);
    await active(a).stopMesh();
  });

  it('an SOS and a rally point get one receipt each, and the raiser counts them (#708)', async () => {
    const hub = new LoopbackMeshHub();
    const a = await founded(hub);
    const { b } = await joined(hub, a, 'Julie');
    await until(() => names(active(a)).includes('Julie:member'), 'A sees Julie');
    // Both phones advertise receipts once they hold a key (the profile check).
    await until(
      () => active(a).receipts({ kind: 'sos', owner: active(b).me, id: 'x' }).capable === 1,
      'A sees Julie’s rc',
    );
    expect(active(b).raiseSos(-71.2, 46.8)).toBeNull();
    const sos = active(b).soses()[0]!;
    const ref = { kind: 'sos' as const, owner: sos.owner, id: sos.id };
    expect(active(b).receipts(ref)).toEqual({ received: 0, capable: 1, others: 1 });
    await until(() => active(b).receipts(ref).received === 1, 'Julie sees A’s receipt');
    expect(a.alerts.filter((x) => x.kind === 'sos')).toHaveLength(1);
    // Nothing more is owed: another sync writes nothing.
    expect(active(a).sendOwedReceipts()).toBe(0);
    expect(active(a).setRally(-71.21, 46.81)).toBeNull();
    const rly = active(a).rally()!;
    const rref = { kind: 'rly' as const, owner: rly.owner, id: rly.id };
    await until(() => active(a).receipts(rref).received === 1, 'A sees Julie’s rally receipt');
    expect(b.alerts.filter((x) => x.kind === 'rally')).toMatchObject([
      { level: 'alert', entity: `rly:${rly.owner}:${rly.id}` },
    ]);
    for (const p of [a, b]) await active(p).stopMesh();
  }, 20_000);

  it.each(['raiser', 'admin'] as const)(
    'a resolved SOS never blocks the next: resolve, then a new SOS at once reaches the team (resolved by the %s, QA 2.6.1)',
    async (resolver) => {
      const hub = new LoopbackMeshHub();
      const a = await founded(hub);
      const { b } = await joined(hub, a, 'Julie');
      await until(() => names(active(a)).includes('Julie:member'), 'A sees Julie');
      await until(
        () => active(a).receipts({ kind: 'sos', owner: active(b).me, id: 'x' }).capable === 1,
        'A sees Julie’s rc',
      );
      const julie = active(b).me;
      const openOnA = () =>
        active(a)
          .soses()
          .filter((s) => s.owner === julie && !s.resolved);
      expect(active(b).raiseSos(-71.2, 46.8, 'Ankle')).toBeNull();
      await until(() => openOnA().length === 1, 'A sees the first SOS');
      const first = active(b).soses()[0]!;
      const ref = { kind: 'sos' as const, owner: julie, id: first.id };
      await until(() => active(b).receipts(ref).received === 1, 'A’s receipt for the first');
      // "Resolve for everyone", by Julie herself or by the admin.
      const resolve =
        resolver === 'raiser'
          ? active(b).resolveSos(julie, first.id)
          : active(a).resolveSos(julie, first.id);
      expect(resolve).toBeNull();
      await until(
        () =>
          active(b)
            .soses()
            .every((s) => s.resolved) && openOnA().length === 0,
        'both see it resolved',
      );
      const raisedAt = Date.now();
      // Seconds later, a real emergency: it must go out now, not in a minute.
      expect(active(b).raiseSos(-71.3, 46.9)).toBeNull();
      const mine = active(b)
        .soses()
        .filter((s) => !s.resolved);
      expect(mine).toMatchObject([{ owner: julie, lng: -71.3, lat: 46.9, text: '' }]);
      // It is a new alert: "just now", and nobody has received it yet.
      expect(mine[0]!.at).toBeGreaterThanOrEqual(raisedAt);
      const next = { kind: 'sos' as const, owner: julie, id: mine[0]!.id };
      expect(active(b).receipts(next).received).toBe(0);
      await until(() => openOnA().length === 1, 'A sees the new SOS');
      expect(openOnA()[0]).toMatchObject({ lng: -71.3, lat: 46.9, text: '' });
      expect(openOnA()[0]!.at).toBeGreaterThanOrEqual(raisedAt);
      // A raised it again (not a silent place update), and receipts it anew.
      expect(a.alerts.filter((x) => x.kind === 'sos' && x.text.startsWith('SOS ·'))).toHaveLength(
        2,
      );
      await until(() => active(b).receipts(next).received === 1, 'A’s receipt for the new SOS');
      for (const p of [a, b]) await active(p).stopMesh();
    },
    20_000,
  );

  it('a write the data fold refuses is reported, never called a success (QA 2.6.1)', async () => {
    const hub = new LoopbackMeshHub();
    const a = await founded(hub);
    const { b } = await joined(hub, a, 'Julie');
    expect(active(a).raiseSos(-71.2, 46.8)).toBeNull();
    const sos = active(a).soses()[0]!;
    await until(
      () =>
        active(b)
          .soses()
          .some((s) => s.id === sos.id),
      'Julie sees the SOS',
    );
    // A member (not an admin) cannot resolve someone else's SOS: the fold
    // skips the write, and the action says so.
    expect(active(b).resolveSos(sos.owner, sos.id)).toBe('not-allowed');
    expect(
      active(b)
        .soses()
        .find((s) => s.id === sos.id)!.resolved,
    ).toBe(false);
    for (const p of [a, b]) await active(p).stopMesh();
  }, 20_000);

  it('runs the whole join on the real noble crypto', async () => {
    const hub = new LoopbackMeshHub();
    const a = await founded(hub, nobleCrypto);
    const { b } = await joined(hub, a, 'Julie', nobleCrypto);
    await until(() => names(active(a)).includes('Julie:member'), 'A sees Julie');
    for (const p of [a, b]) await active(p).stopMesh();
  }, 20_000);
});

describe('join diagnostics', () => {
  it('reports a session that never links up after a join, without personal data', async () => {
    const hub = new LoopbackMeshHub();
    const a = phone(hub);
    const s = await a.service.createTeam({
      name: 'Relevé MSA',
      myName: 'Marc',
      lifetimeMs: lifetimeMs('14d'),
    });
    s.watchFirstLinkMs = 20;
    await s.startMesh();
    await new Promise((r) => setTimeout(r, 60));
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = jest.mocked(reportError).mock.calls[0]!;
    expect(ctx).toBe('team-join-reconnect');
    const msg = (err as Error).message;
    expect(msg).toMatch(
      /^Team: no teammate link 0 s after joining \(discovered 0, dials 0, local network granted; .*mesh started/,
    );
    expect(msg).not.toContain('Marc');
    expect(msg).not.toContain(s.me);
    expect(msg).not.toMatch(/10\.99\./);
    await s.stopMesh();
  });
});
