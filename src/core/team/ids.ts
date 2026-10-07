import { concatBytes, fromB64uLen, isB64uLen, toB64u, utf8 } from './bytes';
import { KEY_BYTES, label, type TeamCrypto } from './crypto';

/**
 * Identifiers (#589). All are unpadded base64url so they travel in JSON, URLs
 * and QR codes unchanged.
 *
 * - **memberId** = the member device's Ed25519 public key itself (43 chars).
 *   Using the key (not a hash of it) means any peer can verify an op from its
 *   author field alone, with no lookup. A person with two phones is two
 *   members in v1.
 * - **teamId** = 16 bytes of `SHA-256(label ‖ ownerPub ‖ genesisNonce)`
 *   (22 chars). It is bound to the owner key: nobody else can mint a genesis
 *   op for a team id they saw in an invite.
 * - **opId** = SHA-256 of the op's signing bytes (43 chars). Content-addressed,
 *   so the same op relayed by any path dedupes to the same id.
 * - **keyId** = 12 bytes of `SHA-256(label ‖ key)` (16 chars). Names a team key
 *   epoch without revealing it.
 */
export const TEAM_ID_BYTES = 16;
export const KEY_ID_BYTES = 12;

export function memberIdOf(signPublic: Uint8Array): string {
  return toB64u(signPublic);
}

/** The Ed25519 public key a member id encodes, or `undefined` if it is not one. */
export function memberPublicKey(memberId: unknown): Uint8Array | undefined {
  return fromB64uLen(memberId, KEY_BYTES);
}

export function isMemberId(value: unknown): value is string {
  return isB64uLen(value, KEY_BYTES);
}

export function deriveTeamId(c: TeamCrypto, ownerPub: Uint8Array, nonce: Uint8Array): string {
  return toB64u(
    c.sha256(concatBytes(label('team-id'), ownerPub, nonce)).subarray(0, TEAM_ID_BYTES),
  );
}

export function isTeamId(value: unknown): value is string {
  return isB64uLen(value, TEAM_ID_BYTES);
}

export function keyIdOf(c: TeamCrypto, key: Uint8Array): string {
  return toB64u(c.sha256(concatBytes(label('key-id'), key)).subarray(0, KEY_ID_BYTES));
}

export function isKeyId(value: unknown): value is string {
  return isB64uLen(value, KEY_ID_BYTES);
}

export function opIdOf(c: TeamCrypto, signingBytes: Uint8Array): string {
  return toB64u(c.sha256(signingBytes));
}

/** Short ids for groups, entities and messages: 1–64 chars of base64url alphabet. */
export function isShortId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * A 6-digit code both phones show during a join so the people can compare
 * them out loud (Signal-style "safety number", short form). It commits to the
 * team and the joiner's key, so a swapped key shows a different code.
 */
export function safetyCode(c: TeamCrypto, teamId: string, memberId: string): string {
  const h = c.sha256(concatBytes(label('safety'), utf8(`${teamId}|${memberId}`)));
  const n = ((h[0]! << 16) | (h[1]! << 8) | h[2]!) % 1_000_000;
  return n.toString().padStart(6, '0');
}
