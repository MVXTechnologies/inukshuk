/**
 * Navigation fields: the target's name, distance, bearing, ETE and ETA, and
 * off-trail. Every target field follows the strip's target unless its own
 * `target` param picks another (owner Q4).
 *
 * Deliberately not routing (2.5.1's destination readout): the distance is the
 * straight line, or what is left along the followed trail when the target is
 * the trail's own; ETE and ETA divide it by your moving speed and mark a
 * straight-line estimate "≈" (owner Q2).
 */
import { distanceUnitLabel, formatDistance } from '@core/format';
import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import { trueToMagnetic } from '@core/geo/wmm';

import {
  bearingValue,
  formatArrival,
  formatDistanceIn,
  formatHoursMinutes,
  splitUnit,
  type DistanceUnit,
} from '../format';
import { effectiveTarget, resolveTarget, targetSubject } from '../target';
import type {
  ComputeContext,
  DepsSnapshot,
  ResolvedTarget,
  StripSubject,
  StripValue,
  Target,
} from '../types';
import { defineField, REFERENCE_PARAM, TARGET_PARAM, type NorthReference } from './define';
import { declinationHere } from './position';

/** Below this moving speed there is no honest ETE, m/s (Q2). */
export const ETE_MIN_SPEED_MPS = 0.5;

function targetOf(
  data: DepsSnapshot,
  own: Target | null,
  ctx: ComputeContext,
): ResolvedTarget | null {
  return resolveTarget(effectiveTarget(own, ctx.target), data);
}

/**
 * The distance to a target, metres, and whether it is a straight line:
 * along the trail when the target is the trail's own and `alongTrail` is
 * allowed, else the great circle from you (null without a fix).
 */
export function targetDistance(
  data: DepsSnapshot,
  t: ResolvedTarget,
  alongTrail: boolean,
): { m: number; straight: boolean } | null {
  if (alongTrail && t.alongTrailM !== null) return { m: t.alongTrailM, straight: false };
  if (data.position === null) return null;
  return { m: haversineMeters(data.position, t.point), straight: true };
}

/**
 * Time to the target at your moving speed, seconds, and whether it is a
 * straight-line estimate; null below {@link ETE_MIN_SPEED_MPS} or while the
 * speed is warming up (Q2: "—").
 */
export function timeToTarget(
  data: DepsSnapshot,
  t: ResolvedTarget,
): { s: number; straight: boolean } | null {
  const d = targetDistance(data, t, true);
  const v = data.movingSpeedMps;
  if (d === null || v === null || v < ETE_MIN_SPEED_MPS) return null;
  return { s: d.m / v, straight: d.straight };
}

type TargetOnly = { target: Target | null };

/**
 * The presets' made-up target (a sample is never shown as live): the
 * miniatures show what the map will, a name or the target's icon.
 */
export const SAMPLE_SUBJECT: StripSubject = { key: 'sample', name: 'Camp lac', glyph: 'flag' };

/** A reading to `t`: it carries its target, so its cell can say to what. */
function to(t: ResolvedTarget, v: StripValue): StripValue {
  return { ...v, subject: targetSubject(t) };
}

const TARGET_DEPS = ['navTarget', 'follow', 'waypoints'] as const;

export const TARGET_NAME = defineField<TargetOnly>({
  id: 'targetName',
  label: 'Target name',
  summary: 'Waypoint, trail target or nav target',
  synonyms: ['destination', 'waypoint', 'goal', 'next'],
  group: 'navigation',
  spaces: 1,
  params: { target: TARGET_PARAM },
  defaults: { target: null },
  deps: TARGET_DEPS,
  tick: 'position',
  compute(data, params, ctx) {
    const t = targetOf(data, params.target, ctx);
    return t === null
      ? null
      : { glyph: t.glyph, value: t.name, subject: targetSubject(t), namesSubject: true };
  },
  sample: { glyph: 'flag', value: 'Camp lac', subject: SAMPLE_SUBJECT, namesSubject: true },
});

export type TargetDistanceParams = {
  target: Target | null;
  measure: 'trail' | 'straight';
  unit: DistanceUnit;
};

export const TARGET_DISTANCE = defineField<TargetDistanceParams>({
  id: 'targetDistance',
  label: 'Distance to target',
  spokenTo: 'Distance to',
  summary: 'Straight line, or along the trail when following',
  synonyms: ['range', 'far', 'km', 'miles', 'how far'],
  group: 'navigation',
  spaces: 1,
  params: {
    target: TARGET_PARAM,
    measure: {
      kind: 'choice',
      label: 'Measure',
      hint: 'Along the trail only while following one; straight line otherwise',
      options: [
        { value: 'straight', label: 'Straight line' },
        { value: 'trail', label: 'Along the trail' },
      ],
    },
    unit: {
      kind: 'choice',
      label: 'Units',
      options: [
        { value: 'app', label: 'App units' },
        { value: 'km', label: distanceUnitLabel('km') },
        { value: 'mi', label: distanceUnitLabel('mi') },
        { value: 'nmi', label: distanceUnitLabel('nmi') },
      ],
    },
  },
  defaults: { target: null, measure: 'trail', unit: 'app' },
  deps: ['position', ...TARGET_DEPS],
  tick: 'position',
  compute(data, params, ctx) {
    const t = targetOf(data, params.target, ctx);
    const d = t === null ? null : targetDistance(data, t, params.measure === 'trail');
    return t === null || d === null
      ? null
      : to(t, splitUnit(formatDistanceIn(d.m, params.unit, ctx.units)));
  },
  sample: { value: '1.23', unit: 'km', subject: SAMPLE_SUBJECT },
  sampleIn: (units) => ({ ...splitUnit(formatDistance(1230, units)), subject: SAMPLE_SUBJECT }),
  placeholder: { glyph: 'straighten' },
});

export type TargetBearingParams = { target: Target | null; reference: NorthReference };

/** Which way to walk: the initial great-circle bearing from you, true or magnetic (Q9). */
export const TARGET_BEARING = defineField<TargetBearingParams>({
  id: 'targetBearing',
  label: 'Bearing to target',
  spokenTo: 'Bearing to',
  summary: 'True or magnetic, your choice',
  synonyms: ['direction', 'azimuth', 'course', 'heading to'],
  group: 'navigation',
  spaces: 1,
  params: { target: TARGET_PARAM, reference: REFERENCE_PARAM },
  defaults: { target: null, reference: 'true' },
  deps: ['position', ...TARGET_DEPS],
  tick: 'position',
  compute(data, params, ctx) {
    const t = targetOf(data, params.target, ctx);
    if (t === null || data.position === null) return null;
    const trueDeg = initialBearingDeg(data.position, t.point);
    // A fix is in hand, so the declination is too; narrowed rather than asserted.
    const decl = params.reference === 'magnetic' ? declinationHere(data) : null;
    const deg = decl === null ? trueDeg : trueToMagnetic(trueDeg, decl);
    return to(t, { glyph: 'explore', ...bearingValue(deg, decl !== null) });
  },
  sample: { glyph: 'explore', value: '042°', unit: 'NE', subject: SAMPLE_SUBJECT },
});

/** Time to the target (ETE), "H:MM"; "≈" for a straight-line estimate; "—" when unknown. */
export const ETE = defineField<TargetOnly>({
  id: 'ete',
  label: 'Time to target (ETE)',
  spokenTo: 'Time to',
  summary: 'From your moving speed over the last 10 min',
  synonyms: ['eta', 'time left', 'remaining', 'duration'],
  group: 'navigation',
  spaces: 1,
  params: { target: TARGET_PARAM },
  defaults: { target: null },
  deps: ['position', ...TARGET_DEPS],
  tick: 'second',
  compute(data, params, ctx) {
    const t = targetOf(data, params.target, ctx);
    if (t === null) return null;
    const ete = timeToTarget(data, t);
    if (ete === null) return to(t, { tag: 'ETE', value: '—' });
    return to(t, { tag: 'ETE', value: `${ete.straight ? '≈' : ''}${formatHoursMinutes(ete.s)}` });
  },
  sample: { tag: 'ETE', value: '0:21', subject: SAMPLE_SUBJECT },
});

/** Arrival clock time (ETA) at your moving speed; "≈" for a straight-line estimate. */
export const ETA = defineField<TargetOnly>({
  id: 'eta',
  label: 'Arrival (ETA)',
  spokenTo: 'Arrival at',
  summary: 'Clock time at your moving speed over the last 10 min',
  synonyms: ['arrival', 'time', 'when'],
  group: 'navigation',
  spaces: 1,
  params: { target: TARGET_PARAM },
  defaults: { target: null },
  deps: ['position', 'clock', ...TARGET_DEPS],
  tick: 'minute',
  compute(data, params, ctx) {
    const t = targetOf(data, params.target, ctx);
    if (t === null) return null;
    const ete = timeToTarget(data, t);
    if (ete === null) return to(t, { tag: 'ETA', value: '—' });
    const at = formatArrival(data.nowMs + Math.ceil(ete.s / 60) * 60_000, data.nowMs);
    return to(t, { tag: 'ETA', value: `${ete.straight ? '≈' : ''}${at}` });
  },
  sample: { tag: 'ETA', value: '14:32', subject: SAMPLE_SUBJECT },
  sampleClockMin: 14 * 60 + 32,
});

/**
 * Off trail (#678 hysteresis, as the follow readout latches it): sage "On
 * trail" within it, amber "Off 62 m" past it. Only while following.
 */
export const OFF_TRAIL = defineField<Record<string, never>>({
  id: 'offTrail',
  label: 'Off trail',
  spokenTo: 'Distance back to',
  summary: 'Distance back to the followed trail',
  synonyms: ['on trail', 'deviation', 'cross track', 'xte'],
  group: 'navigation',
  spaces: 1,
  params: {},
  defaults: {},
  deps: ['follow'],
  tick: 'position',
  compute(data, _params, { units }) {
    const f = data.follow;
    if (f === null) return null;
    if (f.onTrail) return { glyph: 'check_circle', value: 'On trail', tone: 'ok' };
    // Off: the distance back to THE followed trail, which it names (#673 QA).
    const { value, unit } = splitUnit(formatDistance(f.crossTrackM, units));
    const subject: StripSubject = { key: 'trail', name: f.trailName ?? 'Trail', glyph: 'route' };
    return { glyph: 'wrong_location', value: `Off ${value}`, unit, tone: 'warn', subject };
  },
  sample: { glyph: 'check_circle', value: 'On trail', tone: 'ok' },
  placeholder: { glyph: 'route' },
});
