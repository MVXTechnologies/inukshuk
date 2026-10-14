import {
  FT_PER_MI,
  M_PER_FT,
  METRIC,
  formatInUnit,
  fromUnit,
  rulerSystem,
  toUnit,
  type Units,
} from '@core/format';
import { normalizeDeg } from '@core/signal/heading';

/**
 * The pointing line's settings (#681, mockup 2.6.0 info strip §7): a line
 * drawn on the map from your position along the way you face. Map layers ›
 * Map › Pointing line holds the switch and these options (the owner's
 * sub-menu rule: its options live in its own sub-panel).
 *
 * Persisted as ONE settings key, `pointingLine`, an object. The settings
 * ladder copies only the keys a build knows, so an older build simply drops
 * it; a newer build's extra fields or junk values are sanitised here, field
 * by field, back to the defaults.
 */

/** Where the line starts. 2.5.1 has one origin; the centre cursor joins in 2.6.0. */
export type PointingLineOrigin = 'you';
/** Which way it points: the compass heading, the course over ground, or a fixed bearing. */
export type PointingLineDirection = 'heading' | 'course' | 'fixed';
/**
 * Ground length: a preset in metres, to the edge of the visible map, or the
 * user's own distance (`customLengthM`, #703).
 */
export type PointingLineLength = 100 | 250 | 500 | 1000 | 2000 | 'edge' | 'custom';
export type PointingLineWidth = 'hairline' | 'thin' | 'medium' | 'bold';
/** Tick spacing in metres, Auto (a round step ≥ 24 dp apart), or none. */
export type PointingLineTicks = 'off' | 10 | 50 | 100 | 'auto';

export interface PointingLineSettings {
  enabled: boolean;
  origin: PointingLineOrigin;
  direction: PointingLineDirection;
  /** The fixed bearing, whole degrees clockwise from true north, [0, 360). */
  fixedBearingDeg: number;
  length: PointingLineLength;
  /**
   * The Custom length, metres on the ground, within
   * [{@link CUSTOM_LENGTH_MIN_M}, {@link CUSTOM_LENGTH_MAX_M}] (#703). Kept
   * while a preset is chosen, so going back to Custom finds it again. Typed
   * in metres, or feet in imperial; stored in metres either way.
   */
  customLengthM: number;
  /** One of {@link POINTING_LINE_COLORS}. */
  color: string;
  width: PointingLineWidth;
  ticks: PointingLineTicks;
  /** Label every 5th tick with its distance from you. */
  labelEvery5th: boolean;
}

/** The length slider's stops: five presets, the screen edge, then Custom (#703). */
export const POINTING_LINE_LENGTHS: readonly PointingLineLength[] = [
  100,
  250,
  500,
  1000,
  2000,
  'edge',
  'custom',
];
/** A fixed length choice (the persisted value is its metric distance). */
export type PointingLineFixedLength = Exclude<PointingLineLength, 'edge' | 'custom'>;

/** The shortest Custom length, metres: a line shorter than this hides under the puck. */
export const CUSTOM_LENGTH_MIN_M = 10;
/** The longest Custom length, metres: the same cap as Edge (`EDGE_MAX_M`). */
export const CUSTOM_LENGTH_MAX_M = 50_000;
/** Custom's first value, before the user types one. */
export const DEFAULT_CUSTOM_LENGTH_M = 750;

/** A Custom length into its range; null when it is not a positive number. */
export function clampCustomLengthM(m: unknown): number | null {
  if (typeof m !== 'number' || !Number.isFinite(m) || !(m > 0)) return null;
  return Math.min(CUSTOM_LENGTH_MAX_M, Math.max(CUSTOM_LENGTH_MIN_M, m));
}

/** The unit a Custom length is typed in: the ruler's short unit, metres or feet. */
export function customLengthInputUnit(units: Units): 'm' | 'ft' {
  return rulerSystem(units) === 'imperial' ? 'ft' : 'm';
}

/** A Custom length as its input shows it: whole metres, or whole feet on an imperial ruler. */
export function customLengthInputText(m: number, units: Units): string {
  return String(Math.round(toUnit(m, customLengthInputUnit(units))));
}

/**
 * Typed text → a Custom length in metres (clamped to its range), or null
 * while it is not a number yet. Whole or decimal, in the input's unit.
 */
export function parseCustomLength(text: string, units: Units): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return null;
  const v = Number(t);
  return clampCustomLengthM(fromUnit(v, customLengthInputUnit(units)));
}

/**
 * A Custom length as words: "750 m", "1.25 km"; "1500 ft", "1.2 mi". Up to
 * two decimals, trailing zeros dropped.
 */
function customLengthText(m: number, units: Units): string {
  if (rulerSystem(units) === 'imperial') {
    return m / M_PER_FT < FT_PER_MI / 2 ? formatInUnit(m, 'ft', 0) : formatInUnit(m, 'mi', 2);
  }
  return m < 1000 ? formatInUnit(m, 'm', 0) : formatInUnit(m, 'km', 2);
}

/**
 * The imperial length each stop stands for, feet (2.5.1 final QA: the panel
 * read metres in imperial). Round imperial distances, one per stop: 500 ft,
 * 1000 ft, 0.5 mi, 1 mi, 2 mi. Like the ticks, the setting itself stays one
 * value — the metric stop — so switching units keeps your choice.
 */
export const IMPERIAL_LENGTH_FT: Record<PointingLineFixedLength, number> = {
  100: 500,
  250: 1000,
  500: FT_PER_MI / 2,
  1000: FT_PER_MI,
  2000: 2 * FT_PER_MI,
};

/**
 * The ground length a stop draws, metres, in the user's ruler's round values
 * (`rulerSystem`: nautical-mile users get the stops of their short unit —
 * this is a short-range ruler, not a passage plan).
 */
export function pointingLineLengthM(length: PointingLineFixedLength, units: Units): number {
  return rulerSystem(units) === 'imperial' ? IMPERIAL_LENGTH_FT[length] * M_PER_FT : length;
}

/** An imperial stop as words: "500 ft", "0.5 mi", "1 mi". */
function imperialLengthText(length: PointingLineFixedLength): string {
  const m = IMPERIAL_LENGTH_FT[length] * M_PER_FT;
  return IMPERIAL_LENGTH_FT[length] < FT_PER_MI / 2
    ? formatInUnit(m, 'ft', 0)
    : formatInUnit(m, 'mi', 2);
}

/**
 * The length slider's stops as its value reads them, each with its unit (the
 * value shows alone at the slider's end, so a bare "500" or "1000" was
 * ambiguous): "100 m · 250 m · 500 m · 1 km · 2 km · Edge", and in imperial
 * "500 ft · 1000 ft · 0.5 mi · 1 mi · 2 mi · Edge", then "Custom" (its
 * distance is typed in the row that opens under the slider).
 */
export function pointingLineLengthLabels(units: Units): string[] {
  return POINTING_LINE_LENGTHS.map((l) =>
    l === 'edge' ? 'Edge' : l === 'custom' ? 'Custom' : pointingLineLengthText(l, units),
  );
}

export const POINTING_LINE_DIRECTIONS: readonly PointingLineDirection[] = [
  'heading',
  'course',
  'fixed',
];
export const POINTING_LINE_WIDTHS: readonly PointingLineWidth[] = [
  'hairline',
  'thin',
  'medium',
  'bold',
];
export const POINTING_LINE_WIDTH_LABEL: Record<PointingLineWidth, string> = {
  hairline: 'Hairline',
  thin: 'Thin',
  medium: 'Medium',
  bold: 'Bold',
};
/** Stroke width on screen, dp. */
export const POINTING_LINE_WIDTH_DP: Record<PointingLineWidth, number> = {
  hairline: 1,
  thin: 2,
  medium: 3,
  bold: 5,
};

export const POINTING_LINE_TICKS: readonly PointingLineTicks[] = ['off', 10, 50, 100, 'auto'];

/** A fixed tick choice (the persisted value is its metric step). */
export type PointingLineFixedTicks = Exclude<PointingLineTicks, 'off' | 'auto'>;

/**
 * The imperial step each fixed choice stands for, feet: the 1/2/5 × 10ⁿ ft
 * value nearest to the metric step (10 m ≈ 33 ft → 50; 50 m ≈ 164 ft → 200;
 * 100 m ≈ 328 ft → 500). In imperial the ticks fall on round feet, so every
 * label on the line is a round number ("1000 ft", not "820 ft"); the setting
 * itself stays one value, so switching units keeps your choice.
 */
export const IMPERIAL_TICK_FT: Record<PointingLineFixedTicks, number> = {
  10: 50,
  50: 200,
  100: 500,
};

/** A tick choice as its segment reads: "Off", "50 m" / "200 ft", "Auto". */
export function pointingLineTicksLabel(t: PointingLineTicks, units: Units): string {
  if (t === 'off') return 'Off';
  if (t === 'auto') return 'Auto';
  return rulerSystem(units) === 'imperial'
    ? formatInUnit(IMPERIAL_TICK_FT[t] * M_PER_FT, 'ft', 0)
    : formatInUnit(t, 'm', 0);
}

/** The nine colours (mockup §7): red first, then earth, water, stone and paper. */
export const POINTING_LINE_COLORS: readonly { hex: string; name: string }[] = [
  { hex: '#D32F2F', name: 'Red' },
  { hex: '#E8612C', name: 'Orange' },
  { hex: '#F2A900', name: 'Amber' },
  { hex: '#43A047', name: 'Green' },
  { hex: '#00ACC1', name: 'Cyan' },
  { hex: '#1E64C8', name: 'Blue' },
  { hex: '#7E57C2', name: 'Purple' },
  { hex: '#2D3740', name: 'Stone' },
  { hex: '#FBF8F2', name: 'Paper' },
];

/** The line's casing: paper, except under the paper line (stone, or it vanishes on a light map). */
export function pointingLineCasing(color: string): string {
  return color.toUpperCase() === '#FBF8F2' ? '#2D3740' : '#F2ECE0';
}

export const DEFAULT_POINTING_LINE: PointingLineSettings = {
  enabled: false,
  origin: 'you',
  direction: 'heading',
  fixedBearingDeg: 0,
  length: 500,
  customLengthM: DEFAULT_CUSTOM_LENGTH_M,
  color: '#D32F2F',
  width: 'medium',
  ticks: 50,
  labelEvery5th: false,
};

function oneOf<T>(list: readonly T[], value: unknown, fallback: T): T {
  return list.includes(value as T) ? (value as T) : fallback;
}

/** A typed bearing → whole degrees in [0, 360), or null when it is not a number. */
export function parseBearing(raw: unknown): number | null {
  const n = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw)) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.round(normalizeDeg(n)) % 360;
}

/** Settings-file value → settings; every malformed field falls back to its default. */
export function sanitizePointingLine(raw: unknown): PointingLineSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_POINTING_LINE;
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_POINTING_LINE;
  const color =
    typeof r.color === 'string'
      ? POINTING_LINE_COLORS.find((c) => c.hex.toLowerCase() === (r.color as string).toLowerCase())
          ?.hex
      : undefined;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    // An origin a later build added (the centre cursor) reads as You here.
    origin: 'you',
    direction: oneOf(POINTING_LINE_DIRECTIONS, r.direction, d.direction),
    fixedBearingDeg:
      typeof r.fixedBearingDeg === 'number'
        ? (parseBearing(r.fixedBearingDeg) ?? d.fixedBearingDeg)
        : d.fixedBearingDeg,
    length: oneOf(POINTING_LINE_LENGTHS, r.length, d.length),
    customLengthM: clampCustomLengthM(r.customLengthM) ?? d.customLengthM,
    color: color ?? d.color,
    width: oneOf(POINTING_LINE_WIDTHS, r.width, d.width),
    ticks: oneOf(POINTING_LINE_TICKS, r.ticks, d.ticks),
    labelEvery5th: typeof r.labelEvery5th === 'boolean' ? r.labelEvery5th : d.labelEvery5th,
  };
}

/** "062°": a bearing as three digits. */
export function formatFixedBearing(deg: number): string {
  return `${String(Math.round(normalizeDeg(deg)) % 360).padStart(3, '0')}°`;
}

/**
 * A length as the row reads it: "500 m", "1 km", "0.5 mi", "To the edge";
 * Custom as its distance ("750 m", "1.25 km").
 */
export function pointingLineLengthText(
  length: PointingLineLength,
  units: Units = METRIC,
  customLengthM: number = DEFAULT_CUSTOM_LENGTH_M,
): string {
  if (length === 'edge') return 'To the edge';
  if (length === 'custom') return customLengthText(customLengthM, units);
  if (rulerSystem(units) === 'imperial') return imperialLengthText(length);
  return length >= 1000 ? formatInUnit(length, 'km', 2) : formatInUnit(length, 'm', 0);
}

/**
 * The ground length a non-Edge choice draws, metres: a preset in the user's
 * units' round values, or the Custom distance as typed. Null for Edge (it
 * depends on the visible map).
 */
export function pointingLineChoiceM(
  length: PointingLineLength,
  units: Units,
  customLengthM: number = DEFAULT_CUSTOM_LENGTH_M,
): number | null {
  if (length === 'edge') return null;
  if (length === 'custom') return clampCustomLengthM(customLengthM) ?? DEFAULT_CUSTOM_LENGTH_M;
  return pointingLineLengthM(length, units);
}

/**
 * The note under the panel: the line's length is true on the ground, said
 * with the user's current length ("500 m is 500 m", "0.5 mi is 0.5 mi"; Edge:
 * the default stop).
 */
export function pointingLineGroundNote(
  length: PointingLineLength,
  units: Units,
  customLengthM: number = DEFAULT_CUSTOM_LENGTH_M,
): string {
  const len = pointingLineLengthText(length === 'edge' ? 500 : length, units, customLengthM);
  return (
    `Drawn on the map, so ${len} is ${len} on the ground at any zoom. Without a compass it ` +
    'follows your course while you move (COG), and hides when you stop.'
  );
}

/** The preview's caption (mockup): "From you · heading · 500 m · ticks every 50 m". */
export function pointingLineCaption(s: PointingLineSettings, units: Units): string {
  const dir = s.direction === 'fixed' ? formatFixedBearing(s.fixedBearingDeg) : s.direction;
  const len =
    s.length === 'edge' ? 'to the edge' : pointingLineLengthText(s.length, units, s.customLengthM);
  const ticks =
    s.ticks === 'off'
      ? 'no ticks'
      : s.ticks === 'auto'
        ? 'auto ticks'
        : `ticks every ${pointingLineTicksLabel(s.ticks, units)}`;
  return `From you · ${dir} · ${len} · ${ticks}`;
}

/** The row's one-line summary: "500 m along your heading", "To the edge at 062°". */
export function pointingLineSummary(s: PointingLineSettings, units: Units = METRIC): string {
  const how =
    s.direction === 'heading'
      ? 'along your heading'
      : s.direction === 'course'
        ? 'along your course'
        : `at ${formatFixedBearing(s.fixedBearingDeg)}`;
  return `${pointingLineLengthText(s.length, units, s.customLengthM)} ${how}`;
}
