/**
 * The slope layer's options (#723, mockup B1–B4, Option 2 "combined"): the
 * steepness window, an aspect selection (8 sectors) and an altitude range.
 * Where a slope's sector AND altitude AND steepness match it draws in full
 * colour; other steep ground fades to a faint trace (`slopeOverlayIndexed`).
 *
 * Persisted as `terrainSlopeFilter` (a {@link SlopeFilter}); the steepness
 * window keeps its own two keys. Defaults: all 8 aspects, no altitude bounds
 * (no filter). Everything the UI says about them is worded here.
 */
import { ASPECT_SECTORS } from '@core/geo/slopeField';
import { NO_SLOPE_FILTER, slopeFilterActive, type SlopeFilter } from '@core/geo/terrainAnalysis';
import { fromElevationUnit, groupThousands, toElevationUnit, type Units } from '@core/format/units';

export const ALL_ASPECTS = 0xff;
export const DEFAULT_SLOPE_MIN_DEG = 27;
export const DEFAULT_SLOPE_MAX_DEG = 90;
export const DEFAULT_SLOPE_FILTER: SlopeFilter = NO_SLOPE_FILTER;

/** Plausible ground (m): Dead Sea shore to above Everest. */
const ALT_FLOOR_M = -500;
const ALT_CEIL_M = 9000;

function altOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= ALT_FLOOR_M && v <= ALT_CEIL_M
    ? v
    : null;
}

/** A persisted filter, field by field; anything unusable falls back to "no filter". */
export function sanitizeSlopeFilter(raw: unknown): SlopeFilter {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_SLOPE_FILTER;
  const r = raw as Record<string, unknown>;
  const mask =
    typeof r.aspectMask === 'number' &&
    Number.isInteger(r.aspectMask) &&
    r.aspectMask >= 0 &&
    r.aspectMask <= ALL_ASPECTS
      ? r.aspectMask
      : ALL_ASPECTS;
  let minAltM = altOrNull(r.minAltM);
  let maxAltM = altOrNull(r.maxAltM);
  if (minAltM !== null && maxAltM !== null && minAltM > maxAltM) {
    [minAltM, maxAltM] = [maxAltM, minAltM];
  }
  return { aspectMask: mask, minAltM, maxAltM };
}

export function aspectSelected(mask: number, sector: number): boolean {
  return ((mask >> sector) & 1) === 1;
}

/** Tap a petal: that sector in or out. */
export function toggleAspect(mask: number, sector: number): number {
  return (mask ^ (1 << sector)) & ALL_ASPECTS;
}

/** Tap the hub: all eight, or none when all are on. */
export function toggleAllAspects(mask: number): number {
  return (mask & ALL_ASPECTS) === ALL_ASPECTS ? 0 : ALL_ASPECTS;
}

/**
 * The selection in words, clockwise from the start of a run so a contiguous
 * arc reads in order: "NW · N · NE", "W · NW · N"; "All aspects", "No aspect".
 */
export function aspectSelectionLabel(mask: number): string {
  const m = mask & ALL_ASPECTS;
  if (m === ALL_ASPECTS) return 'All aspects';
  if (m === 0) return 'No aspect';
  // First run start clockwise from N: a selected sector whose predecessor isn't.
  let start = 0;
  for (let k = 0; k < 8; k++) {
    if (aspectSelected(m, k) && !aspectSelected(m, (k + 7) % 8)) {
      start = k;
      break;
    }
  }
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    const k = (start + i) % 8;
    if (aspectSelected(m, k)) out.push(ASPECT_SECTORS[k] ?? '');
  }
  return out.join(' · ');
}

/** The window as the slider shows it: "30–90°". */
export function steepnessLabel(minDeg: number, maxDeg: number): string {
  return `${minDeg}–${maxDeg}°`;
}

/** The window as the legend chip says it: "≥30°", or "30–45°" when capped. */
export function steepnessShort(minDeg: number, maxDeg: number): string {
  return maxDeg >= 90 ? `≥${minDeg}°` : steepnessLabel(minDeg, maxDeg);
}

/**
 * The altitude bounds in words, as the slider reads them: "800–1 150 m",
 * "800 m+" (no upper limit), "0–1 150 m" (no lower limit), '' (no filter).
 */
export function altitudeLabel(f: SlopeFilter, units: Units): string {
  const v = (m: number) => groupThousands(Math.round(toElevationUnit(m, units)));
  if (f.minAltM === null && f.maxAltM === null) return '';
  if (f.maxAltM === null) return `${v(f.minAltM ?? 0)} ${units.elevation}+`;
  return `${f.minAltM === null ? '0' : v(f.minAltM)}–${v(f.maxAltM)} ${units.elevation}`;
}

/** The Slope row's hint in Map layers › Terrain: "NW · N · NE · 30–90° · 800–1 150 m". */
export function slopeRowHint(
  minDeg: number,
  maxDeg: number,
  filter: SlopeFilter,
  units: Units,
): string {
  return [
    aspectSelectionLabel(filter.aspectMask),
    steepnessLabel(minDeg, maxDeg),
    altitudeLabel(filter, units),
  ]
    .filter((s) => s !== '')
    .join(' · ');
}

/** The map's legend chip (mockup B4 option 2): bold aspects, quiet "≥30° · 800–1 150 m". */
export function slopeLegendText(
  minDeg: number,
  maxDeg: number,
  filter: SlopeFilter,
  units: Units,
): { title: string; detail: string } {
  return {
    title: aspectSelectionLabel(filter.aspectMask),
    detail: [steepnessShort(minDeg, maxDeg), altitudeLabel(filter, units)]
      .filter((s) => s !== '')
      .join(' · '),
  };
}

/** The legend chip shows while the slope layer is on and filtered. */
export function showSlopeLegend(slopeOn: boolean, filter: SlopeFilter): boolean {
  return slopeOn && slopeFilterActive(filter);
}

/** Everything at its default (Reset has nothing to do). */
export function slopeSettingsAreDefault(minDeg: number, maxDeg: number, f: SlopeFilter): boolean {
  return (
    minDeg === DEFAULT_SLOPE_MIN_DEG &&
    maxDeg === DEFAULT_SLOPE_MAX_DEG &&
    (f.aspectMask & ALL_ASPECTS) === ALL_ASPECTS &&
    f.minAltM === null &&
    f.maxAltM === null
  );
}

/** Lowest and highest ground (m) of the area the slope job last computed. */
export interface ElevationRange {
  minM: number;
  maxM: number;
}

/**
 * The altitude scale's unit of growth, in display units: 500 m, or 1 500 ft.
 * The scale's top is a multiple of it, and each "+" tap adds one.
 */
export function altitudeScaleChunk(units: Units): number {
  return units.elevation === 'ft' ? 1500 : 500;
}

/** Slider step: 10 m, or 50 ft. */
export function altitudeStep(units: Units): number {
  return units.elevation === 'ft' ? 50 : 10;
}

/** The altitude slider in display units: its scale (always from 0), thumbs and step. */
export interface AltitudeSlider {
  /** Always 0: a thumb there is "no lower limit". */
  min: number;
  /** The scale's top: a thumb there is "and above" (no upper limit). */
  max: number;
  lo: number;
  hi: number;
  step: number;
}

/**
 * The altitude slider (owner, 2026-10-15: the scale never caps the user).
 * It runs from 0 to the computed area's highest ground rounded UP to the next
 * 500 m (1 500 ft), never below one chunk; each "+" tap (`extraChunks`) adds
 * a chunk; and it never shrinks below a bound already set (a bound at the
 * very top would read "and above", so the scale keeps a chunk of room).
 */
export function altitudeSlider(
  f: SlopeFilter,
  range: ElevationRange | null,
  units: Units,
  extraChunks = 0,
): AltitudeSlider {
  const chunk = altitudeScaleChunk(units);
  const ground = toElevationUnit(range?.maxM ?? 0, units);
  const base = Math.max(chunk, Math.ceil(ground / chunk) * chunk);
  const setTop = Math.max(
    f.maxAltM === null ? -Infinity : toElevationUnit(f.maxAltM, units),
    f.minAltM === null ? -Infinity : toElevationUnit(f.minAltM, units),
  );
  const fitted = setTop >= base ? (Math.floor(setTop / chunk) + 1) * chunk : base;
  // "+" grows the scale from its area-given base; a bound set out there keeps it.
  const max = Math.max(fitted, base + Math.max(0, Math.floor(extraChunks)) * chunk);
  const at = (m: number) => Math.max(0, Math.min(max, Math.round(toElevationUnit(m, units))));
  return {
    min: 0,
    max,
    lo: f.minAltM === null ? 0 : at(f.minAltM),
    hi: f.maxAltM === null ? max : at(f.maxAltM),
    step: altitudeStep(units),
  };
}

/** The scale's end labels under the slider: "0" and "1 500 m+". */
export function altitudeScaleLabels(max: number, units: Units): [string, string] {
  return ['0', `${groupThousands(max)} ${units.elevation}+`];
}

/**
 * The slider's value label (display units): "Any altitude" with both thumbs
 * at the ends (no filter), "800 m+" at the top, else "800–1 150 m".
 */
export function altitudeSliderValue(lo: number, hi: number, max: number, units: Units): string {
  if (lo <= 0 && hi >= max) return 'Any altitude';
  return hi >= max
    ? `${groupThousands(lo)} ${units.elevation}+`
    : `${groupThousands(lo)}–${groupThousands(hi)} ${units.elevation}`;
}

/** Slider thumbs back to stored bounds (m, 0.1 m): 0 is no lower limit, the top no upper limit. */
export function altitudeFromSlider(
  lo: number,
  hi: number,
  slider: Pick<AltitudeSlider, 'min' | 'max'>,
  units: Units,
): Pick<SlopeFilter, 'minAltM' | 'maxAltM'> {
  const m = (v: number) => Math.round(fromElevationUnit(v, units) * 10) / 10;
  return {
    minAltM: lo <= slider.min ? null : m(lo),
    maxAltM: hi >= slider.max ? null : m(hi),
  };
}
