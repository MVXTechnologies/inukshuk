/**
 * Field params against their schema: validation for persisted values (the
 * settings normaliser) and the registry test ("defaults pass their schema").
 */
import type { LatLng } from '@core/models';

import type { AnyParamSpec, ParamSchema, Params, Target } from './types';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isLatLng(v: unknown): v is LatLng {
  return (
    isObject(v) &&
    typeof v.latitude === 'number' &&
    typeof v.longitude === 'number' &&
    Math.abs(v.latitude) <= 90 &&
    Math.abs(v.longitude) <= 180
  );
}

/** A persisted target, or null when it is not one. */
export function normaliseTarget(raw: unknown): Target | null {
  if (!isObject(raw)) return null;
  switch (raw.kind) {
    case 'navTarget':
    case 'nextOnTrail':
      return { kind: raw.kind };
    case 'waypoint':
      return typeof raw.waypointId === 'string' && raw.waypointId !== ''
        ? { kind: 'waypoint', waypointId: raw.waypointId }
        : null;
    case 'coordinate': {
      if (!isLatLng(raw.point)) return null;
      const point = { latitude: raw.point.latitude, longitude: raw.point.longitude };
      return typeof raw.label === 'string' && raw.label !== ''
        ? { kind: 'coordinate', point, label: raw.label }
        : { kind: 'coordinate', point };
    }
    default:
      return null;
  }
}

/** Whether `value` is valid for `spec`. */
export function paramValid(spec: AnyParamSpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'toggle':
      return typeof value === 'boolean';
    case 'target':
      return value === null || normaliseTarget(value) !== null;
    case 'station':
      return typeof value === 'string' && value !== '';
    default:
      return spec.options.some((o) => o.value === value);
  }
}

/** Whether every key of the schema has a valid value in `params`. */
export function paramsValid<P extends Params>(schema: ParamSchema<P>, params: unknown): boolean {
  if (!isObject(params)) return false;
  return Object.entries(schema).every(([key, spec]) => paramValid(spec, params[key]));
}

/**
 * Persisted params → valid params: each key the schema knows is kept when
 * valid and falls back to its default otherwise; keys it does not know (a
 * newer build's) are kept as they are, so a rollback and a roll-forward both
 * keep the user's settings.
 */
export function normaliseParams<P extends Params>(
  schema: ParamSchema<P>,
  defaults: P,
  raw: unknown,
): P & Record<string, unknown> {
  const r = isObject(raw) ? raw : {};
  const out: Record<string, unknown> = { ...r };
  for (const [key, spec] of Object.entries(schema)) {
    const value = r[key];
    if (spec.kind === 'target') {
      out[key] = value === null || value === undefined ? null : normaliseTarget(value);
    } else {
      out[key] = paramValid(spec, value) ? value : defaults[key];
    }
  }
  return out as P & Record<string, unknown>;
}
