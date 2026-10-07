import { createHash } from 'crypto';

import { base64url, isValidMeshTag, LAN_TAG_LABEL, lanDiscoveryTag } from './tag';

const sha256 = (d: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(d).digest());

describe('base64url', () => {
  it('matches Node for every tail length', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 16, 32]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) % 256);
      expect(base64url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });
});

describe('lanDiscoveryTag', () => {
  it('is the first 16 bytes of the labelled SHA-256, base64url', () => {
    const teamId = 'AbCdEfGhIjKlMnOpQrStUv';
    const expected = createHash('sha256')
      .update(LAN_TAG_LABEL + teamId)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    const tag = lanDiscoveryTag(teamId, sha256);
    expect(tag).toBe(expected);
    expect(tag).toHaveLength(22);
    expect(isValidMeshTag(tag)).toBe(true);
    expect(tag).not.toContain(teamId);
  });

  it('differs per team and refuses a short hash', () => {
    expect(lanDiscoveryTag('team-a', sha256)).not.toBe(lanDiscoveryTag('team-b', sha256));
    expect(() => lanDiscoveryTag('t', () => new Uint8Array(8))).toThrow();
  });
});

describe('isValidMeshTag', () => {
  it('accepts base64url of 8 to 43 characters only', () => {
    expect(isValidMeshTag('abcdEFGH_-12')).toBe(true);
    expect(isValidMeshTag('short')).toBe(false);
    expect(isValidMeshTag('a'.repeat(44))).toBe(false);
    expect(isValidMeshTag('My Team Name')).toBe(false);
    expect(isValidMeshTag('abcdefgh=,')).toBe(false);
  });
});
