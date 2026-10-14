/**
 * Settings › Display › Pin size (#686): one multiplier over every waypoint
 * pin on the map, on top of each pin's own S/M/L/XL. It feeds the pin
 * symbols' `icon-size` (and so their offsets, which MapLibre multiplies by
 * it), the label offset, the tap and long-press hit discs (`pinHitTest`), the
 * cluster radius and the cluster disc (`waypointClusters`).
 *
 * Persisted as a whole percentage (`pinScale: 100`). Anything else read back
 * (an older build's junk, a hand-edited file, a step a later build retired)
 * is 100 %.
 *
 * PURE: no React Native / Expo imports.
 */

export const PIN_SCALES = [75, 100, 125, 150] as const;
export type PinScale = (typeof PIN_SCALES)[number];
export const DEFAULT_PIN_SCALE: PinScale = 100;

export function isPinScale(v: unknown): v is PinScale {
  return (PIN_SCALES as readonly unknown[]).includes(v);
}

/** A stored value as a step: itself when it is one, 100 % otherwise. */
export function normalizePinScale(v: unknown): PinScale {
  return isPinScale(v) ? v : DEFAULT_PIN_SCALE;
}

/** The multiplier a step stands for (125 → 1.25); junk is 1. */
export function pinScaleFactor(v: unknown): number {
  return normalizePinScale(v) / 100;
}

/** "125 %": the row's description and the segments' labels. */
export function pinScaleLabel(v: PinScale): string {
  return `${v} %`;
}
