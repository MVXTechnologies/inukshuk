/**
 * Fields an extension feeds: the GNSS receiver (ellipsoidal height, fix
 * type) and Tide stations (the level at the station and the next high
 * tide). Listed in the picker, and kept when a preset applies, only with
 * their extension installed (`requires`).
 */
import { formatClockTime } from '@core/format';
import { formatHeight, kindLabel } from '@core/gnss/chip';
import { stateOf } from '@core/gnss/quality';

import { splitUnit } from '../format';
import type { StripValue } from '../types';
import { defineField } from './define';

/** Ellipsoidal height from the receiver, with the decimals its accuracy supports. */
export const GNSS_HEIGHT = defineField<Record<string, never>>({
  id: 'gnss:height',
  label: 'Ellipsoidal height',
  summary: 'From the GNSS receiver, in the project datum',
  synonyms: ['h', 'ellipsoid', 'height', 'survey'],
  group: 'extension',
  spaces: 1,
  requires: 'gnss',
  params: {},
  defaults: {},
  deps: ['ext:gnss'],
  tick: 'position',
  compute(data) {
    const h = data.gnss?.ellipsoidalHeightM;
    if (h == null) return null;
    return { tag: 'h', ...splitUnit(formatHeight(h, data.gnss!.heightAccuracyM)) };
  },
  sample: { tag: 'h', value: '183.42', unit: 'm' },
});

/** The receiver's solution: "RTK fixed" sage, "RTK float" plain, "No fix" amber. */
export const GNSS_FIX = defineField<Record<string, never>>({
  id: 'gnss:fix',
  label: 'GNSS fix',
  summary: "The receiver's solution: RTK fixed, float, DGPS…",
  synonyms: ['rtk', 'fix', 'receiver', 'quality'],
  group: 'extension',
  spaces: 1,
  requires: 'gnss',
  params: {},
  defaults: {},
  deps: ['ext:gnss'],
  tick: 'position',
  compute(data) {
    if (data.gnss === null) return null;
    const state = stateOf(data.gnss.kind);
    const out: StripValue = { glyph: 'satellite_alt', value: kindLabel(data.gnss.kind) };
    if (state === 'fixed') out.tone = 'ok';
    if (state === 'no-fix') out.tone = 'warn';
    return out;
  },
  sample: { glyph: 'satellite_alt', value: 'RTK fixed', tone: 'ok' },
});

/** The water level at the chosen tide station, with its trend arrow. */
export const TIDE_LEVEL = defineField<Record<string, never>>({
  id: 'tides:level',
  label: 'Tide at a station',
  summary: 'The level now and whether it rises',
  synonyms: ['tide', 'water level', 'sea', 'height'],
  group: 'extension',
  spaces: 1,
  requires: 'tides',
  params: {},
  defaults: {},
  deps: ['ext:tides'],
  tick: 'minute',
  compute(data) {
    const t = data.tides;
    if (t === null) return null;
    const arrow = t.trend === 'rising' ? ' ↑' : t.trend === 'falling' ? ' ↓' : '';
    const sign = t.levelM < 0 ? '−' : '+';
    return {
      glyph: 'waves',
      tag: t.stationName,
      value: `${sign}${Math.abs(t.levelM).toFixed(2)}`,
      unit: `m${arrow}`,
    };
  },
  sample: { glyph: 'waves', tag: 'Lauzon', value: '+3.84', unit: 'm ↑' },
});

/** The next high tide at the station, clock time. */
export const TIDE_NEXT_HIGH = defineField<Record<string, never>>({
  id: 'tides:nextHigh',
  label: 'Next high tide',
  summary: 'When the water is highest next',
  synonyms: ['high water', 'tide', 'flood'],
  group: 'extension',
  spaces: 1,
  requires: 'tides',
  params: {},
  defaults: {},
  deps: ['ext:tides', 'clock'],
  tick: 'minute',
  compute(data) {
    const next = data.tides?.nextHigh;
    if (next == null) return null;
    return { tag: 'High', value: formatClockTime(next.atMs) };
  },
  sample: { tag: 'High', value: '14:52' },
});
