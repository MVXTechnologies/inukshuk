import {
  dehomogenize,
  identity,
  invert,
  maxAbsDiff,
  multiply,
  perspective,
  rotationX,
  rotationZ,
  scaling,
  transformVec4,
  translation,
  type Mat4,
} from './mat4';
import { rng } from './testUtils';

function randomMat(r: () => number): Mat4 {
  return Array.from({ length: 16 }, () => r() * 4 - 2);
}

describe('mat4 basics', () => {
  it('identity is neutral for multiply', () => {
    const r = rng(1);
    const m = randomMat(r);
    expect(maxAbsDiff(multiply(identity(), m), m)).toBe(0);
    expect(maxAbsDiff(multiply(m, identity()), m)).toBe(0);
  });

  it('is column-major: translation lives in elements 12..14', () => {
    const t = translation(3, 4, 5);
    expect([t[12], t[13], t[14]]).toEqual([3, 4, 5]);
    expect(transformVec4(t, [1, 1, 1, 1])).toEqual([4, 5, 6, 1]);
    expect(transformVec4(t, [1, 1, 1, 0])).toEqual([1, 1, 1, 0]);
  });

  it('scaling scales each axis', () => {
    expect(transformVec4(scaling(2, -1, 0.5), [1, 2, 4, 1])).toEqual([2, -2, 2, 1]);
  });

  it('multiply applies the right operand first', () => {
    const m = multiply(translation(10, 0, 0), scaling(2, 2, 2));
    expect(transformVec4(m, [1, 1, 1, 1])).toEqual([12, 2, 2, 1]);
  });

  it('rotationZ turns +x toward +y', () => {
    const v = transformVec4(rotationZ(Math.PI / 2), [1, 0, 0, 1]);
    expect(v[0]).toBeCloseTo(0, 12);
    expect(v[1]).toBeCloseTo(1, 12);
  });

  it('rotationX turns +y toward +z', () => {
    const v = transformVec4(rotationX(Math.PI / 2), [0, 1, 0, 1]);
    expect(v[1]).toBeCloseTo(0, 12);
    expect(v[2]).toBeCloseTo(1, 12);
  });

  it('a singular matrix has no inverse', () => {
    expect(invert(new Array<number>(16).fill(0))).toBeNull();
    const m = identity();
    m[5] = 0;
    expect(invert(m)).toBeNull();
  });

  it('dehomogenize divides by w and rejects w = 0', () => {
    expect(dehomogenize([2, 4, 6, 2])).toEqual([1, 2, 3]);
    expect(dehomogenize([1, 1, 1, 0])).toBeNull();
  });

  it('perspective maps the near plane to −1 and the far plane to +1', () => {
    const p = perspective(Math.PI / 3, 1.5, 2, 50);
    const near = transformVec4(p, [0, 0, -2, 1]);
    const far = transformVec4(p, [0, 0, -50, 1]);
    expect(near[2] / near[3]).toBeCloseTo(-1, 12);
    expect(far[2] / far[3]).toBeCloseTo(1, 12);
  });
});

describe('mat4 invert round-trips', () => {
  const r = rng(42);
  const mats = Array.from({ length: 40 }, () => randomMat(r));
  it.each(mats.map((m, i) => [i, m] as const))('random matrix #%i', (_i, m) => {
    const inv = invert(m);
    expect(inv).not.toBeNull();
    expect(maxAbsDiff(multiply(m, inv!), identity())).toBeLessThan(1e-9);
    expect(maxAbsDiff(multiply(inv!, m), identity())).toBeLessThan(1e-9);
  });

  it('associativity holds within rounding', () => {
    const a = randomMat(r);
    const b = randomMat(r);
    const c = randomMat(r);
    expect(maxAbsDiff(multiply(multiply(a, b), c), multiply(a, multiply(b, c)))).toBeLessThan(
      1e-12,
    );
  });
});
