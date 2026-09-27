/**
 * The heatmap glow's radius in screen pixels by zoom (MapLibre
 * `heatmap-radius`, exponential base 1.6). Shared by the layer and the tap
 * test, so a tap anywhere on the visible glow counts: the glow is what the
 * user aims at, not the thin trail line inside it.
 */
export const HEAT_RADIUS_STOPS: readonly (readonly [zoom: number, px: number])[] = [
  [6, 3],
  [10, 8],
  [13, 16],
  [16, 28],
];
const BASE = 1.6;

/** `heatmap-radius` at `zoom`, as MapLibre interpolates it (clamped at the ends). */
export function heatRadiusPx(zoom: number): number {
  const first = HEAT_RADIUS_STOPS[0]!;
  const last = HEAT_RADIUS_STOPS[HEAT_RADIUS_STOPS.length - 1]!;
  if (zoom <= first[0]) return first[1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < HEAT_RADIUS_STOPS.length; i++) {
    const [z1, r1] = HEAT_RADIUS_STOPS[i]!;
    const [z0, r0] = HEAT_RADIUS_STOPS[i - 1]!;
    if (zoom <= z1) {
      // MapLibre's exponential interpolation factor.
      const t = (Math.pow(BASE, zoom - z0) - 1) / (Math.pow(BASE, z1 - z0) - 1);
      return r0 + (r1 - r0) * t;
    }
  }
  return last[1];
}

/** The `heatmap-radius` style expression built from the same stops. */
export function heatRadiusExpression(): (string | number | string[])[] {
  return [
    'interpolate',
    ['exponential', BASE] as unknown as string[],
    ['zoom'],
    ...HEAT_RADIUS_STOPS.flat(),
  ];
}
