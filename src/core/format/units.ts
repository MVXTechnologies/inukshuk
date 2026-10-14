/**
 * Display units (#702): the ONE place that turns metres, metres per second
 * and metres of height into text.
 *
 * The user picks two things in Settings › Units:
 *
 * - a **distance** unit — kilometres, statute miles or nautical miles — which
 *   also sets speed (km/h, mph, kn) and pace (min/km, min/mi, min/NM);
 * - an **elevation** unit — metres or feet — for heights, climbs, depths.
 *
 * Short distances fall back to a small unit, so nobody reads "0.04 km":
 *
 * | distance | below                     | reads in                  |
 * | -------- | ------------------------- | ------------------------- |
 * | km       | 1000 m (after rounding)   | metres                    |
 * | mi       | 1000 ft (after rounding)  | feet                      |
 * | NM       | 0.1 NM (one cable, 185 m) | the elevation unit (m/ft) |
 *
 * Feet, not yards, for miles: US trail signs, USGS maps, Garmin and Google
 * Maps all count the last stretch in feet; yards survive mostly on golf
 * courses. For nautical miles the short unit is the user's own height unit:
 * on the water short ranges are called in whatever the chart's soundings use
 * (metres on Canadian/European charts, feet on US ones), and the cable is a
 * naval relic few recreational sailors read — "120 m" beats "0.6 cbl".
 *
 * Pure: the units are always an argument (see `@core/format`'s note on the
 * old `displayUnits` global). Every unit label the app prints comes from
 * here; `src/core/format/unitStrings.test.ts` keeps it that way.
 */

/** A long-distance unit: kilometres, statute miles, nautical miles. */
export type DistanceUnit = 'km' | 'mi' | 'nmi';
/** A height unit: metres or feet. */
export type ElevationUnit = 'm' | 'ft';
/** The unit short distances fall back to. */
export type SmallDistanceUnit = 'm' | 'ft';
/** Speed follows distance: km/h, mph, knots. */
export type SpeedUnit = 'km/h' | 'mph' | 'kn';

/** The user's display units. Immutable: change it by replacing it. */
export interface Units {
  readonly distance: DistanceUnit;
  readonly elevation: ElevationUnit;
}

export const METRIC: Units = Object.freeze({ distance: 'km', elevation: 'm' });
export const IMPERIAL: Units = Object.freeze({ distance: 'mi', elevation: 'ft' });
export const NAUTICAL: Units = Object.freeze({ distance: 'nmi', elevation: 'm' });

export const DISTANCE_UNITS: readonly DistanceUnit[] = ['km', 'mi', 'nmi'];
export const ELEVATION_UNITS: readonly ElevationUnit[] = ['m', 'ft'];

export const M_PER_FT = 0.3048;
export const M_PER_MI = 1609.344;
export const M_PER_NMI = 1852;
export const FT_PER_MI = 5280;

const M_PER: Record<DistanceUnit | SmallDistanceUnit, number> = {
  km: 1000,
  mi: M_PER_MI,
  nmi: M_PER_NMI,
  m: 1,
  ft: M_PER_FT,
};

const LABEL: Record<DistanceUnit, string> = { km: 'km', mi: 'mi', nmi: 'NM' };
const NAME: Record<DistanceUnit, string> = {
  km: 'kilometre',
  mi: 'mile',
  nmi: 'nautical mile',
};
const SPEED: Record<DistanceUnit, SpeedUnit> = { km: 'km/h', mi: 'mph', nmi: 'kn' };

// ---------------------------------------------------------------------------
// Conversions and labels
// ---------------------------------------------------------------------------

/** Metres in one of `unit`. */
export function metresPer(unit: DistanceUnit | SmallDistanceUnit): number {
  return M_PER[unit];
}

/** Metres → the unit's count: `toUnit(1852, 'nmi') === 1`. */
export function toUnit(meters: number, unit: DistanceUnit | SmallDistanceUnit): number {
  return meters / M_PER[unit];
}

/** The unit's count → metres: `fromUnit(1, 'mi') === 1609.344`. */
export function fromUnit(value: number, unit: DistanceUnit | SmallDistanceUnit): number {
  return value * M_PER[unit];
}

/** The printed label: "km", "mi", "NM". */
export function distanceUnitLabel(unit: DistanceUnit): string {
  return LABEL[unit];
}

/** Any unit's printed label, short units included: "m", "ft", "km", "mi", "NM". */
export function unitLabel(unit: DistanceUnit | SmallDistanceUnit): string {
  return unit === 'm' || unit === 'ft' ? unit : LABEL[unit];
}

/** The unit in words, lower case: "kilometre", "mile", "nautical mile". */
export function distanceUnitName(unit: DistanceUnit): string {
  return NAME[unit];
}

/** The unit short distances read in (see the table at the top). */
export function smallDistanceUnit(units: Units): SmallDistanceUnit {
  if (units.distance === 'km') return 'm';
  if (units.distance === 'mi') return 'ft';
  return units.elevation;
}

/**
 * The ruler a short-range drawing is graduated in (the pointing line's
 * stops and ticks): metric for km, imperial for miles, and for nautical
 * miles whichever the short unit is.
 */
export function rulerSystem(units: Units): 'metric' | 'imperial' {
  return smallDistanceUnit(units) === 'ft' ? 'imperial' : 'metric';
}

/** The speed unit that goes with the distance unit. */
export function speedUnit(units: Units): SpeedUnit {
  return SPEED[units.distance];
}

/** m/s → the speed unit's count: 10 m/s → 36 km/h, 22.37 mph, 19.44 kn. */
export function toSpeedUnit(mps: number, units: Units): number {
  return (mps * 3600) / M_PER[units.distance];
}

/** Metres → the elevation unit's count. */
export function toElevationUnit(meters: number, units: Units): number {
  return units.elevation === 'ft' ? meters / M_PER_FT : meters;
}

/** The elevation unit's count → metres. */
export function fromElevationUnit(value: number, units: Units): number {
  return units.elevation === 'ft' ? value * M_PER_FT : value;
}

/**
 * Temperatures in °F: only for the US customary pair (miles AND feet). The
 * distance unit alone can't say it — a Briton reads miles and °C, a sailor
 * nautical miles and °C, a pilot feet and °C.
 */
export function usesFahrenheit(units: Units): boolean {
  return units.distance === 'mi' && units.elevation === 'ft';
}

/** Same units? (Objects from settings are compared by value.) */
export function sameUnits(a: Units, b: Units): boolean {
  return a.distance === b.distance && a.elevation === b.elevation;
}

// ---------------------------------------------------------------------------
// Settings: parse, migrate, default
// ---------------------------------------------------------------------------

const isDistanceUnit = (v: unknown): v is DistanceUnit =>
  typeof v === 'string' && (DISTANCE_UNITS as readonly string[]).includes(v);
const isElevationUnit = (v: unknown): v is ElevationUnit =>
  typeof v === 'string' && (ELEVATION_UNITS as readonly string[]).includes(v);

/**
 * A persisted units value, validated: the current `{ distance, elevation }`
 * object, or the pre-#702 single switch (`'metric'` / `'imperial'`), which
 * migrates to km + m / mi + ft. Anything else is `null` (use the default).
 */
export function sanitizeUnits(raw: unknown): Units | null {
  if (raw === 'metric') return METRIC;
  if (raw === 'imperial') return IMPERIAL;
  if (typeof raw !== 'object' || raw === null) return null;
  const { distance, elevation } = raw as { distance?: unknown; elevation?: unknown };
  if (!isDistanceUnit(distance) || !isElevationUnit(elevation)) return null;
  return { distance, elevation };
}

/** Regions whose everyday units are miles and feet. */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

/**
 * The first-launch default from a BCP 47 locale ("en-US", "fr-CA",
 * "es-Latn-US"): miles and feet in the United States (and Liberia and
 * Myanmar, the other two), metric everywhere else and when unknown.
 */
export function defaultUnitsForLocale(locale: string | null | undefined): Units {
  if (typeof locale !== 'string') return METRIC;
  // The region is the 2-letter (or 3-digit) subtag after the language/script.
  const region = locale
    .split(/[-_]/)
    .slice(1)
    .find((p) => /^([A-Za-z]{2}|\d{3})$/.test(p));
  return region !== undefined && IMPERIAL_REGIONS.has(region.toUpperCase()) ? IMPERIAL : METRIC;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** A formatted quantity split for layouts that set the unit smaller. */
export interface Quantity {
  value: string;
  unit: string;
}

const join = (q: Quantity): string => `${q.value} ${q.unit}`;

/** Narrow no-break space thousands grouping: 12345 → "12 345". */
export function groupThousands(n: number): string {
  const [int = '', frac] = String(n).split('.');
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  return frac === undefined ? g : `${g}.${frac}`;
}

/** Round, folding −0 into 0 so nothing ever reads "-0 m". */
function roundTo(value: number, step: number): number {
  const r = Math.round(value / step) * step;
  return r === 0 ? 0 : r;
}

/**
 * How many decimals the long unit gets:
 *
 * - `precise` — the live HUD, navigation, measuring: 2 decimals below 10,
 *   1 above ("1.23 km", "12.3 mi");
 * - `tenths` — lists and stats: 1 decimal below 100, whole above
 *   ("11.2 km", "142 km");
 * - `short` — cards and glances: 1 decimal below 10, whole above
 *   ("4.2 NM", "17 km").
 */
export type DistanceStyle = 'precise' | 'tenths' | 'short';

const TIERS: Record<DistanceStyle, { below: number; hi: number; lo: number }> = {
  precise: { below: 10, hi: 2, lo: 1 },
  tenths: { below: 100, hi: 1, lo: 0 },
  short: { below: 10, hi: 1, lo: 0 },
};

export interface DistanceOptions {
  /** Decimals in the long unit (default `precise`). */
  style?: DistanceStyle;
  /** Round the short unit to this step (10: "350 m", not "347 m"). Default 1. */
  smallStep?: number;
}

/** A number in the long unit, decimals per the style, never "10.0" in a 1-decimal-below-10 tier. */
function longValue(v: number, style: DistanceStyle): string {
  const t = TIERS[style];
  let decimals = v < t.below ? t.hi : t.lo;
  if (decimals === t.hi && Number(v.toFixed(decimals)) >= t.below) decimals = t.lo;
  return decimals === 0 ? groupThousands(Math.round(v)) : v.toFixed(decimals);
}

/** The short-unit reading if `meters` is short in these units, else null. */
function smallParts(meters: number, units: Units, step: number): Quantity | null {
  const small = smallDistanceUnit(units);
  const n = roundTo(toUnit(meters, small), step);
  const short =
    units.distance === 'nmi'
      ? meters < M_PER_NMI / 10 // one cable
      : n < 1000; // the rounded value: [999.5, 1000) is long, never "1000 m"
  return short ? { value: String(n), unit: small } : null;
}

/** A distance as value + unit: "840" "m", "1.23" "km", "0.32" "NM". */
export function distanceParts(meters: number, units: Units, options?: DistanceOptions): Quantity {
  const m = Number.isFinite(meters) && meters > 0 ? meters : 0;
  const small = smallParts(m, units, options?.smallStep ?? 1);
  if (small) return small;
  return {
    value: longValue(toUnit(m, units.distance), options?.style ?? 'precise'),
    unit: LABEL[units.distance],
  };
}

/** Metres → "840 m", "1.23 km", "999 ft", "0.19 mi", "120 m" / "0.32 NM". */
export function formatDistance(meters: number, units: Units, options?: DistanceOptions): string {
  return join(distanceParts(meters, units, options));
}

/** A distance that is always in the long unit, whole: "12 km", "1 234 mi". */
export function formatWholeDistance(meters: number, units: Units): string {
  const m = Number.isFinite(meters) && meters > 0 ? meters : 0;
  return `${groupThousands(Math.round(toUnit(m, units.distance)))} ${LABEL[units.distance]}`;
}

/**
 * A round value in a fixed unit, trailing zeros dropped — the labels of
 * rulers whose unit is already decided (scale bar, ticks, length stops):
 * "500 m", "0.5 mi", "2 NM", "2500 ft".
 */
export function formatInUnit(
  meters: number,
  unit: DistanceUnit | SmallDistanceUnit,
  maxDecimals = 2,
): string {
  const v = Number(toUnit(Number.isFinite(meters) ? meters : 0, unit).toFixed(maxDecimals));
  return `${v === 0 ? 0 : v} ${unitLabel(unit)}`;
}

/** A point along a trail, as a kilometre marker reads: "km 3.2", "mi 2.0", "NM 1.7". */
export function formatDistanceMarker(meters: number, units: Units): string {
  const m = Number.isFinite(meters) && meters > 0 ? meters : 0;
  return `${LABEL[units.distance]} ${toUnit(m, units.distance).toFixed(1)}`;
}

/** A short distance, always in the short unit: "12 m" / "39 ft". */
export function formatSmallDistance(meters: number, units: Units): string {
  const small = smallDistanceUnit(units);
  const m = Number.isFinite(meters) && meters > 0 ? meters : 0;
  return `${groupThousands(roundTo(toUnit(m, small), 1))} ${small}`;
}

/** A position's accuracy: "±5 m" / "±16 ft" (at least 1, never "±0"). */
export function formatAccuracy(meters: number, units: Units): string {
  const small = smallDistanceUnit(units);
  const m = Number.isFinite(meters) && meters > 0 ? meters : 0;
  return `±${Math.max(1, Math.round(toUnit(m, small)))} ${small}`;
}

export interface ElevationOptions {
  /** Round to this step in the display unit (10: "≈1 850 m"). Default 1. */
  step?: number;
  /** Narrow-space thousands grouping ("4 049 ft"). Default false. */
  grouped?: boolean;
  /** Decimals instead of whole units (a tide or a wave height: "1.2 m"). */
  decimals?: number;
}

/**
 * A height as value + unit: "1234" "m", "4049" "ft", "−430" "m". Negative
 * heights (below the datum, a depth) keep a true minus sign; −0 is "0".
 */
export function elevationParts(meters: number, units: Units, options?: ElevationOptions): Quantity {
  const unit = units.elevation;
  if (!Number.isFinite(meters)) return { value: '0', unit };
  const v = toElevationUnit(meters, units);
  let text: string;
  if (options?.decimals !== undefined && options.decimals > 0) {
    text = Math.abs(v).toFixed(options.decimals);
    if (Number(text) === 0) return { value: text, unit };
  } else {
    const r = Math.abs(roundTo(v, options?.step ?? 1));
    if (r === 0) return { value: '0', unit };
    text = options?.grouped === true ? groupThousands(r) : String(r);
  }
  return { value: v < 0 ? `−${text}` : text, unit };
}

/** Metres → "1234 m" / "4049 ft" / "−430 m". */
export function formatElevation(meters: number, units: Units, options?: ElevationOptions): string {
  return join(elevationParts(meters, units, options));
}

/**
 * A climb or a drop: "+120 m" / "−85 m". Zero (after rounding) carries no
 * sign — "0 m", never "+0 m" or "−0 m".
 */
export function formatElevationChange(
  meters: number,
  direction: 'up' | 'down',
  units: Units,
): string {
  const text = formatElevation(Math.abs(meters), units);
  if (/^0 /.test(text)) return text;
  return `${direction === 'up' ? '+' : '−'}${text}`;
}

/** m/s → "4.2" "km/h" / "2.6" "mph" / "2.3" "kn" (negative and junk read 0.0). */
export function speedParts(mps: number, units: Units): Quantity {
  const v = Number.isFinite(mps) && mps > 0 ? toSpeedUnit(mps, units) : 0;
  return { value: v.toFixed(1), unit: SPEED[units.distance] };
}

/** m/s → "4.2 km/h" / "2.6 mph" / "2.3 kn". */
export function formatSpeed(mps: number, units: Units): string {
  return join(speedParts(mps, units));
}

/** "/km", "/mi", "/NM": the pace suffix. */
export function paceSuffix(units: Units): string {
  return `/${LABEL[units.distance]}`;
}

/**
 * m/s → "6:00/km", "9:39/mi", "5:24/NM". "—" when not moving (≤ 0.1 m/s)
 * or slower than 99 minutes per unit.
 */
export function formatPace(mps: number, units: Units): string {
  if (!Number.isFinite(mps) || mps <= 0.1) return '—';
  const secPerUnit = M_PER[units.distance] / mps;
  if (secPerUnit > 99 * 60) return '—';
  const total = Math.round(secPerUnit);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}${paceSuffix(units)}`;
}
