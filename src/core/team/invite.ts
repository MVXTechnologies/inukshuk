import { concatBytes, fromB64u, fromB64uLen, isB64uLen, toB64u, utf8, utf8Decode } from './bytes';
import { canonicalize, isRecord } from './canonical';
import {
  derive,
  KEY_BYTES,
  safeVerify,
  SIG_BYTES,
  type DeviceKeys,
  type TeamCrypto,
} from './crypto';
import { isMemberId, memberIdOf, memberPublicKey, TEAM_ID_BYTES } from './ids';

/**
 * Invites (#589, owner B7: join by SMS, link or QR).
 *
 * ## Token
 * A compact binary blob, base64url-encoded:
 *
 * | bytes | field |
 * |---|---|
 * | 1 | version (1) |
 * | 1 | flags (bit 0: network hint present) |
 * | 16 | teamId |
 * | 16 | **invite seed** — the only secret |
 * | 4 | expiry, unix seconds, big-endian (display only) |
 * | 4+2+1+n+1+m | optional network hint: IPv4, TCP port, SSID, hotspot password (QR only) |
 *
 * Without the hint it is 38 bytes → 51 characters, so an SMS
 * `https://inukshuk.mvxtechnologies.com/j#<51 chars>` fits one segment. The
 * secret sits after `#`: browsers never send the fragment to a server.
 *
 * ## How it is used
 * The admin creates the invite as an `i.create` op holding only the **invite
 * public key** (Ed25519 key derived from the seed), its expiry, use limit, role
 * and groups. The joiner derives the same key pair from the seed and signs a
 * join request; any member it meets on the LAN checks the signature against
 * the `i.create` in its log and records an `m.admit` op (with the team key
 * wrapped for the joiner). The joiner verifies the whole log it then receives
 * against `teamId`, which commits to the owner's key (`ids.ts`), so a rogue
 * LAN peer cannot feed it a fake team.
 *
 * ## What is secret
 * - **Secret:** the seed (anyone holding it can join until it expires or runs
 *   out of uses). The hotspot password in a QR hint (local, short-lived).
 * - **Not secret:** teamId (lets someone notice the team's LAN adverts, nothing
 *   more), the expiry, the invite public key (it is in the log).
 * - Never in a token: names, phone numbers, the team key.
 *
 * Threat model: `docs/design/team-protocol.md` §Invites.
 */

export const INVITE_VERSION = 1;
export const INVITE_SEED_BYTES = 16;
export const DEFAULT_INVITE_BASE = 'https://inukshuk.mvxtechnologies.com/j';

export interface NetHint {
  /** IPv4 of a peer to dial directly (QR next to an Android hotspot host). */
  host: [number, number, number, number];
  port: number;
  /** Android LocalOnlyHotspot credentials, for iOS `NEHotspotConfiguration`. */
  ssid?: string;
  pass?: string;
}

export interface InviteToken {
  teamId: string;
  seed: Uint8Array;
  /** Epoch ms, whole seconds. Display only: the authoritative expiry is in `i.create`. */
  expiresAt: number;
  net?: NetHint;
}

/** Where a token is going. Only a QR (shown in person) may carry the network hint. */
export type InviteChannel = 'sms' | 'link' | 'qr';

const MAX_SSID_BYTES = 32;
const MAX_PASS_BYTES = 63;

export function encodeInvite(token: InviteToken, channel: InviteChannel): string {
  const withNet = channel === 'qr' && token.net !== undefined;
  const head = new Uint8Array(2 + TEAM_ID_BYTES + INVITE_SEED_BYTES + 4);
  head[0] = INVITE_VERSION;
  head[1] = withNet ? 1 : 0;
  head.set(fromB64uLen(token.teamId, TEAM_ID_BYTES)!, 2);
  head.set(token.seed, 2 + TEAM_ID_BYTES);
  new DataView(head.buffer).setUint32(
    2 + TEAM_ID_BYTES + INVITE_SEED_BYTES,
    Math.floor(token.expiresAt / 1000),
  );
  if (!withNet) return toB64u(head);
  const net = token.net!;
  const ssid = utf8(net.ssid ?? '').subarray(0, MAX_SSID_BYTES);
  const pass = utf8(net.pass ?? '').subarray(0, MAX_PASS_BYTES);
  const tail = new Uint8Array(4 + 2 + 1 + ssid.length + 1 + pass.length);
  tail.set(net.host, 0);
  new DataView(tail.buffer).setUint16(4, net.port);
  tail[6] = ssid.length;
  tail.set(ssid, 7);
  tail[7 + ssid.length] = pass.length;
  tail.set(pass, 8 + ssid.length);
  return toB64u(concatBytes(head, tail));
}

/** Decode a token payload. Total: `undefined` for anything malformed or from a newer version. */
export function decodeInvite(payload: string): InviteToken | undefined {
  const bytes = fromB64u(payload);
  const headLen = 2 + TEAM_ID_BYTES + INVITE_SEED_BYTES + 4;
  if (bytes === undefined || bytes.length < headLen || bytes[0] !== INVITE_VERSION)
    return undefined;
  const flags = bytes[1]!;
  if ((flags & ~1) !== 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const token: InviteToken = {
    teamId: toB64u(bytes.subarray(2, 2 + TEAM_ID_BYTES)),
    seed: bytes.slice(2 + TEAM_ID_BYTES, 2 + TEAM_ID_BYTES + INVITE_SEED_BYTES),
    expiresAt: view.getUint32(2 + TEAM_ID_BYTES + INVITE_SEED_BYTES) * 1000,
  };
  if ((flags & 1) === 0) return bytes.length === headLen ? token : undefined;
  let o = headLen;
  if (bytes.length < o + 7) return undefined;
  const host = [bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!] as NetHint['host'];
  const port = view.getUint16(o + 4);
  const ssidLen = bytes[o + 6]!;
  o += 7;
  if (ssidLen > MAX_SSID_BYTES || bytes.length < o + ssidLen + 1) return undefined;
  const ssid = utf8Decode(bytes.subarray(o, o + ssidLen));
  o += ssidLen;
  const passLen = bytes[o]!;
  o += 1;
  if (passLen > MAX_PASS_BYTES || bytes.length !== o + passLen) return undefined;
  const pass = utf8Decode(bytes.subarray(o, o + passLen));
  if (ssid === undefined || pass === undefined || port === 0) return undefined;
  token.net = { host, port };
  if (ssid !== '') token.net.ssid = ssid;
  if (pass !== '') token.net.pass = pass;
  return token;
}

/** `https://…/j#<payload>` (SMS, link) — the payload rides in the fragment. */
export function inviteLink(payload: string, base = DEFAULT_INVITE_BASE): string {
  return `${base}#${payload}`;
}

/**
 * Accepts what a user might paste or a scanner might read: a bare payload, an
 * `https://…/j#payload` link or an `inukshuk://team/join#payload` deep link.
 */
export function parseInviteText(text: string): InviteToken | undefined {
  const trimmed = text.trim();
  if (trimmed.length > 512) return undefined;
  const hash = trimmed.lastIndexOf('#');
  return decodeInvite(hash >= 0 ? trimmed.slice(hash + 1) : trimmed);
}

/** The invite's Ed25519 seed (private to whoever holds the token). */
export function inviteSigningSeed(c: TeamCrypto, token: Pick<InviteToken, 'teamId' | 'seed'>) {
  return derive(c, token.seed, utf8(token.teamId), 'invite-sign');
}

/** The invite id = the invite public key, as recorded in `i.create`. */
export function inviteIdOf(c: TeamCrypto, token: Pick<InviteToken, 'teamId' | 'seed'>): string {
  return memberIdOf(c.ed25519.publicKey(inviteSigningSeed(c, token)));
}

/** The join request a joiner sends; it is copied verbatim into `m.admit`. */
export interface JoinProof {
  /** Joiner member id (Ed25519 public key). */
  m: string;
  /** Joiner X25519 public key. */
  x: string;
  /** Invite id. */
  inv: string;
  /** Invite key's signature over the join message (proves the seed). */
  ip: string;
  /** Joiner's signature over the join message (proves the identity key). */
  js: string;
}

export function joinMessage(teamId: string, m: string, x: string, inv: string): Uint8Array {
  return utf8(`inukshuk/team/v1/join\n${canonicalize({ tm: teamId, m, x, inv })!}`);
}

export function makeJoinProof(c: TeamCrypto, token: InviteToken, joiner: DeviceKeys): JoinProof {
  const m = memberIdOf(joiner.signPublic);
  const x = toB64u(joiner.boxPublic);
  const invSeed = inviteSigningSeed(c, token);
  const inv = memberIdOf(c.ed25519.publicKey(invSeed));
  const msg = joinMessage(token.teamId, m, x, inv);
  return {
    m,
    x,
    inv,
    ip: toB64u(c.ed25519.sign(msg, invSeed)),
    js: toB64u(c.ed25519.sign(msg, joiner.signSecret)),
  };
}

export function parseJoinProof(value: unknown): JoinProof | undefined {
  if (!isRecord(value)) return undefined;
  const { m, x, inv, ip, js } = value;
  if (!isMemberId(m) || !isMemberId(inv) || !isB64uLen(x, KEY_BYTES)) {
    return undefined;
  }
  if (!isB64uLen(ip, SIG_BYTES) || !isB64uLen(js, SIG_BYTES)) {
    return undefined;
  }
  return { m, x: x as string, inv, ip: ip as string, js: js as string };
}

/** Both signatures check out for this team. Total. */
export function verifyJoinProof(c: TeamCrypto, teamId: string, p: JoinProof): boolean {
  const msg = joinMessage(teamId, p.m, p.x, p.inv);
  return (
    safeVerify(c, fromB64uLen(p.ip, SIG_BYTES), msg, memberPublicKey(p.inv)) &&
    safeVerify(c, fromB64uLen(p.js, SIG_BYTES), msg, memberPublicKey(p.m))
  );
}

export const JOIN_PROOF_KEYS: readonly string[] = ['m', 'x', 'inv', 'ip', 'js'];
