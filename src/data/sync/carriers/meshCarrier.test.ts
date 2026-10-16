import type { CarrierEvent } from '@core/group/link';
import { LANE_SYNC } from '@core/group/lanes';

import { LoopbackMeshHub } from '@data/team/loopbackMesh';

import { MeshCarrier, MESH_MAX_FRAME_BYTES, type MeshConn } from './meshCarrier';

/** Two loopback phones with a manual work queue: A dials B. */
async function pair(options: { maxQueuedBytes?: number; maxFrameBytes?: number } = {}) {
  const queue: (() => void)[] = [];
  const hub = new LoopbackMeshHub({ ...options, schedule: (fn) => queue.push(fn) });
  const run = () => {
    for (let i = 0; i < 1000 && queue.length > 0; i++) for (const fn of queue.splice(0)) fn();
  };
  const ta = hub.createTransport();
  const tb = hub.createTransport();
  await ta.start();
  await tb.start();
  const a = new MeshCarrier(ta, options.maxFrameBytes);
  const b = new MeshCarrier(tb, options.maxFrameBytes);
  const ea: CarrierEvent[] = [];
  const eb: CarrierEvent[] = [];
  const offA = a.subscribe((e) => ea.push(e));
  const offB = b.subscribe((e) => eb.push(e));
  ta.connect(tb.address, tb.port);
  run();
  const conn = (events: CarrierEvent[]) =>
    (events.find((e) => e.type === 'conn') as Extract<CarrierEvent, { type: 'conn' }>)
      .conn as MeshConn;
  return { hub, run, ta, tb, a, b, ea, eb, offA, offB, ca: conn(ea), cb: conn(eb) };
}

describe('MeshCarrier', () => {
  it('reports a mesh connection as a nearby carrier connection, both directions', async () => {
    const { ea, eb, ca, cb, a } = await pair();
    expect(ea.find((e) => e.type === 'conn')).toMatchObject({ type: 'conn', direction: 'out' });
    expect(eb.find((e) => e.type === 'conn')).toMatchObject({ type: 'conn', direction: 'in' });
    expect(ca).toMatchObject({ path: 'nearby', maxFrameBytes: MESH_MAX_FRAME_BYTES });
    expect(ca.peer.direction).toBe('out');
    expect(cb.peer.host).toMatch(/^10\.99\.0\./);
    expect(a.conn(ca.connId)).toBe(ca);
    expect(a.kind).toBe('mesh');
  });

  it('moves frames in order and maps the send outcomes', async () => {
    const { run, ca, eb } = await pair();
    expect(ca.send(Uint8Array.of(1), LANE_SYNC)).toBe('ok');
    expect(ca.send(Uint8Array.of(2), LANE_SYNC)).toBe('ok');
    run();
    const frames = eb
      .filter((e) => e.type === 'frame')
      .map((e) => [...(e as { data: Uint8Array }).data]);
    expect(frames).toEqual([[1], [2]]);
  });

  it('says backpressure when the queue is full (frame NOT queued), then writable', async () => {
    const { run, ca, ea } = await pair({ maxQueuedBytes: 100 });
    expect(ca.send(new Uint8Array(60), LANE_SYNC)).toBe('ok');
    expect(ca.send(new Uint8Array(60), LANE_SYNC)).toBe('backpressure');
    run();
    expect(ea.some((e) => e.type === 'writable' && e.connId === ca.connId)).toBe(true);
    expect(ca.send(new Uint8Array(60), LANE_SYNC)).toBe('ok');
  });

  it('hangs up on a frame the mesh refuses as too large (never a hole in a counter stream)', async () => {
    const { run, ca, ea, eb } = await pair({ maxFrameBytes: 64 });
    expect(ca.send(new Uint8Array(65), LANE_SYNC)).toBe('closed');
    run();
    expect(ea).toContainEqual(expect.objectContaining({ type: 'closed', connId: ca.connId }));
    expect(eb.some((e) => e.type === 'closed')).toBe(true);
    expect(ca.send(Uint8Array.of(1), LANE_SYNC)).toBe('closed');
  });

  it('closes and bans through the transport (an address ban on the LAN)', async () => {
    const { run, ca, cb, ea, eb, ta, tb } = await pair();
    cb.ban(60_000);
    run();
    expect(eb).toContainEqual({ type: 'closed', connId: cb.connId, reason: 'banned' });
    expect(ea.some((e) => e.type === 'closed' && e.connId === ca.connId)).toBe(true);
    expect(tb.accepts(ta.address)).toBe(false);
    ca.close('bye');
    run();
  });

  it('reports only connections made while subscribed; state passes through', async () => {
    const { run, a, ta, tb, offA, ca, ea } = await pair();
    const late: CarrierEvent[] = [];
    const off = a.subscribe((e) => late.push(e));
    tb.send(tb.stats().peers.find((p) => p.host === ta.address)!.peerId, Uint8Array.of(9));
    run();
    expect(late.filter((e) => e.type === 'frame')).toEqual([]);
    expect(ea.filter((e) => e.type === 'frame')).toHaveLength(1);
    await ta.stop();
    run();
    expect(late).toContainEqual(expect.objectContaining({ type: 'state', online: false }));
    expect(late.some((e) => e.type === 'closed')).toBe(false);
    expect(ea).toContainEqual(expect.objectContaining({ type: 'closed', connId: ca.connId }));
    off();
    offA();
    expect(a.conn(ca.connId)).toBeUndefined();
  });

  it('ignores a dial that failed before any connection', async () => {
    const { run, a, ta } = await pair();
    const seen: CarrierEvent[] = [];
    a.subscribe((e) => seen.push(e));
    ta.connect('10.99.0.250', 1);
    run();
    expect(seen.filter((e) => e.type !== 'state')).toEqual([]);
  });
});
