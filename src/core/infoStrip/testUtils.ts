/** Test-only: a `DepsSnapshot` with nothing known, plus overrides. */
import type { ComputeContext, DepsSnapshot, StripFix } from './types';

/** 2026-10-13 15:00 UTC (11:00 in Québec City). */
export const NOW = Date.UTC(2026, 9, 13, 15, 0);

/** Québec City, the mockup's sample place. */
export const QC = { latitude: 46.81394, longitude: -71.20761 };

export function snapshot(over: Partial<DepsSnapshot> = {}): DepsSnapshot {
  return {
    nowMs: NOW,
    centre: null,
    centreElevationM: null,
    followsUser: false,
    position: null,
    headingDeg: null,
    course: null,
    movingSpeedMps: null,
    navTarget: null,
    follow: null,
    waypoints: {},
    recording: null,
    coordinateFormat: 'dd',
    datums: {},
    gnss: null,
    tides: {},
    ...over,
  };
}

export function fix(over: Partial<StripFix> = {}): StripFix {
  return { ...QC, altitudeM: 212.4, accuracyM: 4, speedMps: 1, ...over };
}

export const METRIC: ComputeContext = { units: 'metric', target: { kind: 'navTarget' } };
export const IMPERIAL: ComputeContext = { units: 'imperial', target: { kind: 'navTarget' } };
