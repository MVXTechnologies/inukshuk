/**
 * Chart axis geometry: how much room a set of tick labels actually needs.
 *
 * SVG text has no layout pass we can read back synchronously, so the charts
 * used to reserve a FIXED left gutter (40 px) and right-anchor the labels
 * inside it. That silently clips: the labels are anchored at their right edge,
 * so anything wider than the gutter runs off the left of the viewport and the
 * leading glyphs disappear — "10.00 km" rendered as "0.00 km" on the Dashboard
 * the moment a weekly total reached two digits.
 *
 * The fix is to size the gutter from the strings the chart is about to draw.
 * {@link estimateTextWidth} approximates the advance width of a string from a
 * per-character table; {@link axisGutterWidth} turns the widest label into a
 * gutter. The estimate does not have to be exact — it has to be an upper-ish
 * bound for the digits, spaces and unit suffixes our formatters emit, which is
 * a small, known alphabet.
 */

/**
 * Advance widths in em, from Helvetica's metrics. Roboto (Android) and SF /
 * Helvetica (iOS) — the platform defaults react-native-svg falls back to —
 * track these closely; digits are nudged up to Roboto's slightly wider figure
 * so the estimate errs long for the characters axis labels are made of.
 */
const ADVANCE_EM: Readonly<Record<string, number>> = {
  ' ': 0.28,
  '.': 0.28,
  ',': 0.28,
  ':': 0.28,
  '/': 0.28,
  '-': 0.34,
  '–': 0.56,
  '—': 1,
  '+': 0.58,
  '°': 0.4,
  '↑': 0.6,
  '0': 0.58,
  '1': 0.58,
  '2': 0.58,
  '3': 0.58,
  '4': 0.58,
  '5': 0.58,
  '6': 0.58,
  '7': 0.58,
  '8': 0.58,
  '9': 0.58,
  a: 0.56,
  b: 0.56,
  c: 0.5,
  d: 0.56,
  e: 0.56,
  f: 0.28,
  g: 0.56,
  h: 0.56,
  i: 0.23,
  j: 0.23,
  k: 0.5,
  l: 0.23,
  m: 0.84,
  n: 0.56,
  o: 0.56,
  p: 0.56,
  q: 0.56,
  r: 0.34,
  s: 0.5,
  t: 0.28,
  u: 0.56,
  v: 0.5,
  w: 0.73,
  x: 0.5,
  y: 0.5,
  z: 0.5,
  A: 0.67,
  B: 0.67,
  C: 0.72,
  D: 0.72,
  E: 0.67,
  F: 0.61,
  G: 0.78,
  H: 0.72,
  I: 0.28,
  J: 0.5,
  K: 0.67,
  L: 0.56,
  M: 0.84,
  N: 0.72,
  O: 0.78,
  P: 0.67,
  Q: 0.78,
  R: 0.72,
  S: 0.67,
  T: 0.61,
  U: 0.72,
  V: 0.67,
  W: 0.95,
  X: 0.67,
  Y: 0.67,
  Z: 0.61,
};

/** Anything outside the table (accents, CJK, symbols) costs a wide-ish em. */
const FALLBACK_EM = 0.6;

/**
 * Approximate rendered width, in px, of `text` drawn at `fontSize` in the
 * platform's default sans-serif. Monotonic in both arguments; 0 for "".
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0) return 0;
  let em = 0;
  for (const ch of text) em += ADVANCE_EM[ch] ?? FALLBACK_EM;
  return em * fontSize;
}

export interface AxisGutterOptions {
  /** Font size the labels are drawn at. */
  fontSize: number;
  /** Space between the label's right edge and the axis line. Default 5. */
  gap?: number;
  /** Never return less than this, so a short-label axis doesn't collapse. */
  min?: number;
  /**
   * Never return more than this, so a pathological label can't eat the plot.
   * Callers normally pass a fraction of the chart width. Wins over `min`.
   */
  max?: number;
}

/**
 * Width of the left gutter needed to draw `labels` right-anchored against it.
 *
 * The returned value is the x of the axis line: a label drawn at
 * `gutter - gap` with `textAnchor="end"` then starts at x >= 0.
 */
export function axisGutterWidth(
  labels: readonly string[],
  { fontSize, gap = 5, min = 0, max = Number.POSITIVE_INFINITY }: AxisGutterOptions,
): number {
  let widest = 0;
  for (const label of labels) widest = Math.max(widest, estimateTextWidth(label, fontSize));
  const needed = widest > 0 ? Math.ceil(widest + gap) : 0;
  return Math.min(Math.max(needed, min), max);
}
