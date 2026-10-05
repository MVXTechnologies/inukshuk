/**
 * Convert's input parsing and output formatting.
 *
 * Input is parsed strictly (like `@core/geo/parseCoords`: a value we can't
 * read with certainty is refused, never guessed), and every parsed value
 * carries its PRECISION — what the last typed digit is worth in metres — so
 * the accuracy panel can say "6 decimals ≈ ±0.1 m".
 *
 * Output keeps millimetre digits (metres to 3 decimals, degrees to 9) and
 * groups thousands with narrow spaces the way agencies print them.
 */

export type AngleFormat = 'dd' | 'ddm' | 'dms';

const M_PER_DEG = 111_320;

export interface ParsedValue {
  value: number;
  /** Metres the last typed digit is worth. */
  precisionM: number;
}

function normalize(s: string): string {
  return s
    .replace(/[º˚]/g, '°')
    .replace(/[′’´`]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/''/g, '"')
    .replace(/−/g, '-')
    .replace(/[()]/g, ' ')
    .replace(/,/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const decimalsOf = (t: string): number => {
  const i = t.indexOf('.');
  return i < 0 ? 0 : t.length - i - 1;
};

/**
 * One latitude or longitude: "46.851168", "-71.238585", "71.238585° W",
 * "46 51 04.2048 N", "46°51.0701'N". Refuses a hemisphere letter of the
 * wrong axis, a sign with a hemisphere, minutes/seconds ≥ 60, and anything
 * outside ±90 / ±180.
 */
export function parseAngle(text: string, axis: 'lat' | 'lon'): ParsedValue | null {
  const s = normalize(text);
  if (s === '') return null;
  const m =
    /^([+-])?\s*(\d+(?:\.\d*)?)\s*°?\s*(?:(\d+(?:\.\d*)?)\s*'?\s*(?:(\d+(?:\.\d*)?)\s*"?)?)?\s*([NSEW])?$/.exec(
      s,
    );
  const pre = /^([NSEW])\s*(.*)$/.exec(s);
  if (!m && pre) {
    const inner = parseAngle(`${pre[2] ?? ''} ${pre[1] ?? ''}`, axis);
    return inner;
  }
  if (!m) return null;
  const [, sign, dT = '', mT, sT, hemi] = m;
  if (sign && hemi) return null;
  if (hemi && (axis === 'lat') !== (hemi === 'N' || hemi === 'S')) return null;
  const d = Number(dT);
  const min = mT !== undefined ? Number(mT) : 0;
  const sec = sT !== undefined ? Number(sT) : 0;
  if (mT !== undefined && dT.includes('.')) return null;
  if (sT !== undefined && mT?.includes('.')) return null;
  if (min >= 60 || sec >= 60) return null;
  let v = d + min / 60 + sec / 3600;
  if (sign === '-' || hemi === 'S' || hemi === 'W') v = -v;
  if (axis === 'lat' ? Math.abs(v) > 90 : Math.abs(v) > 180) return null;
  const last = sT ?? mT ?? dT;
  const unitDeg = sT !== undefined ? 1 / 3600 : mT !== undefined ? 1 / 60 : 1;
  const precisionM = 10 ** -decimalsOf(last) * unitDeg * M_PER_DEG;
  return { value: v, precisionM };
}

/** A plain metric value (E, N, height, X/Y/Z): "248 476.150", "-3.127". */
export function parseMetres(text: string): ParsedValue | null {
  const s = normalize(text).replace(/ /g, '').replace(/M$/, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  return { value: Number(s), precisionM: 10 ** -decimalsOf(s) };
}

/** A coordinate epoch: a decimal year, 1990–2100. */
export function parseEpoch(text: string): number | null {
  const s = normalize(text);
  if (!/^\d{4}(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  return v >= 1990 && v <= 2100 ? v : null;
}

/** Thousands in narrow no-break spaces: 5190447.241 → "5 190 447.241". */
export function group(text: string): string {
  const m = /^([-+]?)(\d+)(\.\d*)?$/.exec(text);
  if (!m) return text;
  const [, sign = '', int = '', frac = ''] = m;
  return `${sign}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${frac}`;
}

/** Metres with mm, grouped: "248 476.115". */
export function formatMetres(v: number, decimals = 3): string {
  return group(v.toFixed(decimals)).replace(/^-/, '−');
}

/** Degrees: DD (9 decimals ≈ 0.1 mm), DDM or DMS, with the hemisphere letter. */
export function formatAngle(v: number, axis: 'lat' | 'lon', fmt: AngleFormat = 'dd'): string {
  const hemi = axis === 'lat' ? (v >= 0 ? 'N' : 'S') : v >= 0 ? 'E' : 'W';
  const a = Math.abs(v);
  if (fmt === 'dd') return `${a.toFixed(9)}° ${hemi}`;
  let d = Math.floor(a);
  if (fmt === 'ddm') {
    let mins = (a - d) * 60;
    if (Number(mins.toFixed(7)) >= 60) {
      d += 1;
      mins = 0;
    }
    return `${d}° ${mins.toFixed(7).padStart(10, '0')}′ ${hemi}`;
  }
  let mm = Math.floor((a - d) * 60);
  let ss = ((a - d) * 60 - mm) * 60;
  if (Number(ss.toFixed(5)) >= 60) {
    ss = 0;
    mm += 1;
  }
  if (mm >= 60) {
    mm = 0;
    d += 1;
  }
  return `${d}° ${String(mm).padStart(2, '0')}′ ${ss.toFixed(5).padStart(8, '0')}″ ${hemi}`;
}

/** Height with sign and unit: "24.487 m", "−21.680 m". */
export function formatHeight(v: number): string {
  return `${formatMetres(v)} m`;
}
