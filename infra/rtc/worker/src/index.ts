import { Budget, type BudgetEnv, type RateLimit } from './budget';
import { isRoomId, toB64u } from './protocol';
import { Room, type RoomEnv } from './room';

/**
 * inukshuk-rtc: the rendezvous Worker for phone-to-phone sync (2.7.0, #705).
 *
 * Routes: `GET /v1/r/<roomId>` (WebSocket upgrade) → the room's Durable
 * Object. Everything else is a bare 404. The cron refreshes the TURN usage
 * reading (R-TURN-4). There are no logs of any kind (R-META-2): the client IP
 * is a rate-limit key here and is otherwise turned into an opaque tag (HMAC
 * under `IP_TAG_KEY`) before anything is handed to a Durable Object.
 *
 * Deployed to its own Cloudflare account (R-OPS-1); see ../README.md.
 */

export { Budget, Room };

export interface Env extends RoomEnv, BudgetEnv {
  ROOMS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(r: Request): Promise<Response> };
  };
  WS_LIMITER?: RateLimit;
  IP_TAG_KEY?: string;
}

const ROOM_PATH = /^\/v1\/r\/([A-Za-z0-9_-]{22})$/;

/** Opaque per-client tag: HMAC-SHA256(IP_TAG_KEY, ip), 12 bytes, base64url. */
export async function clientTag(subtle: SubtleCrypto, secret: string, ip: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    enc.encode('inukshuk/rdv/v1/ip-tag\n' + secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await subtle.sign('HMAC', key, enc.encode(ip)));
  return toB64u(mac.subarray(0, 12));
}

async function allowed(binding: RateLimit | undefined, key: string): Promise<boolean> {
  if (binding === undefined) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return true; // a broken limiter must not take the relay down
  }
}

export async function handleFetch(
  request: Request,
  env: Env,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<Response> {
  const url = new URL(request.url);
  const m = ROOM_PATH.exec(url.pathname);
  if (request.method !== 'GET' || m === null || !isRoomId(m[1])) {
    return new Response(null, { status: 404 });
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(null, { status: 426 });
  }
  if (env.RTC_ENABLED === '0') {
    return new Response(null, { status: 503, headers: { 'Retry-After': '600' } });
  }
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await allowed(env.WS_LIMITER, ip))) {
    return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  }
  const roomId = m[1]!;
  const tag = await clientTag(subtle, env.IP_TAG_KEY ?? '', ip);
  // A fresh request: the room object sees the room id, the host (bound into
  // the signature) and the tag, and none of the client's own headers.
  const forwarded = new Request(`https://room/v1/r/${roomId}`, {
    headers: { Upgrade: 'websocket', 'x-rtc-host': url.host, 'x-rtc-tag': tag },
  });
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(forwarded);
}

export async function handleScheduled(env: Env): Promise<void> {
  const stub = env.BUDGET.get(env.BUDGET.idFromName('budget'));
  await stub.fetch('https://budget/usage', { method: 'POST', body: '{}' });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
  scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void {
    ctx.waitUntil(handleScheduled(env));
  },
};
