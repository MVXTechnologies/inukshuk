/**
 * Fields an extension feeds: the GNSS receiver (ellipsoidal height, fix
 * type) and Tide stations (the level at the station and the next high
 * tide). Listed in the picker, and kept when a preset applies, only with
 * their extension installed (`requires`).
 */
import { elevationParts, formatClockTime, type Units } from '@core/format';
import { formatHeight, kindLabel } from '@core/gnss/chip';
import { stateOf } from '@core/gnss/quality';
import { LIVE_MAX_AGE_MS } from '@core/tides/live';

import { splitUnit } from '../format';
import { NEAREST_STATION, type DepsSnapshot, type StripValue, type TideSnapshot } from '../types';
import { defineField, STATION_PARAM } from './define';

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
    const g = data.gnss;
    if (g === null || g.ellipsoidalHeightM === null) return null;
    return { tag: 'h', ...splitUnit(formatHeight(g.ellipsoidalHeightM, g.heightAccuracyM)) };
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

/** A tide field's params: which station it reads (#695). */
export type TideParams = { station: string };

/** The readout of the station a tide field names, or null (not loaded, nothing near). */
function tideOf(data: DepsSnapshot, params: TideParams): TideSnapshot | null {
  return data.tides[params.station] ?? null;
}

/**
 * Whether a station's level is still "now" at `nowMs`: observed no more than
 * `LIVE_MAX_AGE_MS` ago (the tide card's rule). A level without a time is not.
 */
export function levelIsLive(t: TideSnapshot, nowMs: number): boolean {
  return t.levelM !== null && t.levelAtMs !== null && nowMs - t.levelAtMs <= LIVE_MAX_AGE_MS;
}

/**
 * A tide level as the strip prints it: the elevation unit (#702), signed,
 * two decimals, with the trend arrow ("+3.84" "m ↑", "−0.42" "ft ↓").
 */
export function tideLevelText(
  levelM: number,
  trend: TideSnapshot['trend'],
  units: Units,
): Pick<StripValue, 'value' | 'unit'> {
  const arrow = trend === 'rising' ? ' ↑' : trend === 'falling' ? ' ↓' : '';
  const q = elevationParts(levelM, units, { decimals: 2 });
  return { value: q.value.startsWith('−') ? q.value : `+${q.value}`, unit: `${q.unit}${arrow}` };
}

/**
 * The water level at the chosen tide station, with its trend arrow. Per
 * minute tick: one record lookup and a format; the level itself is fetched
 * by the platform every few minutes, never per tick.
 */
export const TIDE_LEVEL = defineField<TideParams>({
  id: 'tides:level',
  label: 'Tide at a station',
  summary: 'The level now and whether it rises',
  synonyms: ['tide', 'water level', 'sea', 'height'],
  group: 'extension',
  spaces: 1,
  requires: 'tides',
  params: { station: STATION_PARAM },
  defaults: { station: NEAREST_STATION },
  deps: ['ext:tides'],
  tick: 'minute',
  compute(data, params, ctx) {
    const t = tideOf(data, params);
    // An hour-old level is not "now" (a refresh failing for a while, a sleeping phone).
    if (t === null || t.levelM === null || !levelIsLive(t, data.nowMs)) return null;
    return { glyph: 'waves', tag: t.stationName, ...tideLevelText(t.levelM, t.trend, ctx.units) };
  },
  // "Tide", never a real station's name: a made-up one read as the station picked (QA 2.6.0).
  sample: { glyph: 'waves', tag: 'Tide', value: '+3.84', unit: 'm ↑' },
  sampleIn: (units) => ({ glyph: 'waves', tag: 'Tide', ...tideLevelText(3.84, 'rising', units) }),
});

/** The next high tide at the station, clock time; it steps aside once it has passed. */
export const TIDE_NEXT_HIGH = defineField<TideParams>({
  id: 'tides:nextHigh',
  label: 'Next high tide',
  summary: 'When the water is highest next',
  synonyms: ['high water', 'tide', 'flood'],
  group: 'extension',
  spaces: 1,
  requires: 'tides',
  params: { station: STATION_PARAM },
  defaults: { station: NEAREST_STATION },
  deps: ['ext:tides', 'clock'],
  tick: 'minute',
  compute(data, params) {
    const next = tideOf(data, params)?.nextHigh;
    if (next == null || next.atMs <= data.nowMs) return null;
    return { tag: 'High', value: formatClockTime(next.atMs) };
  },
  sample: { tag: 'High', value: '14:52' },
  sampleClockMin: 14 * 60 + 52,
});
