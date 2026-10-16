import { bytesEqual, toB64u, utf8 } from '../team/bytes';
import { canonicalize } from '../team/canonical';
import { LAN_LIMITS, RELAY_LIMITS } from '../team/ratelimit';
import type { SessionEvent } from '../team/sync';
import { forAll, int } from '../team/testing/prop';
import { nodeCrypto as c } from '../team/testing/nodeCrypto';
import type { Lane } from './lanes';
import {
  channelLimits,
  channelTag,
  decodeHello,
  DIRECT_LIMITS,
  decodeMuxFrame,
  encodeHello,
  encodeMuxFrame,
  FRAME_KIND,
  HELLO_TIMEOUT_MS,
  KEEPALIVE_MS,
  limitsForPath,
  linkIdOf,
  LinkMux,
  MAX_BANS,
  MAX_CHANNELS,
  MAX_REFUSALS_PER_MIN,
  MemberBans,
  MUX_HEADER_BYTES,
  Pacer,
  PAD_BUCKETS,
  paddedSize,
  TURN_LIMITS,
  type ChannelRequest,
  type LinkEvent,
  type LinkOptions,
  type MuxChannel,
} from './link';

const T = 1_700_000_000_000;
const G1 = toB64u(new Uint8Array(16).fill(1));
const G2 = toB64u(new Uint8Array(16).fill(2));
const G3 = toB64u(new Uint8Array(16).fill(3));
const ALICE = toB64u(new Uint8Array(32).fill(0xa1));
const BOB = toB64u(new Uint8Array(32).fill(0xb0));

class FakeChannel implements MuxChannel {
  phase = 'open';
  peer: string | undefined;
  bannedUntil: number | undefined;
  upgradeIn?: boolean;
  upgradeOut?: boolean;
  readonly queues: Uint8Array[][] = [[], [], [], []];
  readonly received: Uint8Array[] = [];
  /** Events the next receive / tick returns. */
  next: SessionEvent[] = [];
  closedWhy: string | undefined;

  receive(data: Uint8Array): { events: SessionEvent[] } {
    this.received.push(data);
    return { events: this.next.splice(0) };
  }
  tick(): { events: SessionEvent[] } {
    return { events: this.next.splice(0) };
  }
  close(why = 'bye'): { events: SessionEvent[] } {
    this.phase = 'closed';
    this.closedWhy = why;
    return { events: [{ type: 'closed', why }] };
  }
  hasPending(lane: Lane): boolean {
    return this.queues[lane]!.length > 0;
  }
  nextFrame(lane: Lane): Uint8Array | undefined {
    return this.queues[lane]!.shift();
  }
  queue(lane: Lane, ...texts: string[]): void {
    for (const t of texts) this.queues[lane]!.push(utf8(t));
  }
}

interface Side {
  mux: LinkMux;
  events: LinkEvent[];
  channels: Map<string, FakeChannel>;
  requests: ChannelRequest[];
}

function side(
  role: 'initiator' | 'responder',
  groups: string[],
  extra: Partial<LinkOptions> = {},
  accept: (req: ChannelRequest) => boolean = () => true,
): Side {
  const channels = new Map<string, FakeChannel>();
  const requests: ChannelRequest[] = [];
  const mux = new LinkMux(c, {
    side: role,
    maxFrameBytes: 64 * 1024,
    limits: RELAY_LIMITS,
    caps: ['lnk', 'rtc'],
    groups: () => groups,
    channelFactory: (req) => {
      requests.push(req);
      if (!accept(req)) return undefined;
      const ch = new FakeChannel();
      channels.set(`${req.groupId}/${req.cls}`, ch);
      return ch;
    },
    now: T,
    ...extra,
  });
  return { mux, events: mux.takeEvents(), channels, requests };
}

/** Deliver frames both ways until quiet. */
function pump(a: Side, b: Side, now = T, rounds = 50): void {
  for (let i = 0; i < rounds; i++) {
    const fa = a.mux.drain(now);
    const fb = b.mux.drain(now);
    a.events.push(...a.mux.takeEvents());
    b.events.push(...b.mux.takeEvents());
    if (fa.length === 0 && fb.length === 0) return;
    for (const f of fa) b.events.push(...b.mux.receive(f, now));
    for (const f of fb) a.events.push(...a.mux.receive(f, now));
  }
}

const types = (s: Side) => s.events.map((e) => e.type);
const strikes = (s: Side) => s.events.flatMap((e) => (e.type === 'strike' ? [e.reason] : []));
const closedWhy = (s: Side) => s.events.flatMap((e) => (e.type === 'closed' ? [e.why] : []));

function pair(groupsA = [G1, G2], groupsB = [G1, G3]) {
  const a = side('initiator', groupsA);
  const b = side('responder', groupsB);
  pump(a, b);
  return { a, b };
}

describe('wire format', () => {
  it('pads to 256 B, 1, 4, 16 KiB, then whole 16 KiB, never past the carrier', () => {
    expect(paddedSize(0, 65536)).toBe(256);
    expect(paddedSize(248, 65536)).toBe(256);
    expect(paddedSize(249, 65536)).toBe(1024);
    expect(paddedSize(4088, 65536)).toBe(4096);
    expect(paddedSize(16376, 65536)).toBe(16384);
    expect(paddedSize(16377, 65536)).toBe(32768);
    expect(paddedSize(40000, 65536)).toBe(49152);
    expect(paddedSize(60000, 65536)).toBe(65536);
    expect(paddedSize(60000, 62000)).toBe(62000);
    expect(paddedSize(62000, 62000)).toBeUndefined();
  });

  it('property: every encoded frame is a bucket size (or the carrier cap) and decodes back', () => {
    forAll(
      7051,
      300,
      (rnd) => ({
        n: int(rnd, 0, 70_000),
        ch: int(rnd, 0, 0xffff),
        kind: int(rnd, 0, 6),
        max: [65536, 512 * 1024, 16384][int(rnd, 0, 2)]!,
      }),
      ({ n, ch, kind, max }) => {
        const payload = new Uint8Array(n).fill(0x5a);
        if (n > 0) payload[n - 1] = ch & 0xff;
        const f = encodeMuxFrame(kind as never, ch, payload, max);
        if (n + MUX_HEADER_BYTES > max) return expect(f).toBeUndefined();
        expect(f).toBeDefined();
        const len = f!.length;
        expect(PAD_BUCKETS.includes(len) || len % 16384 === 0 || len === max).toBe(true);
        const d = decodeMuxFrame(f!)!;
        expect(d.kind).toBe(kind);
        expect(d.ch).toBe(ch);
        expect(bytesEqual(d.payload, payload)).toBe(true);
      },
    );
  });

  it('refuses malformed frames (total parse)', () => {
    const good = encodeMuxFrame(FRAME_KIND.data, 3, utf8('hi'), 65536)!;
    expect(decodeMuxFrame(good.slice(0, 7))).toBeUndefined();
    const ver = good.slice();
    ver[0] = 2;
    expect(decodeMuxFrame(ver)).toBeUndefined();
    const kind = good.slice();
    kind[1] = 7;
    expect(decodeMuxFrame(kind)).toBeUndefined();
    const len = good.slice();
    new DataView(len.buffer).setUint32(4, 10_000);
    expect(decodeMuxFrame(len)).toBeUndefined();
    const pad = good.slice();
    pad[200] = 1;
    expect(decodeMuxFrame(pad)).toBeUndefined();
    expect(encodeMuxFrame(FRAME_KIND.data, -1, utf8('x'), 65536)).toBeUndefined();
    expect(encodeMuxFrame(FRAME_KIND.data, 0x10000, utf8('x'), 65536)).toBeUndefined();
  });

  it('fuzz: decoding random bytes never throws', () => {
    forAll(
      7052,
      2000,
      (rnd) => {
        const n = int(rnd, 0, 600);
        const b = new Uint8Array(n).map(() => int(rnd, 0, 255));
        if (n > 0 && rnd() < 0.5) b[0] = 1;
        if (n > 1 && rnd() < 0.5) b[1] = int(rnd, 0, 6);
        return b;
      },
      (b) => {
        expect(() => decodeMuxFrame(b)).not.toThrow();
        expect(() => decodeHello(b)).not.toThrow();
      },
    );
  });

  it('hello: round-trips, negotiates versions, refuses junk', () => {
    const n = new Uint8Array(16).fill(9);
    expect(decodeHello(encodeHello({ v: 1, caps: ['lnk'], n }))).toEqual({
      v: 1,
      caps: ['lnk'],
      n,
    });
    const raw = (o: unknown) => utf8(canonicalize(o)!);
    const nn = toB64u(n);
    expect(decodeHello(raw({ v: 3, caps: [], n: nn }))).toMatchObject({ v: 3 });
    expect(decodeHello(raw({ v: 0, caps: [], n: nn }))).toBe('version');
    expect(decodeHello(raw({ v: 1.5, caps: [], n: nn }))).toBeUndefined();
    expect(decodeHello(raw({ v: 1, caps: [], n: nn, x: 1 }))).toBeUndefined();
    expect(decodeHello(raw({ v: 1, caps: 'lnk', n: nn }))).toBeUndefined();
    expect(decodeHello(raw({ v: 1, caps: Array(17).fill('a'), n: nn }))).toBeUndefined();
    expect(decodeHello(raw({ v: 1, caps: [''], n: nn }))).toBeUndefined();
    expect(decodeHello(raw({ v: 1, caps: ['x'.repeat(17)], n: nn }))).toBeUndefined();
    expect(decodeHello(raw({ v: 1, caps: [1], n: nn }))).toBeUndefined();
    expect(decodeHello(raw({ v: 1, caps: [], n: toB64u(new Uint8Array(15)) }))).toBeUndefined();
    expect(decodeHello(raw([1]))).toBeUndefined();
    expect(decodeHello(new Uint8Array(2000))).toBeUndefined();
    expect(decodeHello(Uint8Array.of(0xff, 0xfe))).toBeUndefined();
  });

  it('binds link ids to both nonces in order, and tags to group, link and class', () => {
    const x = new Uint8Array(16).fill(1);
    const y = new Uint8Array(16).fill(2);
    const l1 = linkIdOf(c, x, y);
    expect(l1).not.toEqual(linkIdOf(c, y, x));
    const t = channelTag(c, G1, l1, 'sync');
    expect(t).toHaveLength(32);
    expect(t).not.toEqual(channelTag(c, G2, l1, 'sync'));
    expect(t).not.toEqual(channelTag(c, G1, l1, 'blob'));
    expect(t).not.toEqual(channelTag(c, G1, linkIdOf(c, y, x), 'sync'));
    // A non-base64 id still derives (never throws).
    expect(channelTag(c, 'not base64!', l1, 'sync')).toHaveLength(32);
  });

  it('uses internet profiles with relay strikes and bans (R-RL-4) and fits sessions in the carrier', () => {
    expect(limitsForPath('nearby')).toBe(LAN_LIMITS);
    expect(limitsForPath('direct')).toBe(DIRECT_LIMITS);
    expect(limitsForPath('relay')).toBe(TURN_LIMITS);
    // PM decision after G2: 256 KiB/s direct, 128 KiB/s through TURN.
    expect(DIRECT_LIMITS.bytesPerSec).toBe(256 * 1024);
    expect(TURN_LIMITS.bytesPerSec).toBe(128 * 1024);
    for (const l of [DIRECT_LIMITS, TURN_LIMITS]) {
      expect(l.strikesToBan).toBe(RELAY_LIMITS.strikesToBan);
      expect(l.banMs).toBe(RELAY_LIMITS.banMs);
      expect(l.ops).toEqual(RELAY_LIMITS.ops);
    }
    expect(channelLimits(RELAY_LIMITS, 65536).maxFrameBytes).toBe(65536 - MUX_HEADER_BYTES);
    expect(channelLimits(RELAY_LIMITS, 1 << 20).maxFrameBytes).toBe(RELAY_LIMITS.maxFrameBytes);
  });
});

describe('MemberBans (R-RL-4)', () => {
  it('bans by member id until a time, keeps the later of two bans, and expires', () => {
    const bans = new MemberBans();
    bans.ban(ALICE, T + 1000);
    bans.ban(ALICE, T + 500);
    expect(bans.isBanned(ALICE, T + 999)).toBe(true);
    expect(bans.isBanned(BOB, T)).toBe(false);
    expect(bans.isBanned(ALICE, T + 1000)).toBe(false);
    expect(bans.size).toBe(0);
  });

  it('stays bounded: past the cap the ban ending soonest goes', () => {
    const bans = new MemberBans();
    for (let i = 0; i < MAX_BANS; i++) bans.ban(`m${i}`, T + 10_000 + i);
    bans.ban('soon', T + 1);
    expect(bans.size).toBe(MAX_BANS);
    expect(bans.isBanned('soon', T)).toBe(false);
    expect(bans.isBanned('m0', T)).toBe(true);
  });
});

describe('Pacer', () => {
  it('spends a burst, then waits for the refill', () => {
    const p = new Pacer(RELAY_LIMITS, T);
    let sent = 0;
    while (p.allows(65536, T)) {
      p.spend(65536, T);
      sent++;
    }
    // Half the peer's 512 KiB burst.
    expect(sent).toBe(4);
    const wait = p.waitMs(65536, T);
    expect(wait).toBeGreaterThan(0);
    expect(p.allows(65536, T + wait)).toBe(true);
    // A reserve keeps headroom: lanes 1–3 stop earlier than lane 0.
    const q = new Pacer(RELAY_LIMITS, T);
    q.spend(65536 * 2, T);
    expect(q.allows(65536, T, 2)).toBe(false);
    expect(q.allows(65536, T, 0)).toBe(true);
    expect(q.waitMs(256, T)).toBe(0);
  });

  it('never asks for more than its capacity', () => {
    const tiny = { ...RELAY_LIMITS, burstBytes: 1000, burstFrames: 2 };
    const p = new Pacer(tiny, T);
    expect(p.allows(65536, T, 4)).toBe(true);
  });
});

describe('LinkMux: hellos and channels', () => {
  it('both sides agree on the link id and the common capabilities', () => {
    const a = side('initiator', [G1], { caps: ['lnk', 'rtc', 'blob'] });
    const b = side('responder', [G1], { caps: ['rtc', 'lnk', 'zzz'] });
    pump(a, b);
    expect(a.mux.state).toBe('open');
    expect(b.mux.state).toBe('open');
    expect(a.mux.linkId).toBe(b.mux.linkId);
    expect(a.mux.linkId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.mux.caps).toEqual(['lnk', 'rtc']);
    expect(b.mux.caps).toEqual(['lnk', 'rtc']);
    expect(types(a)).toContain('ready');
  });

  it('opens a channel only for a group both hold, and carries frames on it', () => {
    const { a, b } = pair();
    a.mux.open(G1);
    a.mux.open(G1); // duplicate: ignored
    a.mux.open(G2); // B does not hold it: refused, no reason
    pump(a, b);
    expect(a.events).toContainEqual({ type: 'refused', groupId: G2, cls: 'sync' });
    expect(b.requests).toEqual([{ groupId: G1, cls: 'sync', side: 'responder', now: T }]);
    const ca = a.channels.get(`${G1}/sync`)!;
    const cb = b.channels.get(`${G1}/sync`)!;
    expect(a.mux.channelOf(G1)).toBe(2);
    expect(b.mux.channelOf(G1)).toBe(2);
    ca.queue(2, 'hello from a');
    cb.queue(1, 'hello from b');
    pump(a, b);
    expect(cb.received.map((x) => new TextDecoder().decode(x))).toEqual(['hello from a']);
    expect(ca.received.map((x) => new TextDecoder().decode(x))).toEqual(['hello from b']);
    expect(strikes(a)).toEqual([]);
    expect(strikes(b)).toEqual([]);
    // The responder opens its own channels with odd numbers.
    b.mux.open(G1, 'blob');
    pump(a, b);
    expect(b.mux.channelOf(G1, 'blob')).toBe(1);
  });

  it('defers opens asked before the hellos, and refuses what the factory refuses', () => {
    const a = side('initiator', [G1, G3]);
    const b = side('responder', [G1, G3], {}, (req) => req.groupId !== G3);
    a.mux.open(G1);
    a.mux.open(G3);
    pump(a, b);
    expect(a.mux.channelOf(G1)).toBeDefined();
    expect(a.events).toContainEqual({ type: 'refused', groupId: G3, cls: 'sync' });
  });

  it('closes the opener side when its own factory declines an accepted channel', () => {
    const a = side('initiator', [G1], {}, () => false);
    const b = side('responder', [G1]);
    pump(a, b);
    a.mux.open(G1);
    pump(a, b);
    expect(a.mux.channelOf(G1)).toBeUndefined();
    expect(b.mux.channelOf(G1)).toBeUndefined();
    expect(strikes(b)).toEqual([]);
  });

  it('serves lane 0 of any channel before lower lanes, round-robin within a lane', () => {
    const { a, b } = pair([G1, G3], [G1, G3]);
    a.mux.open(G1);
    a.mux.open(G3);
    pump(a, b);
    const c1 = a.channels.get(`${G1}/sync`)!;
    const c3 = a.channels.get(`${G3}/sync`)!;
    c1.queue(2, 'c1-a', 'c1-b', 'c1-c');
    c3.queue(2, 'c3-a', 'c3-b');
    c3.queue(0, 'SOS');
    const order: string[] = [];
    for (let f = a.mux.next(T); f !== undefined; f = a.mux.next(T + 60_000)) {
      const d = decodeMuxFrame(f)!;
      order.push(new TextDecoder().decode(d.payload));
    }
    expect(order[0]).toBe('SOS');
    expect(order.slice(1)).toEqual(['c1-a', 'c3-a', 'c1-b', 'c3-b', 'c1-c']);
    expect(a.mux.sentByLane[0]).toBeGreaterThan(0);
  });

  it('says which lane each frame came from (nextOut), control frames as lane 0', () => {
    const { a, b } = pair([G1], [G1]);
    a.mux.open(G1);
    pump(a, b);
    const ch = a.channels.get(`${G1}/sync`)!;
    ch.queue(3, 'bulk');
    ch.queue(2, 'sync');
    ch.queue(1, 'live');
    expect(a.mux.nextLane).toBe(1);
    const seen: [string, Lane][] = [];
    for (let o = a.mux.nextOut(T); o !== undefined; o = a.mux.nextOut(T + 60_000)) {
      seen.push([new TextDecoder().decode(decodeMuxFrame(o.frame)!.payload), o.lane]);
    }
    expect(seen).toEqual([
      ['live', 1],
      ['sync', 2],
      ['bulk', 3],
    ]);
    expect(a.mux.nextLane).toBeUndefined();
    // A keepalive (a control frame) is lane 0.
    a.mux.tick(T + 120_000);
    expect(a.mux.nextLane).toBe(0);
    expect(a.mux.nextOut(T + 120_000)?.lane).toBe(0);
  });

  it('closes a channel on both sides when its session ends', () => {
    const { a, b } = pair();
    a.mux.open(G1);
    pump(a, b);
    const ca = a.channels.get(`${G1}/sync`)!;
    const cb = b.channels.get(`${G1}/sync`)!;
    ca.queue(0, 'bye');
    ca.next = [{ type: 'closed', why: 'bye' }];
    a.mux.tick(T);
    pump(a, b);
    expect(a.mux.channelOf(G1)).toBeUndefined();
    expect(cb.closedWhy).toBe('peer-closed');
    expect(b.mux.channelOf(G1)).toBeUndefined();
    expect(b.events).toContainEqual({
      type: 'channel-closed',
      ch: 2,
      groupId: G1,
      why: 'peer-closed',
    });
    // A late frame for the closed channel is not the peer's fault.
    b.events.push(...b.mux.receive(encodeMuxFrame(FRAME_KIND.data, 2, utf8('late'), 65536)!, T));
    expect(strikes(b)).toEqual([]);
    // A ch-close for an unknown channel is ignored.
    b.events.push(
      ...b.mux.receive(encodeMuxFrame(FRAME_KIND.close, 40, new Uint8Array(0), 65536)!, T),
    );
    expect(strikes(b)).toEqual([]);
  });

  it('caps channels per link', () => {
    const groups = Array.from({ length: MAX_CHANNELS + 2 }, (_, i) =>
      toB64u(new Uint8Array(16).fill(i + 10)),
    );
    const a = side('initiator', groups);
    const b = side('responder', groups);
    pump(a, b);
    let now = T;
    for (const g of groups) {
      a.mux.open(g);
      now += 1000; // within the open rate
      pump(a, b, now);
    }
    expect(a.mux.channelCount).toBe(MAX_CHANNELS);
    expect(b.mux.channelCount).toBe(MAX_CHANNELS);
  });

  it('keeps alive when idle, and times out a missing hello', () => {
    const { a, b } = pair();
    a.mux.tick(T + KEEPALIVE_MS - 1);
    expect(a.mux.hasPending()).toBe(false);
    a.mux.tick(T + KEEPALIVE_MS);
    const f = a.mux.next(T + KEEPALIVE_MS)!;
    expect(decodeMuxFrame(f)!.kind).toBe(FRAME_KIND.pad);
    b.mux.receive(f, T + KEEPALIVE_MS);
    expect(b.mux.lastHeard).toBe(T + KEEPALIVE_MS);
    const lonely = side('initiator', [G1]);
    lonely.mux.tick(T + HELLO_TIMEOUT_MS);
    expect(lonely.mux.state).toBe('hello');
    expect(lonely.mux.tick(T + HELLO_TIMEOUT_MS + 1)).toContainEqual({
      type: 'closed',
      why: 'timeout',
    });
  });

  it('closes with its channels’ last frames and a ch-close each', () => {
    const { a, b } = pair();
    a.mux.open(G1);
    pump(a, b);
    const out = a.mux.close('done', T);
    expect(out.length).toBe(1);
    expect(decodeMuxFrame(out[0]!)!.kind).toBe(FRAME_KIND.close);
    expect(a.mux.state).toBe('closed');
    expect(a.mux.takeEvents()).toContainEqual({ type: 'closed', why: 'done' });
    expect(a.mux.close('again', T)).toEqual([]);
    expect(a.mux.next(T)).toBeUndefined();
    expect(a.mux.hasPending()).toBe(false);
    expect(a.mux.nextSendDelay(T)).toBeUndefined();
    expect(a.mux.receive(out[0]!, T)).toEqual([]);
    expect(a.mux.tick(T)).toEqual([]);
    a.mux.open(G1);
  });

  it('paces: past its share of the peer budget it waits, and says how long', () => {
    const { a, b } = pair();
    a.mux.open(G1);
    pump(a, b);
    const ca = a.channels.get(`${G1}/sync`)!;
    for (let i = 0; i < 40; i++) ca.queue(2, 'x'.repeat(60_000));
    expect(a.mux.nextSendDelay(T)).toBe(0);
    const burst = a.mux.drain(T, 1 << 30);
    expect(burst.length).toBeGreaterThan(0);
    expect(burst.length).toBeLessThan(40);
    expect(a.mux.next(T)).toBeUndefined();
    const wait = a.mux.nextSendDelay(T)!;
    expect(wait).toBeGreaterThan(0);
    expect(a.mux.next(T + wait)).toBeDefined();
    // Lane 0 keeps its reserve: an SOS still goes when bulk must wait.
    ca.queue(0, 'SOS');
    expect(a.mux.nextSendDelay(T + wait)).toBe(0);
    expect(new TextDecoder().decode(decodeMuxFrame(a.mux.next(T + wait)!)!.payload)).toBe('SOS');
    expect(side('initiator', [G1]).mux.nextSendDelay(T)).toBe(0); // its hello
  });

  it('closes rather than truncate a frame larger than the carrier', () => {
    const { a, b } = pair();
    a.mux.open(G1);
    pump(a, b);
    a.channels.get(`${G1}/sync`)!.queue(2, 'x'.repeat(70_000));
    expect(a.mux.next(T)).toBeUndefined();
    expect(a.mux.takeEvents()).toContainEqual({ type: 'closed', why: 'oversize' });
  });
});

describe('LinkMux: identity and bans (R-RL-4)', () => {
  it('adopts the first authenticated peer and closes on a different one', () => {
    const { a, b } = pair([G1, G3], [G1, G3]);
    a.mux.open(G1);
    a.mux.open(G3);
    pump(a, b);
    const c1 = b.channels.get(`${G1}/sync`)!;
    const c3 = b.channels.get(`${G3}/sync`)!;
    c1.next = [{ type: 'open', peer: ALICE, joining: false }];
    a.channels.get(`${G1}/sync`)!.queue(2, 'x');
    pump(a, b);
    expect(b.mux.identity).toBe(ALICE);
    expect(b.events).toContainEqual({ type: 'identity', member: ALICE });
    c3.next = [{ type: 'open', peer: BOB, joining: false }];
    a.channels.get(`${G3}/sync`)!.queue(2, 'y');
    pump(a, b);
    expect(closedWhy(b)).toEqual(['identity']);
  });

  it('refuses a banned member at once (internet: identity from L0)', () => {
    const bans = new MemberBans();
    bans.ban(ALICE, T + 60_000);
    const s = side('responder', [G1], { identity: ALICE, bans });
    expect(s.mux.state).toBe('closed');
    expect(closedWhy(s)).toEqual(['banned']);
    // On the LAN the identity comes from the first session.
    const a = side('initiator', [G1]);
    const b = side('responder', [G1], { bans });
    pump(a, b);
    a.mux.open(G1);
    pump(a, b);
    b.channels.get(`${G1}/sync`)!.next = [{ type: 'open', peer: ALICE, joining: false }];
    a.channels.get(`${G1}/sync`)!.queue(2, 'x');
    pump(a, b);
    expect(closedWhy(b)).toEqual(['banned']);
  });

  it('bans the member (not an address) when its session is banned', () => {
    const bans = new MemberBans();
    const a = side('initiator', [G1]);
    const b = side('responder', [G1], { bans, identity: ALICE });
    pump(a, b);
    a.mux.open(G1);
    pump(a, b);
    const cb = b.channels.get(`${G1}/sync`)!;
    cb.bannedUntil = T + 30 * 60_000;
    cb.next = [{ type: 'closed', why: 'banned' }];
    a.channels.get(`${G1}/sync`)!.queue(2, 'x');
    pump(a, b);
    expect(b.events).toContainEqual({ type: 'banned', member: ALICE, until: T + 30 * 60_000 });
    expect(bans.isBanned(ALICE, T + 1)).toBe(true);
    expect(b.mux.state).toBe('closed');
    // No bannedUntil: the profile's ban length.
    const bans2 = new MemberBans();
    const a2 = side('initiator', [G1]);
    const b2 = side('responder', [G1], { bans: bans2, identity: BOB });
    pump(a2, b2);
    a2.mux.open(G1);
    pump(a2, b2);
    b2.channels.get(`${G1}/sync`)!.next = [{ type: 'closed', why: 'banned' }];
    a2.channels.get(`${G1}/sync`)!.queue(2, 'x');
    pump(a2, b2);
    expect(bans2.isBanned(BOB, T + RELAY_LIMITS.banMs - 1)).toBe(true);
  });
});

describe('LinkMux: hostile peers (total, strikes, bans)', () => {
  function opened() {
    const bans = new MemberBans();
    const victim = side('responder', [G1], { bans, identity: ALICE });
    const evil = side('initiator', [G1]);
    pump(evil, victim);
    return { victim, evil, bans };
  }
  const frame = (kind: number, ch: number, payload: Uint8Array = new Uint8Array(0)) =>
    encodeMuxFrame(kind as never, ch, payload, 65536)!;
  const hit = (s: Side, f: Uint8Array, now = T) => s.events.push(...s.mux.receive(f, now));

  it('strikes frames before the hello, a second hello, and junk', () => {
    const v = side('responder', [G1]);
    hit(v, frame(FRAME_KIND.data, 2, utf8('x')));
    expect(strikes(v)).toEqual(['protocol']);
    const { victim } = opened();
    hit(victim, frame(FRAME_KIND.hello, 0, encodeHello({ v: 1, caps: [], n: new Uint8Array(16) })));
    hit(victim, utf8('garbage that is not a mux frame at all'));
    hit(victim, new Uint8Array(RELAY_LIMITS.maxFrameBytes + 1));
    expect(strikes(victim)).toEqual(['protocol', 'malformed', 'oversize']);
    const h = side('responder', [G1]);
    hit(h, frame(FRAME_KIND.hello, 0, utf8('{"v":1}')));
    hit(h, frame(FRAME_KIND.hello, 3, encodeHello({ v: 1, caps: [], n: new Uint8Array(16) })));
    expect(strikes(h)).toEqual(['malformed', 'protocol']);
  });

  it('closes without a strike on a hello below version 1', () => {
    const v = side('responder', [G1]);
    hit(
      v,
      frame(
        FRAME_KIND.hello,
        0,
        utf8(canonicalize({ v: 0, caps: [], n: toB64u(new Uint8Array(16)) })!),
      ),
    );
    expect(closedWhy(v)).toEqual(['version']);
    expect(strikes(v)).toEqual([]);
  });

  it('strikes channel opens with the wrong parity, channel 0, a taken number or a bad body', () => {
    const { victim, evil } = opened();
    const tag = channelTag(c, G1, Uint8Array.from(Buffer.from(evil.mux.linkId!, 'hex')), 'sync');
    const body = Uint8Array.of(0, ...tag);
    hit(victim, frame(FRAME_KIND.open, 3, body)); // the initiator's numbers are even
    hit(victim, frame(FRAME_KIND.open, 0, body));
    hit(victim, frame(FRAME_KIND.open, 4, Uint8Array.of(0, 1, 2)));
    hit(victim, frame(FRAME_KIND.open, 4, Uint8Array.of(9, ...tag)));
    hit(victim, frame(FRAME_KIND.open, 4, body));
    expect(victim.mux.channelOf(G1)).toBe(4);
    hit(victim, frame(FRAME_KIND.open, 4, body)); // taken
    hit(victim, frame(FRAME_KIND.open, 6, body)); // same group twice: refused
    hit(victim, frame(FRAME_KIND.ok, 8)); // an answer to nothing
    hit(victim, frame(FRAME_KIND.data, 10, utf8('x'))); // unknown channel
    expect(strikes(victim)).toEqual([
      'protocol',
      'protocol',
      'protocol',
      'protocol',
      'protocol',
      'protocol',
      'protocol',
    ]);
  });

  it('counts probing: past ten refusals a minute, each is a strike', () => {
    const { victim } = opened();
    for (let i = 0; i < MAX_REFUSALS_PER_MIN + 3; i++) {
      const tag = new Uint8Array(32).fill(i + 1); // a group the victim does not hold
      hit(victim, frame(FRAME_KIND.open, 2 + 2 * i, Uint8Array.of(0, ...tag)), T + i * 1000);
    }
    expect(strikes(victim).filter((s) => s === 'probing')).toHaveLength(3);
    expect(victim.mux.state).toBe('open');
  });

  it('rate-limits channel opens', () => {
    const { victim } = opened();
    for (let i = 0; i < 20; i++) {
      hit(victim, frame(FRAME_KIND.open, 2 + 2 * i, Uint8Array.of(0, ...new Uint8Array(32))));
    }
    expect(strikes(victim)).toContain('rate');
  });

  it('bans the authenticated member after enough strikes', () => {
    const { victim, bans } = opened();
    for (let i = 0; i < RELAY_LIMITS.strikesToBan; i++) hit(victim, utf8(`junk ${i}`));
    expect(closedWhy(victim)).toEqual(['banned']);
    expect(bans.isBanned(ALICE, T + 1)).toBe(true);
    expect(victim.events).toContainEqual({
      type: 'banned',
      member: ALICE,
      until: T + RELAY_LIMITS.banMs,
    });
  });

  it('fuzz: random frames never throw and never open a channel for an unknown group', () => {
    forAll(
      7053,
      300,
      (rnd) =>
        Array.from({ length: int(rnd, 1, 30) }, () => {
          const kind = int(rnd, 0, 7);
          const ch = int(rnd, 0, 12);
          const n = int(rnd, 0, 40);
          const payload = new Uint8Array(n).map(() => int(rnd, 0, 255));
          return encodeMuxFrame(Math.min(kind, 6) as never, ch, payload, 65536)!;
        }),
      (frames) => {
        const { victim } = opened();
        for (const f of frames) expect(() => victim.mux.receive(f, T)).not.toThrow();
        expect(victim.requests).toEqual([]);
      },
    );
  });
});

describe('LinkMux: legacy LAN framing and the upgrade', () => {
  it('passes raw frames on channel 0 and switches when the session says so', () => {
    const legacy = new FakeChannel();
    const a = new LinkMux(c, {
      side: 'initiator',
      maxFrameBytes: 512 * 1024,
      limits: LAN_LIMITS,
      groups: () => [G1],
      channelFactory: () => undefined,
      legacy: { groupId: G1, channel: legacy },
      now: T,
    });
    expect(a.framing).toBe('v1');
    expect(a.hasPending()).toBe(false);
    legacy.queue(0, 'raw hi1');
    expect(new TextDecoder().decode(a.next(T)!)).toBe('raw hi1');
    legacy.next = [{ type: 'open', peer: BOB, joining: false }];
    a.receive(utf8('raw hi2'), T);
    expect(legacy.received.map((x) => new TextDecoder().decode(x))).toEqual(['raw hi2']);
    expect(a.identity).toBe(BOB);
    // `upok` received: both directions switch; a hello goes first.
    legacy.upgradeIn = true;
    legacy.upgradeOut = true;
    const events = a.receive(utf8('raw upok'), T);
    expect(a.framing).toBe('mux');
    expect(events).toContainEqual({ type: 'framing', framing: 'mux' });
    expect(decodeMuxFrame(a.next(T)!)!.kind).toBe(FRAME_KIND.hello);
    legacy.queue(2, 'now framed');
    const f = decodeMuxFrame(a.next(T)!)!;
    expect(f).toMatchObject({ kind: FRAME_KIND.data, ch: 0 });
  });

  it('ends with its one session', () => {
    const legacy = new FakeChannel();
    const a = new LinkMux(c, {
      side: 'responder',
      maxFrameBytes: 512 * 1024,
      limits: LAN_LIMITS,
      groups: () => [G1],
      channelFactory: () => undefined,
      legacy: { groupId: G1, channel: legacy },
      now: T,
    });
    legacy.queue(0, 'bye');
    legacy.next = [{ type: 'closed', why: 'bye' }];
    a.receive(utf8('raw bye'), T);
    expect(new TextDecoder().decode(a.next(T)!)).toBe('bye');
    expect(a.state).toBe('closed');
    expect(a.takeEvents()).toContainEqual({ type: 'closed', why: 'session-closed' });
    // Frames after the end are ignored.
    expect(a.receive(utf8('more'), T)).toEqual([]);
  });

  it('closing a legacy link sends its last raw frames, no ch-close', () => {
    const legacy = new FakeChannel();
    const a = new LinkMux(c, {
      side: 'responder',
      maxFrameBytes: 512 * 1024,
      limits: LAN_LIMITS,
      groups: () => [G1],
      channelFactory: () => undefined,
      legacy: { groupId: G1, channel: legacy },
      now: T,
    });
    legacy.close = function (why = 'bye') {
      this.phase = 'closed';
      this.queue(0, `bye ${why}`);
      return { events: [] };
    };
    const out = a.close('backgrounded', T);
    expect(out.map((x) => new TextDecoder().decode(x))).toEqual(['bye backgrounded']);
  });
});
