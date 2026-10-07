import { canonicalize, hasOnlyKeys, isRecord, MAX_JSON_DEPTH, parseJson } from './canonical';

describe('canonicalize', () => {
  it('sorts keys, drops undefined members and writes JCS numbers', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'], c: undefined })).toBe(
      '{"a":[true,null,"x"],"b":1}',
    );
    expect(canonicalize({ n: -0, f: 1.5, e: 1e21, s: 'é"\n' })).toBe(
      '{"e":1e+21,"f":1.5,"n":0,"s":"é\\"\\n"}',
    );
    expect(canonicalize(Object.create(null) as object)).toBe('{}');
  });

  it('is independent of key insertion order', () => {
    expect(canonicalize({ x: { b: 2, a: 1 }, y: 0 })).toBe(
      canonicalize({ y: 0, x: { a: 1, b: 2 } }),
    );
  });

  it('refuses non-JSON values', () => {
    for (const bad of [
      NaN,
      Infinity,
      () => 1,
      10n,
      Symbol('s'),
      new Uint8Array(2),
      new Date(0),
      [1, undefined],
    ]) {
      expect(canonicalize(bad)).toBeUndefined();
      expect(canonicalize({ k: bad })).toBeUndefined();
    }
    expect(canonicalize(undefined)).toBeUndefined();
  });

  it('caps nesting depth', () => {
    let deep: unknown = 1;
    for (let i = 0; i <= MAX_JSON_DEPTH; i++) deep = [deep];
    expect(canonicalize(deep)).toBeUndefined();
  });
});

describe('parseJson', () => {
  it('parses valid JSON and refuses invalid or too-deep input', () => {
    expect(parseJson('{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(parseJson('{bad')).toBeUndefined();
    expect(parseJson('['.repeat(40) + ']'.repeat(40))).toBeUndefined();
  });

  it('keeps "__proto__" as an inert own key', () => {
    const v = parseJson('{"__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(isRecord(v)).toBe(true);
  });

  it('record helpers', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(hasOnlyKeys({ a: 1 }, ['a', 'b'])).toBe(true);
    expect(hasOnlyKeys({ c: 1 }, ['a'])).toBe(false);
  });
});
