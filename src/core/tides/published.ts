/**
 * Exact arithmetic on published decimal numbers (strings), for the levels
 * table: a level above chart datum plus the published CD offset gives the
 * same level in another datum (H_X = H_CD + CD_in_X).
 *
 * - Exact: digits are summed as scaled integers, never through binary
 *   fractions ("1.541" + "-0.846" is "0.695", not 0.6950000000000001). Tide
 *   levels are metres with ≤ 4 decimals, far inside 2^53.
 * - Honest precision: the result keeps the FEWER decimals of its two inputs
 *   (a 2-decimal offset can't make a 3-decimal level more precise), rounded
 *   half away from zero.
 */

const NUMBER = /^([-+]?)(\d{1,9})(?:\.(\d{1,6}))?$/;

function parse(text: string): { neg: boolean; int: string; frac: string } | null {
  const m = NUMBER.exec(text.trim().replace('−', '-'));
  if (!m) return null;
  return { neg: m[1] === '-', int: m[2] ?? '0', frac: m[3] ?? '' };
}

export function decimalsOf(text: string): number {
  return parse(text)?.frac.length ?? 0;
}

/** "-1.25" at 3 decimals → -1250 (an exact integer). */
function scaled(text: string, decimals: number): number | null {
  const p = parse(text);
  if (!p) return null;
  const digits = Number(p.int + p.frac.padEnd(decimals, '0'));
  return p.neg ? -digits : digits;
}

function render(v: number, decimals: number): string {
  const neg = v < 0;
  const abs = String(Math.abs(v)).padStart(decimals + 1, '0');
  const int = abs.slice(0, abs.length - decimals);
  const body = decimals > 0 ? `${int}.${abs.slice(abs.length - decimals)}` : int;
  return neg && /[1-9]/.test(body) ? `-${body}` : body;
}

/** a + b, with the fewer decimals of the two; null when either isn't a plain number. */
export function addPublished(a: string, b: string): string | null {
  const da = decimalsOf(a);
  const db = decimalsOf(b);
  const full = Math.max(da, db);
  const out = Math.min(da, db);
  const x = scaled(a, full);
  const y = scaled(b, full);
  if (x === null || y === null) return null;
  const sum = x + y;
  const drop = 10 ** (full - out);
  const rounded = drop === 1 ? sum : Math.sign(sum) * Math.floor((Math.abs(sum) + drop / 2) / drop);
  return render(rounded, out);
}

/** Typographic minus for display ("-0.846" → "−0.846"); copies keep ASCII. */
export function displayNumber(text: string): string {
  return text.startsWith('-') ? `−${text.slice(1)}` : text;
}
