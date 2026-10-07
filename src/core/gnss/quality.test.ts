import {
  accuracyOf,
  correctionHealth,
  CORR_STALE_S,
  decideSource,
  horizontal95,
  INITIAL_STATUS,
  K95_2D,
  kindFromGga,
  kindFromMode,
  kindFromUbx,
  MIN_SWITCH_MS,
  nextStatus,
  stateOf,
  STREAM_LOST_MS,
  STREAM_STALE_MS,
  usesCorrections,
  type ExternalStatus,
  type FixKind,
} from './quality';

describe('fix kinds', () => {
  it('maps every GGA quality indicator', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(kindFromGga)).toEqual([
      'none',
      'autonomous',
      'dgps',
      'autonomous',
      'rtk-fixed',
      'rtk-float',
      'dr',
      'manual',
      'simulated',
      'sbas',
      'none',
    ]);
  });

  it('uses the RMC mode letter only to correct a stale GGA 2', () => {
    expect(kindFromMode('R', 'dgps')).toBe('rtk-fixed');
    expect(kindFromMode('F', 'dgps')).toBe('rtk-float');
    expect(kindFromMode('D', 'dgps')).toBe('dgps');
    expect(kindFromMode(null, 'dgps')).toBe('dgps');
    expect(kindFromMode('R', 'autonomous')).toBe('autonomous');
  });

  it('maps UBX NAV-PVT fix type and carrier solution', () => {
    const k = (fixType: number, gnssFixOk = true, diffSoln = false, carrSoln = 0) =>
      kindFromUbx({ fixType, gnssFixOk, diffSoln, carrSoln });
    expect(k(3, false)).toBe('none');
    expect(k(0)).toBe('none');
    expect(k(5)).toBe('none');
    expect(k(1)).toBe('dr');
    expect(k(3, true, true, 2)).toBe('rtk-fixed');
    expect(k(3, true, true, 1)).toBe('rtk-float');
    expect(k(3, true, true)).toBe('dgps');
    expect(k(2)).toBe('autonomous');
    expect(k(4)).toBe('autonomous');
  });

  it('folds kinds into the five chip states', () => {
    const all: FixKind[] = [
      'none',
      'autonomous',
      'sbas',
      'dgps',
      'rtk-float',
      'rtk-fixed',
      'dr',
      'manual',
      'simulated',
    ];
    expect(all.map(stateOf)).toEqual([
      'no-fix',
      'autonomous',
      'dgps',
      'dgps',
      'float',
      'fixed',
      'autonomous',
      'no-fix',
      'no-fix',
    ]);
    expect(all.filter(usesCorrections)).toEqual(['dgps', 'rtk-float', 'rtk-fixed']);
  });
});

describe('accuracy', () => {
  it('95 % radius from per-axis σ; vertical 1.96σ', () => {
    expect(horizontal95(0.01, 0.01)).toBeCloseTo(0.024477, 6);
    expect(
      accuracyOf({ kind: 'rtk-fixed', sigmaLat: 0.01, sigmaLon: 0.01, sigmaV: 0.02, hdop: 0.7 }),
    ).toEqual({
      h95: expect.closeTo(0.024477, 6),
      v95: expect.closeTo(0.0392, 6),
      basis: 'receiver',
    });
    expect(
      accuracyOf({ kind: 'rtk-fixed', sigmaLat: 0.01, sigmaLon: 0.02, sigmaV: null, hdop: null })
        ?.v95,
    ).toBeNull();
  });

  it('falls back to HDOP × UERE, labelled', () => {
    expect(
      accuracyOf({ kind: 'autonomous', sigmaLat: null, sigmaLon: null, sigmaV: null, hdop: 1 }),
    ).toEqual({ h95: K95_2D * 4, v95: null, basis: 'hdop' });
    expect(
      accuracyOf({ kind: 'autonomous', sigmaLat: 1, sigmaLon: null, sigmaV: null, hdop: null }),
    ).toBeNull();
    expect(
      accuracyOf({ kind: 'none', sigmaLat: null, sigmaLon: null, sigmaV: null, hdop: 1 }),
    ).toBeNull();
  });
});

describe('quality state machine', () => {
  const at = (kind: FixKind, t: number, age: number | null = 1) => ({
    kind,
    correctionAgeS: age,
    receivedAtMs: t,
  });

  it('follows the fix, then goes stale and lost without data', () => {
    let s = nextStatus(INITIAL_STATUS, at('rtk-fixed', 1000), 1000);
    expect(s).toMatchObject({ state: 'fixed', freshness: 'live', correction: 'ok', sinceMs: 1000 });
    s = nextStatus(s, null, 1000 + STREAM_STALE_MS);
    expect(s).toMatchObject({ state: 'fixed', freshness: 'stale', sinceMs: 1000 });
    s = nextStatus(s, null, 1000 + STREAM_LOST_MS);
    expect(s).toMatchObject({ state: 'no-fix', freshness: 'lost', sinceMs: 1000 + STREAM_LOST_MS });
    s = nextStatus(s, at('rtk-float', 9000), 9000);
    expect(s).toMatchObject({ state: 'float', freshness: 'live', sinceMs: 9000 });
  });

  it('caps a "fixed" claim at float once corrections are stale', () => {
    let s: ExternalStatus = nextStatus(INITIAL_STATUS, at('rtk-fixed', 0, 30), 0);
    expect(s).toMatchObject({ state: 'fixed', correction: 'aging' });
    s = nextStatus(s, at('rtk-fixed', 100, CORR_STALE_S + 1), 100);
    expect(s).toMatchObject({ state: 'float', reportedState: 'fixed', correction: 'stale' });
  });

  it('correction health by kind and age', () => {
    expect(correctionHealth('autonomous', 5)).toBe('none');
    expect(correctionHealth('rtk-fixed', null)).toBe('ok');
    expect(correctionHealth('rtk-fixed', 10)).toBe('ok');
    expect(correctionHealth('rtk-fixed', 11)).toBe('aging');
    expect(correctionHealth('dgps', 61)).toBe('stale');
  });

  it('a timer tick before any fix stays lost', () => {
    expect(nextStatus(INITIAL_STATUS, null, 5)).toMatchObject({
      state: 'no-fix',
      freshness: 'lost',
      sinceMs: 0,
    });
  });
});

describe('source policy (phone GPS in low-power standby)', () => {
  const live = (
    state: ExternalStatus['state'],
    freshness: ExternalStatus['freshness'] = 'live',
  ): ExternalStatus => ({ ...INITIAL_STATUS, state, freshness });
  const base = {
    current: 'external' as const,
    lastSwitchAtMs: null,
    nowMs: 10_000,
    externalOnly: false,
  };

  it('good receiver → external, phone standby (off when "external only")', () => {
    expect(decideSource({ ...base, external: live('fixed') })).toEqual({
      use: 'external',
      phone: 'standby',
      reason: 'receiver-ok',
      switched: false,
    });
    expect(
      decideSource({ ...base, external: live('autonomous'), externalOnly: true }),
    ).toMatchObject({ phone: 'off' });
  });

  it('stale → keep external but warm the phone up; lost / no fix → phone', () => {
    expect(decideSource({ ...base, external: live('fixed', 'stale') })).toMatchObject({
      use: 'external',
      phone: 'active',
      reason: 'receiver-stale',
    });
    expect(decideSource({ ...base, external: live('no-fix', 'lost') })).toEqual({
      use: 'phone',
      phone: 'active',
      reason: 'receiver-lost',
      switched: true,
    });
    expect(decideSource({ ...base, external: live('no-fix') })).toMatchObject({
      use: 'phone',
      reason: 'receiver-no-fix',
      switched: true,
    });
    expect(decideSource({ ...base, current: 'phone', external: null })).toEqual({
      use: 'phone',
      phone: 'active',
      reason: 'no-receiver',
      switched: false,
    });
  });

  it('never switches twice within MIN_SWITCH_MS, except to the phone with no receiver', () => {
    const recent = {
      ...base,
      current: 'phone' as const,
      lastSwitchAtMs: 10_000 - MIN_SWITCH_MS + 1,
    };
    expect(decideSource({ ...recent, external: live('fixed') })).toEqual({
      use: 'phone',
      phone: 'active',
      reason: 'hold',
      switched: false,
    });
    expect(
      decideSource({ ...recent, lastSwitchAtMs: 10_000 - MIN_SWITCH_MS, external: live('fixed') }),
    ).toMatchObject({ use: 'external', switched: true });
    expect(decideSource({ ...base, lastSwitchAtMs: 9_999, external: null })).toMatchObject({
      use: 'phone',
      switched: true,
    });
  });
});
