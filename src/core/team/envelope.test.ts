import { toB64u } from './bytes';
import { canonicalize } from './canonical';
import { generateDeviceKeys, safeOpen, safeShared, safeVerify } from './crypto';
import {
  aadBytes,
  buildOp,
  checkEnvelope,
  expiresAt,
  MAX_OP_BYTES,
  openPayload,
  type Envelope,
} from './envelope';
import { isMemberId, memberIdOf, safetyCode } from './ids';
import { newTeamKey } from './keys';
import { c, DAY, device, HOUR, T0 } from './testing/fixtures';
import { forAll, int, pick } from './testing/prop';

const teamId = 'AAAAAAAAAAAAAAAAAAAAAA';
const author = { keys: generateDeviceKeys(c), teamId };
const key = newTeamKey(c);
const group = { mode: 'group' as const, ...key };
const keyring = (k: string) => (k === key.keyId ? key.key : undefined);
const ctx = { teamId, now: T0 };
const hlc = { wall: T0, counter: 0 };

const msgOp = (extra: Partial<Parameters<typeof buildOp>[2]> = {}) =>
  buildOp(c, author, {
    t: 'msg',
    sq: 1,
    hlc,
    secret: { id: 'a', th: 'team', tx: 'hi' },
    enc: group,
    ...extra,
  });

describe('build → check → open', () => {
  it('round-trips a group-encrypted op', () => {
    const op = msgOp({ aud: { g: ['sar'] }, pr: 1 });
    const check = checkEnvelope(c, op.env, ctx);
    expect(check.ok && check.op.id).toBe(op.id);
    expect(openPayload(c, op.env, keyring)).toEqual({ id: 'a', th: 'team', tx: 'hi' });
    expect(openPayload(c, op.env, () => undefined)).toBeUndefined();
    expect(op.bytes).toBe(new TextEncoder().encode(canonicalize(op.env)!).length);
  });

  it('round-trips a sealed op only for its recipients', () => {
    const bob = device();
    const eve = device();
    const op = buildOp(c, author, {
      t: 'msg',
      sq: 2,
      hlc,
      secret: { id: 'd', th: `dm:${bob.id}`, tx: 'psst' },
      enc: { mode: 'sealed', recipients: [{ id: bob.id, boxPublic: bob.keys.boxPublic }] },
    });
    expect(checkEnvelope(c, op.env, ctx).ok).toBe(true);
    expect(
      openPayload(c, op.env, keyring, { id: bob.id, boxSecret: bob.keys.boxSecret }),
    ).toMatchObject({ tx: 'psst' });
    expect(
      openPayload(c, op.env, keyring, { id: eve.id, boxSecret: eve.keys.boxSecret }),
    ).toBeUndefined();
    // Eve copying Bob's slot under her own id still fails (the wrap is bound to Bob's id and key).
    const stolen: Envelope = {
      ...op.env,
      x: { e: op.env.x!.e, w: [[eve.id, op.env.x!.w[0]![1]]] },
    };
    expect(
      openPayload(c, stolen, keyring, { id: eve.id, boxSecret: eve.keys.boxSecret }),
    ).toBeUndefined();
    expect(openPayload(c, op.env, keyring)).toBeUndefined();
  });

  it('ephemeral ops carry a TTL and seq 0', () => {
    const op = buildOp(c, author, {
      t: 'pos',
      sq: 0,
      hlc,
      ttl: 3600,
      secret: { la: 1, lo: 2, at: T0 },
      enc: group,
    });
    expect(checkEnvelope(c, op.env, ctx).ok).toBe(true);
    expect(expiresAt(op.env)).toBe(T0 + HOUR);
    expect(expiresAt(msgOp().env)).toBeUndefined();
  });

  it('control ops carry a clear body and optional encrypted labels', () => {
    const op = buildOp(c, author, {
      t: 'g.set',
      sq: 3,
      hlc,
      b: { id: 'sar' },
      secret: { name: 'SAR' },
      enc: group,
    });
    expect(checkEnvelope(c, op.env, ctx).ok).toBe(true);
    expect(openPayload(c, op.env, keyring)).toEqual({ name: 'SAR' });
  });

  it('refuses to build an encrypted payload without an encryption mode', () => {
    expect(() => buildOp(c, author, { t: 'msg', sq: 1, hlc, secret: {} })).toThrow();
  });
});

describe('adversarial envelopes are rejected, never thrown', () => {
  const good = msgOp().env;
  const bad = (patch: Record<string, unknown>) => checkEnvelope(c, { ...good, ...patch }, ctx);
  const why = (r: ReturnType<typeof checkEnvelope>) => (r.ok ? 'ok' : r.reason);

  it('forged or altered signatures', () => {
    const other = generateDeviceKeys(c);
    expect(why(bad({ au: memberIdOf(other.signPublic) }))).toBe('signature');
    expect(why(bad({ sq: 2 }))).toBe('signature');
    expect(why(bad({ c: toB64u(c.randomBytes(40)) }))).toBe('signature');
    expect(why(bad({ sg: toB64u(new Uint8Array(64)) }))).toBe('signature');
    expect(why(bad({ sg: 'short' }))).toBe('signature');
  });

  it('structure, version, team, clock', () => {
    expect(why(checkEnvelope(c, null, ctx))).toBe('not-object');
    expect(why(checkEnvelope(c, [], ctx))).toBe('not-object');
    expect(why(bad({ extra: 1 }))).toBe('unknown-field');
    expect(why(bad({ v: 2 }))).toBe('version');
    expect(why(checkEnvelope(c, good, { ...ctx, teamId: 'BBBBBBBBBBBBBBBBBBBBBB' }))).toBe('team');
    expect(why(bad({ au: 'x' }))).toBe('author');
    expect(why(bad({ sq: -1 }))).toBe('seq');
    expect(why(bad({ hc: [1, 0] }))).toBe('clock');
    expect(why(bad({ t: 'nope' }))).toBe('type');
  });

  it('clock skew: a stamp more than a day ahead is refused', () => {
    const future = buildOp(c, author, {
      t: 'msg',
      sq: 1,
      hlc: { wall: T0 + 2 * DAY, counter: 0 },
      secret: {},
      enc: group,
    });
    expect(why(checkEnvelope(c, future.env, ctx))).toBe('clock-skew');
    expect(checkEnvelope(c, future.env, { ...ctx, now: T0 + 2 * DAY }).ok).toBe(true);
  });

  it('inconsistent field combinations', () => {
    expect(why(bad({ b: { x: 1 } }))).toBe('shape'); // data op with clear body
    expect(why(bad({ k: undefined }))).toBe('shape'); // no key and no seal
    expect(why(bad({ ttl: 5 }))).toBe('shape'); // ttl on a logged op
    expect(why(bad({ pr: 0 }))).toBe('shape');
    expect(why(bad({ pr: 3 }))).toBe('shape');
    expect(why(bad({ aud: { g: ['b', 'a'] } }))).toBe('shape'); // non-canonical audience
    expect(why(bad({ aud: {} }))).toBe('shape');
    expect(why(bad({ n: 'short' }))).toBe('shape');
    expect(why(bad({ c: 'AA' }))).toBe('shape');
    expect(why(bad({ x: { e: 'x', w: [] } }))).toBe('shape');
    const ctl = buildOp(c, author, { t: 'g.set', sq: 1, hlc, b: { id: 'a' } }).env;
    expect(why(checkEnvelope(c, { ...ctl, aud: { r: ['admin'] } }, ctx))).toBe('shape');
    expect(why(checkEnvelope(c, { ...ctl, sq: 0 }, ctx))).toBe('shape');
    expect(why(checkEnvelope(c, { ...ctl, b: 5 }, ctx))).toBe('shape');
    const pos = buildOp(c, author, { t: 'pos', sq: 0, hlc, ttl: 60, secret: {}, enc: group }).env;
    expect(why(checkEnvelope(c, { ...pos, ttl: 0 }, ctx))).toBe('shape');
    expect(why(checkEnvelope(c, { ...pos, sq: 1 }, ctx))).toBe('shape');
    expect(why(checkEnvelope(c, { ...pos, ttl: 2 * DAY }, ctx))).toBe('shape');
  });

  it('oversized payloads', () => {
    const big = msgOp({ secret: { tx: 'x'.repeat(MAX_OP_BYTES.msg) } });
    expect(why(checkEnvelope(c, big.env, ctx))).toBe('too-large');
  });

  it('fuzz: random mutations of a valid envelope never throw and never pass unless unchanged', () => {
    const fields = Object.keys(good);
    const junk: unknown[] = [null, 0, -1, 1e308, '', 'x', [], {}, [1, 2], { a: 1 }, true, 'AAAA'];
    forAll(
      11,
      400,
      (rnd) => ({ field: pick(rnd, fields), value: pick(rnd, junk), drop: int(rnd, 0, 4) === 0 }),
      ({ field, value, drop }) => {
        const env: Record<string, unknown> = { ...good };
        if (drop) delete env[field];
        else env[field] = value;
        let result: ReturnType<typeof checkEnvelope> | undefined;
        expect(() => (result = checkEnvelope(c, env, ctx))).not.toThrow();
        expect(result!.ok).toBe(false);
      },
    );
  });

  it('tampered ciphertext under a valid signature cannot be opened', () => {
    // A relay cannot re-sign, but a sloppy one could flip bytes in storage.
    const env = { ...good, c: toB64u(c.randomBytes(48)) };
    expect(openPayload(c, env, keyring)).toBeUndefined();
    expect(aadBytes(env)).toEqual(aadBytes({ ...env, sg: 'other' }));
  });
});

describe('crypto wrappers and ids', () => {
  it('safe* helpers turn every failure into a value', () => {
    expect(safeVerify(c, undefined, new Uint8Array(0), undefined)).toBe(false);
    const broken = {
      ...c,
      ed25519: {
        ...c.ed25519,
        verify: () => {
          throw new Error('boom');
        },
      },
    };
    expect(safeVerify(broken, new Uint8Array(64), new Uint8Array(0), new Uint8Array(32))).toBe(
      false,
    );
    expect(safeShared(c, c.randomBytes(32), new Uint8Array(32))).toBeUndefined(); // low-order point
    expect(safeShared(c, c.randomBytes(32), new Uint8Array(3))).toBeUndefined();
    expect(
      safeOpen(c, key.key, new Uint8Array(24), new Uint8Array(3), new Uint8Array(0)),
    ).toBeUndefined();
    expect(
      safeOpen(c, key.key, new Uint8Array(2), new Uint8Array(30), new Uint8Array(0)),
    ).toBeUndefined();
    const throwing = {
      ...c,
      aead: {
        ...c.aead,
        open: () => {
          throw new Error('x');
        },
      },
    };
    expect(
      safeOpen(throwing, key.key, new Uint8Array(24), new Uint8Array(30), new Uint8Array(0)),
    ).toBeUndefined();
  });

  it('safety codes are 6 digits, stable, and differ per key', () => {
    const a = device();
    const code = safetyCode(c, teamId, a.id);
    expect(code).toMatch(/^\d{6}$/);
    expect(safetyCode(c, teamId, a.id)).toBe(code);
    expect(safetyCode(c, teamId, device().id)).not.toBe(code);
    expect(isMemberId(a.id)).toBe(true);
    expect(isMemberId(teamId)).toBe(false);
  });
});
