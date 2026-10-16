/**
 * The WebRTC carrier (G6) on an in-memory WebRTC: signalling only through the
 * callback (R-RTC-1), no host candidate ever crosses (R-RTC-3), relay-only
 * attempts use TURN alone (R-RTC-6), a certificate other than the SDP's
 * closes the attempt (R-RTC-2), and the channel reports its queue for the
 * link's in-flight budget.
 */
import type { CarrierEvent } from '@core/group/link';
import type { IceServer } from '@core/group/roomProto';
import type { RtcSignal } from '@core/team/sync';

import { FakeRtcNetwork } from '../testing/fakeRtc';
import { Rig } from '../testing/rig';

import { RtcCarrier, type AttemptEvent, type RtcConn } from './rtcCarrier';

const TURN: IceServer[] = [
  { urls: ['turn:turn.example.net:3478'], username: 'u', credential: 'c' },
];
const STUN: IceServer[] = [{ urls: ['stun:stun.example.net:3478'] }];

function world() {
  const rig = new Rig({ pacingHorizonMs: 1_000 });
  const net = new FakeRtcNetwork((fn) => rig.hub.schedule(fn));
  const side = (name: string) => {
    const attempts: { id: string; e: AttemptEvent }[] = [];
    const events: CarrierEvent[] = [];
    const carrier = new RtcCarrier({
      module: net.module,
      timers: rig.timers,
      onAttempt: (id, _member, e) => attempts.push({ id, e }),
    });
    carrier.subscribe((e) => events.push(e));
    const signals: RtcSignal[] = [];
    return { name, carrier, attempts, events, signals };
  };
  const a = side('a');
  const b = side('b');
  /** A dials B; signals cross through the scheduler (as the L0 session would carry them). */
  const dial = (
    policy: 'direct' | 'relay',
    iceA: IceServer[],
    iceB: IceServer[],
    timeoutMs = 8_000,
  ) => {
    const toB = (s: RtcSignal) => {
      a.signals.push(s);
      rig.hub.schedule(() => {
        if (s.k === 'offer') {
          b.carrier.answer(
            {
              member: 'A',
              policy,
              iceServers: iceB,
              timeoutMs,
              signal: (r) => {
                b.signals.push(r);
                rig.hub.schedule(() => a.carrier.onSignal('B', r));
                return true;
              },
            },
            s.sdp,
          );
        } else b.carrier.onSignal('A', s);
      });
      return true;
    };
    return a.carrier.dial({ member: 'B', policy, iceServers: iceA, timeoutMs, signal: toB });
  };
  return { rig, net, a, b, dial };
}

const conns = (events: CarrierEvent[]) =>
  events.flatMap((e) => (e.type === 'conn' ? [e.conn as RtcConn] : []));

describe('RtcCarrier', () => {
  it('connects directly, verifies the fingerprint, and carries frames both ways', async () => {
    const { rig, net, a, b, dial } = world();
    dial('direct', STUN, STUN);
    await rig.settle();
    const [ca] = conns(a.events);
    const [cb] = conns(b.events);
    expect(ca).toMatchObject({ path: 'direct', member: 'B', maxFrameBytes: 64 * 1024 });
    expect(cb).toMatchObject({ path: 'direct', member: 'A' });
    expect(a.events.find((e) => e.type === 'conn')).toMatchObject({ direction: 'out' });
    expect(b.events.find((e) => e.type === 'conn')).toMatchObject({ direction: 'in' });
    expect(ca!.send(Uint8Array.of(1, 2, 3), 0)).toBe('ok');
    expect(cb!.send(Uint8Array.of(4), 2)).toBe('ok');
    await rig.settle();
    expect(b.events.filter((e) => e.type === 'frame')).toEqual([
      { type: 'frame', connId: cb!.connId, data: Uint8Array.of(1, 2, 3) },
    ]);
    expect(a.events.filter((e) => e.type === 'frame')).toHaveLength(1);
    // R-RTC-3: no private address left either phone, in an SDP or trickled.
    expect(net.remoteCandidates.length).toBeGreaterThan(0);
    expect(net.remoteCandidates.some((c) => c.includes('typ host'))).toBe(false);
    for (const s of [...a.signals, ...b.signals]) {
      expect(JSON.stringify(s)).not.toContain('typ host');
    }
  });

  it('relay-only attempts use TURN alone and report the relay path', async () => {
    const { rig, net, a, b, dial } = world();
    net.directWorks = false;
    dial('relay', TURN, TURN);
    await rig.settle();
    expect(conns(a.events)[0]?.path).toBe('relay');
    expect(conns(b.events)[0]?.path).toBe('relay');
    expect(net.pcs.every((p) => p.config.iceTransportPolicy === 'relay')).toBe(true);
    expect(a.signals.some((s) => s.k === 'ice' && s.c.includes('typ srflx'))).toBe(false);
  });

  it('fails a direct attempt the NATs block, at its deadline', async () => {
    const { rig, net, a, dial } = world();
    net.directWorks = false;
    dial('direct', STUN, STUN, 8_000);
    await rig.settle();
    expect(a.attempts).toEqual([]);
    rig.advance(8_000);
    await rig.settle();
    expect(a.attempts.map((x) => x.e)).toEqual([{ type: 'failed', reason: 'timeout' }]);
    expect(conns(a.events)).toEqual([]);
    expect(net.pcs[0]!.closed).toBe(true);
  });

  it('closes when the negotiated certificate is not the authenticated SDP’s (R-RTC-2)', async () => {
    const { rig, net, a, b, dial } = world();
    net.mitm = true;
    dial('direct', STUN, STUN);
    await rig.settle();
    expect(conns(a.events)).toEqual([]);
    expect(conns(b.events)).toEqual([]);
    expect(a.attempts[0]?.e).toEqual({ type: 'failed', reason: 'fingerprint-mismatch' });
  });

  it('reports its queue for the in-flight budget and says writable once it drains', async () => {
    const { rig, a, b, dial } = world();
    dial('direct', STUN, STUN);
    await rig.settle();
    const ca = conns(a.events)[0]!;
    for (let i = 0; i < 3; i++) expect(ca.send(new Uint8Array(40 * 1024), 3)).toBe('ok');
    expect(ca.inFlight!()).toBe(120 * 1024);
    await rig.settle();
    expect(ca.inFlight!()).toBe(0);
    expect(a.events.some((e) => e.type === 'writable')).toBe(true);
    // Closing one end closes the other.
    ca.close('bye');
    await rig.settle();
    expect(a.events.at(-1)).toMatchObject({ type: 'closed' });
    expect(b.events.at(-1)).toMatchObject({ type: 'closed' });
    expect(ca.send(Uint8Array.of(1), 0)).toBe('closed');
  });
});
