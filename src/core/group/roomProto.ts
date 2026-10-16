import { fromB64uLen, toB64u } from '../team/bytes';
import { canonicalize } from '../team/canonical';
import { CHALLENGE_BYTES } from './rdv';
import { isHandle, ROOM_BLOB_TEXT_LENGTHS } from './roomBlob';

/**
 * Room protocol v1, the phone's side (2.7.0 G6, #705): the text frames of
 * `wss://<host>/v1/r/<roomId>` (server: `infra/rtc/worker/src/protocol.ts`).
 *
 * | Direction | Frame                                    |
 * | --------- | ---------------------------------------- |
 * | S → C     | `{t:'chal', c, now}`                     |
 * | C → S     | `{t:'auth', pub, sig}`                   |
 * | S → C     | `{t:'ok', me, peers, now}`               |
 * | S → C     | `{t:'join', h}` / `{t:'leave', h}`       |
 * | C → S     | `{t:'m', to, b}`                         |
 * | S → C     | `{t:'m', from, b}`                       |
 * | C → S     | `{t:'turn'}`                             |
 * | S → C     | `{t:'turn', ice, ttl}` / `{t:'turn', e}` |
 *
 * Inside a blob (`roomBlob.ts`), one byte says what the payload is:
 * {@link ROOM_KIND}`.hello` starts a session (the payload is its `hi1`; the
 * receiver drops any session it had with that handle), `.frame` is the next
 * frame of the session with that handle.
 *
 * The server is not trusted with anything but forwarding; still, its frames
 * are parsed totally and strictly (unknown types, extra keys, wrong shapes
 * are `undefined`), so a broken or hostile relay can't make the phone throw.
 */

export const ROOM_PROTOCOL_PATH = '/v1/r/';
/** Largest server frame a phone reads (the largest blob plus the JSON around it). */
export const MAX_SERVER_FRAME_CHARS = 21846 + 128;
/** Peers a server may list in `ok` (the room's socket cap, R-RL-3). */
export const MAX_ROOM_PEERS = 128;

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export type TurnRefusal = 'off' | 'busy' | 'budget' | 'rate' | 'alone';

export type ServerFrame =
  | { t: 'chal'; c: Uint8Array; now: number }
  | { t: 'ok'; me: string; peers: string[]; now: number }
  | { t: 'join'; h: string }
  | { t: 'leave'; h: string }
  | { t: 'm'; from: string; b: string }
  | { t: 'turn'; ice: IceServer[]; ttl: number }
  | { t: 'turn'; e: TurnRefusal | 'error' };

const TURN_REFUSALS: ReadonlySet<string> = new Set(['off', 'busy', 'budget', 'rate', 'alone']);
const ICE_URL = /^(stun|turn|turns):[A-Za-z0-9.:?=_-]{1,200}$/;
const CRED = /^[A-Za-z0-9+/=._:-]{1,512}$/;

function keysAre(o: Record<string, unknown>, keys: string[]): boolean {
  const have = Object.keys(o).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

function isServerTime(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) > 0 && (v as number) < 2 ** 32;
}

function iceServer(v: unknown): IceServer | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter(
    (k) => k !== 'urls' && k !== 'username' && k !== 'credential',
  );
  if (extra.length > 0) return undefined;
  const urls = typeof o['urls'] === 'string' ? [o['urls']] : o['urls'];
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 12) return undefined;
  if (!urls.every((u) => typeof u === 'string' && ICE_URL.test(u))) return undefined;
  const out: IceServer = { urls: [...(urls as string[])] };
  if (o['username'] !== undefined || o['credential'] !== undefined) {
    if (typeof o['username'] !== 'string' || !CRED.test(o['username'])) return undefined;
    if (typeof o['credential'] !== 'string' || !CRED.test(o['credential'])) return undefined;
    out.username = o['username'];
    out.credential = o['credential'];
  }
  return out;
}

/** Parse one server frame. Total: anything unexpected is `undefined`. */
export function parseServerFrame(raw: unknown): ServerFrame | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_SERVER_FRAME_CHARS) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  switch (o['t']) {
    case 'chal': {
      const c = fromB64uLen(o['c'], CHALLENGE_BYTES);
      if (!keysAre(o, ['t', 'c', 'now']) || c === undefined || !isServerTime(o['now'])) {
        return undefined;
      }
      return { t: 'chal', c, now: o['now'] };
    }
    case 'ok': {
      const peers = o['peers'];
      if (
        !keysAre(o, ['t', 'me', 'peers', 'now']) ||
        !isHandle(o['me']) ||
        !isServerTime(o['now']) ||
        !Array.isArray(peers) ||
        peers.length > MAX_ROOM_PEERS ||
        !peers.every(isHandle)
      ) {
        return undefined;
      }
      return { t: 'ok', me: o['me'], peers: [...(peers as string[])], now: o['now'] };
    }
    case 'join':
    case 'leave':
      return keysAre(o, ['t', 'h']) && isHandle(o['h']) ? { t: o['t'], h: o['h'] } : undefined;
    case 'm':
      return keysAre(o, ['t', 'from', 'b']) &&
        isHandle(o['from']) &&
        typeof o['b'] === 'string' &&
        ROOM_BLOB_TEXT_LENGTHS.includes(o['b'].length)
        ? { t: 'm', from: o['from'], b: o['b'] }
        : undefined;
    case 'turn': {
      if (keysAre(o, ['t', 'e'])) {
        const e = o['e'];
        return {
          t: 'turn',
          e: typeof e === 'string' && TURN_REFUSALS.has(e) ? (e as TurnRefusal) : 'error',
        };
      }
      const ice = o['ice'];
      const ttl = o['ttl'];
      if (
        !keysAre(o, ['t', 'ice', 'ttl']) ||
        !Array.isArray(ice) ||
        ice.length === 0 ||
        ice.length > 4
      ) {
        return undefined;
      }
      if (!Number.isSafeInteger(ttl) || (ttl as number) < 1 || (ttl as number) > 48 * 3600) {
        return undefined;
      }
      const servers: IceServer[] = [];
      for (const s of ice) {
        const parsed = iceServer(s);
        if (parsed === undefined) return undefined;
        servers.push(parsed);
      }
      return { t: 'turn', ice: servers, ttl: ttl as number };
    }
    default:
      return undefined;
  }
}

/** `{t:'auth', pub, sig}`. */
export function authFrame(pub: Uint8Array, sig: Uint8Array): string {
  return canonicalize({ t: 'auth', pub: toB64u(pub), sig: toB64u(sig) })!;
}

/** `{t:'m', to, b}`: a sealed blob (base64url text) to one handle. */
export function messageFrame(to: string, blobText: string): string {
  return canonicalize({ t: 'm', to, b: blobText })!;
}

export const TURN_REQUEST = '{"t":"turn"}';

/** What a room blob carries (its first byte). */
export const ROOM_KIND = { hello: 1, frame: 2 } as const;
export type RoomKind = (typeof ROOM_KIND)[keyof typeof ROOM_KIND];

export function encodeRoomPayload(kind: RoomKind, frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(frame.length + 1);
  out[0] = kind;
  out.set(frame, 1);
  return out;
}

export function decodeRoomPayload(
  payload: Uint8Array,
): { kind: RoomKind; frame: Uint8Array } | undefined {
  const kind = payload[0];
  if ((kind !== ROOM_KIND.hello && kind !== ROOM_KIND.frame) || payload.length < 2)
    return undefined;
  return { kind, frame: payload.slice(1) };
}

/** Which of two handles starts the session (one handshake per pair). */
export function initiatesTo(me: string, peer: string): boolean {
  return me < peer;
}
