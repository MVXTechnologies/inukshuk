import { NATIVE_MAX_ZOOM } from '@core/geo/tiles';
import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import type { MapBasemap } from '@state/mapStore';
import {
  CHART_LAND_COLOR,
  CHART_WATER_COLOR,
  SOUNDING_INK,
  SOUNDING_SHALLOW_INK,
  type SoundingProperties,
} from '@core/geo/depthChart';
import { MARINE_LAYERS, marineTileUrl, type MarineLayerId } from '@core/geo/marineLayers';
import { trailNetworkTileUrl, type TrailNetworkId } from '@core/geo/trailNetworks';
import type { LngLat } from '@core/models';
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';

/**
 * Open, key-free DEM tiles (Mapzen/AWS Terrain Tiles) used for hillshade relief
 * and 3D terrain. Terrarium-encoded PNGs; ~zoom 15 max.
 */
const TERRAIN_DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/**
 * OpenFreeMap vector tiles + glyphs (openfreemap.org): key-free, no usage
 * limits, commercial use explicitly allowed, self-hostable if it ever goes
 * away. Data © OpenStreetMap contributors (schema © OpenMapTiles). Used ONLY
 * for the weather/marine reference overlay below — the basemap stays raster.
 *
 * Chosen over the raster label candidates (verified live 2026-08-09):
 * CARTO's `*_only_labels` tiles render beautifully but CARTO's basemap terms
 * require an Enterprise licence for commercial use; Esri's World Boundaries
 * and Places renders bilingual double labels in Canada and Esri's Web Site &
 * Service ToU limits keyless arcgisonline use to noncommercial. OpenFreeMap
 * is the one candidate that is legally clean with no key — and being vector
 * it adds the water outlines no labels-only raster source carries.
 */
const OFM_GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const OFM_ATTRIBUTION = 'Labels © OpenStreetMap contributors, via OpenFreeMap (© OpenMapTiles)';

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
   * everything else back. Wave B: `overlayLabels` redraws place names and
   * water outlines ABOVE the drape, which is the real fix; the dim stays as
   * the zero-network degradation.
   */
  weatherMuted?: { dimColor: string; dimOpacity: number };
  /**
   * Labels + coastline reference overlay ABOVE the weather/marine drapes
   * (weather wave B, owner: "names and coastlines readable above the
   * colors, like Windy"): OpenFreeMap vector tiles drawn as a transparent
   * reference pass — water outlines (coastlines, lakes, wide rivers) plus
   * halo'd city/town labels — pushed above every drape so saturated colour
   * fields never swallow geography. Adds a `glyphs` endpoint to the style
   * (the raster basemap never needed one). Network-only like the drapes it
   * rides on: callers only set it while a weather or marine layer is on, so
   * the plain map stays byte-identical to today. If the tile/glyph host is
   * unreachable the overlay simply doesn't draw — silent degradation to the
   * dim-only look.
   */
  overlayLabels?: { dark: boolean; tiles: readonly string[] };
  /**
   * Marine chart mode (marine wave D, owner spec 2026-08-09: the iBoating/
   * ENC paper-chart look). While any marine layer is active the whole map
   * restyles as a nautical chart: the basemap raster is muted (streets stay
   * faintly readable), land takes a chart-tan dim, water polygons (from the
   * wave B OpenFreeMap vector source, when resolved) fill flat chart-blue,
   * and the client-rendered NONNA depth-band drape + spot-sounding numbers
   * draw over it — all BELOW the wave B labels overlay, through the style's
   * own layer list (never a GLView, which would re-cover the labels).
   *
   * `drape` is the bands+contours PNG rendered per viewport region
   * (`@core/geo/depthChart` via a file:// ImageSource, the PDF-overlay
   * mechanic); null while unavailable. `wmsFallback` re-enables the legacy
   * pre-coloured CHS WMS drape when the client pipeline failed (silent
   * degrade). `soundings` needs glyphs, so it only draws when the labels
   * overlay resolved.
   */
  marineChart?: {
    drape: { uri: string; coordinates: [LngLat, LngLat, LngLat, LngLat] } | null;
    soundings: FeatureCollection<Point, SoundingProperties> | null;
    wmsFallback: boolean;
    /**
     * Tile template for the fallback bathymetry drape when the ladder
     * (`@core/geo/marineSources`, wave D §D3) landed on a source that only
     * publishes imagery — GEBCO worldwide, NOAA ENC Online in US waters.
     * Null keeps the legacy CHS WMS pair, which is right in Canada.
     */
    rasterUrl?: string | null;
  };
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
 * Tile template for a marine reference drape. The seamark layer is always
 * OpenSeaMap; the bathymetry drape follows the coverage ladder's fallback
 * choice when there is one (wave D §D3) and otherwise stays on the legacy
 * CHS WMS pair.
 */
function marineDrapeUrl(id: MarineLayerId, options: OsmStyleOptions): string {
  if (id !== 'bathymetry') return marineTileUrl(id);
  return options.marineChart?.rasterUrl ?? marineTileUrl(id);
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
  // Requested marine layers in catalog order (bathymetry under seamarks),
  // whatever order the user toggled them in. In chart mode the legacy WMS
  // bathymetry drape only rides as the silent fallback for a failed client
  // pipeline — the band drape replaces it (see the marineChart option).
  const marine = MARINE_LAYERS.filter((l) => (options.marineLayers ?? []).includes(l.id)).filter(
    (l) =>
      l.id !== 'bathymetry' || options.marineChart === undefined || options.marineChart.wmsFallback,
  );
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
            tiles: [marineDrapeUrl(l.id, options)],
            tileSize: 256,
            // A worldwide fallback source is coarse; overscaling it past its
            // own detail is the blockiness wave D removed. The catalog's
            // maxzoom still governs the Canadian WMS pair.
            maxzoom:
              l.id === 'bathymetry' && (options.marineChart?.rasterUrl ?? null) !== null
                ? 12
                : l.maxzoom,
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
        // Chart mode mutes the raster exactly like weather mode: the chart
        // colours own the palette; streets/labels ghost through the tan dim.
        paint:
          options.weatherMuted || options.marineChart
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
      // Chart-tan land dim (marine chart mode): a semi-opaque warm screen
      // over the muted basemap — the paper-chart ground. `background` paints
      // the whole viewport; the water fill + drape re-cover the wet parts.
      ...(options.marineChart
        ? [
            {
              id: 'marine-land-dim',
              type: 'background' as const,
              paint: { 'background-color': CHART_LAND_COLOR, 'background-opacity': 0.62 },
            },
          ]
        : []),
      // Flat chart-blue water fill from the OpenFreeMap vector water
      // polygons (the wave B overlay source — declared below whenever
      // overlayLabels is set): uncharted water reads chart-blue instead of
      // tan, the iBoating overview idiom. Skipped silently when the vector
      // host didn't resolve.
      ...(options.marineChart && options.overlayLabels
        ? [
            {
              id: 'marine-water-fill',
              type: 'fill' as const,
              source: 'overlay-labels',
              'source-layer': 'water',
              paint: { 'fill-color': CHART_WATER_COLOR, 'fill-opacity': 0.88 },
            },
          ]
        : []),
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

  // Client-rendered depth-band drape (marine chart mode): the bands+contours
  // PNG as a georeferenced image source — the PDF-overlay mechanic, placed
  // in the style's own layer list so it stays BELOW the labels overlay and
  // the seamark symbols ride above it. Inserted before `marine-seamarks`
  // when that layer exists.
  if (options.marineChart?.drape) {
    style.sources['marine-depth-chart'] = {
      type: 'image',
      url: options.marineChart.drape.uri,
      coordinates: options.marineChart.drape.coordinates,
    };
    const drapeLayer = {
      id: 'marine-depth-chart',
      type: 'raster' as const,
      source: 'marine-depth-chart',
      // Near-opaque: the bands ARE the chart; a hint of basemap texture
      // ghosts through. fade 0 — re-anchored drapes must swap crisply.
      paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 0 },
    };
    const seamarksIdx = style.layers.findIndex((l) => l.id === 'marine-seamarks');
    if (seamarksIdx >= 0) style.layers.splice(seamarksIdx, 0, drapeLayer);
    else style.layers.push(drapeLayer);
  }

  // A shaded-relief hillshade derived from the free Terrarium DEM, blended under
  // the live 2D map for the warm topographic look. Kept OFF for offline packs
  // (shadedRelief=false) so the DEM source doesn't bloat downloaded tile pyramids
  // — relief just degrades to flat tiles offline. Skipped in 3D (the real terrain
  // surface adds its own DEM/hillshade below) and for satellite imagery.
  if (
    shadedRelief &&
    !terrain3d &&
    SHADE_BASEMAPS.has(basemap) &&
    !options.weatherMuted &&
    // Chart mode: terrain shading under a nautical chart is noise.
    !options.marineChart
  ) {
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

  // Labels + coastline reference overlay, ABOVE the dim and the weather/
  // marine drapes (see the option's doc). Water outlines first, then towns,
  // then cities — MapLibre renders symbol collisions top-layer-first, so
  // cities win crowded spots. Text colours follow the app theme: the drape
  // colours are the same in both, but the dim backdrop under them is
  // theme-matched, so ink/halo polarity flips with it.
  if (options.overlayLabels) {
    const { dark } = options.overlayLabels;
    style.glyphs = OFM_GLYPHS_URL;
    // maplibre-native silently drops a vector source declared via TileJSON
    // `url` (gl-js loads the identical style fine), so the caller resolves
    // the TileJSON in JS and hands concrete templates in — see
    // useOverlayLabelTiles.
    style.sources['overlay-labels'] = {
      type: 'vector',
      tiles: [...options.overlayLabels.tiles],
      minzoom: 0,
      maxzoom: 14,
      attribution: OFM_ATTRIBUTION,
    };
    const ink = dark ? '#FFFFFF' : '#20303C';
    const halo = dark ? 'rgba(12, 16, 20, 0.92)' : 'rgba(255, 255, 255, 0.94)';
    // Spot soundings (marine chart mode): sparse depth numbers over the
    // band drape, chart-style — small dark digits, shallow (hazard) values
    // in chart blue and sorted first so they win collisions. Pushed BEFORE
    // the place labels so towns/cities take crowded spots (MapLibre resolves
    // symbol collisions top-layer-first). Needs the glyphs endpoint this
    // block just set, which is why soundings only draw when the labels
    // overlay resolved.
    if (options.marineChart?.soundings) {
      style.sources['marine-soundings'] = {
        type: 'geojson',
        data: options.marineChart.soundings,
      };
      style.layers.push({
        id: 'marine-soundings',
        type: 'symbol',
        source: 'marine-soundings',
        minzoom: 9,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9.5, 13, 11, 16, 12.5],
          'text-allow-overlap': false,
          'symbol-sort-key': ['get', 'sort'],
        },
        paint: {
          'text-color': ['case', ['==', ['get', 'shallow'], 1], SOUNDING_SHALLOW_INK, SOUNDING_INK],
          'text-halo-color': 'rgba(255, 255, 255, 0.85)',
          'text-halo-width': 1,
        },
      });
    }
    style.layers.push(
      {
        id: 'overlay-water-line',
        type: 'line',
        source: 'overlay-labels',
        'source-layer': 'water',
        paint: {
          'line-color': dark ? 'rgba(160, 200, 228, 0.62)' : 'rgba(38, 76, 112, 0.60)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.1, 14, 1.7],
        },
      },
      {
        id: 'overlay-town-labels',
        type: 'symbol',
        source: 'overlay-labels',
        'source-layer': 'place',
        minzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', ['town', 'village']]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 14, 13.5],
          'text-max-width': 8,
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: {
          'text-color': ink,
          'text-halo-color': halo,
          'text-halo-width': 1.4,
          'text-halo-blur': 0.4,
        },
      },
      {
        id: 'overlay-city-labels',
        type: 'symbol',
        source: 'overlay-labels',
        'source-layer': 'place',
        minzoom: 3,
        filter: ['==', ['get', 'class'], 'city'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11.5, 8, 13, 12, 16],
          'text-max-width': 8,
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: {
          'text-color': ink,
          'text-halo-color': halo,
          'text-halo-width': 1.6,
          'text-halo-blur': 0.4,
        },
      },
    );
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
