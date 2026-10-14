import { formatClockTime, formatDistance } from '@core/format';
import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import { declinationAt } from '@core/geo/wmm';

import { splitUnit } from '../format';
import { fix, IMPERIAL, METRIC, NOW, QC, snapshot } from '../testUtils';
import type { ComputeContext, FollowSnapshot } from '../types';
import {
  ETA,
  ETE,
  ETE_MIN_SPEED_MPS,
  OFF_TRAIL,
  TARGET_BEARING,
  TARGET_DISTANCE,
  TARGET_NAME,
  targetDistance,
  timeToTarget,
} from './navigation';

const CAMP = { name: 'Camp lac', point: { latitude: 46.8222, longitude: -71.1952 } };
const FOLLOW: FollowSnapshot = {
  targetKind: 'note',
  targetId: 'n1',
  targetName: 'Source',
  targetPoint: { latitude: 46.815, longitude: -71.205 },
  targetDistanceM: 1500,
  crossTrackM: 62,
  onTrail: false,
};
const navigating = (over = {}) => snapshot({ position: fix(), navTarget: CAMP, ...over });
const straightM = haversineMeters(QC, CAMP.point);

describe('target name', () => {
  it("follows the strip's target, or the field's own", () => {
    expect(TARGET_NAME.compute(navigating(), { target: null }, METRIC)).toEqual({
      glyph: 'flag',
      value: 'Camp lac',
    });
    const own = { target: { kind: 'coordinate' as const, point: QC, label: 'Borne 23A' } };
    expect(TARGET_NAME.compute(navigating(), own, METRIC)).toEqual({
      glyph: 'my_location',
      value: 'Borne 23A',
    });
    expect(TARGET_NAME.compute(snapshot(), { target: null }, METRIC)).toBeNull();
  });

  it("uses the strip's own target kind (Hiking: next on trail)", () => {
    const ctx: ComputeContext = { units: 'metric', target: { kind: 'nextOnTrail' } };
    expect(TARGET_NAME.compute(navigating(), { target: null }, ctx)).toBeNull();
    expect(TARGET_NAME.compute(navigating({ follow: FOLLOW }), { target: null }, ctx)).toEqual({
      glyph: 'route',
      value: 'Source',
    });
  });
});

describe('distance to target', () => {
  const P = TARGET_DISTANCE.defaults;

  it('straight line from you', () => {
    expect(TARGET_DISTANCE.compute(navigating(), P, METRIC)).toEqual({
      value: (straightM / 1000).toFixed(2),
      unit: 'km',
    });
  });

  it('along the trail while following, straight when asked', () => {
    const data = navigating({ follow: FOLLOW });
    expect(TARGET_DISTANCE.compute(data, P, METRIC)).toEqual({ value: '1.50', unit: 'km' });
    expect(TARGET_DISTANCE.compute(data, { ...P, measure: 'straight' }, METRIC)).toEqual(
      splitUnit(formatDistance(haversineMeters(QC, FOLLOW.targetPoint), 'metric')),
    );
  });

  it('in a fixed unit (nautical miles for paddling) or the app units', () => {
    const data = navigating({ follow: FOLLOW });
    expect(TARGET_DISTANCE.compute(data, { ...P, unit: 'nmi' }, METRIC)).toEqual({
      value: '0.81',
      unit: 'nmi',
    });
    expect(TARGET_DISTANCE.compute(data, P, IMPERIAL)).toEqual({ value: '0.93', unit: 'mi' });
  });

  it('needs a fix for a straight line, and a target', () => {
    expect(TARGET_DISTANCE.compute(snapshot({ navTarget: CAMP }), P, METRIC)).toBeNull();
    expect(TARGET_DISTANCE.compute(snapshot({ position: fix() }), P, METRIC)).toBeNull();
    // Along the trail needs no fix of its own: the follow readout has it.
    expect(TARGET_DISTANCE.compute(snapshot({ follow: FOLLOW }), P, METRIC)?.value).toBe('1.50');
  });
});

describe('bearing to target', () => {
  it('true by default, magnetic on request', () => {
    const trueDeg = initialBearingDeg(QC, CAMP.point);
    const t = TARGET_BEARING.compute(navigating(), TARGET_BEARING.defaults, METRIC);
    expect(t).toEqual({
      glyph: 'explore',
      value: `${String(Math.round(trueDeg)).padStart(3, '0')}°`,
      unit: 'NE',
    });
    const m = TARGET_BEARING.compute(navigating(), { target: null, reference: 'magnetic' }, METRIC);
    const magDeg = trueDeg - declinationAt(QC.latitude, QC.longitude, NOW);
    expect(m?.value).toBe(`${String(Math.round(magDeg)).padStart(3, '0')}°M`);
  });

  it('needs a fix and a target', () => {
    expect(
      TARGET_BEARING.compute(snapshot({ navTarget: CAMP }), TARGET_BEARING.defaults, METRIC),
    ).toBeNull();
    expect(
      TARGET_BEARING.compute(snapshot({ position: fix() }), TARGET_BEARING.defaults, METRIC),
    ).toBeNull();
  });
});

describe('ETE and ETA (Q2)', () => {
  it('straight line ÷ moving speed, marked ≈', () => {
    const data = navigating({ movingSpeedMps: 1.2 });
    const s = straightM / 1.2;
    const mins = Math.ceil(s / 60);
    expect(ETE.compute(data, { target: null }, METRIC)).toEqual({
      tag: 'ETE',
      value: `≈${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`,
    });
    expect(ETA.compute(data, { target: null }, METRIC)).toEqual({
      tag: 'ETA',
      value: `≈${formatClockTime(NOW + mins * 60_000)}`,
    });
  });

  it('along the trail while following: no ≈', () => {
    const data = navigating({ follow: FOLLOW, movingSpeedMps: 1.25 });
    expect(ETE.compute(data, { target: null }, METRIC)?.value).toBe('0:20');
    expect(ETA.compute(data, { target: null }, METRIC)?.value).toBe(
      formatClockTime(NOW + 20 * 60_000),
    );
  });

  it('an arrival more than 24 h away carries its day ("Thu 14:32")', () => {
    const far = navigating({ follow: { ...FOLLOW, targetDistanceM: 200_000 }, movingSpeedMps: 1 });
    const at = NOW + Math.ceil(200_000 / 60) * 60_000;
    const day = new Date(at).toLocaleDateString(undefined, { weekday: 'short' });
    expect(ETA.compute(far, { target: null }, METRIC)?.value).toBe(`${day} ${formatClockTime(at)}`);
  });

  it('"—" below 0.5 m/s or while the speed warms up', () => {
    const slow = navigating({ movingSpeedMps: ETE_MIN_SPEED_MPS - 0.01 });
    expect(ETE.compute(slow, { target: null }, METRIC)).toEqual({ tag: 'ETE', value: '—' });
    expect(ETA.compute(slow, { target: null }, METRIC)).toEqual({ tag: 'ETA', value: '—' });
    expect(ETE.compute(navigating(), { target: null }, METRIC)?.value).toBe('—');
  });

  it('leaves out without a target', () => {
    expect(ETE.compute(snapshot({ position: fix() }), { target: null }, METRIC)).toBeNull();
    expect(ETA.compute(snapshot({ position: fix() }), { target: null }, METRIC)).toBeNull();
  });

  it('helpers report the measure used', () => {
    const t = { name: 'x', point: CAMP.point, glyph: 'flag' as const, alongTrailM: 900 };
    expect(targetDistance(snapshot(), t, true)).toEqual({ m: 900, straight: false });
    expect(targetDistance(snapshot(), t, false)).toBeNull();
    expect(timeToTarget(snapshot({ movingSpeedMps: 1 }), t)).toEqual({ s: 900, straight: false });
    expect(timeToTarget(snapshot(), t)).toBeNull();
  });
});

describe('off trail', () => {
  it('amber "Off 62 m" past the hysteresis, sage "On trail" within it', () => {
    expect(OFF_TRAIL.compute(snapshot({ follow: FOLLOW }), {}, METRIC)).toEqual({
      glyph: 'wrong_location',
      value: 'Off 62',
      unit: 'm',
      tone: 'warn',
    });
    expect(OFF_TRAIL.compute(snapshot({ follow: FOLLOW }), {}, IMPERIAL)?.unit).toBe('ft');
    expect(
      OFF_TRAIL.compute(snapshot({ follow: { ...FOLLOW, onTrail: true } }), {}, METRIC),
    ).toEqual({ glyph: 'check_circle', value: 'On trail', tone: 'ok' });
  });

  it('only while following', () => {
    expect(OFF_TRAIL.compute(snapshot(), {}, METRIC)).toBeNull();
  });
});
