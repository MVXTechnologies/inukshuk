/**
 * The LAN discovery tag (#589): what a phone puts in its DNS-SD TXT record so
 * teammates can find it, and nothing else. It is a hash of the team id — never
 * the team's name or its members — so a stranger on the Wi-Fi learns only
 * "some Inukshuk team is here". Anyone who already holds the team id (an
 * invite) can compute it, which is the point: joiners find the team with it.
 *
 * `tag = base64url(SHA-256("inukshuk/team/v1/lan-tag" ‖ teamId))[0..22]`
 * (the first 16 bytes). The hash comes in as a parameter so this stays free
 * of any crypto dependency; the team core's SHA-256 is the one to pass.
 */

export const LAN_TAG_LABEL = 'inukshuk/team/v1/lan-tag';
const TAG_RE = /^[A-Za-z0-9_-]{8,43}$/;
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63);
    if (b !== undefined) out += B64URL.charAt((n >> 6) & 63);
    if (c !== undefined) out += B64URL.charAt(n & 63);
  }
  return out;
}

export function lanDiscoveryTag(teamId: string, sha256: (data: Uint8Array) => Uint8Array): string {
  const data = new TextEncoder().encode(LAN_TAG_LABEL + teamId);
  const digest = sha256(data);
  if (digest.length < 16) throw new Error('sha256 returned too few bytes');
  return base64url(digest.subarray(0, 16));
}

/** The same rule the native module enforces: base64url, 8–43 characters. */
export function isValidMeshTag(tag: string): boolean {
  return TAG_RE.test(tag);
}
