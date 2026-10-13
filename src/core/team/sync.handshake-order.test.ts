/**
 * Frames that reach the admitting side out of the handshake's order, and a
 * handler that throws mid-handshake (#589, the E2E join that failed with
 * closed(decrypt) right after admission: runs 37784108605, 37900582863).
 *
 * The founder's trace there read: strike, admitted, open, strike,
 * closed(decrypt). A sealed frame that arrives before hi3 does exactly that
 * when it is dropped: it costs a strike, hi3 then opens the session, and the
 * next sealed frame carries counter 1 while the founder expects 0.
 */
import { makeJoinProof } from './invite';
import { TeamReplica } from './replica';
import { SyncSession, type SessionEvent } from './sync';
import { c, device, invite, MIN, newWorld, T0 } from './testing/fixtures';

const strikes = (events: SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'strike' ? [e.reason] : []));
const closed = (events: SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'closed' ? [e.why] : []));
const types = (events: SessionEvent[]) => events.map((e) => e.type);

/** A joiner and the founder, handshaken up to the joiner's hi3 (not yet delivered). */
function joinUpToHi3() {
  const w = newWorld();
  w.root.write(T0 + 5, 'msg', { id: 'm1', th: 'team', tx: 'before you joined' });
  const inv = invite(w.root, T0 + 10);
  const j = device();
  const joinerReplica = new TeamReplica(c, w.teamId, j.keys);
  const proof = makeJoinProof(c, inv.token, j.keys);
  const now = T0 + MIN;
  const { session: joiner, step: hello } = SyncSession.initiate(c, joinerReplica, {
    join: proof,
    now,
  });
  const founder = SyncSession.respond(c, w.root);
  const hi2 = founder.receive(hello.send[0]!, now).send;
  const afterHi2 = joiner.receive(hi2[0]!, now);
  // The joiner opened: hi3 (clear) then its first sealed frame (vv).
  const [hi3, ...sealed] = afterHi2.send;
  expect(joiner.phase).toBe('open');
  expect(sealed.length).toBeGreaterThan(0);
  return { w, j, joiner, founder, joinerReplica, hi3: hi3!, sealed, now };
}

describe('the admitting side, frames around hi3', () => {
  it('in order: admitted, open, then every sealed frame decrypts', () => {
    const { founder, joiner, hi3, sealed, now } = joinUpToHi3();
    const events: SessionEvent[] = [];
    for (const f of [hi3, ...sealed, ...joiner.tick(now).send]) {
      events.push(...founder.receive(f, now).events);
    }
    expect(strikes(events)).toEqual([]);
    expect(closed(events)).toEqual([]);
    expect(founder.phase).toBe('open');
  });

  it('a sealed frame before hi3 waits for the keys instead of breaking the stream', () => {
    const { founder, joiner, hi3, sealed, now } = joinUpToHi3();
    const later = joiner.tick(now).send; // the joiner's next sealed frame (counter 1)
    const events: SessionEvent[] = [];
    // Out of order: the first sealed frame overtakes hi3.
    for (const f of [...sealed, hi3, ...later]) events.push(...founder.receive(f, now).events);
    // Before the fix: ['malformed', 'decrypt'] and closed(decrypt), the E2E trace.
    expect(strikes(events)).toEqual([]);
    expect(closed(events)).toEqual([]);
    expect(types(events)).toContain('admitted');
    expect(founder.phase).toBe('open');
  });

  it('too many frames before hi3 end the session with a named reason', () => {
    const { founder, joiner, sealed, now } = joinUpToHi3();
    const noise = [...sealed];
    while (noise.length < 40) noise.push(...joiner.tick(now).send);
    const events: SessionEvent[] = [];
    for (const f of noise) events.push(...founder.receive(f, now).events);
    expect(closed(events)).toEqual(['early-frames']);
    expect(founder.phase).toBe('closed');
  });

  it('a handler that throws mid-handshake ends the session, named, instead of limbo', () => {
    const { w, founder, hi3, now } = joinUpToHi3();
    const admit = w.root.admit.bind(w.root);
    let once = true;
    w.root.admit = (...a: Parameters<typeof admit>) => {
      if (once) {
        once = false;
        throw new Error('disk full');
      }
      return admit(...a);
    };
    const events = founder.receive(hi3, now).events;
    // Before the fix: a 'malformed' strike, and the session stayed waiting for
    // an hi3 that would never come again, dropping every sealed frame after.
    expect(closed(events)).toEqual(['error']);
    expect(founder.phase).toBe('closed');
  });
});
