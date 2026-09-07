import { isWeatherLayerId, type WeatherLayerId } from '@core/geo/weatherLayers';

import { isSortKey, type SortKey } from '@/library/sortTracks';
import { isTrimPlacement, type TrimPlacement } from '@/trail/TrailFocus';
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
 *
 * The Library/trail parameters below follow the same rule and are written BACK
 * as they change (see {@link syncUrl}), so "the Library, sorted by D+, phone
 * width, on this trail, in light mode" is a link you can paste at someone.
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

  /** Which primary surface is up: the bare map, the Library, one trail, or
   *  the map store. `?screen=store` is accepted as an alias for `?view=store`,
   *  because that is what issue #250 asks for and both are cheap to read. */
  view: 'map' | 'library' | 'trail' | 'store';
  /** Trail id for `view=trail`. */
  trail: string | null;
  /** Library trail ordering. */
  sort: SortKey | null;
  /** Which trim-button placement the trail focus is showing (backlog item 6). */
  trimAt: TrimPlacement | null;
  /** Library panel width: a phone column, or a desktop-wide take. */
  width: 'phone' | 'wide' | null;
  /** Unit system the formatters bind to (see `lib/format.ts`). */
  units: 'metric' | 'imperial' | null;
  /** The map store's facet selection — see {@link StoreUrlState}. */
  store: StoreUrlState;
}

/**
 * The store filter, as query parameters.
 *
 * The whole point of the playground is that a screenshot is a link, and a
 * filter mockup is worth nothing if "two facets applied" cannot be reopened
 * exactly. Multi-select groups are comma lists; the two single-select bounds
 * are the value shown on the chip, in the chip's own unit (km, MB), so the URL
 * reads the way the UI does:
 *
 *     ?view=store&near=500&country=CA&sheet=1
 */
export interface StoreUrlState {
  countries: string[];
  regions: string[];
  /** Scale denominators, e.g. 24000. */
  scales: number[];
  langs: string[];
  /** Radius in km, matching a chip. */
  near: number | null;
  /** Download-size ceiling in MB, matching a chip. */
  maxSizeMb: number | null;
  query: string;
  /** Whether the filter sheet is up. */
  sheet: boolean;
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

  const trail = params.get('trail');
  const rawView = params.get('view') ?? params.get('screen');
  // `?trail=` implies the trail view even without `?view=`, so a link to one
  // trail is as short as it can be.
  const view: UrlState['view'] =
    rawView === 'library' || rawView === 'trail' || rawView === 'map' || rawView === 'store'
      ? rawView
      : trail !== null
        ? 'trail'
        : 'map';

  const rawSort = params.get('sort');
  const sort = rawSort !== null && isSortKey(rawSort) ? rawSort : null;

  const rawTrimAt = params.get('trimAt');
  const trimAt = rawTrimAt !== null && isTrimPlacement(rawTrimAt) ? rawTrimAt : null;

  const rawWidth = params.get('w');
  const width = rawWidth === 'phone' || rawWidth === 'wide' ? rawWidth : null;

  const rawUnits = params.get('units');
  const units = rawUnits === 'metric' || rawUnits === 'imperial' ? rawUnits : null;

  const list = (key: string): string[] => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return [];
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
  };
  const positive = (key: string): number | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const store: StoreUrlState = {
    countries: list('country'),
    regions: list('region'),
    scales: list('scale')
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0),
    langs: list('lang'),
    near: positive('near'),
    maxSizeMb: positive('maxsize'),
    query: params.get('q') ?? '',
    sheet: params.get('sheet') === '1',
  };

  return {
    theme,
    layer,
    center,
    zoom,
    basemap,
    panel,
    view,
    trail: trail === null || trail === '' ? null : trail,
    sort,
    trimAt,
    width,
    units,
    store,
  };
}

/**
 * Push the live view state into the address bar, without a navigation.
 *
 * `replaceState`, not `pushState`: every one of these is a *view* change, and
 * filling the back stack with thirty sort-order steps would make the browser's
 * back button useless for the one thing it is wanted for here — leaving.
 * Parameters set to null are removed rather than written empty, so a default
 * state produces a clean URL.
 */
export function syncUrl(patch: Record<string, string | null>): void {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${query === '' ? '' : `?${query}`}`,
  );
}
