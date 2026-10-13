import type { Units } from '@core/format';
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
/** Ground length in metres, or to the edge of the visible map. */
export type PointingLineLength = 100 | 250 | 500 | 1000 | 2000 | 'edge';
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
  /** One of {@link POINTING_LINE_COLORS}. */
  color: string;
  width: PointingLineWidth;
  ticks: PointingLineTicks;
  /** Label every 5th tick with its distance from you. */
  labelEvery5th: boolean;
}

export const POINTING_LINE_LENGTHS: readonly PointingLineLength[] = [
  100,
  250,
  500,
  1000,
  2000,
  'edge',
];
/** The length slider's stop labels (mockup: "100 m · 250 · 500 · 1 km · 2 km · Edge"). */
export const POINTING_LINE_LENGTH_LABELS: readonly string[] = [
  '100 m',
  '250',
  '500',
  '1 km',
  '2 km',
  'Edge',
];

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
  return units === 'imperial' ? `${IMPERIAL_TICK_FT[t]} ft` : `${t} m`;
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

/** A length as the row reads it: "500 m", "1 km", "To the edge". */
export function pointingLineLengthText(length: PointingLineLength): string {
  if (length === 'edge') return 'To the edge';
  return length >= 1000 ? `${length / 1000} km` : `${length} m`;
}

/** The preview's caption (mockup): "From you · heading · 500 m · ticks every 50 m". */
export function pointingLineCaption(s: PointingLineSettings, units: Units): string {
  const dir = s.direction === 'fixed' ? formatFixedBearing(s.fixedBearingDeg) : s.direction;
  const len = s.length === 'edge' ? 'to the edge' : pointingLineLengthText(s.length);
  const ticks =
    s.ticks === 'off'
      ? 'no ticks'
      : s.ticks === 'auto'
        ? 'auto ticks'
        : `ticks every ${pointingLineTicksLabel(s.ticks, units)}`;
  return `From you · ${dir} · ${len} · ${ticks}`;
}

/** The row's one-line summary: "500 m along your heading", "To the edge at 062°". */
export function pointingLineSummary(s: PointingLineSettings): string {
  const how =
    s.direction === 'heading'
      ? 'along your heading'
      : s.direction === 'course'
        ? 'along your course'
        : `at ${formatFixedBearing(s.fixedBearingDeg)}`;
  return `${pointingLineLengthText(s.length)} ${how}`;
}
