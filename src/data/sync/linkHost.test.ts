/**
 * The link host's seams and guards (2.7.0 G5), on the rig's manual queue,
 * clock and timers:
 *
 * - another carrier (G6's internet paths) speaks mux from the first frame,
 *   bound to the member the rendezvous named, and needs no LAN;
 * - a connection that floods garbage is banned by address on the LAN.
 */
import type { Carrier, CarrierConn, CarrierEvent, SendResult } from '@core/group/link';
import type { Lane } from '@core/group/lanes';
import { IN_FLIGHT_BUDGET } from '@core/group/link';
import type { PathKind } from '@core/group/path';
import { MAX_MESSAGE_CHARS } from '@core/team/data';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { DEFAULT_INVITE, parseAnyInvite, webJoinLink } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import type { CreatedInvite, TeamSession } from '@data/team/teamSession';

import { DRAIN_POLL_MS } from './linkHost';
import { Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

function phone(rig: Rig) {
  return new TeamService({
    c: nodeCrypto,
    disk: new MemoryTeamDisk(),
    transport: rig.hub.createTransport(),
    now: rig.now,
    tickMs: 0,
    timers: rig.timers,
  });
}

const active = (p: TeamService): TeamSession => p.active!;

/** Two phones in one team (joined over the LAN), then the LAN stopped. */
async function teamOfTwo(rig: Rig) {
  const a = phone(rig);
  const b = phone(rig);
  await a.createTeam({ name: 'Remote', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
  await active(a).startMesh();
  const inv = active(a).createInvite(DEFAULT_INVITE) as CreatedInvite;
  await b.startJoin(parseAnyInvite(webJoinLink(inv.payload))!, 'Julie');
  await rig.settle();
  const joined = await b.confirmJoin();
  if (typeof joined === 'string') throw new Error(joined);
  joined.watchFirstLinkMs = 0;
  await active(b).startMesh();
  await rig.settle();
  await active(a).stopMesh();
  await active(b).stopMesh();
  await rig.settle();
  return { a, b };
}

/** An in-memory carrier: connections in pairs, frames delivered through the rig's queue. */
class FakeCarrier implements Carrier {
  readonly kind = 'rtc' as const;
  private readonly listeners = new Set<(e: CarrierEvent) => void>();
  subscribe(l: (e: CarrierEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: CarrierEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}

function connect(rig: Rig, x: FakeCarrier, y: FakeCarrier, path: PathKind) {
  let open = true;
  const make = (id: string, from: FakeCarrier, to: FakeCarrier, toId: string): CarrierConn => ({
    connId: id,
    path,
    maxFrameBytes: 64 * 1024,
    send(frame: Uint8Array): SendResult {
      if (!open) return 'closed';
      const copy = frame.slice();
      rig.hub.schedule(() => {
        if (open) to.emit({ type: 'frame', connId: toId, data: copy });
      });
      return 'ok';
    },
    close(why: string) {
      if (!open) return;
      open = false;
      rig.hub.schedule(() => {
        from.emit({ type: 'closed', connId: id, reason: why });
        to.emit({ type: 'closed', connId: toId, reason: 'remote-closed' });
      });
    },
  });
  const cx = make('rtc-x', x, y, 'rtc-y');
  const cy = make('rtc-y', y, x, 'rtc-x');
  x.emit({ type: 'conn', conn: cx, direction: 'out' });
  y.emit({ type: 'conn', conn: cy, direction: 'in' });
}

describe('LinkHost over another carrier (the G6 seam)', () => {
  it('speaks mux from the first frame, bound to the named member, with no LAN running', async () => {
    const rig = new Rig();
    const { a, b } = await teamOfTwo(rig);
    const ca = new FakeCarrier();
    const cb = new FakeCarrier();
    a.host.attachCarrier(ca, () => active(b).me);
    b.host.attachCarrier(cb, () => active(a).me);
    connect(rig, ca, cb, 'relay');
    await rig.settle();

    for (const [p, other] of [
      [a, b],
      [b, a],
    ] as const) {
      expect(p.host.links()).toEqual([
        expect.objectContaining({
          path: 'relay',
          framing: 'mux',
          state: 'open',
          identity: active(other).me,
          groups: [active(p).teamId],
        }),
      ]);
    }
    expect(active(b).sendMessage('Over the internet')).toBeNull();
    await rig.settle();
    expect(
      active(a)
        .view()
        .messages.map((m) => m.text),
    ).toContain('Over the internet');
  });

  it('closes a link whose session authenticates someone else than the rendezvous named', async () => {
    const rig = new Rig();
    const { a, b } = await teamOfTwo(rig);
    const ca = new FakeCarrier();
    const cb = new FakeCarrier();
    // A was told the far end is A itself: B's session proves otherwise.
    a.host.attachCarrier(ca, () => active(a).me);
    b.host.attachCarrier(cb, () => active(a).me);
    connect(rig, ca, cb, 'direct');
    await rig.settle();
    expect(a.host.links()).toEqual([]);
    expect(active(a).peers()).toEqual([]);
  });

  it('refuses a connection the rendezvous cannot name, and detaching closes its links', async () => {
    const rig = new Rig();
    const { a, b } = await teamOfTwo(rig);
    const ca = new FakeCarrier();
    const cb = new FakeCarrier();
    a.host.attachCarrier(ca, () => undefined);
    const detachB = b.host.attachCarrier(cb, () => active(a).me);
    connect(rig, ca, cb, 'relay');
    await rig.settle();
    expect(a.host.links()).toEqual([]);
    expect(b.host.links()).toEqual([]);

    const ca2 = new FakeCarrier();
    const cb2 = new FakeCarrier();
    a.host.attachCarrier(ca2, () => active(b).me);
    const detach2 = b.host.attachCarrier(cb2, () => active(a).me);
    connect(rig, ca2, cb2, 'relay');
    await rig.settle();
    expect(b.host.links()).toHaveLength(1);
    detach2();
    await rig.settle();
    expect(b.host.links()).toEqual([]);
    expect(a.host.links()).toEqual([]);
    detachB();
  });
});

describe('LinkHost guards on the LAN', () => {
  it('bans the address of a connection that floods garbage', async () => {
    const rig = new Rig();
    const a = phone(rig);
    await a.createTeam({ name: 'Guarded', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
    await active(a).startMesh();
    await rig.settle();
    const attacker = rig.hub.createTransport();
    await attacker.start();
    const target = rig.hub.services(attacker, null)[0]!;
    attacker.connect(target.address, target.port);
    await rig.settle();
    const peerId = attacker.stats().peers[0]!.peerId;
    for (let i = 0; i < 40 && attacker.stats().peers.length > 0; i++) {
      attacker.send(peerId, Uint8Array.of(1, 2, 3, i));
      await rig.settle();
    }
    expect(attacker.stats().peers).toEqual([]);
    expect(target.accepts(attacker.address)).toBe(false);
    expect(a.host.links()).toEqual([]);
  });
});

/**
 * A carrier pair whose frames wait until the test delivers them: what is
 * queued is what the "native" side holds (`inFlight`), so the test sees
 * exactly what the link handed over, in order, with its lane.
 */
class ManualPipe {
  readonly queue: Uint8Array[] = [];
  /** Every frame handed to `send`, in order. */
  readonly sent: { lane: Lane; bytes: number }[] = [];
  constructor(
    readonly from: FakeCarrier,
    readonly to: FakeCarrier,
    readonly fromId: string,
    readonly toId: string,
  ) {}
  get bytes(): number {
    return this.queue.reduce((n, f) => n + f.length, 0);
  }
  /** Deliver up to `max` queued frames, then tell the sender it may send more. */
  flush(max = Infinity): number {
    let n = 0;
    while (this.queue.length > 0 && n < max) {
      this.to.emit({ type: 'frame', connId: this.toId, data: this.queue.shift()! });
      n++;
    }
    if (n > 0) this.from.emit({ type: 'writable', connId: this.fromId });
    return n;
  }
}

function manualConnect(x: FakeCarrier, y: FakeCarrier, path: PathKind) {
  const ab = new ManualPipe(x, y, 'm-x', 'm-y');
  const ba = new ManualPipe(y, x, 'm-y', 'm-x');
  const make = (id: string, pipe: ManualPipe): CarrierConn => ({
    connId: id,
    path,
    maxFrameBytes: 64 * 1024,
    send(frame: Uint8Array, lane: Lane): SendResult {
      pipe.queue.push(frame.slice());
      pipe.sent.push({ lane, bytes: frame.length });
      return 'ok';
    },
    close() {},
    inFlight: () => pipe.bytes,
  });
  x.emit({ type: 'conn', conn: make('m-x', ab), direction: 'out' });
  y.emit({ type: 'conn', conn: make('m-y', ba), direction: 'in' });
  return { ab, ba };
}

describe('LinkHost: shallow carrier queues (design §4.4, G6)', () => {
  it('a 4 MiB catch-up waits in the lanes; an SOS is the next frame handed over', async () => {
    const rig = new Rig();
    const { a, b } = await teamOfTwo(rig);
    // 4 MiB of messages Julie lacks, written while the two were apart.
    const text = 'x'.repeat(MAX_MESSAGE_CHARS - 8);
    let written = 0;
    for (let i = 0; written < 4 * 1024 * 1024; i++) {
      rig.t += 10;
      expect(active(a).sendMessage(`${i} ${text}`)).toBeNull();
      written += text.length;
    }
    const ca = new FakeCarrier();
    const cb = new FakeCarrier();
    a.host.attachCarrier(ca, () => active(b).me);
    b.host.attachCarrier(cb, () => active(a).me);
    const { ab, ba } = manualConnect(ca, cb, 'direct');
    const group = active(a).teamId;
    const backlog = () => a.host.peers(group)[0]?.session.pendingFrames ?? 0;
    // Run the link until Julie's want is being served and frames pile up.
    for (let i = 0; i < 200 && backlog() < 16; i++) {
      ab.flush();
      ba.flush();
      rig.advance(DRAIN_POLL_MS);
    }
    expect(backlog()).toBeGreaterThanOrEqual(16);
    // The carrier holds at most the budget (plus the frame that crossed it)…
    const held = ab.bytes;
    expect(held).toBeLessThanOrEqual(IN_FLIGHT_BUDGET + 64 * 1024);
    // …while MiBs wait unsealed in the lanes.
    expect(backlog()).toBeGreaterThan(held / (64 * 1024));
    // Full: nothing more goes in while it stays full.
    const before = ab.sent.length;
    rig.advance(10 * DRAIN_POLL_MS);
    expect(ab.sent.length).toBe(before);

    expect(active(a).raiseSos(-71.2, 46.8)).toBeNull();
    // Still full: the SOS waits in lane 0, ahead of every queued catch-up frame.
    expect(ab.sent.length).toBe(before);
    ab.flush(1);
    rig.advance(DRAIN_POLL_MS);
    const after = ab.sent.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!.lane).toBe(0);
    // Everything still converges, the SOS included.
    for (let i = 0; i < 4000; i++) {
      if (ab.queue.length === 0 && ba.queue.length === 0 && backlog() === 0) break;
      ab.flush();
      ba.flush();
      rig.advance(DRAIN_POLL_MS);
    }
    expect(active(b).soses()).toHaveLength(1);
    expect(active(b).view().messages.length).toBe(active(a).view().messages.length);
  });
});

describe('LinkHost: internet links without the LAN (G6)', () => {
  it('ticks while another carrier is attached, LAN or not', async () => {
    const rig = new Rig();
    const { a, b } = await teamOfTwo(rig);
    const solo = new TeamService({
      c: nodeCrypto,
      disk: new MemoryTeamDisk(),
      transport: rig.hub.createTransport(),
      now: rig.now,
      tickMs: 5_000,
      timers: rig.timers,
    });
    expect(solo.host.linkLayer!.ticking).toBe(false);
    const detach = solo.host.attachCarrier(new FakeCarrier(), () => undefined);
    expect(solo.host.linkLayer!.ticking).toBe(true);
    detach();
    expect(solo.host.linkLayer!.ticking).toBe(false);
    // And a tick re-syncs an internet-only link: vectors go out on lane 2.
    const la = a.host.linkLayer!;
    const ca = new FakeCarrier();
    const cb = new FakeCarrier();
    a.host.attachCarrier(ca, () => active(b).me);
    b.host.attachCarrier(cb, () => active(a).me);
    connect(rig, ca, cb, 'direct');
    await rig.settle();
    const sync = () => la.snapshot()[0]!.sentByLane[2]!;
    const s0 = sync();
    la.tick();
    expect(sync()).toBeGreaterThan(s0);
  });

  it('a nearby link and an internet link to the same phone are not duplicates', async () => {
    const rig = new Rig();
    const { a, b } = await teamOfTwo(rig);
    const ca = new FakeCarrier();
    const cb = new FakeCarrier();
    a.host.attachCarrier(ca, () => active(b).me);
    b.host.attachCarrier(cb, () => active(a).me);
    connect(rig, ca, cb, 'direct');
    await rig.settle();
    await active(a).startMesh();
    await active(b).startMesh();
    await rig.settle();
    active(a).tick();
    await rig.settle();
    for (const p of [a, b]) {
      expect(
        p.host
          .links()
          .map((l) => l.path)
          .sort(),
      ).toEqual(['direct', 'nearby']);
    }
  });
});
