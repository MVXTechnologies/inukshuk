/**
 * Test doubles for the relay (run by the app's Jest in Node; the Worker
 * project has no runner of its own). Deterministic: a manual clock, a counter
 * RNG, timers that run only when the test advances the clock.
 *
 * The Durable Object state and the env are Proxies that THROW on any member
 * the relay is not supposed to touch, so "the relay stores nothing" (R-RLY-1)
 * is checked by every test, not only by the grep gate.
 */
import { webcrypto } from 'node:crypto';

import { toB64u, utf8 } from '../../../../src/core/team/bytes';
import { nobleCrypto } from '../../../../src/core/team/testing/noble';
import { mulberry32 } from '../../../../src/core/team/testing/prop';
import { deriveRoom, type Room as RdvRoom, signAuth } from '../../../../src/core/group/rdv';
import vectors from '../../../../src/core/group/rdv.vectors.json';
import { Budget, type BudgetEnv } from '../src/budget';
import { Room, type RoomDeps, type RoomEnv, type Sock } from '../src/room';

export const subtle = webcrypto.subtle as unknown as SubtleCrypto;
export const HOST = 'rtc.example.org';
export const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

export function fromHexStr(h: string): Uint8Array {
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
}

/** The pinned vectors' room (today) and another room (the invite room). */
export function vectorRoom(secret: 'rs' | 'ir' = 'rs'): RdvRoom {
  return deriveRoom(nobleCrypto, fromHexStr(vectors[secret]), vectors.rooms[0]!.day);
}

export type Frame = Record<string, unknown>;

export class FakeSock implements Sock {
  readonly sent: Frame[] = [];
  readonly sentRaw: string[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private attachment: string | undefined;

  send(data: string): void {
    if (this.closed) throw new Error('send on closed socket');
    this.sentRaw.push(data);
    this.sent.push(JSON.parse(data) as Frame);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) throw new Error('already closed');
    this.closed = { code, reason };
  }
  // A real attachment is structured-cloned; JSON is close enough and catches
  // anything that would not survive hibernation (functions, Maps, cycles).
  serializeAttachment(value: unknown): void {
    const text = JSON.stringify(value);
    if (text.length > 2048) throw new Error('attachment over 2 KiB');
    this.attachment = text;
  }
  deserializeAttachment(): unknown {
    return this.attachment === undefined ? null : JSON.parse(this.attachment);
  }
  last(): Frame | undefined {
    return this.sent[this.sent.length - 1];
  }
  ofType(t: string): Frame[] {
    return this.sent.filter((f) => f.t === t);
  }
}

/** Any member access not in `allowed` throws (and is recorded). */
export function strict<T extends object>(
  target: T,
  allowed: readonly string[],
  touched: string[],
): T {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'string' && !allowed.includes(prop) && prop !== 'then') {
        touched.push(prop);
        throw new Error(`relay touched forbidden member: ${prop}`);
      }
      return Reflect.get(t, prop);
    },
  });
}

export interface ApiCall {
  url: string;
  init?: RequestInit;
}

/** A fake Cloudflare API (TURN mint/revoke + GraphQL usage). */
export function fakeApi(
  opts: { egressBytes?: number; mintStatus?: number; usageOk?: boolean } = {},
) {
  const calls: ApiCall[] = [];
  let n = 0;
  const state = {
    egressBytes: opts.egressBytes ?? 1_000_000_000,
    mintStatus: opts.mintStatus ?? 201,
    usageOk: opts.usageOk ?? true,
  };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.endsWith('/credentials/generate-ice-servers')) {
      if (state.mintStatus >= 300) return new Response('nope', { status: state.mintStatus });
      n++;
      return Response.json(
        {
          iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            {
              urls: [
                'turn:turn.cloudflare.com:3478?transport=udp',
                'turns:turn.cloudflare.com:443?transport=tcp',
              ],
              username: `user${n}`,
              credential: `cred${n}`,
            },
          ],
        },
        { status: 201 },
      );
    }
    if (url.includes('/revoke')) return new Response(null, { status: 204 });
    if (url.endsWith('/graphql')) {
      if (!state.usageOk) return Response.json({ errors: [{ message: 'x' }], data: null });
      return Response.json({
        data: {
          viewer: {
            accounts: [
              { callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: state.egressBytes } }] },
            ],
          },
        },
      });
    }
    return new Response(null, { status: 404 });
  };
  return {
    fetchFn,
    calls,
    state,
    mints: () => calls.filter((c) => c.url.endsWith('generate-ice-servers')).length,
  };
}

export const BUDGET_ENV: BudgetEnv = {
  TURN_ENABLED: '1',
  TURN_TTL_S: '900',
  TURN_PER_IP_PER_HOUR: '20',
  TURN_DAILY_BUDGET: '2000',
  TURN_MONTHLY_ALLOWANCE_GB: '1000',
  TURN_USAGE_OFF_PERCENT: '80',
  TURN_KEY_ID: 'key123',
  TURN_KEY_API_TOKEN: 'token-not-real',
  CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  CF_ANALYTICS_TOKEN: 'analytics-not-real',
};

/** A room object wired to a real Budget object, with fakes all around. */
export function makeRoom(
  envOverrides: Partial<RoomEnv> = {},
  budgetEnv: Partial<BudgetEnv> = {},
  api = fakeApi(),
) {
  const clock = { now: T0 };
  const rand = mulberry32(2701);
  const timers: { at: number; fn: () => void }[] = [];
  const sockets: FakeSock[] = [];
  const touched: string[] = [];
  const budget = new Budget(
    strict({}, [], touched),
    { ...BUDGET_ENV, ...budgetEnv },
    { now: () => clock.now, fetch: api.fetchFn },
  );
  const budgetCalls: string[] = [];
  const env: RoomEnv = {
    ROOM_MAX_SOCKETS: '128',
    ROOM_MAX_PER_IP: '16',
    TURN_PER_SOCKET_PER_HOUR: '6',
    BUDGET: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (url: string, init?: RequestInit) => {
          budgetCalls.push(url);
          return budget.fetch(new Request(url, init));
        },
      }),
    },
    ...envOverrides,
  };
  const state = strict(
    {
      acceptWebSocket: (ws: Sock) => {
        sockets.push(ws as FakeSock);
      },
      getWebSockets: () => sockets.filter((s) => !s.closed),
    },
    ['acceptWebSocket', 'getWebSockets', 'setWebSocketAutoResponse'],
    touched,
  );
  const deps: RoomDeps = {
    now: () => clock.now,
    randomBytes: (n) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256)),
    subtle,
    newPair: () => {
      const s = new FakeSock();
      return [{ client: true }, s];
    },
    upgrade: () => new Response(null, { status: 200, headers: { 'x-upgraded': '1' } }),
    later: (fn, ms) => {
      timers.push({ at: clock.now + ms, fn });
    },
  };
  const room = new Room(state, env, deps);

  async function connect(roomId: string, tag = 'tagA', host = HOST): Promise<FakeSock> {
    const res = await room.fetch(
      new Request(`https://room/v1/r/${roomId}`, {
        headers: { Upgrade: 'websocket', 'x-rtc-host': host, 'x-rtc-tag': tag },
      }),
    );
    if (res.status !== 200) throw new Error(`connect refused: ${res.status}`);
    return sockets[sockets.length - 1]!;
  }

  function authFrame(r: RdvRoom, chal: string, host = HOST): string {
    const c = Uint8Array.from(Buffer.from(chal, 'base64url'));
    return JSON.stringify({
      t: 'auth',
      pub: toB64u(r.roomPub),
      sig: toB64u(signAuth(nobleCrypto, r, host, c)),
    });
  }

  /** Connect and authenticate into `r`. */
  async function join(r: RdvRoom, tag = 'tagA'): Promise<FakeSock> {
    const ws = await connect(r.roomId, tag);
    const chal = ws.last()!;
    await room.webSocketMessage(ws, authFrame(r, chal.c as string));
    return ws;
  }

  async function advance(ms: number): Promise<void> {
    clock.now += ms;
    for (const t of timers.splice(0)) {
      if (t.at <= clock.now) t.fn();
      else timers.push(t);
    }
  }

  return {
    room,
    budget,
    env,
    api,
    clock,
    sockets,
    touched,
    budgetCalls,
    connect,
    join,
    authFrame,
    advance,
  };
}

/** A padded blob text of `bytes` length (256 → 342 chars), not a real seal: the server never opens it. */
export function blobText(bytes = 256, fill = 1): string {
  return toB64u(new Uint8Array(bytes).fill(fill));
}

export const msg = (to: string, b = blobText()) => JSON.stringify({ t: 'm', to, b });

export { utf8, vectors };
