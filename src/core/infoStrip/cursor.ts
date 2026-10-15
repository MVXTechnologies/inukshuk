/**
 * The centre cursor as a strip target (owner, 2.6.x: "Bearing to cursor",
 * "Distance to cursor"): from your fix to the point the cursor marks.
 *
 * The cursor is a target only while it shows: switched on in Map aids and
 * not hidden while the map follows you. While the map follows you the cursor
 * sits on you, so there is nothing to measure either: its fields step aside
 * as a target field does without a target.
 *
 * The map's centre moves at gesture rate (30-60 Hz); the strip reads it
 * through {@link createRateGate} at most every {@link CURSOR_TICK_MS}, the
 * last position of a pan always delivered.
 *
 * Pure.
 */
import type { LatLng } from '@core/models';

import type { CursorSettings, StripCursor, StripSubject } from './types';

/** The live cursor's period, ms: at most 10 strip refreshes a second while panning. */
export const CURSOR_TICK_MS = 100;

/**
 * The cursor as a strip target, or null when it does not show or sits on
 * you (see the module note). `centre`: the live map centre, null before the
 * first camera report.
 */
export function visibleCursor(
  settings: CursorSettings,
  centre: LatLng | null,
  followsUser: boolean,
): StripCursor | null {
  if (!settings.enabled || followsUser || centre === null) return null;
  return {
    point: { latitude: centre.latitude, longitude: centre.longitude },
    kind: settings.kind,
    color: settings.color,
    halo: settings.halo,
  };
}

/** What a reading to the cursor is to: "Cursor", drawn as the map draws it. */
export function cursorSubject(c: Pick<StripCursor, 'kind' | 'color' | 'halo'>): StripSubject {
  return {
    ...CURSOR_SUBJECT,
    cursor: { kind: c.kind, color: c.color, halo: c.halo },
  };
}

/** The cursor subject without its look (the editor's samples). */
export const CURSOR_SUBJECT: StripSubject = {
  key: 'cursor',
  name: 'Cursor',
  glyph: 'filter_center_focus',
  spokenName: 'cursor',
};

/** What a {@link RateGate} says to a new value. */
export type GateResult = { kind: 'emit' } | { kind: 'wait'; inMs: number };

export interface RateGate<T> {
  /** A new value at `nowMs`: pass it on now, or hold it and flush in `inMs`. */
  push(value: T, nowMs: number): GateResult;
  /** The held value at `nowMs` (null: nothing held), now passed on. */
  flush(nowMs: number): T | null;
}

/**
 * At most one value per `periodMs`, the last one never lost: a value inside
 * the period is held (the newest replaces it) and the caller flushes it when
 * the period ends. O(1) per push.
 */
export function createRateGate<T>(periodMs: number): RateGate<T> {
  let lastEmitMs = -Infinity;
  let held: { value: T } | null = null;
  return {
    push(value, nowMs) {
      const since = nowMs - lastEmitMs;
      if (since >= periodMs) {
        lastEmitMs = nowMs;
        held = null;
        return { kind: 'emit' };
      }
      held = { value };
      return { kind: 'wait', inMs: periodMs - since };
    },
    flush(nowMs) {
      if (held === null) return null;
      const { value } = held;
      held = null;
      lastEmitMs = nowMs;
      return value;
    },
  };
}
