import {
  chipDetail,
  coordDecimals,
  formatAccuracy,
  formatAge,
  formatHeight,
  formatLatLon,
  kindLabel,
  receiverChip,
  stateLabel,
  type ChipInput,
} from './chip';
import { INITIAL_STATUS, type ExternalStatus, type FixKind } from './quality';
import { fixOf } from './testUtils';

const NOW = 1_800_000_000_000;

function statusOf(over: Partial<ExternalStatus> = {}): ExternalStatus {
  return {
    ...INITIAL_STATUS,
    state: 'fixed',
    reportedState: 'fixed',
    freshness: 'live',
    correction: 'ok',
    correctionAgeS: 1,
    lastFixAtMs: NOW - 500,
    sinceMs: NOW - 60_000,
    ...over,
  };
}

function input(over: Partial<ChipInput> = {}): ChipInput {
  return {
    link: 'connected',
    status: statusOf(),
    fix: fixOf('rtk-fixed'),
    using: 'external',
    phoneAccuracyM: 5,
    fallback: true,
    nowMs: NOW,
    ...over,
  };
}

describe('formatting', () => {
  it('accuracy: cm below 1 m, one decimal below 10 cm and 10 m, ≈ from HDOP', () => {
    expect(formatAccuracy(0.014)).toBe('±1.4 cm');
    expect(formatAccuracy(0)).toBe('±0.1 cm');
    expect(formatAccuracy(0.18)).toBe('±18 cm');
    expect(formatAccuracy(0.6)).toBe('±60 cm');
    expect(formatAccuracy(1.84)).toBe('±1.8 m');
    expect(formatAccuracy(12.4)).toBe('±12 m');
    expect(formatAccuracy(3.1, 'hdop')).toBe('≈±3.1 m');
  });

  it('ages', () => {
    expect(formatAge(-3)).toBe('0 s');
    expect(formatAge(14.9)).toBe('14 s');
    expect(formatAge(125)).toBe('2 min');
    expect(formatAge(7300)).toBe('2 h');
  });

  it('labels every kind and state', () => {
    const kinds: [FixKind, string][] = [
      ['rtk-fixed', 'RTK fixed'],
      ['rtk-float', 'RTK float'],
      ['dgps', 'DGPS'],
      ['sbas', 'SBAS'],
      ['autonomous', 'Receiver'],
      ['dr', 'Dead reckoning'],
      ['none', 'No fix'],
      ['manual', 'No fix'],
    ];
    for (const [k, l] of kinds) expect(kindLabel(k)).toBe(l);
    expect(stateLabel('fixed')).toBe('RTK fixed');
    expect(stateLabel('float')).toBe('RTK float');
    expect(stateLabel('dgps')).toBe('DGPS');
    expect(stateLabel('autonomous')).toBe('Autonomous');
    expect(stateLabel('no-fix')).toBe('No fix');
  });

  it('never shows more decimals than the accuracy supports', () => {
    expect(coordDecimals(null)).toBe(6);
    expect(coordDecimals(0)).toBe(6);
    expect(coordDecimals(0.014)).toBe(8); // 1e-8° ≈ 1.1 mm
    expect(coordDecimals(0.0001)).toBe(9);
    expect(coordDecimals(3)).toBe(6);
    expect(coordDecimals(500)).toBe(5);
    expect(formatLatLon(46.80293147, -71.17740218, 8)).toBe('46.80293147° N, 71.17740218° W');
    expect(formatLatLon(-33.9, 151.2, 5)).toBe('33.90000° S, 151.20000° E');
    expect(formatHeight(62.4183, 0.03)).toBe('62.418 m');
    expect(formatHeight(62.4183, 0.5)).toBe('62.42 m');
    expect(formatHeight(62.4183, 4)).toBe('62.4 m');
    expect(formatHeight(62.4183, null)).toBe('62.4 m');
  });

  it('detail: satellites, and the correction age only for corrected fixes', () => {
    expect(chipDetail(fixOf('rtk-fixed'), statusOf())).toBe('14 sats · corr 1 s');
    expect(chipDetail(fixOf('autonomous'), statusOf())).toBe('14 sats');
    expect(chipDetail(fixOf('dgps', { satsUsed: null }), statusOf())).toBe('corr 1 s');
    expect(chipDetail(fixOf('dgps'), statusOf({ correctionAgeS: null }))).toBe('14 sats');
    expect(chipDetail(null, null)).toBeNull();
  });
});

describe('receiverChip', () => {
  it('connecting', () => {
    expect(receiverChip(input({ link: 'connecting' }))).toMatchObject({
      tone: 'neutral',
      label: 'Connecting to receiver…',
      detail: null,
    });
  });

  it('RTK fixed: green, accuracy in cm, sats and correction age', () => {
    const c = receiverChip(input());
    expect(c).toEqual({
      tone: 'fixed',
      icon: 'receiver',
      label: 'RTK fixed · ±1.4 cm',
      detail: '14 sats · corr 1 s',
      a11y: 'RTK fixed · ±1.4 cm, 14 sats · corr 1 s',
    });
  });

  it('float, DGPS, SBAS and autonomous', () => {
    expect(
      receiverChip(
        input({
          status: statusOf({ state: 'float' }),
          fix: fixOf('rtk-float', { accuracy: { h95: 0.18, v95: null, basis: 'receiver' } }),
        }),
      ),
    ).toMatchObject({ tone: 'float', label: 'RTK float · ±18 cm' });
    expect(
      receiverChip(input({ status: statusOf({ state: 'dgps' }), fix: fixOf('dgps') })),
    ).toMatchObject({ tone: 'dgps', label: 'DGPS · ±1.4 cm' });
    expect(
      receiverChip(input({ status: statusOf({ state: 'dgps' }), fix: fixOf('sbas') })),
    ).toMatchObject({ tone: 'dgps', label: 'SBAS · ±1.4 cm' });
    expect(
      receiverChip(
        input({
          status: statusOf({ state: 'autonomous', correction: 'none' }),
          fix: fixOf('autonomous', { accuracy: { h95: 1.8, v95: null, basis: 'hdop' } }),
        }),
      ),
    ).toMatchObject({ tone: 'neutral', label: 'Receiver · ≈±1.8 m', detail: '14 sats' });
  });

  it('no accuracy claimed: the state alone', () => {
    expect(receiverChip(input({ fix: fixOf('rtk-fixed', { accuracy: null }) })).label).toBe(
      'RTK fixed',
    );
    expect(receiverChip(input({ fix: null })).label).toBe('RTK fixed');
  });

  it('corrections stopped: amber, with their age', () => {
    expect(
      receiverChip(input({ status: statusOf({ correction: 'aging', correctionAgeS: 14 }) })),
    ).toMatchObject({ tone: 'warn', label: 'Corrections lost 14 s · ±1.4 cm', detail: '14 sats' });
    expect(
      receiverChip(
        input({
          status: statusOf({ state: 'float', correction: 'stale', correctionAgeS: 75 }),
          fix: fixOf('rtk-fixed', { satsUsed: null }),
        }),
      ),
    ).toMatchObject({ tone: 'warn', label: 'Corrections lost 1 min · ±1.4 cm', detail: null });
    // A status that can't say how old: the state's own chip.
    expect(
      receiverChip(input({ status: statusOf({ correction: 'aging', correctionAgeS: null }) })).tone,
    ).toBe('fixed');
  });

  it('a receiver silent for 2–5 s: amber "Receiver silent"', () => {
    expect(
      receiverChip(input({ status: statusOf({ freshness: 'stale', lastFixAtMs: NOW - 3000 }) })),
    ).toMatchObject({ tone: 'warn', label: 'Receiver silent 3 s · ±1.4 cm' });
    expect(
      receiverChip(input({ status: statusOf({ freshness: 'stale', lastFixAtMs: null }) })).label,
    ).toBe('Receiver silent · ±1.4 cm');
  });

  it('connected but no fix yet', () => {
    expect(
      receiverChip(
        input({ status: statusOf({ state: 'no-fix' }), fix: fixOf('none', { satsUsed: 3 }) }),
      ),
    ).toMatchObject({ tone: 'neutral', label: 'Receiver · no fix', detail: '3 sats' });
  });

  it('fell back to the phone: amber, says so', () => {
    expect(
      receiverChip(input({ using: 'phone', link: 'reconnecting', status: statusOf() })),
    ).toMatchObject({ tone: 'warn', icon: 'phone', label: 'Phone GPS ±5 m · receiver off' });
    expect(receiverChip(input({ using: 'phone', phoneAccuracyM: null, status: null })).label).toBe(
      'Phone GPS · receiver off',
    );
    expect(
      receiverChip(input({ using: 'phone', status: statusOf({ state: 'no-fix' }) })).label,
    ).toBe('Phone GPS ±5 m · receiver has no fix');
  });

  it('lost with no fallback, or gone while still the source: red, with how long', () => {
    expect(
      receiverChip(
        input({
          using: 'phone',
          fallback: false,
          link: 'disconnected',
          status: statusOf({ freshness: 'lost', lastFixAtMs: NOW - 61_000 }),
        }),
      ),
    ).toMatchObject({ tone: 'lost', icon: 'receiver-off', label: 'Receiver lost · 1 min' });
    expect(receiverChip(input({ using: 'phone', fallback: false, status: null })).label).toBe(
      'Receiver lost',
    );
    expect(
      receiverChip(input({ status: statusOf({ freshness: 'lost', lastFixAtMs: NOW - 12_000 }) })),
    ).toMatchObject({ tone: 'lost', label: 'Receiver lost · 12 s' });
    expect(receiverChip(input({ status: null })).label).toBe('Receiver lost');
  });
});
