/**
 * Team drawing (#683) between phones on the loopback mesh: the real service,
 * sessions, sync and persistence; only the radio is simulated, and the
 * phones share a clock the test moves.
 *
 * A draws; B sees the stroke grow, then the finished shape; it fades and
 * expires; Clear mine and its UNDO; a phone that does not advertise
 * `cap.pen` (an older version) never receives a live stroke, and nothing
 * strikes the drawer.
 */
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { DEFAULT_INVITE, parseAnyInvite, webJoinLink } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';
import { hasCap } from '@core/teamdraw/caps';
import { penBody, toleranceM, type Stroke } from '@core/teamdraw/pen';
import { penStyle, defaultPrefs } from '@core/teamdraw/style';
import { QC, NEAR } from '@core/teamdraw/testUtils';

import { LoopbackMeshHub } from './loopbackMesh';
import { MemoryTeamDisk } from './teamDisk';
import { SessionDrawing, type SessionDrawAlert } from './teamDraw';
import { TeamService } from './teamService';
import type { CreatedInvite, TeamSession } from './teamSession';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

let clock = Date.now();
const now = () => clock;

async function until(cond: () => boolean, what: string, ms = 6000): Promise<void> {
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
  const draws = { n: 0 };
  const changes = { n: 0 };
  const alerts: SessionDrawAlert[] = [];
  service.onDraw(() => draws.n++);
  service.subscribe(() => changes.n++);
  service.onDrawAlert((a) => alerts.push(a));
  return { service, draws, changes, alerts };
}
type Phone = ReturnType<typeof phone>;
const active = (p: Phone): TeamSession => p.service.active!;

async function join(hub: LoopbackMeshHub, admin: Phone, name: string): Promise<Phone> {
  const inv = active(admin).createInvite(DEFAULT_INVITE) as CreatedInvite;
  const b = phone(hub);
  const attempt = await b.service.startJoin(parseAnyInvite(webJoinLink(inv.payload))!, name);
  await until(() => attempt.state().phase === 'verify', `${name} admitted`);
  await b.service.confirmJoin();
  await active(b).startMesh();
  return b;
}

const style = penStyle({ ...defaultPrefs(1), fadeMs: 10_000 });
const TOL = toleranceM(16, QC[1]);
/** A pencil line growing to `n` points. */
const line = (id: string, n: number): Stroke => ({
  id,
  sh: 'free',
  pts: Array.from({ length: n }, (_, i) => [QC[0] + i * 0.0005, QC[1] + (i % 2) * 0.0003]),
  style,
});

async function crew() {
  const hub = new LoopbackMeshHub();
  const a = phone(hub);
  await a.service.createTeam({
    name: 'Ridge crew',
    myName: 'Julie',
    lifetimeMs: lifetimeMs('14d'),
  });
  await active(a).startMesh();
  const b = await join(hub, a, 'Sam');
  // Synced: everyone advertises live drawing.
  await until(
    () =>
      hasCap(active(a).replica.data(now()), active(b).me) &&
      hasCap(active(b).replica.data(now()), active(a).me),
    'caps both ways',
  );
  return { hub, a, b };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('team drawing on the mesh', () => {
  it('A draws: B sees the stroke grow, then the shape, which fades and expires', async () => {
    clock = Date.now();
    const { a, b } = await crew();
    const draw = active(a).draw;
    expect(draw.canDraw()).toBe(true);

    // The stroke in progress: each update holds the whole stroke so far.
    const changesBefore = b.changes.n;
    const ownBefore = a.changes.n;
    for (let n = 2; n <= 6; n++) {
      clock += 250;
      expect(draw.sendPen(penBody(line('s1', n), TOL)!)).toBeNull();
      await until(() => active(b).draw.live()[0]?.pts.length === n, `B sees ${n} points`);
    }
    const seen = active(b).draw.live();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ author: active(a).me, id: 's1', sh: 'free' });
    // Live strokes went through the draw channel, never the screens' change signal.
    expect(b.draws.n).toBeGreaterThanOrEqual(5);
    expect(b.changes.n).toBe(changesBefore);
    // Nor on the drawer's own phone.
    expect(a.changes.n).toBe(ownBefore);
    // The drawer's own phone never shows its own stroke as a teammate's.
    expect(draw.live()).toEqual([]);
    // Sam hears once per session: a snackbar, no notification for a 10 s fade.
    expect(b.alerts).toHaveLength(1);
    expect(b.alerts[0]).toMatchObject({ author: active(a).me, snackbar: true, notify: null });

    // Pen-up: the shape replaces the live stroke.
    expect(draw.finish(line('s1', 6), TOL, 10_000)).toBeNull();
    await until(() => active(b).draw.shapes().length === 1, 'B has the shape');
    expect(active(b).draw.live()).toEqual([]);
    const shape = active(b).draw.shapes()[0]!;
    expect(shape).toMatchObject({ owner: active(a).me, id: 's1', sh: 'free', c: 1 });
    expect(shape.expires! - shape.created).toBe(10_000);
    expect(b.alerts).toHaveLength(1);

    // Its life passes: gone on both phones (the replica's clock, no new op needed).
    clock += 10_001;
    expect(active(a).draw.shapes()).toEqual([]);
    expect(active(b).draw.shapes()).toEqual([]);

    await active(a).stopMesh();
    await active(b).stopMesh();
  });

  it('a long-lived shape notifies once; my own drawing never alerts me', async () => {
    clock = Date.now();
    const { a, b } = await crew();
    const arrow: Stroke = { id: 'ar', sh: 'arrow', pts: [QC, NEAR], style };
    expect(active(a).draw.finish(arrow, TOL, 30 * 60_000)).toBeNull();
    await until(() => b.alerts.length === 1, 'alert at B');
    // Julie founded the team (an admin): an alert, with the shape's words.
    expect(b.alerts[0]).toMatchObject({ snackbar: true, notify: 'alert' });
    expect(b.alerts[0]!.shape).toMatchObject({ sh: 'arrow', tx: '' });
    expect(active(a).draw.finish({ ...arrow, id: 'ar2' }, TOL, 30 * 60_000)).toBeNull();
    await until(() => active(b).draw.shapes().length === 2, 'second at B');
    expect(b.alerts).toHaveLength(1);
    expect(a.alerts).toEqual([]);
    await active(a).stopMesh();
    await active(b).stopMesh();
  });

  it('a note, Clear mine and its UNDO, and an admin’s Clear all', async () => {
    clock = Date.now();
    const { a, b } = await crew();
    const sam = active(b).draw;
    for (const id of ['n1', 'n2']) {
      expect(sam.finish({ id, sh: 'circle', pts: [QC], r: 80, style }, TOL, null)).toBeNull();
    }
    expect(sam.setNote('n1', 'Camp?')).toBeNull();
    await until(() => active(a).draw.shapes().length === 2, 'A has both');
    await until(
      () =>
        active(a)
          .draw.shapes()
          .some((s) => s.tx === 'Camp?'),
      'A has the note',
    );

    // Sam may not delete Julie's; Julie (admin) may delete Sam's.
    expect(sam.remove(active(a).me, 'x')).toBe('not-allowed');

    const removed = sam.clearMine();
    expect(removed.map((s) => s.id).sort()).toEqual(['n1', 'n2']);
    expect(sam.shapes()).toEqual([]);
    await until(() => active(a).draw.shapes().length === 0, 'cleared at A');
    expect(sam.restore(removed)).toBe(2);
    await until(() => active(a).draw.shapes().length === 2, 'UNDO reaches A');
    expect(
      active(a)
        .draw.shapes()
        .find((s) => s.id === 'n1')?.tx,
    ).toBe('Camp?');

    expect(active(b).draw.clearAll()).toBe(0); // not an admin
    expect(active(a).draw.clearAll()).toBe(2);
    await until(() => sam.shapes().length === 0, 'Clear all reaches Sam');
    await active(a).stopMesh();
    await active(b).stopMesh();
  });

  it('a phone without cap.pen (an older version) never gets a live stroke, and nobody is struck', async () => {
    clock = Date.now();
    const { hub, a, b } = await crew();
    // Leo's phone predates live drawing: it never advertises the capability.
    const real = SessionDrawing.prototype.advertise;
    const spy = jest.spyOn(SessionDrawing.prototype, 'advertise').mockImplementation(function (
      this: SessionDrawing,
    ) {
      return this === active(a).draw || this === active(b).draw ? real.call(this) : false;
    });
    const leo = await join(hub, a, 'Leo');
    await until(
      () =>
        active(leo)
          .view()
          .members.filter((m) => m.active).length === 3,
      'Leo synced',
    );
    expect(spy).toHaveBeenCalled();
    expect(hasCap(active(a).replica.data(now()), active(leo).me)).toBe(false);

    for (let n = 2; n <= 8; n++) {
      clock += 250;
      active(a).draw.sendPen(penBody(line('s9', n), TOL)!);
    }
    await until(() => active(b).draw.live()[0]?.pts.length === 8, 'Sam sees it');
    // The finished shape reaches every phone (old ones skip the unknown kind).
    expect(active(a).draw.finish(line('s9', 8), TOL, null)).toBeNull();
    await until(
      () =>
        active(leo)
          .replica.opsInRange(active(a).me, 1, 1e9)
          .some((op) => op.env.t === 'e.set'),
      'Leo has the shape op',
    );
    await until(() => active(b).draw.shapes().length === 1, 'Sam has the shape');
    const pens = active(leo)
      .replica.liveEphemeral(now())
      .filter((op) => op.env.t === 'pen');
    expect(pens).toEqual([]);
    // Nobody struck or banned the drawer: what she writes next still reaches Leo.
    expect(active(a).sendMessage('Still here?')).toBeNull();
    await until(
      () =>
        active(leo)
          .view()
          .messages.some((m) => m.text === 'Still here?'),
      'Leo still hears Julie',
    );
    for (const p of [a, b, leo]) await active(p).stopMesh();
  });
});
