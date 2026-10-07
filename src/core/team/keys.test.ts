import { toB64u } from './bytes';
import { keyIdOf } from './ids';
import { newTeamKey, parseKeyWraps, unwrapKeys, wrapCoverage, wrapKeys } from './keys';
import { c, device } from './testing/fixtures';

const teamId = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('key wraps', () => {
  const alice = device();
  const bob = device();
  const k1 = newTeamKey(c);
  const k2 = newTeamKey(c);
  const targets = [alice, bob].map((d) => ({ memberId: d.id, boxPublic: d.keys.boxPublic }));
  const kw = wrapKeys(c, teamId, [k1, k2], targets);

  it('each recipient unwraps exactly its keys', () => {
    expect(parseKeyWraps(kw)).toBe(kw);
    const got = unwrapKeys(c, teamId, kw, { id: bob.id, boxSecret: bob.keys.boxSecret });
    expect(got.map((k) => k.keyId).sort()).toEqual([k1.keyId, k2.keyId].sort());
    expect(got.find((k) => k.keyId === k1.keyId)?.key).toEqual(k1.key);
    expect(wrapCoverage(kw).members).toEqual(new Set([alice.id, bob.id]));
    expect(keyIdOf(c, k1.key)).toBe(k1.keyId);
  });

  it('outsiders, other teams and swapped slots get nothing', () => {
    const eve = device();
    expect(unwrapKeys(c, teamId, kw, { id: eve.id, boxSecret: eve.keys.boxSecret })).toEqual([]);
    expect(
      unwrapKeys(c, 'BBBBBBBBBBBBBBBBBBBBBB', kw, { id: bob.id, boxSecret: bob.keys.boxSecret }),
    ).toEqual([]);
    // Eve relabels Alice's slot as hers: the KEK is bound to the id, so it fails.
    const relabelled = {
      ...kw,
      w: kw.w.map(([m, k, w]) => [m === alice.id ? eve.id : m, k, w]),
    } as typeof kw;
    expect(
      unwrapKeys(c, teamId, relabelled, { id: eve.id, boxSecret: eve.keys.boxSecret }),
    ).toEqual([]);
    // Bad ephemeral key.
    expect(
      unwrapKeys(
        c,
        teamId,
        { ...kw, e: toB64u(new Uint8Array(32)) },
        { id: bob.id, boxSecret: bob.keys.boxSecret },
      ),
    ).toEqual([]);
    expect(
      unwrapKeys(c, teamId, { ...kw, e: 'x' }, { id: bob.id, boxSecret: bob.keys.boxSecret }),
    ).toEqual([]);
  });

  it('a wrap whose plaintext does not match its key id is ignored (bad admin)', () => {
    const liar = wrapKeys(c, teamId, [{ keyId: k1.keyId, key: k2.key }], [targets[1]!]);
    expect(unwrapKeys(c, teamId, liar, { id: bob.id, boxSecret: bob.keys.boxSecret })).toEqual([]);
  });

  it('parse refuses unsorted, duplicate, oversized or malformed wrap sets', () => {
    expect(parseKeyWraps({ ...kw, w: [...kw.w].reverse() })).toBeUndefined();
    expect(parseKeyWraps({ ...kw, w: [kw.w[0], kw.w[0]] })).toBeUndefined();
    expect(parseKeyWraps({ ...kw, w: [] })).toBeUndefined();
    expect(parseKeyWraps({ ...kw, w: [['x', 'y', 'z']] })).toBeUndefined();
    expect(parseKeyWraps({ ...kw, w: [[alice.id, k1.keyId]] })).toBeUndefined();
    expect(parseKeyWraps({ ...kw, extra: 1 })).toBeUndefined();
    expect(parseKeyWraps({ ...kw, e: 'bad' })).toBeUndefined();
    expect(parseKeyWraps(null)).toBeUndefined();
    expect(parseKeyWraps({ ...kw, w: 'x' })).toBeUndefined();
  });

  it('refuses to wrap for an invalid X25519 key', () => {
    expect(() =>
      wrapKeys(c, teamId, [k1], [{ memberId: alice.id, boxPublic: new Uint8Array(32) }]),
    ).toThrow();
  });
});
