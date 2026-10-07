import { LoopbackMeshHub } from './loopbackMesh';
import type { MeshEvent } from './meshTransport';

function manualHub(opts: { maxQueuedBytes?: number; maxFrameBytes?: number } = {}) {
  const queue: (() => void)[] = [];
  const hub = new LoopbackMeshHub({ schedule: (fn) => queue.push(fn), ...opts });
  const run = (): void => {
    for (let fn = queue.shift(); fn; fn = queue.shift()) fn();
  };
  return { hub, run };
}

function record(t: { subscribe(l: (e: MeshEvent) => void): () => void }): MeshEvent[] {
  const events: MeshEvent[] = [];
  t.subscribe((e) => events.push(e));
  return events;
}

const bytes = (...v: number[]): Uint8Array => Uint8Array.from(v);

describe('LoopbackMeshHub', () => {
  it('finds teammates by tag and exchanges frames in order', async () => {
    const { hub, run } = manualHub();
    const a = hub.createTransport();
    const b = hub.createTransport();
    const c = hub.createTransport();
    const ea = record(a);
    const eb = record(b);
    await Promise.all([a.start(), b.start(), c.start()]);
    await a.startAdvertising('team-tag-1');
    await c.startAdvertising('other-team');
    await b.startBrowsing('team-tag-1');
    run();
    const found = eb.filter((e) => e.type === 'peer-found');
    expect(found).toHaveLength(1);
    const service = found[0]?.type === 'peer-found' ? found[0].service : undefined;
    expect(service?.host).toBe(a.address);

    const dial = b.connectService(service?.serviceId ?? '');
    run();
    const bConn = eb.find((e) => e.type === 'connected');
    const aConn = ea.find((e) => e.type === 'connected');
    expect(bConn?.type === 'connected' && bConn.peer.dialId).toBe(dial);
    expect(aConn?.type === 'connected' && aConn.peer.direction).toBe('in');
    const toA = bConn?.type === 'connected' ? bConn.peer.peerId : '';
    const toB = aConn?.type === 'connected' ? aConn.peer.peerId : '';

    const original = bytes(1, 2, 3);
    expect(b.send(toA, original)).toEqual({ ok: true, queuedBytes: 7 });
    expect(b.send(toA, bytes(4))).toMatchObject({ ok: true });
    original[0] = 99; // the transport copied the frame
    run();
    const frames = ea.filter((e) => e.type === 'frame');
    expect(frames.map((e) => (e.type === 'frame' ? [...e.data] : []))).toEqual([[1, 2, 3], [4]]);
    expect(frames.every((e) => e.type === 'frame' && e.peerId === toB)).toBe(true);
    expect(a.stats().peers[0]).toMatchObject({ framesIn: 2, bytesIn: 12 });

    a.stopAdvertising();
    run();
    expect(eb.some((e) => e.type === 'peer-lost')).toBe(true);

    b.disconnect(toA);
    run();
    expect(ea.some((e) => e.type === 'disconnected' && e.reason === 'remote-closed')).toBe(true);
    expect(b.send(toA, bytes(1))).toEqual({ ok: false, reason: 'no-peer' });
  });

  it('dials by address, enforces the frame cap and backpressure', async () => {
    const { hub, run } = manualHub({ maxFrameBytes: 8, maxQueuedBytes: 24 });
    const a = hub.createTransport();
    const b = hub.createTransport();
    const eb = record(b);
    await a.start();
    await b.start();
    b.connect(a.address, a.port);
    run();
    const conn = eb.find((e) => e.type === 'connected');
    const toA = conn?.type === 'connected' ? conn.peer.peerId : '';
    expect(b.send(toA, new Uint8Array(9))).toEqual({ ok: false, reason: 'too-large' });
    expect(() => b.send(toA, new Uint8Array(0))).toThrow('keepalive');
    expect(b.send(toA, new Uint8Array(8)).ok).toBe(true);
    expect(b.send(toA, new Uint8Array(8)).ok).toBe(true);
    expect(b.send(toA, new Uint8Array(8))).toEqual({ ok: false, reason: 'backpressure' });
    run();
    expect(eb.some((e) => e.type === 'writable' && e.peerId === toA)).toBe(true);

    b.connect('10.99.0.250', 47321);
    run();
    expect(eb.some((e) => e.type === 'disconnected' && e.reason === 'connect-failed')).toBe(true);
    expect(b.networkInfo().interfaces[0]?.address).toBe(b.address);
    expect(b.state()).toMatchObject({ running: true, advertising: false });
  });

  it('bans: the address is refused and hidden from discovery', async () => {
    const { hub, run } = manualHub();
    const a = hub.createTransport();
    const b = hub.createTransport();
    const ea = record(a);
    const eb = record(b);
    await a.start();
    await b.start();
    await b.startAdvertising('team-tag-1');
    b.connect(a.address, a.port);
    run();
    const conn = ea.find((e) => e.type === 'connected');
    a.ban(conn?.type === 'connected' ? conn.peer.peerId : '', 60_000);
    run();
    expect(ea.some((e) => e.type === 'disconnected' && e.reason === 'banned')).toBe(true);
    expect(a.stats().activeBans).toBe(1);
    b.connect(a.address, a.port);
    run();
    expect(
      eb.filter((e) => e.type === 'disconnected' && e.reason === 'connect-failed'),
    ).toHaveLength(1);
    await a.startBrowsing(null);
    run();
    expect(ea.some((e) => e.type === 'peer-found')).toBe(false);
    await a.stop();
    await b.stop();
    expect(() => a.connect(b.address, b.port)).toThrow('not started');
    expect(() => a.connectService('nope')).toThrow();
  });
});
