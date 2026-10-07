import { LoopbackMeshHub } from './loopbackMesh';
import {
  MeshSessionHost,
  type FrameSession,
  type FrameStep,
  type SessionFactory,
} from './meshSessions';
import type { MeshEvent, MeshTransport, SendResult } from './meshTransport';

/**
 * A stand-in for the core's SyncSession with the same shape: a hello from
 * the initiator, echo of 'ping', 'bye' closes, 'evil' gets the peer banned.
 */
type Ev = { type: 'open' } | { type: 'got'; text: string } | { type: 'closed'; why: string };

class EchoSession implements FrameSession<Ev> {
  phase = 'open';
  bannedUntil: number | undefined;
  ticks = 0;

  receive(frame: Uint8Array, now: number): FrameStep<Ev> {
    const text = new TextDecoder().decode(frame);
    if (text === 'evil') {
      this.bannedUntil = now + 60_000;
      this.phase = 'closed';
      return { send: [], events: [{ type: 'closed', why: 'banned' }] };
    }
    if (text === 'bye') return this.close('peer');
    const send = text === 'ping' ? [new TextEncoder().encode('pong')] : [];
    return { send, events: [{ type: 'got', text }] };
  }

  tick(): FrameStep<Ev> {
    this.ticks += 1;
    return { send: [new TextEncoder().encode('tick')], events: [] };
  }

  close(why = 'bye'): FrameStep<Ev> {
    if (this.phase === 'closed') return { send: [], events: [] };
    this.phase = 'closed';
    return { send: [new TextEncoder().encode('bye')], events: [{ type: 'closed', why }] };
  }
}

const factory: SessionFactory<Ev, EchoSession> = {
  initiate: () => ({
    session: new EchoSession(),
    step: { send: [new TextEncoder().encode('hello')], events: [{ type: 'open' }] },
  }),
  respond: () => new EchoSession(),
};

function setup() {
  const queue: (() => void)[] = [];
  const hub = new LoopbackMeshHub({ schedule: (fn) => queue.push(fn) });
  const run = (): void => {
    for (let fn = queue.shift(); fn; fn = queue.shift()) fn();
  };
  const a = hub.createTransport();
  const b = hub.createTransport();
  const events: { side: string; peerId: string; event: Ev }[] = [];
  const hostA = new MeshSessionHost(
    a,
    factory,
    (peerId, event) => events.push({ side: 'a', peerId, event }),
    {
      tickMs: 0,
      now: () => 1_000,
    },
  );
  const hostB = new MeshSessionHost(
    b,
    factory,
    (peerId, event) => events.push({ side: 'b', peerId, event }),
    {
      tickMs: 0,
      now: () => 1_000,
    },
  );
  return { a, b, hostA, hostB, events, run };
}

const texts = (events: { side: string; event: Ev }[], side: string): string[] =>
  events
    .filter((e) => e.side === side && e.event.type === 'got')
    .map((e) => (e.event.type === 'got' ? e.event.text : ''));

describe('MeshSessionHost', () => {
  it('runs one session per connection: the dialler initiates, the listener responds', async () => {
    const { a, b, hostA, hostB, events, run } = setup();
    await a.start();
    await b.start();
    hostA.start();
    hostB.start();
    b.connect(a.address, a.port);
    run();
    expect(hostA.size).toBe(1);
    expect(hostB.size).toBe(1);
    expect(texts(events, 'a')).toEqual(['hello']);

    hostB.forEachOpen(() => ({ send: [new TextEncoder().encode('ping')], events: [] }));
    run();
    expect(texts(events, 'a')).toEqual(['hello', 'ping']);
    expect(texts(events, 'b')).toEqual(['pong']);

    hostB.stop();
    run();
    expect(
      events.some((e) => e.side === 'a' && e.event.type === 'closed' && e.event.why === 'peer'),
    ).toBe(true);
    expect(hostA.size).toBe(0);
  });

  it('bans a peer the session bans, at the transport', async () => {
    const { a, b, hostA, events, run } = setup();
    await a.start();
    await b.start();
    hostA.start();
    const seen: MeshEvent[] = [];
    b.subscribe((e) => seen.push(e));
    b.connect(a.address, a.port);
    run();
    const conn = seen.find((e) => e.type === 'connected');
    b.send(conn?.type === 'connected' ? conn.peer.peerId : '', new TextEncoder().encode('evil'));
    run();
    expect(
      events.some((e) => e.side === 'a' && e.event.type === 'closed' && e.event.why === 'banned'),
    ).toBe(true);
    expect(a.stats().activeBans).toBe(1);
    expect(seen.some((e) => e.type === 'disconnected')).toBe(true);
  });

  it('holds frames behind backpressure and sends them in order on writable', () => {
    let full = true;
    const sent: string[] = [];
    let listener: ((e: MeshEvent) => void) | null = null;
    const transport = {
      subscribe: (l: (e: MeshEvent) => void) => {
        listener = l;
        return () => undefined;
      },
      send: (_p: string, f: Uint8Array): SendResult => {
        if (full) return { ok: false, reason: 'backpressure' };
        sent.push(new TextDecoder().decode(f));
        return { ok: true, queuedBytes: 0 };
      },
      disconnect: jest.fn(),
      ban: jest.fn(),
    } as unknown as MeshTransport;
    const host = new MeshSessionHost(transport, factory, () => undefined, {
      tickMs: 0,
      maxPendingBytes: 10,
    });
    host.start();
    const emit = (e: MeshEvent): void => listener?.(e);
    emit({
      type: 'connected',
      peer: { peerId: 'p1', dialId: 'd1', host: 'h', port: 1, direction: 'out' },
    });
    emit({ type: 'frame', peerId: 'p1', data: new TextEncoder().encode('ping') });
    expect(sent).toEqual([]);
    full = false;
    emit({ type: 'writable', peerId: 'p1' });
    expect(sent).toEqual(['hello', 'pong']);

    // Over the JS bound: the peer is dropped rather than losing a frame.
    full = true;
    emit({ type: 'frame', peerId: 'p1', data: new TextEncoder().encode('ping') });
    emit({ type: 'frame', peerId: 'p1', data: new TextEncoder().encode('ping') });
    emit({ type: 'frame', peerId: 'p1', data: new TextEncoder().encode('ping') });
    expect(transport.disconnect).toHaveBeenCalledWith('p1');
    expect(host.size).toBe(0);
    // A frame for a forgotten session closes that connection.
    emit({ type: 'frame', peerId: 'zz', data: new Uint8Array([1]) });
    expect(transport.disconnect).toHaveBeenCalledWith('zz');
  });

  it('ticks open sessions on its timer', async () => {
    jest.useFakeTimers();
    try {
      const { a, b, run } = setup();
      const host = new MeshSessionHost(a, factory, () => undefined, { tickMs: 1_000 });
      await a.start();
      await b.start();
      host.start();
      a.connect(b.address, b.port);
      run();
      jest.advanceTimersByTime(3_000);
      const session = host.session([...a.stats().peers][0]?.peerId ?? '') as
        EchoSession | undefined;
      expect(session?.ticks).toBe(3);
      host.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
