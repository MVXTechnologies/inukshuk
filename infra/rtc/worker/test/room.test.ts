/**
 * The room Durable Object (src/room.ts): auth, forwarding, caps, timeouts,
 * kill switch, TURN gating — against throwing state/env Proxies (no storage)
 * and a console spy (no logs).
 */
import { toB64u } from '../../../../src/core/team/bytes';
import { nobleCrypto } from '../../../../src/core/team/testing/noble';
import { signAuth } from '../../../../src/core/group/rdv';
import { CLOSE } from '../src/protocol';
import { blobText, HOST, makeRoom, msg, T0, vectorRoom, type FakeSock } from './harness';

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
let spies: jest.SpyInstance[] = [];
beforeEach(() => {
  spies = consoleMethods.map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  // R-META-2: the relay never logs anything.
  for (const s of spies) expect(s).not.toHaveBeenCalled();
  for (const s of spies) s.mockRestore();
});

const R = vectorRoom('rs');
const OTHER = vectorRoom('ir');

describe('R-RDV-2: room entry', () => {
  it('sends a fresh 32-byte challenge and the server time on connect', async () => {
    const h = makeRoom();
    const ws = await h.connect(R.roomId);
    const chal = ws.last()!;
    expect(chal.t).toBe('chal');
    expect(Buffer.from(chal.c as string, 'base64url')).toHaveLength(32);
    expect(chal.now).toBe(Math.floor(T0 / 1000));
  });

  it('admits a socket that signs the challenge with the room key', async () => {
    const h = makeRoom();
    const ws = await h.join(R);
    const ok = ws.last()!;
    expect(ok.t).toBe('ok');
    expect(ok.peers).toEqual([]);
    expect(typeof ok.me).toBe('string');
    expect((ok.me as string).length).toBe(11);
    expect(ws.closed).toBeUndefined();
    expect(h.touched).toEqual([]);
  });

  it('gives every socket its own challenge', async () => {
    const h = makeRoom();
    const a = await h.connect(R.roomId);
    const b = await h.connect(R.roomId);
    expect(a.sent[0]!.c).not.toBe(b.sent[0]!.c);
  });

  it('refuses a signature for another room (key does not hash to the room id)', async () => {
    const h = makeRoom();
    const ws = await h.connect(R.roomId);
    await h.room.webSocketMessage(ws, h.authFrame(OTHER, ws.last()!.c as string));
    expect(ws.last()!.t).toBe('chal'); // a new challenge, not 'ok'
    expect(ws.ofType('ok')).toHaveLength(0);
  });

  it('refuses a signature made for another host (no cross-deployment replay)', async () => {
    const h = makeRoom();
    const ws = await h.connect(R.roomId);
    await h.room.webSocketMessage(ws, h.authFrame(R, ws.last()!.c as string, 'rtc.evil.org'));
    expect(ws.ofType('ok')).toHaveLength(0);
  });

  it('refuses a replayed signature over an earlier challenge (challenge is single use)', async () => {
    const h = makeRoom();
    const first = await h.connect(R.roomId);
    const replay = h.authFrame(R, first.last()!.c as string);
    await h.room.webSocketMessage(first, replay);
    expect(first.last()!.t).toBe('ok');
    // The same frame on another socket (other challenge) …
    const second = await h.connect(R.roomId);
    await h.room.webSocketMessage(second, replay);
    expect(second.ofType('ok')).toHaveLength(0);
    // … and on the same socket after a failure (the first challenge is spent).
    const third = await h.connect(R.roomId);
    const spent = h.authFrame(R, third.last()!.c as string);
    await h.room.webSocketMessage(third, h.authFrame(OTHER, third.last()!.c as string));
    await h.room.webSocketMessage(third, spent);
    expect(third.ofType('ok')).toHaveLength(0);
  });

  it('refuses a small-order key whose hash is the room id', async () => {
    const h = makeRoom();
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        Buffer.concat([Buffer.from('inukshuk/rdv/v1/room'), Buffer.from(identity)]),
      ),
    );
    const roomId = toB64u(digest.subarray(0, 16));
    const ws = await h.connect(roomId);
    const forged = new Uint8Array(64);
    forged[0] = 1; // R = identity, S = 0: verifies for any message under plain RFC 8032
    await h.room.webSocketMessage(
      ws,
      JSON.stringify({ t: 'auth', pub: toB64u(identity), sig: toB64u(forged) }),
    );
    expect(ws.ofType('ok')).toHaveLength(0);
  });

  it('closes after 3 failed attempts (R-RL-2)', async () => {
    const h = makeRoom();
    const ws = await h.connect(R.roomId);
    for (let i = 0; i < 3; i++) {
      await h.room.webSocketMessage(ws, h.authFrame(OTHER, ws.last()!.c as string));
    }
    expect(ws.closed?.code).toBe(CLOSE.authFailed);
    expect(ws.ofType('chal')).toHaveLength(3);
  });

  it('closes at once when the client is over its strikes (AUTH_FAIL_LIMITER)', async () => {
    const keys: string[] = [];
    const h = makeRoom({
      AUTH_FAIL_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    });
    const ws = await h.connect(R.roomId, 'tagZ');
    await h.room.webSocketMessage(ws, h.authFrame(OTHER, ws.last()!.c as string));
    expect(ws.closed?.code).toBe(CLOSE.authFailed);
    expect(keys).toEqual([`tagZ:${R.roomId}`]); // the opaque tag and the room, never an IP
  });

  it('CGNAT: strikes on a shared IP in one room do not lock that IP out of other rooms', async () => {
    const counts = new Map<string, number>();
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= 10 };
      },
    };
    const h = makeRoom({ AUTH_FAIL_LIMITER: limiter });
    // A bad actor behind the shared IP burns its strikes against room R.
    for (let i = 0; i < 4; i++) {
      const bad = await h.connect(R.roomId, 'shared-ip');
      for (let j = 0; j < 3 && !bad.closed; j++) {
        await h.room.webSocketMessage(bad, h.authFrame(OTHER, bad.last()!.c as string));
      }
    }
    expect(counts.get(`shared-ip:${R.roomId}`)).toBe(11);
    // A legitimate phone on the same IP, in its own room, is unaffected,
    // even after one failed attempt of its own.
    const other = makeRoom({ AUTH_FAIL_LIMITER: limiter });
    const fine = await other.connect(OTHER.roomId, 'shared-ip');
    await other.room.webSocketMessage(fine, other.authFrame(R, fine.last()!.c as string));
    expect(fine.closed).toBeUndefined();
    await other.room.webSocketMessage(fine, other.authFrame(OTHER, fine.last()!.c as string));
    expect(fine.last()!.t).toBe('ok');
  });

  it('treats a throwing strike limiter as allowing (per-socket cap still holds)', async () => {
    const h = makeRoom({
      AUTH_FAIL_LIMITER: {
        limit: async () => {
          throw new Error('binding down');
        },
      },
    });
    const ws = await h.connect(R.roomId);
    await h.room.webSocketMessage(ws, h.authFrame(OTHER, ws.last()!.c as string));
    expect(ws.closed).toBeUndefined();
  });

  it('closes an unauthenticated socket after 10 s (timer and lazy check)', async () => {
    const h = makeRoom();
    const idle = await h.connect(R.roomId);
    await h.advance(10_200);
    expect(idle.closed?.code).toBe(CLOSE.authTimeout);
    // A late auth on a socket whose timer did not fire yet is refused too.
    const late = await h.connect(R.roomId);
    h.clock.now += 10_001;
    await h.room.webSocketMessage(late, h.authFrame(R, late.last()!.c as string));
    expect(late.closed?.code).toBe(CLOSE.authTimeout);
  });

  it('refuses anything but auth before authentication', async () => {
    const h = makeRoom();
    const ws = await h.connect(R.roomId);
    await h.room.webSocketMessage(ws, msg('*'));
    expect(ws.closed?.code).toBe(CLOSE.protocol);
  });
});

describe('R-RDV-3: forwarding opaque blobs by handle', () => {
  async function trio() {
    const h = makeRoom();
    const a = await h.join(R, 't1');
    const b = await h.join(R, 't2');
    const c = await h.join(R, 't3');
    const handle = (ws: FakeSock) => ws.ofType('ok')[0]!.me as string;
    return { h, a, b, c, ha: handle(a), hb: handle(b), hc: handle(c) };
  }

  it('announces joins and lists present peers', async () => {
    const { a, b, c, ha, hb, hc } = await trio();
    expect(c.ofType('ok')[0]!.peers).toEqual([ha, hb]);
    expect(a.ofType('join').map((f) => f.h)).toEqual([hb, hc]);
    expect(b.ofType('join').map((f) => f.h)).toEqual([hc]);
  });

  it('forwards a blob verbatim to one handle, stamped with the sender', async () => {
    const { h, a, b, c, ha, hb } = await trio();
    const blob = blobText(1024, 7);
    await h.room.webSocketMessage(a, msg(hb, blob));
    expect(b.ofType('m')).toEqual([{ t: 'm', from: ha, b: blob }]);
    expect(c.ofType('m')).toHaveLength(0);
    expect(a.ofType('m')).toHaveLength(0);
  });

  it('broadcasts with "*" to everyone but the sender', async () => {
    const { h, a, b, c } = await trio();
    await h.room.webSocketMessage(a, msg('*'));
    expect(b.ofType('m')).toHaveLength(1);
    expect(c.ofType('m')).toHaveLength(1);
    expect(a.ofType('m')).toHaveLength(0);
  });

  it('drops a blob to an unknown handle silently', async () => {
    const { h, a, b, c } = await trio();
    await h.room.webSocketMessage(a, msg('AAAAAAAAAAA'));
    expect([b, c].map((s) => s.ofType('m').length)).toEqual([0, 0]);
    expect(a.closed).toBeUndefined();
  });

  it('announces a leave and stops forwarding to the gone socket', async () => {
    const { h, a, b, c, hb } = await trio();
    await h.room.webSocketClose(b, 1000, 'bye');
    expect(a.ofType('leave')).toEqual([{ t: 'leave', h: hb }]);
    expect(c.ofType('leave')).toEqual([{ t: 'leave', h: hb }]);
    await h.room.webSocketMessage(a, msg(hb));
    expect(b.ofType('m')).toHaveLength(0);
    // A second close event for the same socket is a no-op.
    await h.room.webSocketError(b);
    expect(a.ofType('leave')).toHaveLength(1);
  });

  it('never parses the blob: any bucket-sized base64url passes, other sizes close', async () => {
    const { h, a, b } = await trio();
    for (const size of [256, 1024, 4096, 16384]) {
      await h.room.webSocketMessage(a, msg('*', blobText(size, 0xff)));
    }
    expect(b.ofType('m')).toHaveLength(4);
    await h.room.webSocketMessage(a, msg('*', blobText(300)));
    expect(a.closed?.code).toBe(CLOSE.protocol);
  });
});

describe('R-RL-2: per-socket caps (abuse)', () => {
  it('closes a socket over 20 frames/s once the burst of 60 is spent', async () => {
    const h = makeRoom();
    const a = await h.join(R, 't1');
    await h.join(R, 't2');
    // auth used 1 token; 59 more fit in the same millisecond.
    for (let i = 0; i < 59; i++) await h.room.webSocketMessage(a, msg('*'));
    expect(a.closed).toBeUndefined();
    await h.room.webSocketMessage(a, msg('*'));
    expect(a.closed?.code).toBe(CLOSE.rate);
  });

  it('sustains 20 frames/s indefinitely', async () => {
    const h = makeRoom();
    const a = await h.join(R, 't1');
    await h.join(R, 't2');
    for (let i = 0; i < 400; i++) {
      h.clock.now += 50;
      await h.room.webSocketMessage(a, msg('*'));
    }
    expect(a.closed).toBeUndefined();
  });

  it('closes a socket over 128 KiB/s', async () => {
    const h = makeRoom();
    const a = await h.join(R, 't1');
    const big = msg('*', blobText(16384));
    let n = 0;
    while (!a.closed && n < 20) {
      await h.room.webSocketMessage(a, big);
      n++;
    }
    expect(a.closed?.code).toBe(CLOSE.rate);
    // 128 KiB burst / ~21.9 KiB per frame: the 6th frame is refused.
    expect(n).toBe(6);
  });

  it('closes on an oversized frame or a binary frame', async () => {
    const h = makeRoom();
    const a = await h.join(R, 't1');
    await h.room.webSocketMessage(a, 'x'.repeat(21846 + 65));
    expect(a.closed?.code).toBe(CLOSE.tooBig);
    const b = await h.join(R, 't2');
    await h.room.webSocketMessage(b, new ArrayBuffer(8));
    expect(b.closed?.code).toBe(CLOSE.protocol);
  });

  it('closes on malformed or unknown frames', async () => {
    for (const bad of [
      '{',
      '[]',
      'null',
      '{"t":"x"}',
      '{"t":"m","to":"*","b":"zz"}',
      '{"t":"turn","x":1}',
    ]) {
      const h = makeRoom();
      const a = await h.join(R);
      await h.room.webSocketMessage(a, bad);
      expect(a.closed?.code).toBe(CLOSE.protocol);
    }
  });
});

describe('R-RL-3: room flooding', () => {
  it('admits at most ROOM_MAX_SOCKETS authenticated sockets', async () => {
    const h = makeRoom({ ROOM_MAX_SOCKETS: '5', ROOM_MAX_PER_IP: '100' });
    const socks: FakeSock[] = [];
    for (let i = 0; i < 6; i++) socks.push(await h.join(R, `t${i}`));
    expect(socks.slice(0, 5).every((s) => s.closed === undefined)).toBe(true);
    expect(socks[5]!.closed?.code).toBe(CLOSE.full);
  });

  it('CGNAT: 12 phones of one team behind one shared IP all join one room', async () => {
    const h = makeRoom();
    const socks: FakeSock[] = [];
    for (let i = 0; i < 12; i++) socks.push(await h.join(R, 'carrier-ip'));
    expect(socks.every((s) => s.closed === undefined)).toBe(true);
    expect(socks.every((s) => s.ofType('ok').length === 1)).toBe(true);
    // They can all talk to each other.
    await h.room.webSocketMessage(socks[0]!, msg('*'));
    expect(socks.slice(1).every((s) => s.ofType('m').length === 1)).toBe(true);
  });

  it('admits at most ROOM_MAX_PER_IP (16) sockets of one client in a room', async () => {
    const h = makeRoom();
    const socks: FakeSock[] = [];
    for (let i = 0; i < 17; i++) socks.push(await h.join(R, 'same'));
    expect(socks.filter((s) => s.closed === undefined)).toHaveLength(16);
    expect(socks[16]!.closed?.code).toBe(CLOSE.full);
    expect((await h.join(R, 'other')).closed).toBeUndefined();
  });

  it('refuses new connections past 64 pending (unauthenticated) sockets', async () => {
    const h = makeRoom();
    for (let i = 0; i < 64; i++) await h.connect(R.roomId, `p${i}`);
    await expect(h.connect(R.roomId)).rejects.toThrow('503');
    // Once the pending ones time out, the room accepts again.
    await h.advance(10_200);
    await expect(h.connect(R.roomId)).resolves.toBeDefined();
  });

  it('refuses a malformed room path or a non-upgrade request', async () => {
    const h = makeRoom();
    expect((await h.room.fetch(new Request('https://room/v1/r/short'))).status).toBe(404);
    expect((await h.room.fetch(new Request(`https://room/v1/r/${R.roomId}`))).status).toBe(426);
  });
});

describe('kill switch (RTC_ENABLED = "0")', () => {
  it('closes live sockets on their next frame', async () => {
    const h = makeRoom();
    const a = await h.join(R);
    h.env.RTC_ENABLED = '0';
    await h.room.webSocketMessage(a, msg('*'));
    expect(a.closed?.code).toBe(CLOSE.disabled);
  });
});

describe('R-TURN-1/2: TURN credentials only for authenticated, paired sockets', () => {
  it('refuses a socket alone in its room', async () => {
    const h = makeRoom();
    const a = await h.join(R);
    await h.room.webSocketMessage(a, '{"t":"turn"}');
    expect(a.last()).toEqual({ t: 'turn', e: 'alone' });
    expect(h.api.mints()).toBe(0);
  });

  it('refuses before authentication (and closes)', async () => {
    const h = makeRoom();
    const a = await h.connect(R.roomId);
    await h.room.webSocketMessage(a, '{"t":"turn"}');
    expect(a.closed?.code).toBe(CLOSE.protocol);
    expect(h.api.mints()).toBe(0);
  });

  it('mints for a paired socket with a TTL of at most 15 minutes', async () => {
    const h = makeRoom({}, { TURN_TTL_S: '172800' });
    const a = await h.join(R, 't1');
    await h.join(R, 't2');
    await h.room.webSocketMessage(a, '{"t":"turn"}');
    const turn = a.last()!;
    expect(turn.t).toBe('turn');
    expect(turn.ttl).toBe(900);
    expect(JSON.stringify(turn.ice)).toContain('turn:turn.cloudflare.com');
    const mint = h.api.calls.find((c) => c.url.endsWith('generate-ice-servers'))!;
    expect(JSON.parse(mint.init!.body as string)).toEqual({ ttl: 900 });
  });

  it('allows 6 per socket per hour', async () => {
    const h = makeRoom();
    const a = await h.join(R, 't1');
    await h.join(R, 't2');
    for (let i = 0; i < 7; i++) {
      h.clock.now += 1000;
      await h.room.webSocketMessage(a, '{"t":"turn"}');
    }
    expect(a.ofType('turn').filter((f) => f.ice !== undefined)).toHaveLength(6);
    expect(a.last()).toEqual({ t: 'turn', e: 'rate' });
    h.clock.now += 3_600_000;
    await h.room.webSocketMessage(a, '{"t":"turn"}');
    expect(a.last()!.ice).toBeDefined();
  });

  it('revokes a socket’s credentials when it leaves', async () => {
    const h = makeRoom();
    const a = await h.join(R, 't1');
    await h.join(R, 't2');
    await h.room.webSocketMessage(a, '{"t":"turn"}');
    await h.room.webSocketClose(a, 1006, '');
    const revoke = h.api.calls.filter((c) => c.url.includes('/revoke'));
    expect(revoke.map((c) => c.url)).toEqual([
      'https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/user1/revoke',
    ]);
    expect(a.closed?.code).toBe(1000);
  });

  it('answers busy when the budget object is unreachable', async () => {
    const h = makeRoom();
    const a = await h.join(R, 't1');
    await h.join(R, 't2');
    h.env.BUDGET = {
      idFromName: () => 'x',
      get: () => ({
        fetch: async () => {
          throw new Error('down');
        },
      }),
    };
    await h.room.webSocketMessage(a, '{"t":"turn"}');
    expect(a.last()).toEqual({ t: 'turn', e: 'busy' });
    // Leaving still works when revoking fails.
    await h.room.webSocketClose(a, 1000, 'bye');
  });

  it('passes the kill switch through (TURN_ENABLED = "0")', async () => {
    const h = makeRoom({}, { TURN_ENABLED: '0' });
    const a = await h.join(R, 't1');
    await h.join(R, 't2');
    await h.room.webSocketMessage(a, '{"t":"turn"}');
    expect(a.last()).toEqual({ t: 'turn', e: 'off' });
    expect(h.api.calls).toHaveLength(0);
  });
});

describe('R-RLY-1 / R-META: nothing kept, nothing identifying', () => {
  it('a full session touches no storage and keeps only handles, counters and the tag', async () => {
    const h = makeRoom();
    const a = await h.join(R, 't1');
    const b = await h.join(R, 't2');
    await h.room.webSocketMessage(a, msg(b.ofType('ok')[0]!.me as string));
    await h.room.webSocketMessage(a, '{"t":"turn"}');
    await h.room.webSocketClose(b, 1000, '');
    expect(h.touched).toEqual([]);
    const attachment = JSON.stringify(a.deserializeAttachment());
    expect(attachment).not.toContain(blobText());
    expect(attachment).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(Object.keys(a.deserializeAttachment() as object).sort()).toEqual(
      ['a', 'bb', 'c', 'dl', 'f', 'h', 'host', 'mb', 'rid', 'tag', 'tt', 'tu', 'x'].sort(),
    );
  });

  it('server frames carry no room id, tag or host', async () => {
    const h = makeRoom();
    const a = await h.join(R, 'secret-tag');
    await h.join(R, 'other-tag');
    const all = a.sentRaw.join('\n');
    expect(all).not.toContain(R.roomId);
    expect(all).not.toContain('secret-tag');
    expect(all).not.toContain(HOST);
  });

  it('the auth signature binds host and room exactly as the phone signs it', async () => {
    const h = makeRoom();
    const ws = await h.connect(R.roomId);
    const c = Uint8Array.from(Buffer.from(ws.last()!.c as string, 'base64url'));
    const sig = signAuth(nobleCrypto, R, HOST, c);
    await h.room.webSocketMessage(
      ws,
      JSON.stringify({ t: 'auth', pub: toB64u(R.roomPub), sig: toB64u(sig) }),
    );
    expect(ws.last()!.t).toBe('ok');
  });
});
