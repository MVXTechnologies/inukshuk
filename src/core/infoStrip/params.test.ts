import { normaliseParams, normaliseTarget, paramsValid, paramValid } from './params';
import type { ParamSchema } from './types';

type P = { mode: 'a' | 'b'; on: boolean; target: null | { kind: 'navTarget' } };

const SCHEMA: ParamSchema<P> = {
  mode: {
    kind: 'choice',
    label: 'Mode',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  },
  on: { kind: 'toggle', label: 'On' },
  target: { kind: 'target', label: 'Target' },
};
const DEFAULTS: P = { mode: 'a', on: true, target: null };

describe('normaliseTarget', () => {
  it('keeps every valid target kind', () => {
    expect(normaliseTarget({ kind: 'navTarget', junk: 1 })).toEqual({ kind: 'navTarget' });
    expect(normaliseTarget({ kind: 'nextOnTrail' })).toEqual({ kind: 'nextOnTrail' });
    expect(normaliseTarget({ kind: 'waypoint', waypointId: 'w1' })).toEqual({
      kind: 'waypoint',
      waypointId: 'w1',
    });
    const point = { latitude: 46.8, longitude: -71.2 };
    expect(normaliseTarget({ kind: 'coordinate', point })).toEqual({ kind: 'coordinate', point });
    expect(normaliseTarget({ kind: 'coordinate', point, label: '23A' })).toEqual({
      kind: 'coordinate',
      point,
      label: '23A',
    });
  });

  it('rejects anything else', () => {
    expect(normaliseTarget(null)).toBeNull();
    expect(normaliseTarget([])).toBeNull();
    expect(normaliseTarget({ kind: 'teleport' })).toBeNull();
    expect(normaliseTarget({ kind: 'waypoint', waypointId: '' })).toBeNull();
    expect(normaliseTarget({ kind: 'waypoint' })).toBeNull();
    expect(
      normaliseTarget({ kind: 'coordinate', point: { latitude: 91, longitude: 0 } }),
    ).toBeNull();
    expect(
      normaliseTarget({ kind: 'coordinate', point: { latitude: 0, longitude: 181 } }),
    ).toBeNull();
    expect(
      normaliseTarget({ kind: 'coordinate', point: { latitude: '1', longitude: 0 } }),
    ).toBeNull();
    expect(
      normaliseTarget({ kind: 'coordinate', point: { latitude: 1, longitude: '0' } }),
    ).toBeNull();
    expect(normaliseTarget({ kind: 'coordinate', point: 'here' })).toBeNull();
  });

  it('drops an empty label', () => {
    const point = { latitude: 1, longitude: 2 };
    expect(normaliseTarget({ kind: 'coordinate', point, label: '' })).toEqual({
      kind: 'coordinate',
      point,
    });
  });
});

describe('paramValid / paramsValid', () => {
  it('checks each spec kind', () => {
    expect(paramValid(SCHEMA.mode, 'b')).toBe(true);
    expect(paramValid(SCHEMA.mode, 'c')).toBe(false);
    expect(paramValid(SCHEMA.on, false)).toBe(true);
    expect(paramValid(SCHEMA.on, 'false')).toBe(false);
    expect(paramValid(SCHEMA.target, null)).toBe(true);
    expect(paramValid(SCHEMA.target, { kind: 'navTarget' })).toBe(true);
    expect(paramValid(SCHEMA.target, { kind: 'nope' })).toBe(false);
  });

  it('checks a whole params object', () => {
    expect(paramsValid(SCHEMA, DEFAULTS)).toBe(true);
    expect(paramsValid(SCHEMA, { ...DEFAULTS, mode: 'z' })).toBe(false);
    expect(paramsValid(SCHEMA, { mode: 'a', on: true })).toBe(false);
    expect(paramsValid(SCHEMA, null)).toBe(false);
  });
});

describe('normaliseParams', () => {
  it('keeps valid values and replaces bad ones with defaults', () => {
    expect(normaliseParams(SCHEMA, DEFAULTS, { mode: 'b', on: 'yes', target: 3 })).toEqual({
      mode: 'b',
      on: true,
      target: null,
    });
  });

  it('keeps a valid target override, normalised', () => {
    expect(
      normaliseParams(SCHEMA, DEFAULTS, { target: { kind: 'nextOnTrail', extra: true } }).target,
    ).toEqual({ kind: 'nextOnTrail' });
  });

  it('keeps keys it does not know (a newer build wrote them)', () => {
    expect(normaliseParams(SCHEMA, DEFAULTS, { futureKnob: 7 })).toEqual({
      ...DEFAULTS,
      futureKnob: 7,
    });
  });

  it('reads junk as the defaults', () => {
    expect(normaliseParams(SCHEMA, DEFAULTS, 'junk')).toEqual(DEFAULTS);
    expect(normaliseParams(SCHEMA, DEFAULTS, undefined)).toEqual(DEFAULTS);
  });
});
