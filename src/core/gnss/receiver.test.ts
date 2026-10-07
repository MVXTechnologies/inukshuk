import { asciiToBytes } from './bytes';
import { formatNmea } from './nmea';
import { MIN_SWITCH_MS, STREAM_LOST_MS, type ExternalStatus } from './quality';
import {
  arbitrate,
  INITIAL_SOURCE,
  ReceiverPipeline,
  shortDistanceM,
  shouldRecord,
  trackPointFromFix,
} from './receiver';
import { nmeaEpoch, quebecRtkSession } from './sim';
import { encodeRtcm3 } from './rtcm3';
import { fixOf, navPvtFrame } from './testUtils';

const T0 = 1_800_000_000_000;

describe('ReceiverPipeline: the scripted Québec City RTK session', () => {
  it('goes autonomous → float → fixed → (corrections lost) float, one fix per epoch', () => {
    const p = new ReceiverPipeline();
    const { epochs } = quebecRtkSession();
    const states: string[] = [];
    epochs.forEach((e, i) => {
      for (const f of p.push(asciiToBytes(nmeaEpoch(e)), T0 + i * 1000)) {
        expect(f.lat).toBeCloseTo(epochs[states.length]?.lat ?? NaN, 7);
        states.push(p.status.state);
      }
    });
    // NMEA epochs close when the next one starts: the last is still open.
    expect(states).toHaveLength(epochs.length - 1);
    expect(states[0]).toBe('autonomous');
    expect(states[15]).toBe('float');
    expect(states[50]).toBe('fixed');
    // Corrections stopped at epoch 80: still "fixed" (aging), then the receiver drops to float.
    expect(states[100]).toBe('fixed');
    expect(states[130]).toBe('float');
    expect(p.counters).toEqual({ nmea: epochs.length * 3, ubx: 0, rtcm: 0 });
    // A disconnect closes the open epoch.
    const last = p.discontinuity(T0 + epochs.length * 1000);
    expect(last).toHaveLength(1);
    expect(p.fix?.lat).toBeCloseTo(epochs[epochs.length - 1]?.lat ?? NaN, 7);
  });

  it('notices silence on the tick: stale, then lost', () => {
    const p = new ReceiverPipeline();
    const { epochs } = quebecRtkSession();
    p.push(asciiToBytes(nmeaEpoch(epochs[40] as never) + nmeaEpoch(epochs[41] as never)), T0);
    expect(p.tick(T0 + 1000).freshness).toBe('live');
    expect(p.tick(T0 + 2500).freshness).toBe('stale');
    expect(p.tick(T0 + STREAM_LOST_MS).state).toBe('no-fix');
  });

  it('counts UBX and RTCM frames, and exposes the sky view', () => {
    const p = new ReceiverPipeline();
    p.push(
      navPvtFrame({
        iTOW: 1000,
        date: [2026, 10, 7, 12, 0, 0],
        fixType: 3,
        flags: 0x01,
        numSV: 12,
        lon: -71.2,
        lat: 46.8,
        height: 20,
        hMSL: 51,
        hAcc: 1.5,
        vAcc: 2.5,
      }),
      T0,
    );
    p.push(encodeRtcm3(new Uint8Array([0x3e, 0xd0, 0x00])), T0);
    p.push(asciiToBytes(formatNmea('GPGSV,1,1,01,05,45,120,40')), T0);
    expect(p.counters.ubx).toBe(1);
    expect(p.counters.rtcm).toBe(1);
    expect(p.counters.nmea).toBe(1);
    expect(Array.isArray(p.sky)).toBe(true);
  });
});

function ext(over: Partial<ExternalStatus>): ExternalStatus {
  return {
    state: 'fixed',
    freshness: 'live',
    correction: 'ok',
    reportedState: 'fixed',
    correctionAgeS: 1,
    lastFixAtMs: T0,
    sinceMs: T0,
    ...over,
  };
}

describe('arbitrate: decideSource with its state, and "no fallback"', () => {
  const opts = { phoneWhileGood: 'standby' as const, fallback: true };

  it('a good receiver becomes the source; the phone goes to standby', () => {
    const o = arbitrate(INITIAL_SOURCE, ext({}), T0, opts);
    expect(o).toMatchObject({ use: 'external', phone: 'standby' });
    expect(o.state).toEqual({ current: 'external', lastSwitchAtMs: T0 });
    expect(o.decision.switched).toBe(true);
    // No new switch: the switch time is kept.
    const again = arbitrate(o.state, ext({}), T0 + 1000, opts);
    expect(again.state.lastSwitchAtMs).toBe(T0);
  });

  it('"phone GPS off" while the receiver is good', () => {
    expect(arbitrate(INITIAL_SOURCE, ext({}), T0, { ...opts, phoneWhileGood: 'off' }).phone).toBe(
      'off',
    );
  });

  it('anti-flap: a drop right after a switch is held, then honoured', () => {
    const s = arbitrate(INITIAL_SOURCE, ext({}), T0, opts).state;
    const lost = ext({ freshness: 'lost', state: 'no-fix' });
    expect(arbitrate(s, lost, T0 + 500, opts)).toMatchObject({ use: 'external', phone: 'active' });
    expect(arbitrate(s, lost, T0 + MIN_SWITCH_MS, opts)).toMatchObject({
      use: 'phone',
      phone: 'active',
    });
  });

  it('with fallback off the receiver stays the source, lost or not', () => {
    const s = arbitrate(INITIAL_SOURCE, ext({}), T0, opts).state;
    const lost = ext({ freshness: 'lost', state: 'no-fix' });
    const o = arbitrate(s, lost, T0 + 10_000, { ...opts, fallback: false });
    expect(o).toMatchObject({ use: 'external', phone: 'standby' });
    expect(arbitrate(s, lost, T0 + 10_000, { phoneWhileGood: 'off', fallback: false }).phone).toBe(
      'off',
    );
    // No receiver at all: the phone, fallback or not.
    expect(arbitrate(s, null, T0, { ...opts, fallback: false }).use).toBe('phone');
  });
});

describe('recording an external fix', () => {
  it('carries the source, the solution, the receiver accuracy and the arrival time', () => {
    const p = trackPointFromFix(fixOf('rtk-fixed'), { lat: 46.80001, lon: -71.20001 }, T0 + 5);
    expect(p).toEqual({
      latitude: 46.80001,
      longitude: -71.20001,
      time: T0 + 5,
      source: 'external',
      gnss: { fix: 'rtk-fixed', sats: 14, ageS: 1, hdop: 0.8 },
      altitude: 51,
      accuracy: 0.014,
      altitudeAccuracy: 0.026,
      speed: 1.2,
    });
  });

  it('omits what the receiver did not say', () => {
    const p = trackPointFromFix(
      fixOf('autonomous', {
        hMsl: null,
        hEll: null,
        accuracy: { h95: 3, v95: null, basis: 'hdop' },
        speedMps: null,
        satsUsed: null,
        correctionAgeS: null,
        hdop: null,
      }),
      { lat: 1, lon: 2 },
      T0,
    );
    expect(p).toEqual({
      latitude: 1,
      longitude: 2,
      time: T0,
      source: 'external',
      gnss: { fix: 'autonomous' },
      accuracy: 3,
    });
    const noAcc = trackPointFromFix(
      fixOf('autonomous', { accuracy: null, hMsl: null }),
      { lat: 1, lon: 2 },
      T0,
    );
    expect(noAcc.accuracy).toBeUndefined();
    expect(noAcc.altitude).toBe(20);
  });

  it('a distance filter like the phone watch’s, at least 1 m', () => {
    const a = { lat: 46.8, lon: -71.2 };
    expect(shortDistanceM(a, { lat: 46.80001, lon: -71.2 })).toBeCloseTo(1.11, 2);
    expect(shouldRecord(null, a, 5)).toBe(true);
    expect(shouldRecord(a, { lat: 46.800005, lon: -71.2 }, 0)).toBe(false);
    expect(shouldRecord(a, { lat: 46.80001, lon: -71.2 }, 0)).toBe(true);
    expect(shouldRecord(a, { lat: 46.80001, lon: -71.2 }, 5)).toBe(false);
  });
});
