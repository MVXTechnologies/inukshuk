/**
 * The map's terrain options (#461): how early named summits appear, and how
 * strongly the shaded relief is drawn. Pure data + decisions — the style
 * builders (`stoneStyle.ts`, `features/map/mapStyle.ts`) turn them into
 * layers, the settings store persists the choice.
 */

/** How early named summits appear on the map. */
export type PeakDensity = 'fewer' | 'normal' | 'more';

export const PEAK_DENSITIES: readonly PeakDensity[] = ['fewer', 'normal', 'more'];

/**
 * The default. The owner found peaks appearing too late on the original
 * elevation ladder (#461), so the default shows every summit one zoom level
 * earlier than that ladder; `fewer` is the original ladder.
 */
export const DEFAULT_PEAK_DENSITY: PeakDensity = 'normal';

/**
 * Zoom levels EARLIER than its elevation-ladder zoom (the `rank` each summit
 * carries in our peaks tiles) at which a summit is drawn.
 */
export const PEAK_LEAD: Readonly<Record<PeakDensity, number>> = { fewer: 0, normal: 1, more: 2 };

/**
 * The largest lead any setting asks for. The peaks tileset puts every summit
 * in the tiles this many zooms before its rank (`PEAK_MAX_LEAD` in
 * `infra/tiles/nas/peaks_geojson.py` — keep the two equal), so the style can
 * pick any lead up to it without a rebuild.
 */
export const PEAK_MAX_LEAD = 2;

export function isPeakDensity(v: unknown): v is PeakDensity {
  return typeof v === 'string' && (PEAK_DENSITIES as readonly string[]).includes(v);
}

/** Shaded-relief (hillshade) strength; `none` draws no hillshade at all. */
export type ShadingLevel = 'none' | 'light' | 'medium' | 'heavy';
/** The strengths that draw something. */
export type HillshadeStrength = Exclude<ShadingLevel, 'none'>;

export const SHADING_LEVELS: readonly ShadingLevel[] = ['none', 'light', 'medium', 'heavy'];
export const HILLSHADE_STRENGTHS: readonly HillshadeStrength[] = ['light', 'medium', 'heavy'];

/** The pre-#461 look (exaggeration 0.45). */
export const DEFAULT_HILLSHADE_STRENGTH: HillshadeStrength = 'medium';

export function isHillshadeStrength(v: unknown): v is HillshadeStrength {
  return typeof v === 'string' && (HILLSHADE_STRENGTHS as readonly string[]).includes(v);
}

/** The one-word labels the settings UI shows. */
export const PEAK_DENSITY_LABEL: Readonly<Record<PeakDensity, string>> = {
  fewer: 'Fewer',
  normal: 'Normal',
  more: 'More',
};
export const SHADING_LABEL: Readonly<Record<ShadingLevel, string>> = {
  none: 'None',
  light: 'Light',
  medium: 'Medium',
  heavy: 'Heavy',
};

/** MapLibre hillshade paint values for one strength and theme. */
export interface HillshadeLook {
  exaggeration: number;
  shadowColor: string;
  highlightColor: string;
  accentColor: string;
}

/**
 * Hillshade paint for a strength. Light maps shade with a warm umber and
 * lift sunlit slopes with a paper-white; the stone-night map has no light
 * paper to darken toward brown, so it shades in near-black and keeps the
 * highlight faint (a bright highlight washes a dark map grey).
 */
export function hillshadeLook(strength: HillshadeStrength, dark: boolean): HillshadeLook {
  const k = { light: 0, medium: 1, heavy: 2 }[strength];
  const exaggeration = [0.25, 0.45, 0.75][k]!;
  if (dark) {
    const shadow = [0.55, 0.75, 0.9][k]!;
    const highlight = [0.06, 0.1, 0.14][k]!;
    return {
      exaggeration,
      shadowColor: `rgba(0, 0, 0, ${shadow})`,
      highlightColor: `rgba(235, 228, 214, ${highlight})`,
      accentColor: `rgba(0, 0, 0, ${[0.15, 0.25, 0.35][k]!})`,
    };
  }
  const shadow = [0.4, 0.55, 0.75][k]!;
  const highlight = [0.18, 0.25, 0.32][k]!;
  return {
    exaggeration,
    shadowColor: `rgba(74, 62, 45, ${shadow})`,
    highlightColor: `rgba(255, 250, 240, ${highlight})`,
    accentColor: `rgba(120, 105, 80, ${[0.2, 0.3, 0.4][k]!})`,
  };
}
