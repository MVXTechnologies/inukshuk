import { createInvite } from './actions';
import {
  decodeInvite,
  DEFAULT_INVITE_BASE,
  encodeInvite,
  inviteIdOf,
  inviteLink,
  makeJoinProof,
  parseInviteText,
  parseJoinProof,
  verifyJoinProof,
  type InviteToken,
} from './invite';
import { c, DAY, device, T0 } from './testing/fixtures';
import { forAll, int } from './testing/prop';

const teamId = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('invite token', () => {
  const inv = createInvite(c, teamId, {
    expiresAt: T0 + 2 * DAY + 123,
    maxUses: 1,
    role: 'member',
  });

  it('fits a single SMS segment as a link', () => {
    const sms = inviteLink(inv.encode('sms'));
    expect(inv.encode('sms')).toHaveLength(51);
    expect(sms.length).toBeLessThanOrEqual(160);
    expect(sms.startsWith(`${DEFAULT_INVITE_BASE}#`)).toBe(true);
  });

  it('round-trips through every textual form', () => {
    const payload = inv.encode('link');
    for (const text of [
      payload,
      inviteLink(payload),
      `inukshuk://team/join#${payload}`,
      `  ${payload}\n`,
    ]) {
      const t = parseInviteText(text)!;
      expect(t.teamId).toBe(teamId);
      expect(t.seed).toEqual(inv.token.seed);
      expect(t.expiresAt).toBe(Math.floor((T0 + 2 * DAY + 123) / 1000) * 1000);
      expect(t.net).toBeUndefined();
    }
    expect(inviteIdOf(c, decodeInvite(payload)!)).toBe((inv.body as { inv: string }).inv);
  });

  it('only a QR carries the network hint', () => {
    const token: InviteToken = {
      ...inv.token,
      net: { host: [192, 168, 49, 1], port: 7777, ssid: 'DIRECT-Inukshuk', pass: 'hunter22' },
    };
    expect(decodeInvite(encodeInvite(token, 'qr'))?.net).toEqual(token.net);
    expect(decodeInvite(encodeInvite(token, 'sms'))?.net).toBeUndefined();
    const bare: InviteToken = { ...inv.token, net: { host: [10, 0, 0, 2], port: 1 } };
    expect(decodeInvite(encodeInvite(bare, 'qr'))?.net).toEqual({ host: [10, 0, 0, 2], port: 1 });
  });

  it('decoding is total on garbage and truncation', () => {
    const qr = encodeInvite(
      { ...inv.token, net: { host: [1, 2, 3, 4], port: 9, ssid: 'a', pass: 'b' } },
      'qr',
    );
    expect(parseInviteText('')).toBeUndefined();
    expect(parseInviteText('x'.repeat(600))).toBeUndefined();
    expect(decodeInvite('!!!')).toBeUndefined();
    forAll(
      5,
      200,
      (rnd) => qr.slice(0, int(rnd, 0, qr.length - 1)),
      (cut) => expect(() => decodeInvite(cut)).not.toThrow(),
    );
    const bytes = Buffer.from(qr, 'base64url');
    const version2 = Buffer.from(bytes);
    version2[0] = 2;
    expect(decodeInvite(version2.toString('base64url'))).toBeUndefined();
    const flags = Buffer.from(bytes);
    flags[1] = 0x82;
    expect(decodeInvite(flags.toString('base64url'))).toBeUndefined();
    const trailing = Buffer.concat([Buffer.from(inv.encode('sms'), 'base64url'), Buffer.from([0])]);
    expect(decodeInvite(trailing.toString('base64url'))).toBeUndefined();
    const zeroPort = Buffer.from(
      Buffer.from(
        encodeInvite({ ...inv.token, net: { host: [1, 1, 1, 1], port: 0 } }, 'qr'),
        'base64url',
      ),
    );
    expect(decodeInvite(zeroPort.toString('base64url'))).toBeUndefined();
    const longSsid = Buffer.from(bytes);
    longSsid[38 + 6] = 200;
    expect(decodeInvite(longSsid.toString('base64url'))).toBeUndefined();
  });
});

describe('join proof', () => {
  const inv = createInvite(c, teamId, { expiresAt: T0 + DAY, maxUses: 3, role: 'guest' });
  const joiner = device();
  const proof = makeJoinProof(c, inv.token, joiner.keys);

  it('verifies for this team only', () => {
    expect(parseJoinProof(proof)).toEqual(proof);
    expect(verifyJoinProof(c, teamId, proof)).toBe(true);
    expect(verifyJoinProof(c, 'BBBBBBBBBBBBBBBBBBBBBB', proof)).toBe(false);
  });

  it('cannot be re-pointed at another identity or forged without the seed', () => {
    const other = device();
    expect(verifyJoinProof(c, teamId, { ...proof, m: other.id })).toBe(false);
    expect(verifyJoinProof(c, teamId, { ...proof, x: other.x })).toBe(false);
    const noSeed = makeJoinProof(c, { ...inv.token, seed: c.randomBytes(16) }, joiner.keys);
    expect(verifyJoinProof(c, teamId, { ...noSeed, inv: proof.inv })).toBe(false);
  });

  it('parse rejects malformed proofs', () => {
    expect(parseJoinProof(null)).toBeUndefined();
    expect(parseJoinProof({ ...proof, m: 'x' })).toBeUndefined();
    expect(parseJoinProof({ ...proof, x: 'x' })).toBeUndefined();
    expect(parseJoinProof({ ...proof, ip: 'x' })).toBeUndefined();
  });
});
