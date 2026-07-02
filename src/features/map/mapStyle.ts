import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import type { MapBasemap } from '@state/mapStore';

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
): StyleSpecification {
  const base = baseSource(basemap, tileUrl);
  const style: StyleSpecification = {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: base.tiles,
        tileSize: 256,
        maxzoom: 19,
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

  return style;
}
