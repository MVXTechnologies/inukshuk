/**
 * The real team core over the transport: MeshSessionHost + SyncSession +
 * the loopback hub. Proves the structural FrameSession contract matches the
 * core (hi1/hi2/hi3 handshake, options.now, tick(now), bannedUntil).
 */
import { lanDiscoveryTag, isValidMeshTag } from '@core/mesh/tag';
import { TeamReplica } from '@core/team/replica';
import { SyncSession, type SessionEvent } from '@core/team/sync';
import { addMember, c, device, MIN, newWorld, T0 } from '@core/team/testing/fixtures';
import { nobleCrypto } from '@core/team/testing/noble';

import { LoopbackMeshHub } from './loopbackMesh';
import { MeshSessionHost, type SessionFactory } from './meshSessions';
import type { MeshEvent } from './meshTransport';

function manualHub() {
  const queue: (() => void)[] = [];
  // A roomy hub so a hostile peer can send what the core must refuse.
  const hub = new LoopbackMeshHub({
    schedule: (fn) => queue.push(fn),
    maxFrameBytes: 1 << 20,
    maxQueuedBytes: 64 << 20,
  });
  const run = (): void => {
    for (let fn = queue.shift(); fn; fn = queue.shift()) fn();
  };
  return { hub, run };
}

function factoryFor(
  store: TeamReplica,
  handshakeTimeoutMs?: number,
): SessionFactory<SessionEvent, SyncSession> {
  const options = handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs };
  return {
    initiate: (_peer, now) => SyncSession.initiate(c, store, { ...options, now }),
    respond: () => SyncSession.respond(c, store, options),
  };
}

function twoMembers() {
  const w = newWorld();
  const b = device();
  addMember(w.root, b, 'member', T0 + 1);
  const bob = new TeamReplica(c, w.teamId, b.keys);
  bob.ingest(
    [...w.root.log.logged()].map((op) => op.env),
    T0 + 2,
  );
  // The owner writes more after Bob's copy: the session must bring it over.
  addMember(w.root, device(), 'member', T0 + 3);
  return { w, bob };
}

describe('MeshSessionHost with the team core', () => {
  it('handshakes (hi1/hi2/hi3) and syncs a member over the mesh', async () => {
    const { w, bob } = twoMembers();
    const { hub, run } = manualHub();
    const a = hub.createTransport();
    const b = hub.createTransport();
    const now = () => T0 + MIN;
    const eventsA: SessionEvent[] = [];
    const eventsB: SessionEvent[] = [];
    const hostA = new MeshSessionHost(a, factoryFor(w.root), (_p, e) => eventsA.push(e), {
      tickMs: 0,
      now,
    });
    const hostB = new MeshSessionHost(b, factoryFor(bob), (_p, e) => eventsB.push(e), {
      tickMs: 0,
      now,
    });
    await a.start();
    await b.start();
    hostA.start();
    hostB.start();

    // Discovery by the LAN tag computed with the core's own SHA-256.
    const tag = lanDiscoveryTag(w.teamId, nobleCrypto);
    expect(isValidMeshTag(tag)).toBe(true);
    expect(lanDiscoveryTag(w.teamId, (d) => c.sha256(d))).toBe(tag);
    await a.startAdvertising(tag);
    const seen: MeshEvent[] = [];
    b.subscribe((e) => seen.push(e));
    await b.startBrowsing(tag);
    run();
    const found = seen.find((e) => e.type === 'peer-found');
    b.connectService(found?.type === 'peer-found' ? found.service.serviceId : '');
    run();

    expect(eventsA.some((e) => e.type === 'open')).toBe(true);
    expect(eventsB.some((e) => e.type === 'open')).toBe(true);
    expect(bob.versionVector()).toEqual(w.root.versionVector());
    expect(eventsA.concat(eventsB).filter((e) => e.type === 'strike')).toEqual([]);

    // Periodic tick(now) on open sessions re-syncs without strikes.
    hostB.tickAll();
    run();
    expect(eventsA.concat(eventsB).filter((e) => e.type === 'strike')).toEqual([]);

    hostB.stop();
    run();
    expect(eventsA.some((e) => e.type === 'closed')).toBe(true);
    expect(hostA.size).toBe(0);
  });

  it('drops a peer whose handshake never finishes (tick(now) + handshakeTimeoutMs)', async () => {
    const { w } = twoMembers();
    const { hub, run } = manualHub();
    const a = hub.createTransport();
    const silent = hub.createTransport();
    let clock = T0;
    const events: SessionEvent[] = [];
    const host = new MeshSessionHost(a, factoryFor(w.root, 5_000), (_p, e) => events.push(e), {
      tickMs: 0,
      now: () => clock,
    });
    await a.start();
    await silent.start();
    host.start();
    a.connect(silent.address, silent.port);
    run();
    expect(host.size).toBe(1);
    clock += 6_000;
    host.tickAll();
    run();
    expect(events).toContainEqual({ type: 'closed', why: 'timeout' });
    expect(host.size).toBe(0);
  });

  it('bans at the transport when the core bans the peer', async () => {
    const { w } = twoMembers();
    const { hub, run } = manualHub();
    const a = hub.createTransport();
    const attacker = hub.createTransport();
    const events: SessionEvent[] = [];
    const host = new MeshSessionHost(a, factoryFor(w.root), (_p, e) => events.push(e), {
      tickMs: 0,
      now: () => T0 + MIN,
    });
    await a.start();
    await attacker.start();
    host.start();
    const seen: MeshEvent[] = [];
    attacker.subscribe((e) => seen.push(e));
    attacker.connect(a.address, a.port);
    run();
    const conn = seen.find((e) => e.type === 'connected');
    const toA = conn?.type === 'connected' ? conn.peer.peerId : '';
    // Frames over the core's 512 KiB cap are strikes before anything is
    // parsed; 20 strikes within a minute ban (LAN_LIMITS).
    for (let i = 0; i < 20; i++) {
      expect(attacker.send(toA, new Uint8Array(512 * 1024 + 1)).ok).toBe(true);
    }
    run();
    expect(events.filter((e) => e.type === 'strike')).toHaveLength(20);
    expect(events).toContainEqual({ type: 'closed', why: 'banned' });
    expect(a.stats().activeBans).toBe(1);
    expect(seen.some((e) => e.type === 'disconnected')).toBe(true);
    // The address cannot come back.
    attacker.connect(a.address, a.port);
    run();
    expect(
      seen.filter((e) => e.type === 'disconnected' && e.reason === 'connect-failed'),
    ).toHaveLength(1);
  });
});
