/**
 * Visual tuning for the weather map — the shared LOOK constants.
 *
 * Sibling of `windLook.ts`, which holds the wind-particle-specific numbers.
 * Everything here is pure data with the review history that produced it, kept
 * in `@core` for the same reason `WIND_DRAPE_OPACITY` is: the style builder
 * (`src/features/map/mapStyle.ts`), the drape component (`MapScreen`) and the
 * web playground all render from these numbers, and a value that lives in one
 * of them gets silently copied into the others and then drifts.
 *
 * NOTE: the Weather and Marine features are currently PARKED behind
 * `@core/features/flags`. These constants still drive the reference overlay
 * the map style builds, so they stay live; parking is not un-parked by
 * anything in this file.
 */

/**
 * `raster-opacity` for every weather colour drape EXCEPT wind.
 *
 * The shared default. Wind runs lighter (see `WIND_DRAPE_OPACITY` in
 * `windLook.ts`, 0.30) because it is the only layer that also draws its own
 * ink — the particle streaks — on top of the drape; every other layer is the
 * drape alone and needs this much to read as colour over a muted basemap.
 */
export const WEATHER_DRAPE_OPACITY = 0.62;

/**
 * Ink for the reference overlay that redraws geography ABOVE the colour
 * drapes (`overlayLabels`).
 *
 * Owner review, 2026-08-13: with a weather layer running you could not tell
 * where the coast was — "it should be much easier to differentiate coasts and
 * features, have lines thicker". The previous treatment was a single hairline
 * at ~0.6 alpha, which loses twice over: once against the drape (a
 * full-spectrum colour ramp — no single ink reads over all of it) and again
 * against the wind particle field drawn on top of the whole map.
 *
 * So each reference line is a CASING + CORE pair in opposite polarity. The
 * pair brings its own contrast, so it reads identically over blue, green or
 * magenta drape, and the casing doubles as separation from the white streaks.
 * Alphas are high on purpose: this overlay only exists while a drape is up,
 * and under a drape "subtle" means "invisible".
 *
 * Polarity follows the theme, matching the label ink/halo the style builder
 * picks alongside it: dark ink on a light casing in light theme, and the
 * reverse in dark.
 */
export const WEATHER_REFERENCE_INK = {
  light: {
    coast: 'rgba(11, 45, 74, 0.95)',
    road: 'rgba(60, 48, 38, 0.80)',
    casing: 'rgba(255, 255, 255, 0.85)',
    casingAdd: 2.6,
  },
  dark: {
    coast: 'rgba(190, 224, 248, 0.95)',
    road: 'rgba(236, 222, 200, 0.78)',
    casing: 'rgba(6, 11, 16, 0.85)',
    casingAdd: 2.6,
  },
} as const;

/** Core stroke width at zooms 5 / 10 / 14; the style interpolates between them. */
export interface ReferenceLineWidths {
  z5: number;
  z10: number;
  z14: number;
}

/**
 * Core stroke widths by zoom for the reference lines, roughly double the
 * hairlines they replace (water was 0.6/1.1/1.7). Water carries the shape of
 * the land so it leads; roads stay a step behind it so the coast still wins
 * the eye when the two run together along a waterfront.
 */
export const WATER_LINE_W: ReferenceLineWidths = { z5: 1.4, z10: 2.4, z14: 3.4 };
export const ROAD_LINE_W: ReferenceLineWidths = { z5: 0.8, z10: 1.4, z14: 2.2 };
