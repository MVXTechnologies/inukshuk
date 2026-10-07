import { concatBytes, fromB64u, fromB64uLen, isB64uLen, toB64u, utf8, utf8Decode } from './bytes';
import { canonicalize, hasOnlyKeys, isRecord, parseJson, type Json } from './canonical';
import {
  derive,
  KEY_BYTES,
  NONCE_BYTES,
  safeOpen,
  safeShared,
  safeVerify,
  SIG_BYTES,
  TAG_BYTES,
  type DeviceKeys,
  type TeamCrypto,
} from './crypto';
import { hlcToWire, isTooFarAhead, parseHlc, type Hlc, type Stamp } from './hlc';
import { isKeyId, isTeamId, memberIdOf, memberPublicKey, opIdOf } from './ids';
import { parseAudience, PRIORITIES, type Audience, type Priority } from './roles';

/**
 * The op envelope (#589) — the one unit that is signed, stored, relayed and
 * (later) handed to Nostr relays or the paid hosted relay (#590) unchanged.
 *
 * ```
 * { v:1, tm:teamId, au:authorMemberId, sq:seq, hc:[wallMs,counter], t:type,
 *   b?:controlBody, aud?:audience, pr?:1|2, ttl?:seconds,
 *   k?:keyId | x?:{e:ephemeralPub, w:[[memberId, wrappedCek]…]},
 *   n?:nonce, c?:ciphertext, sg:signature }
 * ```
 *
 * - **Control ops** (membership, invites, groups, expiry, keys) carry their
 *   authority data in clear `b` so any peer — even one still waiting for a key
 *   — can validate the membership log. Human labels (names, team/group
 *   names) go in the optional group-encrypted `c`.
 * - **Data ops** (`e.set`, `e.del`, `msg`) and the **ephemeral** `pos` carry
 *   their whole body encrypted in `c`: under the team key `k` (group mode)
 *   or under a one-off key sealed to each recipient's X25519 key `x`
 *   (sealed mode: DMs and narrow audiences).
 * - `sg` = Ed25519 over `DOMAIN "op\n" ‖ canonical(envelope − sg)`. The op id
 *   is the SHA-256 of those same bytes (dedupe id).
 * - The AEAD's associated data is `DOMAIN "aad\n" ‖ canonical(envelope − sg − c)`,
 *   so a ciphertext cannot be moved under another header.
 * - Unknown members are refused, so one op has exactly one encoding.
 */

export const PROTOCOL_VERSION = 1;

export const CONTROL_TYPES = [
  'm.genesis',
  'm.add',
  'm.admit',
  'm.update',
  'm.remove',
  'i.create',
  'i.revoke',
  'g.set',
  'g.del',
  't.extend',
  't.close',
  'k.rotate',
  'k.share',
] as const;
export const DATA_TYPES = ['e.set', 'e.del', 'msg'] as const;
export const EPHEMERAL_TYPES = ['pos'] as const;

export type ControlType = (typeof CONTROL_TYPES)[number];
export type DataType = (typeof DATA_TYPES)[number];
export type EphemeralType = (typeof EPHEMERAL_TYPES)[number];
export type OpType = ControlType | DataType | EphemeralType;
export const OP_TYPES: readonly OpType[] = [...CONTROL_TYPES, ...DATA_TYPES, ...EPHEMERAL_TYPES];

export const isControlType = (t: string): t is ControlType =>
  (CONTROL_TYPES as readonly string[]).includes(t);
export const isEphemeralType = (t: string): t is EphemeralType =>
  (EPHEMERAL_TYPES as readonly string[]).includes(t);

/** Byte caps per op type (UTF-8 of the canonical envelope). */
export const MAX_OP_BYTES: Readonly<Record<OpType, number>> = {
  ...(Object.fromEntries(CONTROL_TYPES.map((t) => [t, 128 * 1024])) as Record<ControlType, number>),
  'e.set': 32 * 1024,
  'e.del': 2 * 1024,
  msg: 16 * 1024,
  pos: 1024,
};
export const MAX_SEQ = 2 ** 31 - 1;
/** Ephemeral ops live at most a day. */
export const MAX_TTL_S = 24 * 60 * 60;
export const MAX_SEALED_RECIPIENTS = 64;

export interface SealedKeys {
  /** Ephemeral X25519 public key. */
  e: string;
  /** HKDF commitment to the content key (key-committing sealed mode). */
  cc: string;
  /** `[memberId, wrapped content key]`, sorted by member id. */
  w: [string, string][];
}

export interface Envelope {
  v: 1;
  tm: string;
  au: string;
  sq: number;
  /** Previous op of this author (`sq − 1`): a per-author hash chain. Logged ops with sq ≥ 2. */
  pv?: string;
  hc: [number, number];
  t: OpType;
  b?: Json;
  aud?: Audience;
  pr?: 1 | 2;
  ttl?: number;
  k?: string;
  x?: SealedKeys;
  n?: string;
  c?: string;
  sg: string;
}

/** A structurally valid, signature-verified envelope with its derived fields. */
export interface SignedOp {
  env: Envelope;
  id: string;
  stamp: Stamp;
  /** UTF-8 length of the canonical envelope. */
  bytes: number;
}

const ENVELOPE_KEYS = [
  'v',
  'tm',
  'au',
  'sq',
  'pv',
  'hc',
  't',
  'b',
  'aud',
  'pr',
  'ttl',
  'k',
  'x',
  'n',
  'c',
  'sg',
];

type Unsigned = Omit<Envelope, 'sg'>;

function withoutKeys(env: Partial<Envelope>, drop: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.includes(k)));
}

export function signingBytes(env: Unsigned | Envelope): Uint8Array {
  return utf8(`inukshuk/team/v1/op\n${canonicalize(withoutKeys(env, ['sg']))!}`);
}

export function aadBytes(env: Partial<Envelope>): Uint8Array {
  return utf8(`inukshuk/team/v1/aad\n${canonicalize(withoutKeys(env, ['sg', 'c']))!}`);
}

export type RejectReason =
  | 'not-object'
  | 'unknown-field'
  | 'version'
  | 'team'
  | 'author'
  | 'seq'
  | 'clock'
  | 'clock-skew'
  | 'type'
  | 'shape'
  | 'too-large'
  | 'signature';

export type CheckResult = { ok: true; op: SignedOp } | { ok: false; reason: RejectReason };

function parseSealed(value: unknown): SealedKeys | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['e', 'w', 'cc'])) return undefined;
  if (!isB64uLen(value['e'], KEY_BYTES) || !isB64uLen(value['cc'], KEY_BYTES)) return undefined;
  const w = value['w'];
  if (!Array.isArray(w) || w.length === 0 || w.length > MAX_SEALED_RECIPIENTS) return undefined;
  let prev = '';
  for (const pair of w as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) return undefined;
    const [id, wrapped] = pair as unknown[];
    if (memberPublicKey(id) === undefined || (id as string) <= prev) return undefined; // sorted, unique
    if (!isB64uLen(wrapped, KEY_BYTES + TAG_BYTES)) return undefined;
    prev = id as string;
  }
  return value as unknown as SealedKeys;
}

/** Field-presence rules per op class. Returns `false` for any inconsistent combination. */
function shapeOk(r: Record<string, unknown>, t: OpType): boolean {
  const has = (k: string) => r[k] !== undefined;
  if (has('n') && !isB64uLen(r['n'], NONCE_BYTES)) return false;
  if (has('c') && (fromB64u(r['c']) ?? new Uint8Array(0)).length < TAG_BYTES) return false;
  if (has('k') && !isKeyId(r['k'])) return false;
  if (has('x') && parseSealed(r['x']) === undefined) return false;
  if (has('c') !== has('n')) return false;
  // Chain link: logged ops from seq 2 on name their predecessor; seq 1 and ephemeral ops don't.
  const logged = !isEphemeralType(t);
  if (logged && (r['sq'] as number) >= 2 ? !isB64uLen(r['pv'], 32) : has('pv')) return false;
  if (isControlType(t)) {
    // Clear body; optional group-encrypted labels; no audience/priority/ttl/sealing.
    if (!isRecord(r['b'])) return false;
    if (has('aud') || has('pr') || has('ttl') || has('x')) return false;
    if (has('c') !== has('k')) return false;
    return Number.isSafeInteger(r['sq']) && (r['sq'] as number) >= 1;
  }
  // Data and ephemeral: encrypted body, exactly one of k / x.
  if (has('b') || !has('c') || has('k') === has('x')) return false;
  if (has('aud')) {
    // Only the canonical (sorted, unique) spelling is accepted: one op, one encoding.
    const aud = parseAudience(r['aud']);
    if (aud === undefined || canonicalize(aud) !== canonicalize(r['aud'])) return false;
  }
  if (
    has('pr') &&
    (t !== 'msg' || !(PRIORITIES as readonly unknown[]).includes(r['pr']) || r['pr'] === 0)
  ) {
    return false;
  }
  if (isEphemeralType(t)) {
    if (r['sq'] !== 0) return false;
    const ttl = r['ttl'];
    return Number.isSafeInteger(ttl) && (ttl as number) >= 1 && (ttl as number) <= MAX_TTL_S;
  }
  if (has('ttl')) return false;
  return Number.isSafeInteger(r['sq']) && (r['sq'] as number) >= 1;
}

export interface CheckContext {
  teamId: string;
  now: number;
  maxFutureMs?: number;
}

/**
 * Stateless admission of one untrusted envelope: shape, size, team, clock
 * skew and signature. Membership/authority is checked later by the fold
 * (`membership.ts`). Total: never throws.
 */
export function checkEnvelope(c: TeamCrypto, raw: unknown, ctx: CheckContext): CheckResult {
  try {
    if (!isRecord(raw)) return { ok: false, reason: 'not-object' };
    if (!hasOnlyKeys(raw, ENVELOPE_KEYS)) return { ok: false, reason: 'unknown-field' };
    if (raw['v'] !== PROTOCOL_VERSION) return { ok: false, reason: 'version' };
    if (!isTeamId(raw['tm']) || raw['tm'] !== ctx.teamId) return { ok: false, reason: 'team' };
    const pub = memberPublicKey(raw['au']);
    if (pub === undefined) return { ok: false, reason: 'author' };
    if (
      !Number.isSafeInteger(raw['sq']) ||
      (raw['sq'] as number) < 0 ||
      (raw['sq'] as number) > MAX_SEQ
    ) {
      return { ok: false, reason: 'seq' };
    }
    const hlc = parseHlc(raw['hc']);
    if (hlc === undefined) return { ok: false, reason: 'clock' };
    if (isTooFarAhead(hlc, ctx.now, ctx.maxFutureMs)) return { ok: false, reason: 'clock-skew' };
    const t = raw['t'];
    if (typeof t !== 'string' || !(OP_TYPES as readonly string[]).includes(t)) {
      return { ok: false, reason: 'type' };
    }
    const type = t as OpType;
    if (!shapeOk(raw, type)) return { ok: false, reason: 'shape' };
    const text = canonicalize(raw);
    if (text === undefined) return { ok: false, reason: 'shape' };
    const bytes = utf8(text).length;
    if (bytes > MAX_OP_BYTES[type]) return { ok: false, reason: 'too-large' };
    const env = raw as unknown as Envelope;
    const msg = signingBytes(env);
    if (!safeVerify(c, fromB64uLen(env.sg, SIG_BYTES), msg, pub)) {
      return { ok: false, reason: 'signature' };
    }
    return {
      ok: true,
      op: { env, id: opIdOf(c, msg), stamp: { ...hlc, author: env.au }, bytes },
    };
  } catch {
    return { ok: false, reason: 'shape' };
  }
}

// ── Building ────────────────────────────────────────────────────────────────

export interface Author {
  keys: DeviceKeys;
  teamId: string;
}

export type Encryption =
  | { mode: 'group'; keyId: string; key: Uint8Array }
  | { mode: 'sealed'; recipients: readonly { id: string; boxPublic: Uint8Array }[] };

export interface OpDraft {
  t: OpType;
  sq: number;
  /** Id of this author's previous logged op (required from sq 2). */
  pv?: string;
  hlc: Hlc;
  /** Clear body (control ops). */
  b?: Json;
  /** Encrypted body (data/ephemeral ops) or encrypted labels (control ops). */
  secret?: Json;
  enc?: Encryption;
  aud?: Audience;
  pr?: Priority;
  ttl?: number;
}

function sealedKey(
  c: TeamCrypto,
  teamId: string,
  shared: Uint8Array,
  epk: Uint8Array,
  recipient: string,
): Uint8Array {
  return derive(c, shared, utf8(teamId), 'seal', concatBytes(epk, utf8(recipient)));
}

const ZERO_NONCE = new Uint8Array(NONCE_BYTES);

/**
 * Key separation: the epoch key itself never encrypts; payloads use a
 * derived subkey (later uses, e.g. Nostr tags, derive their own label).
 */
export function payloadKey(c: TeamCrypto, teamId: string, epochKey: Uint8Array): Uint8Array {
  return derive(c, epochKey, utf8(teamId), 'payload');
}

/** Key commitment for sealed ops: binds the header to one content key. */
function cekCommitment(c: TeamCrypto, teamId: string, cek: Uint8Array): string {
  return toB64u(derive(c, cek, utf8(teamId), 'commit'));
}

/**
 * Build and sign an envelope. Throws only on programmer error (a draft the
 * protocol would reject), never on peer input — this runs on our own data.
 */
export function buildOp(c: TeamCrypto, author: Author, draft: OpDraft): SignedOp {
  const env: Partial<Envelope> = {
    v: 1,
    tm: author.teamId,
    au: memberIdOf(author.keys.signPublic),
    sq: draft.sq,
    ...(draft.pv !== undefined ? { pv: draft.pv } : {}),
    hc: hlcToWire(draft.hlc),
    t: draft.t,
  };
  if (draft.b !== undefined) env.b = draft.b;
  if (draft.aud !== undefined) env.aud = draft.aud;
  if (draft.pr !== undefined && draft.pr !== 0) env.pr = draft.pr;
  if (draft.ttl !== undefined) env.ttl = draft.ttl;
  if (draft.secret !== undefined) {
    const enc = draft.enc;
    if (enc === undefined) throw new Error('secret payload needs an encryption mode');
    let cek: Uint8Array;
    if (enc.mode === 'group') {
      env.k = enc.keyId;
      cek = payloadKey(c, author.teamId, enc.key);
    } else {
      cek = c.randomBytes(KEY_BYTES);
      const esk = c.randomBytes(KEY_BYTES);
      const epk = c.x25519.publicKey(esk);
      const recipients = [...enc.recipients].sort((a, b) => (a.id < b.id ? -1 : 1));
      const w: [string, string][] = recipients.map((r) => {
        const shared = safeShared(c, esk, r.boxPublic);
        if (shared === undefined) throw new Error('bad recipient key');
        const kek = sealedKey(c, author.teamId, shared, epk, r.id);
        return [r.id, toB64u(c.aead.seal(kek, ZERO_NONCE, cek, utf8(r.id)))];
      });
      env.x = { e: toB64u(epk), w, cc: cekCommitment(c, author.teamId, cek) };
    }
    const nonce = c.randomBytes(NONCE_BYTES);
    env.n = toB64u(nonce);
    const plaintext = utf8(canonicalize(draft.secret)!);
    env.c = toB64u(c.aead.seal(cek, nonce, plaintext, aadBytes(env)));
  }
  const unsigned = env as Unsigned;
  const msg = signingBytes(unsigned);
  const full: Envelope = { ...unsigned, sg: toB64u(c.ed25519.sign(msg, author.keys.signSecret)) };
  const bytes = utf8(canonicalize(full)!).length;
  return {
    env: full,
    id: opIdOf(c, msg),
    stamp: { ...draft.hlc, author: full.au },
    bytes,
  };
}

/** Looks up a team key by id (the local keyring). */
export type KeyLookup = (keyId: string) => Uint8Array | undefined;

/**
 * Decrypt an envelope's `c`. Group mode needs the key in `keyring`; sealed
 * mode needs `me` to be a listed recipient. Total: `undefined` on any failure
 * (missing key, not a recipient, tampered bytes, non-JSON plaintext).
 */
export function openPayload(
  c: TeamCrypto,
  env: Envelope,
  keyring: KeyLookup,
  me?: { id: string; boxSecret: Uint8Array },
): Json | undefined {
  try {
    if (env.c === undefined) return undefined;
    let cek: Uint8Array | undefined;
    if (env.k !== undefined) {
      const key = keyring(env.k);
      cek = key === undefined ? undefined : payloadKey(c, env.tm, key);
    } else if (env.x !== undefined && me !== undefined) {
      const entry = env.x.w.find(([id]) => id === me.id);
      const epk = fromB64uLen(env.x.e, KEY_BYTES);
      if (entry === undefined || epk === undefined) return undefined;
      const shared = safeShared(c, me.boxSecret, epk);
      if (shared === undefined) return undefined;
      const kek = sealedKey(c, env.tm, shared, epk, me.id);
      cek = safeOpen(c, kek, ZERO_NONCE, fromB64u(entry[1]), utf8(me.id));
      // A recipient-specific key that doesn't match the header's commitment is refused.
      if (cek === undefined || cekCommitment(c, env.tm, cek) !== env.x.cc) return undefined;
    }
    if (cek?.length !== KEY_BYTES) return undefined;
    const plain = safeOpen(c, cek, fromB64u(env.n), fromB64u(env.c), aadBytes(env));
    if (plain === undefined) return undefined;
    const text = utf8Decode(plain);
    return text === undefined ? undefined : parseJson(text);
  } catch {
    return undefined;
  }
}

/** Expiry instant of an ephemeral op (ms), or `undefined` for logged ops. */
export function expiresAt(env: Envelope): number | undefined {
  return env.ttl === undefined ? undefined : env.hc[0] + env.ttl * 1000;
}
