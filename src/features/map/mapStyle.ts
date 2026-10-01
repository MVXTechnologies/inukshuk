import { NIGHT_MAP } from '@ui/tokens';
import { NATIVE_MAX_ZOOM, type PackFormat } from '@core/geo/tiles';
import type {
  FilterSpecification,
  LayerSpecification,
  LineLayerSpecification,
  StyleSpecification,
} from '@maplibre/maplibre-react-native';
import type { MapBasemap } from '@state/mapStore';
import { CHART_LAND_COLOR, CHART_WATER_COLOR } from '@core/geo/depthChart';
import { drapeAnchorLayer } from '@core/geo/mapLayerStack';
import {
  drawsImageryLabels,
  drawsShadedRelief,
  drawsTiltRelief,
  SLOT_ANCHOR,
  stackLayers,
  type MapLayerSlot,
} from '@core/map/layerSlots';
import { MARINE_LAYERS, marineTileUrl, type MarineLayerId } from '@core/geo/marineLayers';
import {
  ROAD_LINE_W,
  WATER_LINE_W,
  WEATHER_REFERENCE_INK,
  type ReferenceLineWidths,
} from '@core/weather/weatherLook';
import type { Feature, Polygon } from 'geojson';
import { VECTOR_BASEMAP_ENABLED } from '@core/features/flags';
import {
  buildStoneImagerySlots,
  buildStoneLayers,
  type StoneContourSource,
  STONE_FONTS_ATKINSON,
  STONE_FONTS_NOTO,
} from '@core/map/stoneStyle';
import {
  DEFAULT_HILLSHADE_STRENGTH,
  hillshadeLook,
  type HillshadeStrength,
  type PeakDensity,
} from '@core/map/terrainOptions';
import { MAP_MAX_PITCH_DEG, tiltReliefLook, type TiltRelief } from '@core/map/tiltRelief';
import { imageryStoneScheme, stoneScheme } from './stoneScheme';

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
 * What a new offline pack of the `map` basemap stores: our vector base map once
 * `VECTOR_BASEMAP_ENABLED` is on (the OSM tile policy forbids offline packs of
 * its raster tiles), the OSM raster until then. Satellite stays raster.
 */
export const MAP_PACK_FORMAT: PackFormat = VECTOR_BASEMAP_ENABLED ? 'vector' : 'raster';

/** The vector base map's data: OSM via our Protomaps extract. */
const PROTOMAPS_ATTRIBUTION = '© OpenStreetMap contributors · Protomaps';
/** Source id of the served contour tiles on the vector base map. */
export const VECTOR_CONTOURS_SOURCE = 'basemap-contours';
/** Source id of our worldwide named-summits tiles on the vector base map. */
export const VECTOR_PEAKS_SOURCE = 'basemap-peaks';
/** Source id of the vector base map (see `OsmStyleOptions.vectorBasemap`). */
export const VECTOR_BASEMAP_SOURCE = 'basemap-vector';

/**
 * Free, key-free raster base layers. Satellite comes from Esri's public
 * ArcGIS Online tile service (note the `{z}/{y}/{x}` row/col order). `map` uses
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
    default:
      return { tiles: [tileUrl], attribution: '© OpenStreetMap contributors' };
  }
}

/**
 * The short credit the attribution chip shows for a basemap (bottom-right of
 * the map, revamp `Main.html`). MapLibre's own attribution button stays off
 * (it crowded the map); Settings › System info carries the full credits roll.
 */
export function basemapAttribution(basemap: MapBasemap, vector = false): string {
  switch (basemap) {
    case 'satellite':
      // `vector`: our OSM names, roads and trails ride the imagery (#492).
      return vector ? '© Esri, Maxar · © OpenStreetMap' : '© Esri, Maxar';
    default:
      // The vector base is OSM data cut by Protomaps' pipeline.
      return vector ? '© OpenStreetMap · Protomaps' : '© OpenStreetMap';
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
};

/** Basemaps that get a shaded-relief hillshade blended under the live 2D map. */
const SHADE_BASEMAPS = new Set<MapBasemap>(['map']);

/**
 * Camera zoom below which the 2D shaded relief is not drawn — and, because
 * MapLibre only keeps a source loaded while some layer using it is in range,
 * below which the DEM is not even FETCHED (#230).
 *
 * The owner reported map hitching on zoom-out on iOS while satellite
 * (the one basemap with no hillshade) stayed smooth. Zooming out does not put
 * more DEM tiles on screen — a viewport needs the same ~15 of them at z8 as at
 * z12 — it crosses pyramid LEVELS, and every level crossed is a fresh set of
 * Terrarium PNGs to fetch, decode and hillshade-prepare. Measured with
 * {@link zoomOutTileLoad} on a 440x956 phone viewport, one z15 -> z8 pinch-out
 * cost 105 DEM tiles as shipped in 1.5.0; the gate alone drops that to 60,
 * with a hard zero under z11 (a 512-px declaration halved it again, until
 * #461 — see {@link HILLSHADE_2D_DEM_TILE_SIZE}).
 *
 * z11 is roughly "a whole mountain range on screen", where a hillshade carries
 * almost no information anyway — so this is a free win on every platform, not
 * an iOS-only workaround.
 */
export const HILLSHADE_2D_MIN_ZOOM = 11;

/** The 2D shaded relief's layer id, and its Terrarium DEM source's id. */
export const HILLSHADE_2D_LAYER_ID = 'hillshade-2d';
export const HILLSHADE_DEM_SOURCE_ID = 'dem';
/** The shaded relief's light: from the north-north-west, as on paper maps. */
export const HILLSHADE_ILLUMINATION_DIRECTION = 335;
/**
 * The tilted-map relief pass (#480): a second hillshade stacked right on the
 * base shading. It ships HIDDEN in the style (visibility none, exaggeration
 * 0) carrying its colours; MapScreen adopts it with a same-id component
 * `<Layer>` that only switches it on and sets the exaggeration from the
 * settled pitch — a paint change in place, where a style change would reload
 * everything. The colours must live here: this MapLibre Native types the
 * hillshade shadow/highlight colours `array<color>`, which no component prop
 * can express on Android (see `tiltReliefLayer`).
 */
export const TILT_RELIEF_LAYER_ID = 'hillshade-tilt';

/**
 * Whether a style draws the 2D shaded relief — i.e. has the DEM source and
 * the layer that the tilted-map relief pass anchors to (#480). The
 * gate lives in {@link buildOsmStyle} (shading on, a shade-able basemap, no
 * weather dim, no marine chart); reading the built style keeps callers from
 * having to mirror it.
 */
export function styleHasHillshade(style: StyleSpecification): boolean {
  return (
    style.sources[HILLSHADE_DEM_SOURCE_ID] !== undefined &&
    style.layers.some((l) => l.id === HILLSHADE_2D_LAYER_ID)
  );
}

/** Whether a style carries the (hidden) tilted-map relief pass (#480). */
export function styleHasTiltRelief(style: StyleSpecification): boolean {
  // Not tied to the flat shading: over satellite the pass stands alone (#492).
  return (
    style.sources[HILLSHADE_DEM_SOURCE_ID] !== undefined &&
    style.layers.some((l) => l.id === TILT_RELIEF_LAYER_ID)
  );
}

/**
 * Tile size DECLARED for the 2D shaded-relief DEM source: the Terrarium PNGs'
 * true 256 px.
 *
 * MapLibre's zoom is defined against a 512-px canonical tile, so a 256
 * declaration is asked for one level DEEPER than the camera (camera z13
 * fetches DEM z14). #230 declared 512 instead — a quarter of the tiles — on
 * the bet that half the DEM sample rate was invisible under the basemap. It
 * was not: each DEM sample then spanned ~5 device pixels on a phone and the
 * shading read as stepped, blocky facets (#461, owner on a Samsung). The
 * true size restores the full sample rate; the z11 gate still keeps the
 * zoomed-out views (where the tile count bites) free of DEM traffic, and iOS
 * — where #230's stutter was seen — defaults the shading off.
 *
 * Same as the 3D terrain DEM below, where the DEM is the geometry.
 */
export const HILLSHADE_2D_DEM_TILE_SIZE = 256;

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
   * Declared tile size for the base raster source, in POINTS. Zoom is defined
   * against {@link CANONICAL_TILE_PX} (512), so under-declaring makes MapLibre
   * fetch deeper: 256 fetches one level past the camera, 128 fetches two —
   * four times the tiles and four times the pixels.
   *
   * Default 256, which is right for a 1x screen and soft on a 3x one: MapLibre
   * does not raise RASTER tile zoom for device pixel ratio the way it does for
   * vector, so one 256-point tile is stretched over ~768 device pixels and the
   * baked-in labels go mushy. The map maker's editor passes 128 while it is
   * open — sharpness is the whole point of a WYSIWYG sheet — and the rest of
   * the app keeps today's tile budget.
   */
  rasterTileSize?: number;
  /**
   * "Locally downloaded only" mask: an opaque fill drawn ABOVE the raster/
   * hillshade layers (but below everything added at runtime — trails, markers,
   * the location dot) hiding the basemap outside downloaded regions. `data` is
   * a world polygon with holes over the downloaded regions (see
   * `buildDownloadedMask`); `color` should suit the app theme.
   */
  downloadedMask?: { data: Feature<Polygon>; color: string };
  /**
   * Night red (decision 4): the raster goes greyscale and dim, under the red
   * veil MapScreen draws over the map. Wins over the weather/chart mute.
   */
  night?: boolean;
  /**
   * Checked marine reference layers (CHS NONNA bathymetry / OpenSeaMap
   * seamarks — see `@core/geo/marineLayers`). Network-only like the trail
   * networks: callers must pass [] while `offlineOnly` is on. Catalog order
   * wins regardless of toggle order, so the depth tint always draws under
   * the seamark symbols.
   */
  marineLayers?: readonly MarineLayerId[];
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
  overlayLabels?: {
    dark: boolean;
    tiles: readonly string[];
    /**
     * Add the major-road reference pass (motorway/trunk/primary from z9).
     * Weather only. Marine chart mode deliberately dims land to tan so the
     * water reads as the content, and bright cased road lines over it fight
     * that intent — so the roads are opt-in per caller rather than riding
     * along with every use of this overlay.
     */
    roads?: boolean;
  };
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
  /**
   * The vector Stone & Paper base (`@core/map/stoneStyle`) — used in place of
   * the OSM raster ONLY while `VECTOR_BASEMAP_ENABLED` is on and the basemap
   * is `map`; ignored otherwise. `tiles` are XYZ templates on our own
   * Protomaps (schema v4) host — see `@data/basemapTiles`.
   * Callers leave it unset for offline packs and offline-only mode, which
   * stay raster.
   */
  vectorBasemap?: {
    tiles: readonly string[];
    dark: boolean;
    /**
     * Our glyph host, serving Atkinson Hyperlegible Next. Unset = the
     * OpenFreeMap Noto fallback (whole-stack swap, see `STONE_FONTS_NOTO`).
     */
    glyphs?: string;
    /** Contour-line vector tiles (our Worker); unset = no contour layers. */
    contours?: string;
    /**
     * Named-summit vector tiles (our Worker, `infra/tiles/nas/peaks.sh`);
     * unset = Protomaps' own peaks, which only appear from z13.
     */
    peaks?: string;
    /** How early the summits appear (#461); default `normal`. */
    peakDensity?: PeakDensity;
  };
  /**
   * "Labels on satellite" (#484): our vector base map's roads, trails and
   * names — no ground fills — drawn over the satellite imagery, in the
   * imagery palette (light ink on a dark halo, both app themes). Honoured
   * ONLY when the basemap is `satellite`, and not under a weather or marine
   * chart drape, whose own reference overlay carries the names there.
   * Same tile/glyph/summit hosts as {@link vectorBasemap}.
   */
  imageryLabels?: {
    tiles: readonly string[];
    glyphs?: string;
    peaks?: string;
    peakDensity?: PeakDensity;
  };
  /**
   * Contours on satellite (#492): the Map base's served contour tiles, with
   * their height labels, drawn over the imagery in the imagery palette — in
   * the same slot as on the map, under the roads, the names and every PDF
   * map. Honoured ONLY when the basemap is `satellite`; independent of
   * {@link imageryLabels}. `glyphs` as for the labels (the heights need a
   * glyph host).
   */
  imageryContours?: { tiles: string; glyphs?: string };
  /**
   * Strength of the 2D shaded relief when it is drawn (`shadedRelief`); the
   * "None" setting is `shadedRelief = false`. Default `medium`, the pre-#461
   * look. The dark palette applies only over the stone-night vector base —
   * the raster basemaps are always light.
   */
  hillshadeStrength?: HillshadeStrength;
  /**
   * The "3D relief" setting (#480): unset or `off` = no tilted-map relief
   * pass; otherwise a hidden pass in that mode's palette rides above the
   * shaded relief, for the map screen to switch on as the map tilts.
   */
  tiltRelief?: TiltRelief;
  marineChart?: {
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
/** Night red's raster: no colour (no blue or green), brightness capped. */
const NIGHT_RASTER_PAINT: Record<string, number> = {
  'raster-saturation': NIGHT_MAP.rasterSaturation,
  'raster-brightness-max': NIGHT_MAP.rasterBrightnessMax,
};

const WEATHER_MUTED_PAINT: Record<string, number> = {
  'raster-saturation': -0.85,
  'raster-contrast': -0.08,
};

/**
 * A zoom-interpolated `line-width`, optionally widened by a fixed casing
 * allowance. The casing is a constant amount wider at every zoom rather than
 * a multiple: a proportional casing vanishes at low zoom, which is exactly
 * where the coastline most needs help.
 *
 * The reference ink and the width tables themselves live in
 * `@core/weather/weatherLook` — they are pure data that other renderers
 * (the web playground) draw from too.
 */
type LineWidth = NonNullable<NonNullable<LineLayerSpecification['paint']>['line-width']>;

function widthAtZoom(w: ReferenceLineWidths, add: number): LineWidth {
  return ['interpolate', ['linear'], ['zoom'], 5, w.z5 + add, 10, w.z10 + add, 14, w.z14 + add];
}

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

/** The vector base map's source (our Protomaps extract). */
function vectorBaseSource(tiles: readonly string[]): StyleSpecification['sources'][string] {
  return {
    type: 'vector',
    tiles: [...tiles],
    minzoom: 0,
    // Protomaps builds go to z15; MapLibre overzooms past that.
    maxzoom: 15,
    attribution: PROTOMAPS_ATTRIBUTION,
  };
}

/** Our served contour tiles (the Worker), on the map and over imagery alike. */
function contoursSource(tiles: string): StyleSpecification['sources'][string] {
  return {
    type: 'vector',
    tiles: [tiles],
    minzoom: 0,
    // Generated to z14; the lines overzoom cleanly past it.
    maxzoom: 14,
    attribution: 'Elevation: Mapzen Terrain Tiles',
  };
}

/** How the stone layers read the served contour tiles. */
const STONE_CONTOURS: StoneContourSource = {
  source: VECTOR_CONTOURS_SOURCE,
  sourceLayer: 'contours',
  field: 'ele',
  levelField: 'level',
};

/** Our named-summits source. OSM data, already credited by the base map. */
function peaksSource(tiles: string): StyleSpecification['sources'][string] {
  return {
    type: 'vector',
    tiles: [tiles],
    // Built z5–z12: the ≥ 4000 m summits from z5, every named summit by
    // z12 (the ladder's last rung), so deeper tiles would be copies —
    // MapLibre overzooms z12 instead, and packs store fewer tiles. The
    // stone layer's filter picks which of them to draw (peak density).
    minzoom: 5,
    maxzoom: 12,
  };
}

/**
 * A minimal MapLibre style that renders a raster base layer (OSM streets,
 * or satellite imagery — see {@link baseSource}).
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
        tileSize: options.rasterTileSize ?? 256,
        maxzoom: Math.min(NATIVE_MAX_ZOOM[basemap], options.rasterMaxZoom ?? Infinity),
        attribution: base.attribution,
      },
      // Marine reference drapes (marine M3): NONNA bathymetry rides the same
      // WMS-through-a-raster-source mechanism as the weather layers; the
      // seamarks are plain XYZ tiles.
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
    layers: [],
  };

  // The layers go into the map's stack slots (`@core/map/layerSlots`), which
  // fix the order — bottom to top, the same on every base map — whatever
  // order the code below happens to fill them in.
  const slots: Partial<Record<MapLayerSlot, LayerSpecification[]>> = {};
  const put = (slot: MapLayerSlot, ...layers: LayerSpecification[]) => {
    (slots[slot] ??= []).push(...layers);
  };

  // Vector Stone & Paper base (flag-gated): swaps the paper backdrop + OSM
  // raster for the vector source and the stone body layers (its contours,
  // roads and trails included); its labels go in the labels slot.
  const stone =
    VECTOR_BASEMAP_ENABLED && basemap === 'map' && options.vectorBasemap
      ? buildStoneLayers(stoneScheme(options.vectorBasemap.dark), {
          source: VECTOR_BASEMAP_SOURCE,
          // Atkinson from our host when configured, else OpenFreeMap's Noto.
          fonts: options.vectorBasemap.glyphs ? STONE_FONTS_ATKINSON : STONE_FONTS_NOTO,
          ...(options.vectorBasemap.contours ? { contours: STONE_CONTOURS } : {}),
          ...(options.vectorBasemap.peaks
            ? { peaks: { source: VECTOR_PEAKS_SOURCE, sourceLayer: 'peaks' } }
            : {}),
          ...(options.vectorBasemap.peakDensity
            ? { peakDensity: options.vectorBasemap.peakDensity }
            : {}),
        })
      : null;
  if (stone && options.vectorBasemap) {
    delete style.sources.osm;
    style.sources[VECTOR_BASEMAP_SOURCE] = vectorBaseSource(options.vectorBasemap.tiles);
    if (options.vectorBasemap.contours) {
      style.sources[VECTOR_CONTOURS_SOURCE] = contoursSource(options.vectorBasemap.contours);
    }
    if (options.vectorBasemap.peaks) {
      style.sources[VECTOR_PEAKS_SOURCE] = peaksSource(options.vectorBasemap.peaks);
    }
    style.glyphs = options.vectorBasemap.glyphs ?? OFM_GLYPHS_URL;
    put('base', ...stone.base);
    put('labels', ...stone.labels);
  } else {
    put(
      'base',
      // Warm paper backdrop that shows through while tiles load and at the edges.
      { id: 'background', type: 'background', paint: { 'background-color': '#E6DFCF' } },
      {
        id: 'osm',
        type: 'raster',
        source: 'osm',
        // Chart mode mutes the raster exactly like weather mode: the chart
        // colours own the palette; streets/labels ghost through the tan dim.
        paint: options.night
          ? NIGHT_RASTER_PAINT
          : options.weatherMuted || options.marineChart
            ? WEATHER_MUTED_PAINT
            : (RASTER_PAINT[basemap] ?? {}),
      },
    );
  }

  // Over satellite imagery (#484, #492): the Map base's served contours and
  // its roads, trails and names, in the imagery palette and in the SAME
  // slots the stone body fills on the map — contours under the roads, names
  // above the relief, everything under the PDF maps.
  const weatherOn = options.weatherMuted !== undefined;
  const chartOn = options.marineChart !== undefined;
  const imageryLabels = drawsImageryLabels({
    basemap: basemap === 'satellite' ? 'satellite' : 'map',
    vector: true,
    satelliteLabels: options.imageryLabels !== undefined,
    weather: weatherOn,
    marine: chartOn,
  })
    ? (options.imageryLabels ?? null)
    : null;
  const imageryContours = basemap === 'satellite' ? (options.imageryContours ?? null) : null;
  if (imageryLabels || imageryContours) {
    const glyphs = imageryLabels?.glyphs ?? imageryContours?.glyphs;
    if (imageryLabels) {
      style.sources[VECTOR_BASEMAP_SOURCE] = vectorBaseSource(imageryLabels.tiles);
      if (imageryLabels.peaks)
        style.sources[VECTOR_PEAKS_SOURCE] = peaksSource(imageryLabels.peaks);
    }
    if (imageryContours) {
      style.sources[VECTOR_CONTOURS_SOURCE] = contoursSource(imageryContours.tiles);
    }
    style.glyphs = glyphs ?? OFM_GLYPHS_URL;
    const imagery = buildStoneImagerySlots(imageryStoneScheme(), {
      source: VECTOR_BASEMAP_SOURCE,
      fonts: glyphs ? STONE_FONTS_ATKINSON : STONE_FONTS_NOTO,
      labels: imageryLabels !== null,
      ...(imageryContours ? { contours: STONE_CONTOURS } : {}),
      ...(imageryLabels?.peaks
        ? { peaks: { source: VECTOR_PEAKS_SOURCE, sourceLayer: 'peaks' } }
        : {}),
      ...(imageryLabels?.peakDensity ? { peakDensity: imageryLabels.peakDensity } : {}),
    });
    put('contours', ...imagery.contours);
    put('linework', ...imagery.linework);
    put('labels', ...imagery.labels);
  }
  // On-device contours (the raster fallback) mount at the top of the
  // contours slot: under the roads and relief, as the served ones draw.
  put('contours', drapeAnchorLayer(SLOT_ANCHOR.contours));

  // Marine chart mode — chart-tan land dim: a semi-opaque warm screen over
  // the muted basemap, the paper-chart ground. `background` paints the whole
  // viewport; the water fill + drape re-cover the wet parts.
  if (options.marineChart) {
    put('chart', {
      id: 'marine-land-dim',
      type: 'background',
      paint: { 'background-color': CHART_LAND_COLOR, 'background-opacity': 0.62 },
    });
  }
  // Flat chart-blue water fill from the OpenFreeMap vector water polygons
  // (the wave B overlay source — declared below whenever overlayLabels is
  // set): uncharted water reads chart-blue instead of tan, the iBoating
  // overview idiom. Skipped silently when the vector host didn't resolve.
  if (options.marineChart && options.overlayLabels) {
    put('chart', {
      id: 'marine-water-fill',
      type: 'fill',
      source: 'overlay-labels',
      'source-layer': 'water',
      paint: { 'fill-color': CHART_WATER_COLOR, 'fill-opacity': 0.88 },
    });
  }
  // Anchor for the client-rendered depth-band drape (a MapView child — see
  // `@core/geo/mapLayerStack`). It sits under the marine WMS layers: the
  // seamark symbols must stay above the bands, and the legacy WMS bathymetry
  // drape is only ever present as the fallback for a FAILED client
  // pipeline, i.e. never at the same time as the drape itself.
  if (options.marineChart) put('chart', drapeAnchorLayer(SLOT_ANCHOR.chart));
  // Marine layers; the depth tint is dimmed so the basemap's shoreline and
  // labels stay readable through it.
  put(
    'chart',
    ...marine.map((l) => ({
      id: `marine-${l.id}`,
      type: 'raster' as const,
      source: `marine-${l.id}`,
      paint: { 'raster-opacity': l.opacity },
    })),
  );

  // The client-rendered depth-band drape and the spot soundings are NOT
  // declared here either: they are MapView children (`MarineChartLayers`),
  // so a re-anchored chart updates the image source in place instead of
  // reloading the entire style (which used to feed a reload storm — see
  // `@core/geo/mapLayerStack`).

  // A shaded-relief hillshade derived from the free Terrarium DEM, blended
  // over the live 2D map body for the warm topographic look. Kept OFF for
  // offline packs (shadedRelief=false) so the DEM source doesn't bloat
  // downloaded tile pyramids — relief just degrades to flat tiles offline.
  // Skipped in 3D (the real terrain surface adds its own DEM/hillshade
  // below), on satellite imagery (it carries the sun's real shadows) and
  // under weather and the marine chart (see `drawsShadedRelief`).
  //
  // The tilted-map pass (#480) rides above it; over satellite imagery it is
  // drawn on its own (#492) — hidden flat, faded in with the pitch by the
  // map screen, lighter and in the night palette (see `tiltReliefLook`).
  const reliefGates = {
    basemap: basemap === 'satellite' ? ('satellite' as const) : ('map' as const),
    shadedRelief: shadedRelief && SHADE_BASEMAPS.has(basemap),
    tiltRelief: (options.tiltRelief ?? 'off') !== 'off',
    weather: weatherOn,
    marine: chartOn,
  };
  const flatRelief = !terrain3d && drawsShadedRelief(reliefGates);
  const tiltPass = !terrain3d && drawsTiltRelief(reliefGates);
  if (flatRelief || tiltPass) {
    style.sources[HILLSHADE_DEM_SOURCE_ID] = {
      type: 'raster-dem',
      tiles: [TERRAIN_DEM_URL],
      encoding: 'terrarium',
      // See HILLSHADE_2D_DEM_TILE_SIZE: the DEM's full sample rate.
      tileSize: HILLSHADE_2D_DEM_TILE_SIZE,
      maxzoom: 15,
      attribution: 'Elevation © Mapzen / AWS Terrain Tiles',
    };
  }
  const stoneNight = stone !== null && options.vectorBasemap?.dark === true;
  if (flatRelief) {
    const look = hillshadeLook(options.hillshadeStrength ?? DEFAULT_HILLSHADE_STRENGTH, stoneNight);
    put('relief', {
      id: HILLSHADE_2D_LAYER_ID,
      type: 'hillshade',
      source: HILLSHADE_DEM_SOURCE_ID,
      // The zoom gate (#230) — no shading, and no DEM traffic at all, below it.
      minzoom: HILLSHADE_2D_MIN_ZOOM,
      paint: {
        // Ramp the exaggeration up over the first zoom level above the gate so
        // the shading fades in instead of popping when the gate is crossed.
        'hillshade-exaggeration': [
          'interpolate',
          ['linear'],
          ['zoom'],
          HILLSHADE_2D_MIN_ZOOM,
          0,
          HILLSHADE_2D_MIN_ZOOM + 1,
          look.exaggeration,
        ],
        'hillshade-shadow-color': look.shadowColor,
        'hillshade-highlight-color': look.highlightColor,
        'hillshade-accent-color': look.accentColor,
        'hillshade-illumination-direction': HILLSHADE_ILLUMINATION_DIRECTION,
      },
    });
  }
  const tilt = tiltPass
    ? tiltReliefLook(
        options.tiltRelief ?? 'off',
        MAP_MAX_PITCH_DEG,
        stoneNight,
        reliefGates.basemap === 'satellite',
      )
    : null;
  if (tilt !== null) {
    put('relief', {
      id: TILT_RELIEF_LAYER_ID,
      type: 'hillshade',
      source: HILLSHADE_DEM_SOURCE_ID,
      minzoom: HILLSHADE_2D_MIN_ZOOM,
      layout: { visibility: 'none' },
      paint: {
        'hillshade-exaggeration': 0,
        'hillshade-shadow-color': tilt.shadowColor,
        'hillshade-highlight-color': tilt.highlightColor,
        'hillshade-accent-color': tilt.accentColor,
        'hillshade-illumination-direction': HILLSHADE_ILLUMINATION_DIRECTION,
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
    put('relief', {
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem',
      paint: { 'hillshade-exaggeration': 0.7 },
    });
    // NOTE (#480): MapLibre Native as bundled (Android 13.6.1 / iOS 6.31.0)
    // does not parse `terrain` — it is dropped, and the map stays a flat
    // sheet. Only a MapLibre GL JS host would drape this. The main map never
    // passes terrain3d=true (its 3D is the three.js Terrain3DLiveView).
    style.terrain = { source: 'dem', exaggeration: 2.2 };
  }

  // The slope-angle raster (a MapView child) mounts here: over the relief,
  // under the names and the PDF maps.
  put('terrain', drapeAnchorLayer(SLOT_ANCHOR.terrain));

  // Weather-mode dim: a semi-opaque neutral BACKGROUND layer above the
  // basemap/overlay rasters and below the weather drape. `background` paints
  // the whole viewport regardless of its position in the layer list, so it
  // works as a "screen" over raster tiles — the only muting available when
  // labels are baked into tile pixels (see the option's doc).
  if (options.weatherMuted) {
    put(
      'weather',
      {
        id: 'weather-dim',
        type: 'background',
        paint: {
          'background-color': options.weatherMuted.dimColor,
          'background-opacity': options.weatherMuted.dimOpacity,
        },
      },
      // The weather drape itself is NOT declared here: its two crossfade
      // slots are mounted as MapView children (`WeatherDrapeLayers`) — a
      // frame URL inside this style would make every playback tick reload
      // the whole native style. They anchor HERE, directly above the dim,
      // whatever order the modes were toggled in.
      drapeAnchorLayer(SLOT_ANCHOR.weather),
    );
  }

  // Anchor for the spot soundings, above the weather anchor: ink beats
  // colour, so the depth numbers stay readable through a weather field.
  if (options.marineChart) put('soundings', drapeAnchorLayer(SLOT_ANCHOR.soundings));

  // The always-present anchors for the MapView-child overlays (#332): PDF
  // maps, then trails — below the reference labels and, more importantly,
  // below the position puck, which the map appends last.
  put('pdf', drapeAnchorLayer(SLOT_ANCHOR.pdf));
  put('trails', drapeAnchorLayer(SLOT_ANCHOR.trails));

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
    const ref = dark ? WEATHER_REFERENCE_INK.dark : WEATHER_REFERENCE_INK.light;
    // Major roads — the skeleton that says "this is a city and here is its
    // shape". Deliberately restrained next to the water: thinner, and only
    // the top three road classes from zoom 9. The basemap raster already
    // draws every street; redrawing all of them above the drape would trade
    // one unreadable image for a busier one. This pass restores ORIENTATION,
    // not detail — and it is weather-only (see the `roads` option).
    const roadFilter: FilterSpecification = [
      'in',
      ['get', 'class'],
      ['literal', ['motorway', 'trunk', 'primary']],
    ];
    const roadLayers: LayerSpecification[] = options.overlayLabels.roads
      ? [
          {
            id: 'overlay-road-casing',
            type: 'line',
            source: 'overlay-labels',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: roadFilter,
            paint: {
              'line-color': ref.casing,
              'line-width': widthAtZoom(ROAD_LINE_W, ref.casingAdd),
              'line-blur': 0.4,
            },
          },
          {
            id: 'overlay-road-line',
            type: 'line',
            source: 'overlay-labels',
            'source-layer': 'transportation',
            minzoom: 9,
            filter: roadFilter,
            paint: {
              'line-color': ref.road,
              'line-width': widthAtZoom(ROAD_LINE_W, 0),
            },
          },
        ]
      : [];
    put(
      'reference',
      // Coast/water edges, drawn as a CASING + CORE pair. One flat line is
      // what the owner rejected on 2026-08-13 ("it should be much easier to
      // differentiate coasts and features"): a single stroke has to compete
      // with whatever colour the drape happens to be under it — and the drape
      // is a full-spectrum ramp, so no single ink wins everywhere. The casing
      // is the opposite polarity to the core, so the pair carries its own
      // contrast with it and reads the same over blue, green or magenta.
      {
        id: 'overlay-water-casing',
        type: 'line',
        source: 'overlay-labels',
        'source-layer': 'water',
        paint: {
          'line-color': ref.casing,
          'line-width': widthAtZoom(WATER_LINE_W, ref.casingAdd),
          'line-blur': 0.4,
        },
      },
      {
        id: 'overlay-water-line',
        type: 'line',
        source: 'overlay-labels',
        'source-layer': 'water',
        paint: {
          'line-color': ref.coast,
          'line-width': widthAtZoom(WATER_LINE_W, 0),
        },
      },
      ...roadLayers,
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

  // "Locally downloaded only" mask, the `mask` slot: above every base-map
  // layer (raster, vector, relief, drapes) but UNDER the PDF maps and the
  // trails (#492) — those are on the device and must stay visible offline.
  // The position puck and markers are appended after the style's own
  // layers, so they draw on top of the mask too.
  if (options.downloadedMask) {
    style.sources['downloaded-mask'] = {
      type: 'geojson',
      data: options.downloadedMask.data,
    };
    put('mask', {
      id: 'downloaded-mask',
      type: 'fill',
      source: 'downloaded-mask',
      paint: { 'fill-color': options.downloadedMask.color, 'fill-opacity': 1 },
    });
  }

  style.layers = stackLayers(slots);
  return style;
}
