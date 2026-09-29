/**
 * The personal heatmap's look (#466), shared by the MapLibre layers and the
 * offline PNG preview so both draw the same thing.
 *
 * Street zooms: crisp pass-count lines (see `heatGridLines`) — a single pass
 * is a clearly visible warm line, many passes run hot. Low zooms: a soft glow
 * from the coarse grid, fading out as the lines take over.
 */

/** Pass count → line colour. Opaque on purpose: chained lines meet with round
 * caps, and translucent caps would bead at every joint. */
export type Ramp = readonly (readonly [count: number, color: string])[];

/** Light basemaps: warm orange for one pass, deepening to crimson. */
export const HEAT_LINE_RAMP_LIGHT: Ramp = [
  [1, '#F28E2B'],
  [2, '#EF6A1F'],
  [4, '#E4461A'],
  [8, '#CC2418'],
  [16, '#A8102A'],
  [64, '#7A0636'],
];

/** Dark basemaps: ember for one pass, brightening to near-white hot. */
export const HEAT_LINE_RAMP_DARK: Ramp = [
  [1, '#D9541E'],
  [2, '#F0762A'],
  [4, '#FF9A2E'],
  [8, '#FFC23D'],
  [16, '#FFE47A'],
  [64, '#FFF8D6'],
];

/** Line width (px) by zoom for one pass; more passes add up to +60 %. */
export const HEAT_LINE_WIDTH_STOPS: readonly (readonly [zoom: number, px: number])[] = [
  [9, 0.8],
  [12, 1.6],
  [14, 2.4],
  [16, 3.2],
  [18, 4.5],
];

/** Width multiplier for a pass count (log-scaled, capped). */
export function heatLineWidthFactor(count: number): number {
  return 1 + Math.min(0.6, 0.12 * Math.log2(Math.max(1, count)));
}

/** Lines fade in over these zooms (the glow fades out over the same range). */
export const HEAT_CROSSFADE: readonly [from: number, to: number] = [10, 12.5];

/** Colour for a count, stepping through the ramp (MapLibre `step` semantics). */
export function rampColor(ramp: Ramp, count: number): string {
  let color = ramp[0]?.[1] ?? '#000000';
  for (const [c, col] of ramp) if (count >= c) color = col;
  return color;
}

/** Linear interpolation over zoom stops, clamped (MapLibre `interpolate linear`). */
export function interpolateStops(
  stops: readonly (readonly [number, number])[],
  zoom: number,
): number {
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return 0;
  if (zoom <= first[0]) return first[1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [z1, v1] = stops[i] as readonly [number, number];
    const [z0, v0] = stops[i - 1] as readonly [number, number];
    if (zoom <= z1) return v0 + ((v1 - v0) * (zoom - z0)) / (z1 - z0);
  }
  return last[1];
}

/** Line layer opacity at a zoom (0 below the crossfade, 1 above). */
export function heatLineOpacity(zoom: number): number {
  return interpolateStops(
    [
      [HEAT_CROSSFADE[0], 0.55],
      [HEAT_CROSSFADE[1], 1],
    ],
    zoom,
  );
}

/** Glow layer opacity at a zoom (full below the crossfade, gone above). */
export function heatGlowOpacity(zoom: number): number {
  return interpolateStops(
    [
      [HEAT_CROSSFADE[0], 0.85],
      [HEAT_CROSSFADE[1], 0],
    ],
    zoom,
  );
}

/** Glow kernel radius (px) by zoom. */
export const HEAT_GLOW_RADIUS_STOPS: readonly (readonly [zoom: number, px: number])[] = [
  [6, 2],
  [10, 5],
  [12, 9],
];

/** Glow `heatmap-intensity`. */
export const HEAT_GLOW_INTENSITY = 1.2;

/** Glow `heatmap-weight` for a coarse cell's pass count (log-scaled). */
export function heatGlowWeight(count: number): number {
  return 0.5 + Math.log2(Math.max(1, count)) / 4;
}

/** Glow colour by kernel density: [density, colour, alpha]. A lone pass
 * already reads (alpha 0.45); dense corridors run to the ramp's hot end. */
export function heatGlowColorStops(
  ramp: Ramp,
): readonly (readonly [density: number, color: string, alpha: number])[] {
  const c = (n: number) => rampColor(ramp, n);
  return [
    [0, c(1), 0],
    [0.02, c(1), 0.45],
    [0.25, c(2), 0.65],
    [0.5, c(4), 0.8],
    [0.75, c(8), 0.9],
    [1, c(16), 1],
  ];
}

/**
 * The finger's reach on the heat (px): the glow's radius while the glow is
 * what's drawn; at street zooms the lines are thin and the caller's normal
 * trail tolerance applies.
 */
export function heatTapRadiusPx(zoom: number): number {
  return zoom < HEAT_CROSSFADE[1] ? interpolateStops(HEAT_GLOW_RADIUS_STOPS, zoom) : 0;
}

/** `#rrggbb` + alpha → `rgba(…)` (MapLibre colour string). */
export function rgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
