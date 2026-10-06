/**
 * The playground's two themes.
 *
 * The owner runs his phone in dark mode and checks both, so every surface here
 * is defined twice and nothing is allowed to exist only in one.
 *
 * `dimColor`/`dimOpacity` are NOT playground inventions — they are lifted
 * verbatim from `MapScreen.tsx`, where they are the weather-mode basemap mute
 * (see `OsmStyleOptions.weatherMuted` in `src/features/map/mapStyle.ts`). The
 * point of this app is to judge changes against the shipped baseline, so the
 * baseline numbers get copied exactly rather than re-eyeballed.
 */

export type ThemeName = 'dark' | 'light';

export interface Theme {
  name: ThemeName;
  dark: boolean;
  /** Weather-mode basemap dim — verbatim from MapScreen.tsx:477-478. */
  dimColor: string;
  dimOpacity: number;
  /** OpenFreeMap style for the PLAIN map (no weather drape). */
  basemapStyle: string;
  /** OpenFreeMap style used while a weather drape is up. */
  mutedBasemapStyle: string;
}

/**
 * Two cartographies per theme, and the pair is the point.
 *
 * The app does exactly this, by a different mechanism. Its basemap is raster,
 * so "weather mode" applies `raster-saturation: -0.85` to the tile pixels —
 * near-grayscale — plus the dim, and it does so ONLY while a drape is up
 * (`OsmStyleOptions.weatherMuted`). The plain map keeps its full colour.
 *
 * A vector basemap has no global saturation knob, so the same decision has to
 * be expressed as a choice of cartography. Measured off the published style
 * JSON, the neutral pair is the honest match:
 *
 *   liberty  #f8f4f0 bg / rgb(158,189,255) water  — full colour  (plain)
 *   positron rgb(242,243,240) / rgb(194,200,202)  — near-neutral (muted)
 *   fiord    #45516E bg / #38435C water           — blue         (plain)
 *   dark     rgb(12,12,12) / rgb(27,27,29)        — near-neutral (muted)
 *
 * Using the colourful style under a drape was visibly wrong: fiord's blue land
 * under the wind ramp's blues produced a saturated blue wash the app never
 * shows, because the app's basemap is grey by then.
 */
export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    name: 'dark',
    dark: true,
    dimColor: '#101418',
    dimOpacity: 0.45,
    basemapStyle: 'fiord',
    mutedBasemapStyle: 'dark',
  },
  light: {
    name: 'light',
    dark: false,
    dimColor: '#F4F1EC',
    dimOpacity: 0.38,
    basemapStyle: 'liberty',
    mutedBasemapStyle: 'positron',
  },
};

export const OPENFREEMAP_STYLE_URL = (style: string): string =>
  `https://tiles.openfreemap.org/styles/${style}`;
