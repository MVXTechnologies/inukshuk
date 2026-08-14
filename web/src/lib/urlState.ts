import { isWeatherLayerId, type WeatherLayerId } from '@core/geo/weatherLayers';

import type { ThemeName } from '@/ui/theme';

/**
 * Read the opening state out of the query string.
 *
 * This exists because the playground's job is to settle arguments about how
 * things LOOK, and an argument needs two captures of the same place. A URL that
 * pins theme + layer + camera makes a capture reproducible and a comparison
 * shareable:
 *
 *     ?theme=light&layer=wind&at=-71.2075,46.8139,10.4
 *
 * `layer=off` is spelled out rather than left as an empty value so "no weather"
 * is an explicit, linkable state instead of "the parameter is missing".
 *
 * Everything is optional and everything degrades: a junk value is ignored and
 * the stored preference (or the default) wins. `isWeatherLayerId` is the app's
 * own guard, so this can never name a layer the catalog doesn't have.
 */
export interface UrlState {
  theme: ThemeName | null;
  layer: WeatherLayerId | null | 'unset';
  center: [number, number] | null;
  zoom: number | null;
  /** Override the theme's OpenFreeMap cartography, e.g. `?basemap=positron`. */
  basemap: string | null;
  /** Open a side drawer on load, e.g. `?panel=catalog`. */
  panel: 'catalog' | 'tracks' | null;
}

/** The OpenFreeMap styles worth comparing. Anything else is ignored. */
const BASEMAPS = new Set(['liberty', 'bright', 'positron', 'dark', 'fiord']);

export function readUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);

  const rawTheme = params.get('theme');
  const theme: ThemeName | null = rawTheme === 'dark' || rawTheme === 'light' ? rawTheme : null;

  const rawLayer = params.get('layer');
  let layer: WeatherLayerId | null | 'unset' = 'unset';
  if (rawLayer === 'off' || rawLayer === 'none') layer = null;
  else if (rawLayer !== null && isWeatherLayerId(rawLayer)) layer = rawLayer;

  let center: [number, number] | null = null;
  let zoom: number | null = null;
  const at = params.get('at');
  if (at !== null) {
    const parts = at.split(',').map(Number);
    const [lng, lat, z] = parts;
    if (
      lng !== undefined &&
      lat !== undefined &&
      Number.isFinite(lng) &&
      Number.isFinite(lat) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      center = [lng, lat];
      if (z !== undefined && Number.isFinite(z) && z >= 0 && z <= 22) zoom = z;
    }
  }

  const rawBasemap = params.get('basemap');
  const basemap = rawBasemap !== null && BASEMAPS.has(rawBasemap) ? rawBasemap : null;

  const rawPanel = params.get('panel');
  const panel = rawPanel === 'catalog' || rawPanel === 'tracks' ? rawPanel : null;

  return { theme, layer, center, zoom, basemap, panel };
}
