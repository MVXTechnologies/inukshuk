import { NATIVE_MAX_ZOOM } from '@core/geo/tiles';
import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import type { MapBasemap } from '@state/mapStore';
import { MARINE_LAYERS, marineTileUrl, type MarineLayerId } from '@core/geo/marineLayers';
import { trailNetworkTileUrl, type TrailNetworkId } from '@core/geo/trailNetworks';
import type { Feature, Polygon } from 'geojson';

/**
 * Open, key-free DEM tiles (Mapzen/AWS Terrain Tiles) used for hillshade relief
 * and 3D terrain. Terrarium-encoded PNGs; ~zoom 15 max.
 */
const TERRAIN_DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/**
 * Free, key-free raster base layers. Satellite/relief come from Esri's public
 * ArcGIS Online tile services (note the `{z}/{y}/{x}` row/col order). `map` uses
 * the OSM URL injected from settings.
 */
function baseSource(
  basemap: MapBasemap,
  tileUrl: string,
): { tiles: string[]; attribution: string } {
  switch (basemap) {
    case 'satellite':
      return {
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      };
    case 'relief':
      return {
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
        ],
        attribution: 'Topographic © Esri, USGS, NOAA',
      };
    default:
      return { tiles: [tileUrl], attribution: '© OpenStreetMap contributors' };
  }
}

/**
 * The raster tile-URL template ({z}/{x}/{y} or {z}/{y}/{x}) for a basemap — used
 * to fetch a single preview tile without spinning up a whole MapLibre instance.
 */
export function basemapTileUrl(basemap: MapBasemap, tileUrl: string): string {
  return baseSource(basemap, tileUrl).tiles[0] ?? tileUrl;
}

/**
 * Per-basemap raster colour tuning, toward a muted outdoor/topographic look
 * (think AllTrails/Gaia): desaturate the neon OSM palette into natural tones and
 * lift contrast a touch. Satellite is left alone — imagery shouldn't be muted.
 */
const RASTER_PAINT: Partial<Record<MapBasemap, Record<string, number>>> = {
  map: {
    'raster-saturation': -0.25,
    'raster-contrast': 0.06,
    'raster-brightness-min': 0.04,
    'raster-brightness-max': 0.96,
  },
  relief: {
    'raster-saturation': -0.1,
    'raster-contrast': 0.04,
  },
};

/**
 * The 'edge' UI style's pastel treatment: wash the raster toward soft, light
 * tones (heavy desaturation + a lifted black point) so the map reads like a
 * pastel illustration under the pastel chrome. Satellite imagery stays true.
 */
const PASTEL_PAINT: Partial<Record<MapBasemap, Record<string, number>>> = {
  map: {
    // Toward the logo's paper-and-sage palette: strong desaturation with a
    // lifted black point melts OSM's poppy colours into cream/sage pastels
    // that sit naturally next to the Edge chrome.
    'raster-saturation': -0.45,
    'raster-contrast': -0.06,
    'raster-brightness-min': 0.16,
    'raster-brightness-max': 1,
  },
  relief: {
    'raster-saturation': -0.4,
    'raster-contrast': -0.05,
    'raster-brightness-min': 0.13,
  },
};

/** Basemaps that get a shaded-relief hillshade blended under the live 2D map. */
const SHADE_BASEMAPS = new Set<MapBasemap>(['map', 'relief']);

/**
 * The raster SOURCE's `maxzoom` per basemap — the highest zoom at which each
 * tile service reliably serves REAL tiles worldwide. Beyond it MapLibre
 * OVERSCALES the deepest real tiles (blurry but correct) instead of fetching,
 * because the raster LAYERS deliberately carry no `maxzoom` of their own.
 *
 * Esri never 404s past its data: it serves an HTTP-200 grey "Map data not yet
 * available" placeholder tile, which MapLibre happily renders — that's the
 * "white/unavailable" screen users hit when zooming in close. Probed z15–19
 * across rural Québec, Yukon, Patagonia, the Sahara and Siberia (2026-07):
 * World_Imagery is real everywhere through z17; World_Topo_Map only through
 * z15 (Patagonia placeholders start at z16). OSM has real tiles to z19
 * globally. Capping each source below its placeholder zone trades a little
 * sharpness in well-covered areas for never showing "data not available".
 *
 * The caps live in `@core/geo/tiles` because the offline downloader has to obey
 * them too (see `packZoomRange`): a pack may only ever request zooms its
 * source's `maxzoom` allows.
 */

/** Optional tweaks to the base style (all default off). */
export interface OsmStyleOptions {
  /**
   * Cap the base raster source's tile-fetch zoom, e.g. at the top stored zoom
   * of the offline packs when only locally downloaded tiles may be served —
   * past the cap the map overscales the deepest downloaded tiles instead of
   * requesting tiles that can never arrive.
   */
  rasterMaxZoom?: number;
  /**
   * "Locally downloaded only" mask: an opaque fill drawn ABOVE the raster/
   * hillshade layers (but below everything added at runtime — trails, markers,
   * the location dot) hiding the basemap outside downloaded regions. `data` is
   * a world polygon with holes over the downloaded regions (see
   * `buildDownloadedMask`); `color` should suit the app theme.
   */
  downloadedMask?: { data: Feature<Polygon>; color: string };
  /** Pastel raster wash for the 'edge' UI style. */
  pastel?: boolean;
  /** Checked marked-trail databases, each draped as its own tile overlay. */
  markedTrailsNetworks?: readonly TrailNetworkId[];
  /**
   * Checked marine reference layers (CHS NONNA bathymetry / OpenSeaMap
   * seamarks — see `@core/geo/marineLayers`). Network-only like the trail
   * networks: callers must pass [] while `offlineOnly` is on. Catalog order
   * wins regardless of toggle order, so the depth tint always draws under
   * the seamark symbols.
   */
  marineLayers?: readonly MarineLayerId[];
  /**
   * Live weather overlay (ECCC GeoMet WMS via `weatherTileUrl`). Network-only
   * by nature: callers must drop it entirely when `offlineOnly` is on, exactly
   * like `markedTrailsNetworks`.
   *
   * Frame-swap crossfade (wave A item 3): `slots` carries TWO frame URL
   * slots (A/B, null = unused) with `activeSlot` naming the visible one. A
   * frame change stages the incoming URL in the inactive slot at opacity 0 —
   * MapLibre fetches tiles for an opacity-0 layer, so this IS the prefetch —
   * and the caller flips `activeSlot` once the preload window elapses (see
   * `@core/weather/weatherCrossfade`). The outgoing frame stays on screen
   * until the incoming one is ready: no more blank between frames. Both
   * updates flow through the caller's style-memo rebuild as before.
   */
  weather?: {
    slots: readonly [string | null, string | null];
    activeSlot: 0 | 1;
    attribution: string;
    opacity?: number;
  };
  /**
   * Weather-mode basemap muting (weather UX M1, the Windy look): while a
   * weather layer is draped, the basemap steps back — heavy desaturation on
   * the raster plus a semi-opaque neutral "dim" backdrop layered between the
   * basemap and the weather drape, and the shaded-relief hillshade is
   * suppressed (terrain shading under a radar/temperature field is noise).
   *
   * HONEST LIMIT: the base is raster tiles, so a true labels-only minimal
   * style (land/water + city labels) is impossible — labels are baked into
   * the tile pixels. The dim treatment keeps them readable while pushing
   * everything else back. Future work: a vector basemap variant could style
   * a real city-labels-only weather background.
   */
  weatherMuted?: { dimColor: string; dimOpacity: number };
}

/**
 * Weather-mode raster wash: near-grayscale so the weather drape owns the
 * colour space. Applied to every basemap — the "don't mute satellite" rule
 * yields here because under weather the drape IS the content.
 */
const WEATHER_MUTED_PAINT: Record<string, number> = {
  'raster-saturation': -0.85,
  'raster-contrast': -0.08,
};

/**
 * A minimal MapLibre style that renders a raster base layer (OSM streets,
 * satellite imagery, or a topographic relief map — see {@link baseSource}).
 * Raster (not vector) keeps us free of any API key or paid tile service. The OSM
 * tile URL is injected from settings so it can be swapped without touching code.
 *
 * When `terrain3d` is on, a free Terrarium DEM source is added with a hillshade
 * relief layer and a `terrain` spec so the map can be pitched into a 3D relief
 * view (needs network for the DEM tiles).
 */
export function buildOsmStyle(
  tileUrl: string,
  terrain3d = false,
  basemap: MapBasemap = 'map',
  shadedRelief = false,
  options: OsmStyleOptions = {},
): StyleSpecification {
  const base = baseSource(basemap, tileUrl);
  // Requested marine layers in catalog order (bathymetry under seamarks),
  // whatever order the user toggled them in.
  const marine = MARINE_LAYERS.filter((l) => (options.marineLayers ?? []).includes(l.id));
  const style: StyleSpecification = {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: base.tiles,
        tileSize: 256,
        maxzoom: Math.min(NATIVE_MAX_ZOOM[basemap], options.rasterMaxZoom ?? Infinity),
        attribution: base.attribution,
      },
      ...Object.fromEntries(
        (options.markedTrailsNetworks ?? []).map((n) => [
          `wmt-${n}`,
          {
            type: 'raster' as const,
            tiles: [trailNetworkTileUrl(n)],
            tileSize: 256,
            maxzoom: 17,
            attribution: '© Waymarked Trails',
          },
        ]),
      ),
      // Marine reference drapes (marine M3): NONNA bathymetry rides the same
      // WMS-through-a-raster-source mechanism as the weather layers; the
      // seamarks are plain XYZ tiles like the trail networks.
      ...Object.fromEntries(
        marine.map((l) => [
          `marine-${l.id}`,
          {
            type: 'raster' as const,
            tiles: [marineTileUrl(l.id)],
            tileSize: 256,
            maxzoom: l.maxzoom,
            attribution: l.attribution,
          },
        ]),
      ),
    },
    layers: [
      // Warm paper backdrop that shows through while tiles load and at the edges.
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': options.pastel ? '#F2ECE0' : '#E6DFCF' },
      },
      {
        id: 'osm',
        type: 'raster',
        source: 'osm',
        paint: options.weatherMuted
          ? WEATHER_MUTED_PAINT
          : ((options.pastel ? PASTEL_PAINT[basemap] : RASTER_PAINT[basemap]) ?? {}),
      },
      // Marked-trail networks, each its own layer over the basemap (only
      // requested networks get a source — keeps offline packs and 3D drapes
      // free of network-only layers).
      ...(options.markedTrailsNetworks ?? []).map((n) => ({
        id: `marked-trails-${n}`,
        type: 'raster' as const,
        source: `wmt-${n}`,
        paint: { 'raster-opacity': 0.85 },
      })),
      // Marine layers above the trail overlays; the depth tint is dimmed so
      // the basemap's shoreline/labels stay readable through it.
      ...marine.map((l) => ({
        id: `marine-${l.id}`,
        type: 'raster' as const,
        source: `marine-${l.id}`,
        paint: { 'raster-opacity': l.opacity },
      })),
    ],
  };

  // A shaded-relief hillshade derived from the free Terrarium DEM, blended under
  // the live 2D map for the warm topographic look. Kept OFF for offline packs
  // (shadedRelief=false) so the DEM source doesn't bloat downloaded tile pyramids
  // — relief just degrades to flat tiles offline. Skipped in 3D (the real terrain
  // surface adds its own DEM/hillshade below) and for satellite imagery.
  if (shadedRelief && !terrain3d && SHADE_BASEMAPS.has(basemap) && !options.weatherMuted) {
    style.sources.dem = {
      type: 'raster-dem',
      tiles: [TERRAIN_DEM_URL],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
      attribution: 'Elevation © Mapzen / AWS Terrain Tiles',
    };
    style.layers.push({
      id: 'hillshade-2d',
      type: 'hillshade',
      source: 'dem',
      paint: {
        'hillshade-exaggeration': 0.45,
        'hillshade-shadow-color': 'rgba(74, 62, 45, 0.55)',
        'hillshade-highlight-color': 'rgba(255, 250, 240, 0.25)',
        'hillshade-accent-color': 'rgba(120, 105, 80, 0.30)',
        'hillshade-illumination-direction': 335,
      },
    });
  }

  if (terrain3d) {
    style.sources.dem = {
      type: 'raster-dem',
      tiles: [TERRAIN_DEM_URL],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
      attribution: 'Elevation © Mapzen / AWS Terrain Tiles',
    };
    style.layers.push({
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem',
      paint: { 'hillshade-exaggeration': 0.7 },
    });
    style.terrain = { source: 'dem', exaggeration: 2.2 };
  }

  // Weather-mode dim: a semi-opaque neutral BACKGROUND layer above the
  // basemap/overlay rasters and below the weather drape. `background` paints
  // the whole viewport regardless of its position in the layer list, so it
  // works as a "screen" over raster tiles — the only muting available when
  // labels are baked into tile pixels (see the option's doc).
  if (options.weatherMuted) {
    style.layers.push({
      id: 'weather-dim',
      type: 'background',
      paint: {
        'background-color': options.weatherMuted.dimColor,
        'background-opacity': options.weatherMuted.dimOpacity,
      },
    });
  }

  // Weather drape (radar / model fields), above the basemap, trail overlays
  // and hillshade — it's the topmost data layer, only under the offline mask
  // (mutually exclusive with it anyway) and the runtime layers (trails,
  // markers, the location dot) MapLibre appends after the style's own.
  // Two crossfade slots (see the option's doc): the inactive slot prefetches
  // the incoming frame at opacity 0 while the active one keeps the current
  // frame on screen. raster-fade-duration 0: per-tile fades would smear
  // consecutive radar frames into each other (and the swap itself is already
  // covered by the preload).
  if (options.weather) {
    for (const i of [0, 1] as const) {
      const url = options.weather.slots[i];
      if (url === null) continue;
      const id = i === 0 ? 'weather-a' : 'weather-b';
      style.sources[id] = {
        type: 'raster',
        tiles: [url],
        tileSize: 256,
        attribution: options.weather.attribution,
      };
      style.layers.push({
        id,
        type: 'raster',
        source: id,
        paint: {
          'raster-opacity':
            i === options.weather.activeSlot ? (options.weather.opacity ?? 0.62) : 0,
          'raster-fade-duration': 0,
        },
      });
    }
  }

  // "Locally downloaded only" mask, pushed LAST so it sits above every basemap
  // layer (raster + hillshade). Layers the map adds at runtime (trails, the
  // recording line, markers, the location dot) are appended after the style's
  // own layers, so they still draw on top of the mask.
  if (options.downloadedMask) {
    style.sources['downloaded-mask'] = {
      type: 'geojson',
      data: options.downloadedMask.data,
    };
    style.layers.push({
      id: 'downloaded-mask',
      type: 'fill',
      source: 'downloaded-mask',
      paint: { 'fill-color': options.downloadedMask.color, 'fill-opacity': 1 },
    });
  }

  return style;
}
