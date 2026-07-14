import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import type { MapBasemap } from '@state/mapStore';
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

/** Basemaps that get a shaded-relief hillshade blended under the live 2D map. */
const SHADE_BASEMAPS = new Set<MapBasemap>(['map', 'relief']);

/**
 * Highest zoom at which each tile service reliably serves REAL tiles worldwide
 * — the raster SOURCE's `maxzoom`. Beyond it MapLibre OVERSCALES the deepest
 * real tiles (blurry but correct) instead of fetching, because the raster
 * LAYERS deliberately carry no `maxzoom` of their own.
 *
 * Esri never 404s past its data: it serves an HTTP-200 grey "Map data not yet
 * available" placeholder tile, which MapLibre happily renders — that's the
 * "white/unavailable" screen users hit when zooming in close. Probed z15–19
 * across rural Québec, Yukon, Patagonia, the Sahara and Siberia (2026-07):
 * World_Imagery is real everywhere through z17; World_Topo_Map only through
 * z15 (Patagonia placeholders start at z16). OSM has real tiles to z19
 * globally. Capping each source below its placeholder zone trades a little
 * sharpness in well-covered areas for never showing "data not available".
 */
const NATIVE_MAX_ZOOM: Record<MapBasemap, number> = { map: 19, satellite: 17, relief: 15 };

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
}

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
    },
    layers: [
      // Warm paper backdrop that shows through while tiles load and at the edges.
      { id: 'background', type: 'background', paint: { 'background-color': '#E6DFCF' } },
      { id: 'osm', type: 'raster', source: 'osm', paint: RASTER_PAINT[basemap] ?? {} },
    ],
  };

  // A shaded-relief hillshade derived from the free Terrarium DEM, blended under
  // the live 2D map for the warm topographic look. Kept OFF for offline packs
  // (shadedRelief=false) so the DEM source doesn't bloat downloaded tile pyramids
  // — relief just degrades to flat tiles offline. Skipped in 3D (the real terrain
  // surface adds its own DEM/hillshade below) and for satellite imagery.
  if (shadedRelief && !terrain3d && SHADE_BASEMAPS.has(basemap)) {
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
