import { concatBytes, fromB64u, fromB64uLen, isB64uLen, toB64u, utf8 } from './bytes';
import { hasOnlyKeys, isRecord } from './canonical';
import {
  derive,
  KEY_BYTES,
  NONCE_BYTES,
  safeOpen,
  safeShared,
  TAG_BYTES,
  type TeamCrypto,
} from './crypto';
import { isKeyId, isMemberId, keyIdOf } from './ids';

/**
 * Team key epochs (#589).
 *
 * **Scheme (v1): one symmetric team key per epoch, distributed by admins.**
 * Every group-mode op is XChaCha20-Poly1305 under the current epoch key
 * (random 24-byte nonce per op). A key reaches each member as a *wrap*: the
 * admin (or, for `k.share`, any member holding it) draws an ephemeral X25519
 * key `e`, and for each recipient derives `kek = HKDF(X25519(e, memberX),
 * salt=teamId, "wrap" ‖ e ‖ memberId ‖ keyId)` and seals the key under `kek`
 * with a zero nonce (each `kek` is used exactly once). All wraps of one op share
 * `e`, so a rotation for 500 members is ~60 kB in a single signed op.
 *
 * **Why not Signal-style sender keys** (each member has their own chain key and
 * sends it pairwise to everyone): rekeying after a removal is O(n²) pairwise
 * messages that must themselves gossip through an offline mesh, and a joiner
 * cannot read anything from a sender who has not come online since. A single
 * admin-signed rotation op is O(n), arrives with the membership log, and works
 * when the senders are away. The price: no per-message forward secrecy inside
 * an epoch (sender keys with a hash ratchet would give some). Acceptable for
 * trail teams; MLS (RFC 9420) is the upgrade path, see the protocol doc.
 *
 * **Removal ⇒ rotation.** A key whose recipient set includes a removed member is
 * *unsafe*; senders refuse to use it (fail closed) until an admin rotates
 * (`membership.ts` → `needsRotation`). The removed phone keeps what it already
 * decrypted — there is no remote wipe.
 */

export interface TeamKey {
  keyId: string;
  key: Uint8Array;
}

/** `[memberId, keyId, wrappedKey]`. */
export type WrapEntry = [string, string, string];

export interface KeyWraps {
  /** Ephemeral X25519 public key shared by all wraps of this op. */
  e: string;
  /** Sorted by (memberId, keyId), unique. */
  w: WrapEntry[];
}

export const MAX_WRAPS = 1024;

export function newTeamKey(c: TeamCrypto): TeamKey {
  const key = c.randomBytes(KEY_BYTES);
  return { keyId: keyIdOf(c, key), key };
}

const ZERO_NONCE = new Uint8Array(NONCE_BYTES);

function kek(
  c: TeamCrypto,
  teamId: string,
  shared: Uint8Array,
  epk: Uint8Array,
  memberId: string,
  keyId: string,
): Uint8Array {
  return derive(c, shared, utf8(teamId), 'wrap', concatBytes(epk, utf8(`${memberId}|${keyId}`)));
}

export interface WrapTarget {
  memberId: string;
  boxPublic: Uint8Array;
}

/** Wrap each key for each target. Throws only if a target's X25519 key is invalid (our own data). */
export function wrapKeys(
  c: TeamCrypto,
  teamId: string,
  keys: readonly TeamKey[],
  targets: readonly WrapTarget[],
): KeyWraps {
  const esk = c.randomBytes(KEY_BYTES);
  const epk = c.x25519.publicKey(esk);
  const w: WrapEntry[] = [];
  for (const t of targets) {
    const shared = safeShared(c, esk, t.boxPublic);
    if (shared === undefined) throw new Error(`invalid box key for ${t.memberId}`);
    for (const k of keys) {
      const sealed = c.aead.seal(
        kek(c, teamId, shared, epk, t.memberId, k.keyId),
        ZERO_NONCE,
        k.key,
        utf8(`${t.memberId}|${k.keyId}`),
      );
      w.push([t.memberId, k.keyId, toB64u(sealed)]);
    }
  }
  w.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
  return { e: toB64u(epk), w };
}

/** Strict structural parse of a `kw` field (sorted, unique, sized). */
export function parseKeyWraps(value: unknown): KeyWraps | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['e', 'w'])) return undefined;
  if (!isB64uLen(value['e'], KEY_BYTES)) return undefined;
  const w = value['w'];
  if (!Array.isArray(w) || w.length === 0 || w.length > MAX_WRAPS) return undefined;
  let prev = '';
  for (const entry of w as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3) return undefined;
    const [m, k, wrapped] = entry as unknown[];
    if (!isMemberId(m) || !isKeyId(k)) return undefined;
    if (!isB64uLen(wrapped, KEY_BYTES + TAG_BYTES)) return undefined;
    const sortKey = m + k;
    if (sortKey <= prev) return undefined;
    prev = sortKey;
  }
  return value as unknown as KeyWraps;
}

/** The member ids and key ids a wrap set covers (public metadata). */
export function wrapCoverage(kw: KeyWraps): { members: Set<string>; keyIds: Set<string> } {
  return {
    members: new Set(kw.w.map(([m]) => m)),
    keyIds: new Set(kw.w.map(([, k]) => k)),
  };
}

/**
 * Unwrap every key addressed to `me`. A wrap that fails to open, or whose
 * plaintext does not hash to its claimed key id (a buggy or malicious admin),
 * is skipped. Total.
 */
export function unwrapKeys(
  c: TeamCrypto,
  teamId: string,
  kw: KeyWraps,
  me: { id: string; boxSecret: Uint8Array },
): TeamKey[] {
  const epk = fromB64uLen(kw.e, KEY_BYTES);
  if (epk === undefined) return [];
  const shared = safeShared(c, me.boxSecret, epk);
  if (shared === undefined) return [];
  const out: TeamKey[] = [];
  for (const [m, keyId, wrapped] of kw.w) {
    if (m !== me.id) continue;
    const key = safeOpen(
      c,
      kek(c, teamId, shared, epk, m, keyId),
      ZERO_NONCE,
      fromB64u(wrapped),
      utf8(`${m}|${keyId}`),
    );
    if (key?.length === KEY_BYTES && keyIdOf(c, key) === keyId) {
      out.push({ keyId, key });
    }
  }
  return out;
}
