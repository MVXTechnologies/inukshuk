import { nodeCrypto } from '../../team/testing/nodeCrypto';
import { PAD_BUCKETS } from '../link';
import type { SimConn } from './network';
import { SimPathDriver, type PairEnv } from './paths';
import type { AppVersion, SimPhone } from './phone';
import { chance, choose, randInt, type Rng } from './rng';
import { SimWorld } from './world';

/**
 * The deterministic multi-peer simulator v1 (design §8.1): seeded worlds of
 * 2.7 and 2.6 phones over nearby, direct and relay paths with latency, loss
 * (retransmissions), reordering across paths, partitions mid-frame and path
 * failover driven by the real `choosePath`. Invariants after quiescence:
 * convergence, no strikes between honest phones, no gated frame to a 2.6
 * phone, nothing readable on the wire, every internet frame padded.
 */

/**
 * PR budget: small worlds, 24 seeds. A longer run (nightly, or by hand) sets
 * `INUKSHUK_SIM_SEEDS` / `INUKSHUK_SIM_FROM`; a failing seed is pinned in
 * {@link PINNED} as a regression, never retried.
 */
const SEED_COUNT = Number(process.env['INUKSHUK_SIM_SEEDS'] ?? 24);
const SEED_FROM = Number(process.env['INUKSHUK_SIM_FROM'] ?? 1000);
const PINNED: number[] = [];
const SEEDS = [...PINNED, ...Array.from({ length: SEED_COUNT }, (_, i) => SEED_FROM + i)];

const latin1 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return s;
};

const isPadded = (n: number): boolean => PAD_BUCKETS.includes(n) || (n > 16384 && n % 16384 === 0);

interface Scenario {
  world: SimWorld;
  drivers: SimPathDriver[];
  secrets: string[];
}

function randomEnv(rnd: Rng): PairEnv {
  return {
    nearby: chance(rnd, 0.3),
    online: chance(rnd, 0.85),
    directWorks: chance(rnd, 0.6),
    alwaysRelay: chance(rnd, 0.2),
  };
}

/** A random world, workload and adversity; healed at the end and left to settle. */
function scenario(seed: number): Scenario {
  const pre = new SimWorld({ seed, base: nodeCrypto, phones: ['2.7'] });
  const rnd = pre.rnd;
  const count = randInt(rnd, 3, 5);
  const versions: AppVersion[] = Array.from({ length: count }, (_, i) =>
    i >= 2 && chance(rnd, 0.35) ? '2.6' : '2.7',
  );
  const world = new SimWorld({ seed, base: nodeCrypto, phones: versions, groups: 2 });
  const r = world.rnd;
  const modern = world.phones.filter((p) => p.version === '2.7');
  const legacy = world.phones.filter((p) => p.version === '2.6');
  const drivers: SimPathDriver[] = [];
  // A spanning tree of pairs (so the healed world is connected), plus extra pairs.
  for (let j = 1; j < modern.length; j++) {
    const tree = randInt(r, 0, j - 1);
    for (let i = 0; i < j; i++) {
      if (i !== tree && !chance(r, 0.5)) continue;
      const d = new SimPathDriver(world, modern[i]!, modern[j]!, randomEnv(r));
      d.start();
      drivers.push(d);
    }
  }
  // Each 2.6 phone sits on the LAN with one 2.7 phone (re-dialled when cut).
  const lanOf = new Map<SimPhone, SimPhone>(legacy.map((p) => [p, choose(r, modern)]));
  const lanConns = new Map<SimPhone, SimConn>();
  const relink = (p: SimPhone) => {
    const c = lanConns.get(p);
    if (c?.open === true) return;
    lanConns.set(p, world.link(lanOf.get(p)!, p, 'nearby'));
  };
  legacy.forEach(relink);
  world.startTicks();

  const secrets: string[] = [];
  const end = world.clock.now + 120_000;
  let n = 0;
  while (world.clock.now < end) {
    world.run(randInt(r, 500, 4000));
    const p = choose(r, world.phones);
    const g = choose(r, [...p.groups.keys()]);
    const roll = r();
    if (roll < 0.55) {
      const secret = `secret-${seed}-${n++}`;
      secrets.push(secret);
      p.write(g, choose(r, ['wpt', 'trl', 'task']), `e${n}`, { name: secret });
    } else if (roll < 0.65) {
      p.write(g, 'sos', `s${n++}`, { on: 1 });
    } else if (roll < 0.8) {
      p.position(g, 46.8 + r() / 10, -71.2 + r() / 10);
    } else if (roll < 0.9 && drivers.length > 0) {
      // The environment changes: Wi-Fi joins or leaves, the internet drops, NAT changes.
      const d = choose(r, drivers);
      d.env = { ...randomEnv(r), alwaysRelay: d.env.alwaysRelay };
    } else {
      // A partition mid-frame: a random live connection drops with frames in flight.
      const live = [...world.net.conns.values()];
      if (live.length > 0) world.net.cut(choose(r, live), 'partition');
      legacy.forEach((q) => world.clock.after(randInt(r, 1000, 8000), () => relink(q)));
    }
  }
  // Heal: everyone online; the LAN pairs back; let anti-entropy settle.
  for (const d of drivers) d.env = { ...d.env, online: true };
  legacy.forEach(relink);
  world.run(120_000);
  return { world, drivers, secrets };
}

function checkInvariants({ world, secrets }: Scenario): void {
  // 1. Convergence of every group.
  for (const g of world.groupIds) expect(world.convergence(g)).toMatchObject({ ok: true });
  // 2. Honest phones never strike each other; 7. a 2.6 phone never sees a gated frame.
  const strikes = world.phones.flatMap((p) => p.stats.strikes);
  expect(strikes).toEqual([]);
  for (const p of world.phones.filter((q) => q.version === '2.6')) {
    expect(p.stats.upgrades).toBe(0);
    expect(p.stats.events['rtc'] ?? 0).toBe(0);
  }
  // 4. Nothing readable on the wire: no member id, no frame type, no record text;
  //    a group id only inside the v1 `hi1` hello (residual W3, hidden by room AEAD in G3).
  const ids = world.phones.map((p) => p.id);
  for (const w of world.net.wire) {
    const text = latin1(w.data);
    for (const id of ids) expect(text.includes(id)).toBe(false);
    for (const marker of ['"t":"ops"', '"t":"vv"', '"t":"want"', '"t":"rtc"', 'secret-']) {
      expect(text.includes(marker)).toBe(false);
    }
    for (const g of world.groupIds) if (text.includes(g)) expect(text).toContain('"t":"hi1"');
    // 5. Every internet frame is padded to a bucket.
    if (w.path !== 'nearby') expect(isPadded(w.data.length)).toBe(true);
  }
  expect(secrets.length).toBeGreaterThan(0);
}

describe('simulator: convergence under loss, reorder, partitions and path failover', () => {
  it.each(SEEDS)('seed %i converges with every invariant held', (seed) => {
    checkInvariants(scenario(seed));
  });

  it('is deterministic: a seed replays byte for byte', () => {
    const a = scenario(1003).world;
    const b = scenario(1003).world;
    expect(a.net.wire.length).toBe(b.net.wire.length);
    expect(a.wireDigest()).toBe(b.wireDigest());
    expect(a.clock.ran).toBe(b.clock.ran);
    const c = scenario(1004).world;
    expect(c.wireDigest()).not.toBe(a.wireDigest());
  });
});

describe('simulator: SOS lane under load (design §4.4, invariant 6)', () => {
  /**
   * The writer holds a backlog of catch-up frames on every link (4,096 ops at
   * most, written by a fourth phone that is away, so the SOS's own chain is
   * complete at the peers); an SOS written then must be the very next frame on
   * each link, measured in frames, not time.
   */
  it.each([2001, 2002, 2003, 2004, 2005, 2006])(
    'seed %i: the SOS is the next frame on every live link',
    (seed) => {
      const world = new SimWorld({ seed, base: nodeCrypto, phones: ['2.7', '2.7', '2.7', '2.7'] });
      const [p0, p1, p2, p3] = world.phones as [SimPhone, SimPhone, SimPhone, SimPhone];
      const g = world.groupIds[0]!;
      const backlog = randInt(world.rnd, 1500, 4096);
      for (let i = 0; i < backlog; i++) {
        world.clock.now += 1;
        p3.write(g, 'wpt', `w${i}`, { name: `w${i}`, d: 'x'.repeat(randInt(world.rnd, 10, 200)) });
      }
      const r3 = p3.groups.get(g)!;
      p0.groups.get(g)!.ingest(
        r3.log.logged().map((op) => op.env),
        world.clock.now,
      );
      world.startTicks();
      // Internet paths: 64 KiB frames, so the catch-up spans many frames (a LAN
      // drains it in a couple of 512 KiB frames before an SOS could be written).
      const paths = ['direct', 'relay'] as const;
      world.link(p0, p1, choose(world.rnd, paths));
      world.link(p0, p2, choose(world.rnd, paths));
      // Until both peers' `want`s are being served: the shallow carrier queue keeps
      // the rest of the catch-up waiting, unsealed, in p0's lanes.
      const backlogged = () =>
        p0.muxLinks().length === 2 &&
        p0.muxLinks().every((l) => (l.sessions.get(g)?.pendingFrames ?? 0) > 1);
      for (let i = 0; i < 800 && !backlogged(); i++) world.run(10);
      expect(backlogged()).toBe(true);
      // Hold the writer until what is already in flight has landed, so a frame we
      // hand over directly cannot overtake one on the wire.
      p0.hold = true;
      world.run(5000);
      const links = p0.muxLinks();
      for (const l of links) {
        expect(l.conn.pipes[l.conn.a === p0 ? 'ab' : 'ba'].inflight).toBe(0);
        expect(l.sessions.get(g)!.pendingFrames).toBeGreaterThan(1);
      }
      const sos = p0.write(g, 'sos', 'help', { on: 1 })!;
      for (const l of links) {
        const peer = l.conn.peerOf(p0) as SimPhone;
        const frame = l.mux.next(world.clock.now)!;
        peer.onFrame(l.conn.id, frame);
        expect(peer.groups.get(g)!.log.get(sos.id)).toBeDefined();
      }
      p0.release();
      // The away phone comes back: everything still converges, counters intact.
      world.link(p3, p1, 'relay');
      world.run(180_000);
      expect(world.convergence(g)).toMatchObject({ ok: true });
      expect(world.phones.flatMap((p) => p.stats.strikes)).toEqual([]);
    },
  );
});

describe('simulator: mixed versions and the LAN upgrade', () => {
  it('two 2.7 phones on a LAN upgrade to mux and carry a second group; a 2.6 phone stays v1', () => {
    const world = new SimWorld({
      seed: 77,
      base: nodeCrypto,
      phones: ['2.7', '2.7', '2.6'],
      groups: 2,
    });
    const [p0, p1, p2] = world.phones as [SimPhone, SimPhone, SimPhone];
    world.startTicks();
    const modern = world.link(p0, p1, 'nearby');
    const mixed = world.link(p1, p2, 'nearby');
    world.run(5000);
    for (const g of world.groupIds) p0.write(g, 'wpt', `a${g}`, { name: 'a' });
    p2.write(world.groupIds[0]!, 'wpt', 'b', { name: 'b' });
    world.run(60_000);
    for (const g of world.groupIds) expect(world.convergence(g)).toMatchObject({ ok: true });
    expect(p0.stats.upgrades).toBe(1);
    expect(p1.stats.upgrades).toBe(1);
    expect(p2.stats.upgrades).toBe(0);
    expect(world.phones.flatMap((p) => p.stats.strikes)).toEqual([]);
    const l0 = p0.links.get(modern.id)!;
    expect(l0.kind === 'mux' && l0.mux.framing).toBe('mux');
    const l1 = p1.links.get(mixed.id)!;
    expect(l1.kind === 'mux' && l1.mux.framing).toBe('v1');
    // After the upgrade every frame between the 2.7 phones is padded.
    const after = world.net.wire.filter((w) => w.connId === modern.id).slice(-20);
    for (const w of after) expect(isPadded(w.data.length)).toBe(true);
  });
});

describe('simulator: path failover (design §2.5)', () => {
  it('fails over direct → relay, then prefers nearby after the hysteresis, and converges', () => {
    const world = new SimWorld({ seed: 31, base: nodeCrypto, phones: ['2.7', '2.7'] });
    const [p0, p1] = world.phones as [SimPhone, SimPhone];
    const g = world.groupIds[0]!;
    world.startTicks();
    const d = new SimPathDriver(world, p0, p1, {
      nearby: false,
      online: true,
      directWorks: true,
      alwaysRelay: false,
    });
    d.start();
    world.run(10_000);
    expect(d.primary).toBe('direct');
    const primaries = () => [...new Set(d.log.map((x) => x.decision.primary ?? '-'))];
    p0.write(g, 'wpt', 'one', { name: 'one' });
    // NAT rebinding: direct dies mid-frame and cannot come back.
    d.env = { ...d.env, directWorks: false };
    world.net.cut(d.conns.direct!, 'nat');
    p1.write(g, 'wpt', 'two', { name: 'two' });
    world.run(20_000);
    expect(d.primary).toBe('relay');
    expect(world.convergence(g)).toMatchObject({ ok: true });
    // Same Wi-Fi: nearby takes over only after 10 s ready, then the relay closes.
    d.env = { ...d.env, nearby: true };
    world.run(3000);
    expect(d.primary).toBe('relay');
    world.run(15_000);
    expect(d.primary).toBe('nearby');
    expect(d.conns.relay).toBeUndefined();
    p0.write(g, 'sos', 'help', { on: 1 });
    world.run(10_000);
    expect(world.convergence(g)).toMatchObject({ ok: true });
    expect(primaries().filter((x) => x !== '-')).toEqual(['direct', 'relay', 'nearby']);
    expect(d.log.map((x) => x.decision.reason)).toContain('upgrade');
    expect(world.phones.flatMap((p) => p.stats.strikes)).toEqual([]);
  });

  it('"Always use the relay" never opens a direct path', () => {
    const world = new SimWorld({ seed: 32, base: nodeCrypto, phones: ['2.7', '2.7'] });
    const [p0, p1] = world.phones as [SimPhone, SimPhone];
    world.startTicks();
    const d = new SimPathDriver(world, p0, p1, {
      nearby: false,
      online: true,
      directWorks: true,
      alwaysRelay: true,
    });
    d.start();
    world.run(30_000);
    expect(d.primary).toBe('relay');
    expect(world.net.wire.some((w) => w.path === 'direct')).toBe(false);
    d.stop();
  });
});
