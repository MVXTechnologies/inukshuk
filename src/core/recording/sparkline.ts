/**
 * The expanded recording panel's "elevation so far" sparkline: a long,
 * growing altitude series squeezed into a small box. Pure — the component
 * hands the result to an SVG polyline.
 */

/**
 * Evenly pick at most `max` values, always keeping the first and last (the
 * start and "now" are the two points the eye reads).
 */
export function downsample(values: readonly number[], max: number): number[] {
  if (max < 2 || values.length <= max) return [...values];
  const out: number[] = [];
  const step = (values.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]!);
  return out;
}

/**
 * SVG polyline `points` for the series in a `width` × `height` box, y down,
 * min at the bottom. A flat series draws along the middle; fewer than two
 * finite values draw nothing.
 */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  maxPoints = 120,
): string {
  const series = downsample(
    values.filter((v) => Number.isFinite(v)),
    maxPoints,
  );
  if (series.length < 2) return '';
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min;
  const round = (n: number) => Math.round(n * 10) / 10;
  return series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * width;
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${round(x)},${round(y)}`;
    })
    .join(' ');
}
