import { buildDownloadedMask } from '@core/geo/downloadedMask';
import {
  ALWAYS_PRESENT_ANCHORS,
  CONTOURS_ANCHOR,
  DRAPE_ANCHORS_BOTTOM_TO_TOP,
  MARINE_DRAPE_ANCHOR,
  MARINE_SOUNDINGS_ANCHOR,
  PDF_MAPS_ANCHOR,
  TERRAIN_OVERLAY_ANCHOR,
  TRAILS_ANCHOR,
  WEATHER_DRAPE_ANCHOR,
} from '@core/geo/mapLayerStack';
import { mapDrawOrder, type MapElement, type MapStackInput } from '@core/map/layerSlots';
import type {
  RasterDEMSourceSpecification,
  RasterSourceSpecification,
} from '@maplibre/maplibre-react-native';
import {
  DEFAULT_HILLSHADE_STRENGTH,
  HILLSHADE_STRENGTHS,
  hillshadeLook,
  PEAK_DENSITIES,
  PEAK_LEAD,
} from '@core/map/terrainOptions';
import { peakDueFilter } from '@core/map/stoneStyle';
import { validateStyleMin as validateStyle } from '@maplibre/maplibre-gl-style-spec';
import {
  buildOsmStyle,
  CONTOUR_SOURCE_MAXZOOM,
  CONTOUR_SOURCE_MINZOOM,
  HILLSHADE_2D_DEM_TILE_SIZE,
  HILLSHADE_2D_LAYER_ID,
  HILLSHADE_2D_MIN_ZOOM,
  HILLSHADE_DEM_SOURCE_ID,
  styleHasHillshade,
  styleHasTiltRelief,
  TILT_RELIEF_LAYER_ID,
} from './mapStyle';
import { MAP_MAX_PITCH_DEG, tiltReliefLook } from '@core/map/tiltRelief';
import {
  DEFAULT_IMAGERY_LOOK,
  IMAGERY_PAINT,
  SATELLITE_FADE_MS,
  SATELLITE_TILE_SIZE,
} from '@core/map/satelliteImagery';

const TILE = 'https://tile.example/{z}/{x}/{y}.png';
const layerIds = (s: ReturnType<typeof buildOsmStyle>) => s.layers.map((l) => l.id);
const baseSource = (s: ReturnType<typeof buildOsmStyle>) =>
  s.sources.osm as RasterSourceSpecification;

describe('buildOsmStyle', () => {
  it('renders a plain raster base with no relief by default (offline-pack style)', () => {
    const s = buildOsmStyle(TILE, 'map');
    expect(s.sources.dem).toBeUndefined();
    // The three puck anchors ride along in every style (#332); invisible, sourceless.
    expect(layerIds(s)).toEqual(['background', 'osm', ...ALWAYS_PRESENT_ANCHORS]);
    expect(s.terrain).toBeUndefined();
  });

  it('adds a 2D hillshade + DEM source when shaded relief is requested', () => {
    const s = buildOsmStyle(TILE, 'map', true);
    expect(s.sources.dem).toBeDefined();
    expect(layerIds(s)).toContain('hillshade-2d');
    expect(s.terrain).toBeUndefined(); // shaded relief is flat — no terrain spec
  });

  it('mutes the OSM "map" basemap via raster paint', () => {
    const osm = buildOsmStyle(TILE, 'map', true).layers.find((l) => l.id === 'osm');
    expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.25 });
  });

  it('does NOT shade satellite imagery even when shaded relief is requested', () => {
    const s = buildOsmStyle(TILE, 'satellite', true);
    expect(s.sources.dem).toBeUndefined();
    expect(layerIds(s)).not.toContain('hillshade-2d');
  });

  it('keeps offline packs lean: shadedRelief defaults off so the DEM never enters a pack style', () => {
    // The offline-download path calls buildOsmStyle(tileUrl, basemap) with
    // no shadedRelief arg — assert that path yields no DEM source/tiles.
    const s = buildOsmStyle(TILE, 'map');
    expect(s.sources.dem).toBeUndefined();
  });

  /**
   * #230 — map stutter on zoom-out on iOS, satellite is smooth. The
   * arithmetic behind these constants lives in `@core/geo/tiles`
   * ("live-viewport DEM tile load"); this pins the style that spends it.
   */
  describe('shaded-relief cost controls (#230)', () => {
    const hillshade2d = (s: ReturnType<typeof buildOsmStyle>) =>
      s.layers.find((l) => l.id === 'hillshade-2d');

    it('zoom-gates the map hillshade at z11', () => {
      const layer = hillshade2d(buildOsmStyle(TILE, 'map', true));
      expect(layer).toBeDefined();
      expect(layer?.minzoom).toBe(HILLSHADE_2D_MIN_ZOOM);
      expect(HILLSHADE_2D_MIN_ZOOM).toBe(11);
    });

    it('ramps the exaggeration up from 0 at the gate so the shading fades in', () => {
      const layer = hillshade2d(buildOsmStyle(TILE, 'map', true));
      expect(layer?.paint).toMatchObject({
        'hillshade-exaggeration': [
          'interpolate',
          ['linear'],
          ['zoom'],
          HILLSHADE_2D_MIN_ZOOM,
          0,
          HILLSHADE_2D_MIN_ZOOM + 1,
          0.45,
        ],
      });
    });

    it('declares the 2D DEM at its true 256 px — full sample rate, no blocky facets (#461)', () => {
      const dem = buildOsmStyle(TILE, 'map', true).sources.dem as RasterDEMSourceSpecification;
      expect(dem.tileSize).toBe(256);
      expect(HILLSHADE_2D_DEM_TILE_SIZE).toBe(256);
      expect(dem.encoding).toBe('terrarium');
      expect(dem.maxzoom).toBe(15);
    });

    it('emits NO hillshade layer and NO DEM source when the setting is off', () => {
      // showHillshade=false must cost zero DEM fetches, not a hidden layer.
      for (const basemap of ['map', 'satellite'] as const) {
        const s = buildOsmStyle(TILE, basemap, false);
        expect(layerIds(s)).not.toContain('hillshade-2d');
        expect(s.sources.dem).toBeUndefined();
        expect(JSON.stringify(s)).not.toContain('elevation-tiles-prod');
      }
    });

    it('still shades nothing on satellite, gate or no gate', () => {
      const s = buildOsmStyle(TILE, 'satellite', true);
      expect(layerIds(s)).not.toContain('hillshade-2d');
      expect(s.sources.dem).toBeUndefined();
    });
  });

  describe('overzoom (blurry upscaled tiles instead of "map unavailable")', () => {
    it("caps each raster SOURCE at its service's real-data zoom, under the camera max of 18", () => {
      // Esri serves HTTP-200 "Map data not yet available" placeholders past its
      // real data (imagery ends ~z17 in remote areas, topo ~z15), so the source
      // maxzoom must stop fetching before that zone; OSM is real through z19.
      expect(baseSource(buildOsmStyle(TILE, 'map')).maxzoom).toBe(19);
      expect(baseSource(buildOsmStyle(TILE, 'satellite')).maxzoom).toBe(17);
    });

    it('leaves the raster LAYER without a maxzoom so tiles overscale past the source cap', () => {
      for (const basemap of ['map', 'satellite'] as const) {
        const osmLayer = buildOsmStyle(TILE, basemap, true).layers.find((l) => l.id === 'osm');
        expect(osmLayer).toBeDefined();
        expect(osmLayer && 'maxzoom' in osmLayer ? osmLayer.maxzoom : undefined).toBeUndefined();
      }
    });

    it("caps the source at an offline pack's top stored zoom via rasterMaxZoom", () => {
      const s = buildOsmStyle(TILE, 'map', true, { rasterMaxZoom: 15 });
      expect(baseSource(s).maxzoom).toBe(15);
    });

    it("never raises the source cap above the service's real-data zoom", () => {
      const s = buildOsmStyle(TILE, 'satellite', true, { rasterMaxZoom: 19 });
      expect(baseSource(s).maxzoom).toBe(17);
    });
  });

  describe('weather drape', () => {
    // The frames themselves are NOT style layers any more (perf fix
    // 2026-08-10): they mount as MapView children (`WeatherDrapeLayers`)
    // because a changed style object reloads the ENTIRE native style, which
    // blanked the drape twice per playback tick. Stacking is covered by
    // `@core/geo/mapLayerStack`; the style only owns the muting below.
    it('never declares a frame source or layer, playback or not', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        weatherMuted: { dimColor: '#F4F1EC', dimOpacity: 0.42 },
        overlayLabels: { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      expect(s.sources['weather-a']).toBeUndefined();
      expect(s.sources['weather-b']).toBeUndefined();
      expect(layerIds(s)).not.toContain('weather-a');
      expect(layerIds(s)).not.toContain('weather-b');
    });

    it('carries the weather anchor whenever the drape can mount', () => {
      // The drape children mount on exactly `weatherLayer !== null &&
      // !offlineOnly`, which is the same condition that sets `weatherMuted`.
      // If the anchor were ever missing, `waitForLayer` would park the layer
      // forever (a style layer never fires `layerAdded`), so this pairing is
      // load-bearing.
      const s = buildOsmStyle(TILE, 'map', true, {
        weatherMuted: { dimColor: '#F4F1EC', dimOpacity: 0.42 },
        overlayLabels: { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      expect(layerIds(s)).toContain(WEATHER_DRAPE_ANCHOR);
    });
  });

  describe('live drape anchors (`@core/geo/mapLayerStack`)', () => {
    const overlayLabels = { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] };
    const weatherMuted = { dimColor: '#F4F1EC', dimOpacity: 0.42 };
    const chart = { wmsFallback: false };
    const mask = {
      data: buildDownloadedMask([{ minLng: -71, minLat: 46, maxLng: -70, maxLat: 47 }]),
      color: '#FFFFFF',
    };

    it('adds none of the conditional ones on a plain map — only the puck anchors (#332)', () => {
      const ids = layerIds(buildOsmStyle(TILE, 'map', true));
      const conditional = DRAPE_ANCHORS_BOTTOM_TO_TOP.filter(
        (a) => !(ALWAYS_PRESENT_ANCHORS as readonly string[]).includes(a),
      );
      for (const a of conditional) expect(ids).not.toContain(a);
      for (const a of ALWAYS_PRESENT_ANCHORS) expect(ids).toContain(a);
    });

    it('is invisible and sourceless — a marker must never paint or fetch', () => {
      const s = buildOsmStyle(TILE, 'map', true, { weatherMuted });
      const anchor = s.layers.find((l) => l.id === WEATHER_DRAPE_ANCHOR);
      expect(anchor).toEqual({
        id: WEATHER_DRAPE_ANCHOR,
        type: 'background',
        layout: { visibility: 'none' },
      });
    });

    it('keeps the soundings ABOVE the weather field in EITHER toggle order', () => {
      // The whole point of separate anchors: with one shared anchor the last
      // child re-inserted took the top slot, so the 62%-opaque colour field
      // buried the depth numbers.
      for (const opts of [
        { weatherMuted, marineChart: chart, overlayLabels },
        { marineChart: chart, weatherMuted, overlayLabels },
      ]) {
        const ids = layerIds(buildOsmStyle(TILE, 'map', true, opts));
        expect(ids.indexOf(MARINE_SOUNDINGS_ANCHOR)).toBeGreaterThan(
          ids.indexOf(WEATHER_DRAPE_ANCHOR),
        );
        expect(ids.indexOf(WEATHER_DRAPE_ANCHOR)).toBeGreaterThan(ids.indexOf(MARINE_DRAPE_ANCHOR));
      }
    });

    it('puts the weather anchor directly above the dim, and the chart anchor below it', () => {
      const ids = layerIds(buildOsmStyle(TILE, 'map', true, { weatherMuted, marineChart: chart }));
      expect(ids.indexOf(WEATHER_DRAPE_ANCHOR)).toBe(ids.indexOf('weather-dim') + 1);
      // A chart under a weather field must be dimmed with everything else.
      expect(ids.indexOf(MARINE_DRAPE_ANCHOR)).toBeLessThan(ids.indexOf('weather-dim'));
    });

    it('keeps the depth bands under the seamark symbols', () => {
      const ids = layerIds(
        buildOsmStyle(TILE, 'map', true, {
          marineLayers: ['bathymetry', 'seamarks'],
          marineChart: chart,
          overlayLabels,
        }),
      );
      expect(ids.indexOf(MARINE_DRAPE_ANCHOR)).toBeLessThan(ids.indexOf('marine-seamarks'));
    });

    it('keeps every anchor under wave B labels — colour never swallows geography', () => {
      const ids = layerIds(
        buildOsmStyle(TILE, 'map', true, {
          weatherMuted,
          marineChart: chart,
          overlayLabels,
        }),
      );
      for (const a of DRAPE_ANCHORS_BOTTOM_TO_TOP) {
        expect(ids.indexOf(a)).toBeLessThan(ids.indexOf('overlay-water-line'));
      }
    });

    it('keeps every anchor UNDER the downloaded-only mask', () => {
      // The regression this guards: with no anchor a child layer goes through
      // `style.addLayer()` = top of the whole stack, so in offline-only mode
      // the marine drape drew OVER the mask that hides undownloaded ground.
      // Marine chart mode survives offline-only when a pack is installed.
      const ids = layerIds(
        buildOsmStyle(TILE, 'map', true, { marineChart: chart, downloadedMask: mask }),
      );
      for (const a of [MARINE_DRAPE_ANCHOR, MARINE_SOUNDINGS_ANCHOR]) {
        expect(ids.indexOf(a)).toBeGreaterThan(-1);
        expect(ids.indexOf(a)).toBeLessThan(ids.indexOf('downloaded-mask'));
      }
    });
  });

  describe('weather-mode basemap muting', () => {
    const weatherMuted = { dimColor: '#F4F1EC', dimOpacity: 0.42 };

    it('is absent by default — no dim layer, normal raster paint', () => {
      const s = buildOsmStyle(TILE, 'map', true);
      expect(layerIds(s)).not.toContain('weather-dim');
      const osm = s.layers.find((l) => l.id === 'osm');
      expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.25 });
    });

    it('desaturates the raster and screens it with the dim backdrop', () => {
      const s = buildOsmStyle(TILE, 'map', true, { weatherMuted });
      const osm = s.layers.find((l) => l.id === 'osm');
      expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.85 });
      const dim = s.layers.find((l) => l.id === 'weather-dim');
      expect(dim).toMatchObject({
        type: 'background',
        paint: { 'background-color': '#F4F1EC', 'background-opacity': 0.42 },
      });
    });

    it('stacks dim above every basemap-side raster (the drape rides above it)', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        weatherMuted,
        marineLayers: ['bathymetry'],
      });
      const ids = layerIds(s);
      expect(ids.indexOf('weather-dim')).toBeGreaterThan(ids.indexOf('osm'));
      expect(ids.indexOf('weather-dim')).toBeGreaterThan(ids.indexOf('marine-bathymetry'));
    });

    it('suppresses the shaded-relief hillshade (terrain shading under weather is noise)', () => {
      const s = buildOsmStyle(TILE, 'map', true, { weatherMuted });
      expect(layerIds(s)).not.toContain('hillshade-2d');
      expect(s.sources.dem).toBeUndefined();
    });

    it('mutes satellite imagery too — under weather the drape is the content', () => {
      const s = buildOsmStyle(TILE, 'satellite', true, { weatherMuted });
      const osm = s.layers.find((l) => l.id === 'osm');
      expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.85 });
    });
  });

  describe('labels + coastline overlay (wave B)', () => {
    const OVERLAY_LAYER_IDS = [
      'overlay-water-casing',
      'overlay-water-line',
      'overlay-town-labels',
      'overlay-city-labels',
    ];
    /** The road pass is weather-only — see the `roads` option. */
    const ROAD_LAYER_IDS = ['overlay-road-casing', 'overlay-road-line'];

    it('is absent by default — no vector source, no glyphs endpoint', () => {
      const s = buildOsmStyle(TILE, 'map', true);
      expect(s.sources['overlay-labels']).toBeUndefined();
      expect(s.glyphs).toBeUndefined();
      for (const id of OVERLAY_LAYER_IDS) expect(layerIds(s)).not.toContain(id);
    });

    it('adds the OpenFreeMap vector source, glyphs and the three reference layers', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        overlayLabels: { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      expect(s.sources['overlay-labels']).toMatchObject({
        type: 'vector',
        // Inline templates, resolved from the TileJSON in JS — native drops
        // a TileJSON `url` vector source silently.
        tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'],
      });
      expect(s.glyphs).toBe('https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf');
      for (const id of OVERLAY_LAYER_IDS) expect(layerIds(s)).toContain(id);
      const water = s.layers.find((l) => l.id === 'overlay-water-line');
      expect(water).toMatchObject({ type: 'line', 'source-layer': 'water' });
      const cities = s.layers.find((l) => l.id === 'overlay-city-labels');
      expect(cities).toMatchObject({ type: 'symbol', 'source-layer': 'place' });
    });

    it('draws ABOVE the dim and the marine drapes (the whole point)', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        weatherMuted: { dimColor: '#111', dimOpacity: 0.4 },
        marineLayers: ['bathymetry', 'seamarks'],
        overlayLabels: { dark: true, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      const ids = layerIds(s);
      for (const id of OVERLAY_LAYER_IDS) {
        expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf('weather-dim'));
        expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf('marine-seamarks'));
      }
    });

    it('sits above a marine-only drape too (no weather layer in the style)', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        marineLayers: ['bathymetry'],
        overlayLabels: { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      const ids = layerIds(s);
      expect(ids.indexOf('overlay-water-line')).toBeGreaterThan(ids.indexOf('marine-bathymetry'));
    });

    it('draws each reference line as a casing UNDER its core, and wider', () => {
      // Owner, 2026-08-13: a single hairline could not be told apart from the
      // drape. The pair is what carries contrast over an arbitrary colour.
      const s = buildOsmStyle(TILE, 'map', true, {
        overlayLabels: {
          dark: false,
          tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'],
          roads: true,
        },
      });
      const ids = layerIds(s);
      const widthAt14 = (id: string): number => {
        const w = s.layers.find((l) => l.id === id)?.paint as Record<string, unknown>;
        const expr = w['line-width'] as unknown[];
        return expr[expr.length - 1] as number;
      };
      for (const [casing, core] of [
        ['overlay-water-casing', 'overlay-water-line'],
        ['overlay-road-casing', 'overlay-road-line'],
      ]) {
        expect(ids.indexOf(casing!)).toBeLessThan(ids.indexOf(core!));
        expect(widthAt14(casing!)).toBeGreaterThan(widthAt14(core!));
      }
    });

    it('draws water thicker than roads, and both thicker than the old hairline', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        overlayLabels: {
          dark: false,
          tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'],
          roads: true,
        },
      });
      const widthAt14 = (id: string): number => {
        const p = s.layers.find((l) => l.id === id)?.paint as Record<string, unknown>;
        const expr = p['line-width'] as unknown[];
        return expr[expr.length - 1] as number;
      };
      // Water leads: it carries the shape of the land.
      expect(widthAt14('overlay-water-line')).toBeGreaterThan(widthAt14('overlay-road-line'));
      // The treatment this replaced topped out at 1.7 px at z14.
      expect(widthAt14('overlay-water-line')).toBeGreaterThan(1.7);
    });

    it('keeps the road pass restrained — top three classes, not before z9', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        overlayLabels: {
          dark: false,
          tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'],
          roads: true,
        },
      });
      for (const id of ROAD_LAYER_IDS) {
        const l = s.layers.find((x) => x.id === id) as { filter?: unknown } | undefined;
        expect(l).toMatchObject({ 'source-layer': 'transportation', minzoom: 9 });
        expect(JSON.stringify(l?.filter)).toContain('motorway');
        // Redrawing every street above the drape would trade an unreadable
        // map for a busy one — secondary and below stay in the raster.
        expect(JSON.stringify(l?.filter)).not.toContain('secondary');
      }
    });

    it('keeps the road pass out of marine chart mode (land is dimmed there on purpose)', () => {
      const withRoads = buildOsmStyle(TILE, 'map', true, {
        overlayLabels: {
          dark: false,
          tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'],
          roads: true,
        },
      });
      const without = buildOsmStyle(TILE, 'map', true, {
        overlayLabels: { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      for (const id of ROAD_LAYER_IDS) {
        expect(layerIds(withRoads)).toContain(id);
        expect(layerIds(without)).not.toContain(id);
      }
      // The coast pass is NOT opt-in — marine mode needs it just as much.
      expect(layerIds(without)).toContain('overlay-water-line');
    });

    it('flips reference-line polarity with the theme, casing against core', () => {
      const paintOf = (dark: boolean, id: string): Record<string, unknown> => {
        const s = buildOsmStyle(TILE, 'map', true, {
          overlayLabels: { dark, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
        });
        return s.layers.find((l) => l.id === id)?.paint as Record<string, unknown>;
      };
      // Light theme: dark coast on a light casing. Dark theme: the reverse.
      expect(paintOf(false, 'overlay-water-casing')['line-color']).toContain('255, 255, 255');
      expect(paintOf(true, 'overlay-water-casing')['line-color']).toContain('6, 11, 16');
      expect(paintOf(false, 'overlay-water-line')['line-color']).toContain('11, 45, 74');
      expect(paintOf(true, 'overlay-water-line')['line-color']).toContain('190, 224, 248');
    });

    it('flips ink/halo polarity with the theme', () => {
      const light = buildOsmStyle(TILE, 'map', true, {
        overlayLabels: { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      const dark = buildOsmStyle(TILE, 'map', true, {
        overlayLabels: { dark: true, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      const cityPaint = (s: ReturnType<typeof buildOsmStyle>) =>
        s.layers.find((l) => l.id === 'overlay-city-labels')?.paint as Record<string, unknown>;
      expect(cityPaint(light)['text-color']).toBe('#20303C');
      expect(cityPaint(dark)['text-color']).toBe('#FFFFFF');
    });
  });

  describe('marine overlays', () => {
    it('is absent by default — the map is byte-identical to today with marine off', () => {
      const s = buildOsmStyle(TILE, 'map', true);
      expect(s.sources['marine-bathymetry']).toBeUndefined();
      expect(s.sources['marine-seamarks']).toBeUndefined();
      expect(layerIds(s)).not.toContain('marine-bathymetry');
    });

    it('adds a raster source + layer per checked marine layer, with attribution and zoom clamp', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        marineLayers: ['bathymetry', 'seamarks'],
      });
      expect(s.sources['marine-bathymetry']).toMatchObject({
        type: 'raster',
        tileSize: 256,
        maxzoom: 17,
      });
      const bathySource = s.sources['marine-bathymetry'] as {
        tiles: string[];
        attribution: string;
      };
      expect(bathySource.tiles[0]).toContain('nonna-geoserver.data.chs-shc.ca');
      expect(bathySource.tiles[0]).toContain('bbox={bbox-epsg-3857}');
      expect(bathySource.attribution).toContain('Not for navigation');
      const seamarkSource = s.sources['marine-seamarks'] as { tiles: string[] };
      expect(seamarkSource.tiles[0]).toContain('tiles.openseamap.org');
      const bathyLayer = s.layers.find((l) => l.id === 'marine-bathymetry');
      expect(bathyLayer).toMatchObject({
        type: 'raster',
        source: 'marine-bathymetry',
        paint: { 'raster-opacity': 0.7 },
      });
    });

    it('draws bathymetry under seamarks in catalog order, whatever the toggle order', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        marineLayers: ['seamarks', 'bathymetry'],
      });
      const ids = layerIds(s);
      expect(ids.indexOf('marine-bathymetry')).toBeGreaterThan(ids.indexOf('osm'));
      expect(ids.indexOf('marine-seamarks')).toBeGreaterThan(ids.indexOf('marine-bathymetry'));
    });
  });

  describe('marine chart mode (wave D — the ENC chart look)', () => {
    const overlayLabels = { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] };
    const chart = { wmsFallback: false };

    it('is absent by default — the map is byte-identical with marine off', () => {
      const s = buildOsmStyle(TILE, 'map', true);
      for (const id of ['marine-land-dim', 'marine-water-fill']) {
        expect(layerIds(s)).not.toContain(id);
      }
    });

    it('restyles land tan, fills water chart-blue and mutes the raster', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        marineLayers: ['bathymetry', 'seamarks'],
        overlayLabels,
        marineChart: chart,
      });
      const osm = s.layers.find((l) => l.id === 'osm');
      expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.85 });
      const dim = s.layers.find((l) => l.id === 'marine-land-dim');
      expect(dim).toMatchObject({ type: 'background' });
      const water = s.layers.find((l) => l.id === 'marine-water-fill');
      expect(water).toMatchObject({
        type: 'fill',
        source: 'overlay-labels',
        'source-layer': 'water',
      });
      // Chart flatness: no terrain shading under a nautical chart.
      expect(layerIds(s)).not.toContain('hillshade-2d');
    });

    it('drops the WMS bathymetry drape — the client chart replaces it', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        marineLayers: ['bathymetry', 'seamarks'],
        overlayLabels,
        marineChart: chart,
      });
      expect(layerIds(s)).not.toContain('marine-bathymetry');
      expect(s.sources['marine-bathymetry']).toBeUndefined();
      // The anchors the live chart mounts against must exist (see the
      // "live drape anchors" block for the ordering they encode).
      expect(layerIds(s)).toContain(MARINE_DRAPE_ANCHOR);
      expect(layerIds(s)).toContain(MARINE_SOUNDINGS_ANCHOR);
    });

    it('never declares the client drape or the soundings itself', () => {
      // They are MapView children (`MarineChartLayers`) so a re-anchored
      // chart updates the image source in place instead of reloading the
      // whole native style — the reload storm behind "charts load very slow".
      const s = buildOsmStyle(TILE, 'map', true, {
        marineLayers: ['bathymetry'],
        overlayLabels,
        marineChart: chart,
      });
      expect(s.sources['marine-depth-chart']).toBeUndefined();
      expect(s.sources['marine-soundings']).toBeUndefined();
      expect(layerIds(s)).not.toContain('marine-depth-chart');
      expect(layerIds(s)).not.toContain('marine-soundings');
    });

    it('keeps the WMS drape as the silent fallback when the client pipeline failed', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        marineLayers: ['bathymetry'],
        overlayLabels,
        marineChart: { wmsFallback: true },
      });
      expect(layerIds(s)).toContain('marine-bathymetry');
    });

    it('skips the water fill when the vector overlay did not resolve', () => {
      const s = buildOsmStyle(TILE, 'map', true, {
        marineLayers: ['bathymetry'],
        marineChart: chart,
      });
      expect(layerIds(s)).not.toContain('marine-water-fill');
      expect(layerIds(s)).toContain('marine-land-dim');
    });
  });

  describe('downloaded-regions mask', () => {
    const mask = {
      data: buildDownloadedMask([{ minLng: -71, minLat: 46, maxLng: -70, maxLat: 47 }]),
      color: '#FFFFFF',
    };

    it('is absent by default', () => {
      const s = buildOsmStyle(TILE, 'map', true);
      expect(s.sources['downloaded-mask']).toBeUndefined();
      expect(layerIds(s)).not.toContain('downloaded-mask');
    });

    it('adds an opaque fill in the requested colour over every base-map layer', () => {
      const s = buildOsmStyle(TILE, 'map', true, { downloadedMask: mask });
      expect(s.sources['downloaded-mask']).toEqual({ type: 'geojson', data: mask.data });
      const ids = layerIds(s);
      // Above raster + hillshade…
      for (const id of ['osm', 'hillshade-2d']) {
        expect(ids.indexOf('downloaded-mask')).toBeGreaterThan(ids.indexOf(id));
      }
      const layer = s.layers.find((l) => l.id === 'downloaded-mask');
      expect(layer).toMatchObject({
        type: 'fill',
        source: 'downloaded-mask',
        paint: { 'fill-color': '#FFFFFF', 'fill-opacity': 1 },
      });
    });

    it('keeps PDF maps and trails ABOVE it — they live on the device (#492)', () => {
      // Owner: in "Locally downloaded only" mode a PDF map outside a
      // downloaded region vanished under the mask, as did your own trails.
      for (const basemap of ['map', 'satellite'] as const) {
        for (const opts of [{}, { weatherMuted: { dimColor: '#111', dimOpacity: 0.4 } }]) {
          const ids = layerIds(
            buildOsmStyle(TILE, basemap, true, { downloadedMask: mask, ...opts }),
          );
          const at = (id: string) => ids.indexOf(id);
          expect(at(PDF_MAPS_ANCHOR)).toBe(at('downloaded-mask') + 1);
          expect(at(TRAILS_ANCHOR)).toBeGreaterThan(at('downloaded-mask'));
          // …and every base-map drape and terrain overlay stays under it.
          for (const a of [CONTOURS_ANCHOR, TERRAIN_OVERLAY_ANCHOR]) {
            expect(at(a)).toBeLessThan(at('downloaded-mask'));
          }
          if (at(WEATHER_DRAPE_ANCHOR) >= 0) {
            expect(at(WEATHER_DRAPE_ANCHOR)).toBeLessThan(at('downloaded-mask'));
          }
        }
      }
    });

    it('sits above the base raster layer for every basemap', () => {
      for (const basemap of ['map', 'satellite'] as const) {
        const ids = layerIds(buildOsmStyle(TILE, basemap, true, { downloadedMask: mask }));
        expect(ids.indexOf('downloaded-mask')).toBeGreaterThan(ids.indexOf('osm'));
      }
    });
  });
});

// #332 — the blue dot must always be on top. MapLibre appends a MapView-child
// layer without `beforeId` to the TOP of the style, above the puck that was
// mounted at first paint. Every overlay therefore inserts `beforeId` one of
// these anchors, which must exist in EVERY style variant or the layer would
// wait for it forever.
describe('position-puck anchors (#332)', () => {
  const overlayLabels = { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] };
  const weatherMuted = { dimColor: '#F4F1EC', dimOpacity: 0.42 };
  const variants: [string, Parameters<typeof buildOsmStyle>[3]][] = [
    ['plain map', undefined],
    ['satellite', undefined],
    ['weather', { weatherMuted, overlayLabels }],
    ['marine', { marineChart: { wmsFallback: false }, overlayLabels }],
    ['labels only', { overlayLabels }],
  ];

  it.each(variants)(
    '%s: carries every anchor in order, drapes under the PDF maps',
    (name, opts) => {
      const ids = layerIds(
        buildOsmStyle(TILE, name === 'satellite' ? 'satellite' : 'map', true, opts),
      );
      const at = (id: string) => ids.indexOf(id);
      for (const a of ALWAYS_PRESENT_ANCHORS) expect(at(a)).toBeGreaterThanOrEqual(0);
      // Whatever subset is present appears in the table's order.
      const present = DRAPE_ANCHORS_BOTTOM_TO_TOP.filter((a) => at(a) >= 0).map(at);
      expect(present).toEqual([...present].sort((a, b) => a - b));
      for (const drape of [MARINE_DRAPE_ANCHOR, WEATHER_DRAPE_ANCHOR, MARINE_SOUNDINGS_ANCHOR]) {
        if (at(drape) >= 0) expect(at(drape)).toBeLessThan(at(PDF_MAPS_ANCHOR));
      }
    },
  );

  it('keeps the reference labels above the overlays (ink beats maps)', () => {
    const ids = layerIds(buildOsmStyle(TILE, 'map', true, { overlayLabels }));
    const lastAnchor = ids.indexOf(TRAILS_ANCHOR);
    const labelIds = ids.filter((id) => /label|overlay-labels|coast/i.test(id));
    expect(labelIds.length).toBeGreaterThan(0);
    for (const id of labelIds) expect(ids.indexOf(id)).toBeGreaterThan(lastAnchor);
  });
});

describe('night red raster (decision 4)', () => {
  const osmPaint = (night: boolean) => {
    const style = buildOsmStyle('https://tiles/{z}/{x}/{y}.png', 'map', false, { night });
    return style.layers.find((l) => l.id === 'osm')?.paint as Record<string, number> | undefined;
  };

  it('goes greyscale and dim at night', () => {
    expect(osmPaint(true)).toEqual({ 'raster-saturation': -1, 'raster-brightness-max': 0.35 });
  });

  it('keeps the normal paint otherwise', () => {
    expect(osmPaint(false)?.['raster-brightness-max']).not.toBe(0.35);
  });
});

describe('vector Stone & Paper basemap (VECTOR_BASEMAP_ENABLED)', () => {
  const VECTOR_TILES = ['https://vector.example/{z}/{x}/{y}.pbf'];
  const vectorBasemap = { tiles: VECTOR_TILES, dark: false };

  /** buildOsmStyle from a fresh module graph with the flag forced. */
  function withFlag(enabled: boolean): typeof buildOsmStyle {
    let build: typeof buildOsmStyle = buildOsmStyle;
    jest.isolateModules(() => {
      jest.doMock('@core/features/flags', () => ({
        ...jest.requireActual<object>('@core/features/flags'),
        VECTOR_BASEMAP_ENABLED: enabled,
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      build = (require('./mapStyle') as typeof import('./mapStyle')).buildOsmStyle;
    });
    return build;
  }

  it('flag off: the option is ignored and the map stays the OSM raster', () => {
    const s = withFlag(false)(TILE, 'map', false, { vectorBasemap });
    expect(baseSource(s).tiles).toEqual([TILE]);
    expect(s.sources['basemap-vector']).toBeUndefined();
    expect(s.glyphs).toBeUndefined();
    expect(layerIds(s).some((id) => id.startsWith('stone-'))).toBe(false);
  });

  it('flag off: identical to a style built without the option', () => {
    const build = withFlag(false);
    expect(build(TILE, 'map', true, { vectorBasemap })).toEqual(build(TILE, 'map', true));
  });

  it('flag on + map: swaps the raster for the vector source and stone layers', () => {
    const s = withFlag(true)(TILE, 'map', true, { vectorBasemap });
    expect(s.sources.osm).toBeUndefined();
    expect(s.sources['basemap-vector']).toMatchObject({ type: 'vector', tiles: VECTOR_TILES });
    expect(s.glyphs).toMatch(/\{fontstack\}.*\{range\}/);
    const ids = layerIds(s);
    expect(ids).not.toContain('osm');
    expect(ids).not.toContain('background');
    expect(ids[0]).toBe('stone-background');
    // Body under the hillshade, labels over it, all under the overlay anchors.
    const at = (id: string) => ids.indexOf(id);
    expect(at('stone-water')).toBeLessThan(at('hillshade-2d'));
    expect(at('stone-place-town')).toBeGreaterThan(at('hillshade-2d'));
    expect(at('stone-place-town')).toBeLessThan(at(PDF_MAPS_ANCHOR));
    // Every vector layer reads the declared source.
    for (const l of s.layers) {
      if ('source' in l && l.id.startsWith('stone-')) expect(l.source).toBe('basemap-vector');
    }
  });

  it('flag on: Noto from OpenFreeMap by default, Atkinson from our glyph host when set', () => {
    const build = withFlag(true);
    const fontsOf = (st: ReturnType<typeof build>) =>
      st.layers.flatMap((l) =>
        l.type === 'symbol' && l.id.startsWith('stone-')
          ? [JSON.stringify((l.layout as Record<string, unknown>)['text-font'])]
          : [],
      );
    const noto = build(TILE, 'map', false, { vectorBasemap });
    expect(noto.glyphs).toContain('openfreemap');
    expect(fontsOf(noto).every((f) => f.includes('Noto Sans'))).toBe(true);
    const ours = 'https://tiles.example/fonts/{fontstack}/{range}.pbf';
    const atkinson = build(TILE, 'map', false, {
      vectorBasemap: { ...vectorBasemap, glyphs: ours },
    });
    expect(atkinson.glyphs).toBe(ours);
    expect(fontsOf(atkinson).every((f) => f.includes('Atkinson Hyperlegible Next'))).toBe(true);
  });

  it('flag on: adds served contour tiles only when asked', () => {
    const build = withFlag(true);
    const without = build(TILE, 'map', false, { vectorBasemap });
    expect(without.sources['basemap-contours']).toBeUndefined();
    const withContours = build(TILE, 'map', false, {
      vectorBasemap: {
        ...vectorBasemap,
        contours: 'https://tiles.example/contours/{z}/{x}/{y}.mvt',
      },
    });
    expect(withContours.sources['basemap-contours']).toMatchObject({
      type: 'vector',
      minzoom: CONTOUR_SOURCE_MINZOOM,
      maxzoom: CONTOUR_SOURCE_MAXZOOM,
    });
    const ids = layerIds(withContours);
    expect(ids).toContain('stone-contour-major');
    expect(ids).toContain('stone-contour-minor');
  });

  it('flag on: contour tiles load z8–13 only — overzoomed past 13, nothing drawn below 8 (#509)', () => {
    expect(CONTOUR_SOURCE_MAXZOOM).toBe(13);
    const style = withFlag(true)(TILE, 'map', false, {
      vectorBasemap: {
        ...vectorBasemap,
        contours: 'https://tiles.example/contours/{z}/{x}/{y}.mvt',
      },
    });
    const contourLayers = style.layers.filter(
      (l) => 'source' in l && l.source === 'basemap-contours',
    );
    expect(contourLayers.length).toBeGreaterThanOrEqual(3);
    // Every contour layer starts at or after the source's first zoom, and the
    // earliest one starts exactly there (no tiles fetched that nothing draws).
    const starts = contourLayers.map((l) => l.minzoom ?? 0);
    expect(Math.min(...starts)).toBe(CONTOUR_SOURCE_MINZOOM);
    // None stops at the source's maxzoom: they keep drawing overzoomed tiles.
    for (const l of contourLayers) expect(l.maxzoom).toBeUndefined();
  });

  it('flag on: labels peaks from our summit tiles when given, else from Protomaps', () => {
    const build = withFlag(true);
    const without = build(TILE, 'map', false, { vectorBasemap });
    expect(without.sources['basemap-peaks']).toBeUndefined();
    expect(without.layers.find((l) => l.id === 'stone-peak')).toMatchObject({
      'source-layer': 'pois',
    });
    const peaks = 'https://tiles.example/peaks/{z}/{x}/{y}.mvt';
    const withPeaks = build(TILE, 'map', false, {
      vectorBasemap: { ...vectorBasemap, peaks },
    });
    expect(withPeaks.sources['basemap-peaks']).toEqual({
      type: 'vector',
      tiles: [peaks],
      minzoom: 5,
      maxzoom: 12,
    });
    expect(withPeaks.layers.filter((l) => l.id.includes('peak'))).toEqual([
      expect.objectContaining({
        id: 'stone-peak',
        source: 'basemap-peaks',
        'source-layer': 'peaks',
      }),
    ]);
  });

  describe('parks and protected areas', () => {
    const PARK_LAYERS = [
      'stone-park-band',
      'stone-park-outline',
      'stone-park-line',
      'stone-park-label',
    ];
    const parks = 'https://tiles.example/parks/{z}/{x}/{y}.mvt';
    const parkLayers = (s: ReturnType<typeof buildOsmStyle>) =>
      s.layers.filter((l) => PARK_LAYERS.includes(l.id));
    /** The whole style through the reference validator (it catches a nested zoom). */
    const validateStyleMin = (s: ReturnType<typeof buildOsmStyle>) =>
      validateStyle(s as never).map((e) => e.message);

    it("draws Protomaps' parks by default, with no extra source", () => {
      const s = withFlag(true)(TILE, 'map', false, { vectorBasemap });
      expect(parkLayers(s).map((l) => l.id)).toEqual(PARK_LAYERS);
      expect(s.sources['basemap-parks']).toBeUndefined();
      for (const l of parkLayers(s)) expect(l).toMatchObject({ source: 'basemap-vector' });
      expect(validateStyleMin(s)).toEqual([]);
    });

    it('reads our parks tiles (z4–z12) when given', () => {
      const s = withFlag(true)(TILE, 'map', false, { vectorBasemap: { ...vectorBasemap, parks } });
      expect(s.sources['basemap-parks']).toEqual({
        type: 'vector',
        tiles: [parks],
        minzoom: 4,
        maxzoom: 12,
      });
      const byId = Object.fromEntries(parkLayers(s).map((l) => [l.id, l]));
      for (const id of ['stone-park-band', 'stone-park-line']) {
        expect(byId[id]).toMatchObject({ source: 'basemap-parks', 'source-layer': 'parks' });
      }
      expect(byId['stone-park-label']).toMatchObject({
        source: 'basemap-parks',
        'source-layer': 'park_labels',
      });
      expect(validateStyleMin(s)).toEqual([]);
    });

    it('the toggle removes the layers and the source, and nothing else', () => {
      const build = withFlag(true);
      const on = build(TILE, 'map', false, { vectorBasemap: { ...vectorBasemap, parks } });
      const off = build(TILE, 'map', false, {
        vectorBasemap: { ...vectorBasemap, parks, protectedAreas: false },
      });
      expect(parkLayers(off)).toEqual([]);
      // No layer reads it, so an offline pack must not download it.
      expect(off.sources['basemap-parks']).toBeUndefined();
      expect(off.layers.map((l) => l.id)).toEqual(
        on.layers.map((l) => l.id).filter((id) => !PARK_LAYERS.includes(id)),
      );
      expect(validateStyleMin(off)).toEqual([]);
    });

    it('over satellite: boundary and name with the labels, no fill, same toggle', () => {
      const imageryLabels = { tiles: vectorBasemap.tiles, parks };
      const s = buildOsmStyle(TILE, 'satellite', false, { imageryLabels });
      expect(parkLayers(s).map((l) => l.id)).toEqual(PARK_LAYERS);
      expect(s.sources['basemap-parks']).toMatchObject({ type: 'vector', maxzoom: 12 });
      expect(s.layers.some((l) => l.id.startsWith('stone-') && l.type === 'fill')).toBe(false);
      expect(validateStyleMin(s)).toEqual([]);

      const off = buildOsmStyle(TILE, 'satellite', false, {
        imageryLabels: { ...imageryLabels, protectedAreas: false },
      });
      expect(parkLayers(off)).toEqual([]);
      expect(off.sources['basemap-parks']).toBeUndefined();
      expect(off.layers.some((l) => l.id === 'stone-place-town')).toBe(true);
    });
  });

  describe('province and state names (Natural Earth points)', () => {
    const admin1 = 'https://pages.example/data/admin1-labels-v1.json';
    const province = (s: ReturnType<typeof buildOsmStyle>) =>
      s.layers.filter((l) => l.id === 'stone-place-province');

    it("draws Protomaps' regions without our points, with no extra source", () => {
      const s = withFlag(true)(TILE, 'map', false, { vectorBasemap });
      expect(s.sources['basemap-admin1']).toBeUndefined();
      expect(province(s)).toEqual([expect.objectContaining({ source: 'basemap-vector' })]);
    });

    it('reads one static GeoJSON file instead when given, on the map and over imagery', () => {
      const s = withFlag(true)(TILE, 'map', false, { vectorBasemap: { ...vectorBasemap, admin1 } });
      expect(s.sources['basemap-admin1']).toMatchObject({
        type: 'geojson',
        data: admin1,
        maxzoom: 8,
      });
      expect(province(s)).toEqual([expect.objectContaining({ source: 'basemap-admin1' })]);
      expect(s.layers.some((l) => l.id === 'stone-place-country')).toBe(true);
      expect(validateStyle(s as never).map((e) => e.message)).toEqual([]);

      const sat = buildOsmStyle(TILE, 'satellite', false, {
        imageryLabels: { tiles: vectorBasemap.tiles, admin1 },
      });
      expect(sat.sources['basemap-admin1']).toMatchObject({ type: 'geojson', data: admin1 });
      expect(province(sat)).toEqual([expect.objectContaining({ source: 'basemap-admin1' })]);
      expect(sat.layers.some((l) => l.id === 'stone-place-country')).toBe(true);
      expect(validateStyle(sat as never).map((e) => e.message)).toEqual([]);
    });
  });

  it('flag on: the dark scheme yields a different stone style', () => {
    const build = withFlag(true);
    const light = build(TILE, 'map', false, { vectorBasemap });
    const dark = build(TILE, 'map', false, {
      vectorBasemap: { ...vectorBasemap, dark: true },
    });
    expect(JSON.stringify(dark.layers)).not.toEqual(JSON.stringify(light.layers));
  });

  it('flag on: satellite stays raster', () => {
    const build = withFlag(true);
    expect(build(TILE, 'satellite', false, { vectorBasemap })).toEqual(
      build(TILE, 'satellite', false),
    );
  });

  it('flag on: offline packs (no option) stay raster', () => {
    const s = withFlag(true)(TILE, 'map');
    expect(baseSource(s).tiles).toEqual([TILE]);
    expect(s.sources['basemap-vector']).toBeUndefined();
  });
});

describe('terrain options in the style (#461)', () => {
  /** buildOsmStyle with the vector base map flag forced on. */
  function vectorBuild(): typeof buildOsmStyle {
    let build: typeof buildOsmStyle = buildOsmStyle;
    jest.isolateModules(() => {
      jest.doMock('@core/features/flags', () => ({
        ...jest.requireActual<object>('@core/features/flags'),
        VECTOR_BASEMAP_ENABLED: true,
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      build = (require('./mapStyle') as typeof import('./mapStyle')).buildOsmStyle;
    });
    return build;
  }
  const hillshadePaint = (s: ReturnType<typeof buildOsmStyle>) =>
    s.layers.find((l) => l.id === 'hillshade-2d')?.paint as Record<string, unknown> | undefined;
  const vector = (dark: boolean) => ({
    tiles: ['https://vector.example/{z}/{x}/{y}.pbf'],
    dark,
    peaks: 'https://peaks.example/{z}/{x}/{y}.mvt',
  });

  describe('shading', () => {
    it('None (shaded relief off) draws no hillshade and fetches no DEM, in both themes', () => {
      for (const dark of [false, true]) {
        const s = vectorBuild()(TILE, 'map', false, {
          vectorBasemap: vector(dark),
          hillshadeStrength: 'heavy',
        });
        expect(hillshadePaint(s)).toBeUndefined();
        expect(s.sources.dem).toBeUndefined();
      }
    });

    it('defaults to Medium', () => {
      const paint = hillshadePaint(buildOsmStyle(TILE, 'map', true));
      expect(DEFAULT_HILLSHADE_STRENGTH).toBe('medium');
      expect(paint?.['hillshade-shadow-color']).toBe(hillshadeLook('medium', false).shadowColor);
    });

    it.each(HILLSHADE_STRENGTHS)(
      '%s drives the exaggeration and colours (light raster)',
      (level) => {
        const look = hillshadeLook(level, false);
        const paint = hillshadePaint(
          buildOsmStyle(TILE, 'map', true, { hillshadeStrength: level }),
        );
        expect(paint).toMatchObject({
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
        });
      },
    );

    it.each(HILLSHADE_STRENGTHS)('%s uses the dark palette over the stone-night map', (level) => {
      const build = vectorBuild();
      const dark = hillshadePaint(
        build(TILE, 'map', true, { vectorBasemap: vector(true), hillshadeStrength: level }),
      );
      const light = hillshadePaint(
        build(TILE, 'map', true, { vectorBasemap: vector(false), hillshadeStrength: level }),
      );
      expect(dark?.['hillshade-shadow-color']).toBe(hillshadeLook(level, true).shadowColor);
      expect(light?.['hillshade-shadow-color']).toBe(hillshadeLook(level, false).shadowColor);
    });

    it('keeps the light palette on raster basemaps even in a dark app theme', () => {
      // Only the stone vector map has a night variant; the OSM raster is light.
      const s = buildOsmStyle(TILE, 'map', true, { hillshadeStrength: 'heavy' });
      expect(hillshadePaint(s)?.['hillshade-shadow-color']).toBe(
        hillshadeLook('heavy', false).shadowColor,
      );
    });
  });

  describe('peak density', () => {
    it.each(PEAK_DENSITIES)('%s reaches the stone peak layer (both themes)', (density) => {
      for (const dark of [false, true]) {
        const s = vectorBuild()(TILE, 'map', true, {
          vectorBasemap: { ...vector(dark), peakDensity: density },
        });
        const peak = s.layers.find((l) => l.id === 'stone-peak') as { filter?: unknown };
        expect(peak.filter).toEqual(peakDueFilter(PEAK_LEAD[density]));
      }
    });

    it('defaults to normal when the caller passes none (offline packs, trail viewer)', () => {
      const s = vectorBuild()(TILE, 'map', false, { vectorBasemap: vector(false) });
      const peak = s.layers.find((l) => l.id === 'stone-peak') as { filter?: unknown };
      expect(peak.filter).toEqual(peakDueFilter(PEAK_LEAD.normal));
    });

    it('keeps the peaks source z5–z12 (the style filter, not the source, picks the lead)', () => {
      const s = vectorBuild()(TILE, 'map', false, {
        vectorBasemap: { ...vector(false), peakDensity: 'more' },
      });
      expect(s.sources['basemap-peaks']).toMatchObject({ minzoom: 5, maxzoom: 12 });
    });
  });
});

// #480 — the tilted-map relief pass mounts only over a style that has the base
// shading (it names that layer as its afterId and reads the same DEM source).
describe('styleHasHillshade (#480)', () => {
  it('is true when the shaded relief is drawn, and names the ids the pass uses', () => {
    const s = buildOsmStyle(TILE, 'map', true);
    expect(styleHasHillshade(s)).toBe(true);
    expect(layerIds(s)).toContain(HILLSHADE_2D_LAYER_ID);
    const dem = s.sources[HILLSHADE_DEM_SOURCE_ID] as RasterDEMSourceSpecification;
    expect(dem.type).toBe('raster-dem');
    expect(dem.encoding).toBe('terrarium');
  });

  it('is false with shading off, over satellite, and under the weather dim', () => {
    const weatherMuted = { dimColor: '#F4F1EC', dimOpacity: 0.42 };
    expect(styleHasHillshade(buildOsmStyle(TILE, 'map', false))).toBe(false);
    expect(styleHasHillshade(buildOsmStyle(TILE, 'satellite', true))).toBe(false);
    expect(styleHasHillshade(buildOsmStyle(TILE, 'map', true, { weatherMuted }))).toBe(false);
  });
});

// #480 — the tilted-map relief pass ships hidden in the style, carrying the
// colours the RN component cannot set on Android.
describe('tilted-map relief pass (#480)', () => {
  const tiltLayer = (s: ReturnType<typeof buildOsmStyle>) =>
    s.layers.find((l) => l.id === TILT_RELIEF_LAYER_ID);

  it.each(['natural', 'dramatic'] as const)(
    '%s: hidden, flat, right above the base shading, on its DEM',
    (mode) => {
      const s = buildOsmStyle(TILE, 'map', true, { tiltRelief: mode });
      expect(styleHasTiltRelief(s)).toBe(true);
      const ids = layerIds(s);
      expect(ids.indexOf(TILT_RELIEF_LAYER_ID)).toBe(ids.indexOf(HILLSHADE_2D_LAYER_ID) + 1);
      const layer = tiltLayer(s);
      expect(layer).toMatchObject({
        type: 'hillshade',
        source: HILLSHADE_DEM_SOURCE_ID,
        minzoom: HILLSHADE_2D_MIN_ZOOM,
        layout: { visibility: 'none' },
      });
      const look = tiltReliefLook(mode, 60, false)!;
      expect(layer).toMatchObject({
        paint: {
          'hillshade-exaggeration': 0,
          'hillshade-shadow-color': look.shadowColor,
          'hillshade-highlight-color': look.highlightColor,
          'hillshade-accent-color': look.accentColor,
        },
      });
    },
  );

  it('is absent when the setting is off or unset', () => {
    expect(tiltLayer(buildOsmStyle(TILE, 'map', true, { tiltRelief: 'off' }))).toBeUndefined();
    expect(tiltLayer(buildOsmStyle(TILE, 'map', true))).toBeUndefined();
  });

  it('is absent on the map wherever the base shading is (none, weather dim)', () => {
    const weatherMuted = { dimColor: '#F4F1EC', dimOpacity: 0.42 };
    for (const s of [
      buildOsmStyle(TILE, 'map', false, { tiltRelief: 'dramatic' }),
      buildOsmStyle(TILE, 'map', true, { tiltRelief: 'dramatic', weatherMuted }),
      buildOsmStyle(TILE, 'satellite', true, { tiltRelief: 'dramatic', weatherMuted }),
      buildOsmStyle(TILE, 'satellite', true, { tiltRelief: 'off' }),
    ]) {
      expect(tiltLayer(s)).toBeUndefined();
      expect(styleHasTiltRelief(s)).toBe(false);
    }
  });
});

describe('labels on satellite (#484)', () => {
  const imageryLabels = {
    tiles: ['https://vector.example/{z}/{x}/{y}.mvt'],
    glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf',
    peaks: 'https://tiles.example/peaks/{z}/{x}/{y}.mvt',
  };
  const stoneIds = (s: ReturnType<typeof buildOsmStyle>) =>
    layerIds(s).filter((id) => id.startsWith('stone-'));

  it('draws the roads, trails and names over the imagery when on', () => {
    const s = buildOsmStyle(TILE, 'satellite', true, { imageryLabels });
    // The imagery stays the base…
    expect(baseSource(s).tiles?.[0]).toContain('World_Imagery');
    expect(s.sources['basemap-vector']).toMatchObject({ type: 'vector' });
    expect(s.sources['basemap-peaks']).toMatchObject({ type: 'vector', maxzoom: 12 });
    expect(s.glyphs).toBe(imageryLabels.glyphs);
    const ids = stoneIds(s);
    for (const id of [
      'stone-path',
      'stone-road-minor',
      'stone-place-town',
      'stone-waterway-label',
    ]) {
      expect(ids).toContain(id);
    }
    // …with no ground fills over it.
    const fills = s.layers.filter(
      (l) => l.id.startsWith('stone-') && (l.type === 'fill' || l.type === 'background'),
    );
    expect(fills).toEqual([]);
  });

  it('sits above the imagery and below the overlay anchors and the puck', () => {
    const ids = layerIds(buildOsmStyle(TILE, 'satellite', true, { imageryLabels }));
    const firstStone = ids.findIndex((id) => id.startsWith('stone-'));
    const lastStone = ids.map((id) => id.startsWith('stone-')).lastIndexOf(true);
    expect(firstStone).toBeGreaterThan(ids.indexOf('osm'));
    expect(lastStone).toBeLessThan(ids.indexOf(PDF_MAPS_ANCHOR));
  });

  it('reads light ink on a dark halo — the imagery palette, whatever the app theme', () => {
    const s = buildOsmStyle(TILE, 'satellite', true, { imageryLabels });
    const town = s.layers.find((l) => l.id === 'stone-place-town');
    const paint = town?.paint as Record<string, string> | undefined;
    expect(paint?.['text-color']).toBe('#FBF8F2');
    expect(paint?.['text-halo-color']).toBe('#14181C');
  });

  it('emits nothing when off, on the map base, or under weather/marine', () => {
    const off = buildOsmStyle(TILE, 'satellite', true);
    expect(stoneIds(off)).toEqual([]);
    expect(off.sources['basemap-vector']).toBeUndefined();
    expect(off.glyphs).toBeUndefined();
    // The raster map: the option is ignored (the vector map has its own labels).
    expect(stoneIds(buildOsmStyle(TILE, 'map', true, { imageryLabels }))).toEqual([]);
    const weather = buildOsmStyle(TILE, 'satellite', true, {
      imageryLabels,
      weatherMuted: { dimColor: '#101418', dimOpacity: 0.45 },
    });
    expect(stoneIds(weather)).toEqual([]);
    const marine = buildOsmStyle(TILE, 'satellite', true, {
      imageryLabels,
      marineChart: { wmsFallback: false },
    });
    expect(stoneIds(marine)).toEqual([]);
  });

  it('falls back to the Noto glyphs without our glyph host', () => {
    const s = buildOsmStyle(TILE, 'satellite', true, {
      imageryLabels: { tiles: imageryLabels.tiles },
    });
    expect(s.glyphs).toContain('openfreemap');
    expect(s.sources['basemap-peaks']).toBeUndefined();
  });
});

describe('contours on satellite (#492)', () => {
  const imageryContours = {
    tiles: 'https://tiles.example/contours/{z}/{x}/{y}.mvt',
    glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf',
  };
  const imageryLabels = {
    tiles: ['https://vector.example/{z}/{x}/{y}.mvt'],
    glyphs: imageryContours.glyphs,
  };

  it('draws the served contour tiles over the imagery, with their heights', () => {
    const s = buildOsmStyle(TILE, 'satellite', true, { imageryContours });
    expect(s.sources['basemap-contours']).toMatchObject({
      type: 'vector',
      tiles: [imageryContours.tiles],
      maxzoom: 13,
    });
    // Contours alone need no base-map source, but the heights need glyphs.
    expect(s.sources['basemap-vector']).toBeUndefined();
    expect(s.glyphs).toBe(imageryContours.glyphs);
    const ids = layerIds(s);
    for (const id of [
      'stone-contour-minor-casing',
      'stone-contour-minor',
      'stone-contour-major-casing',
      'stone-contour-major',
      'stone-contour-label',
    ]) {
      expect(ids).toContain(id);
    }
    // No roads or names without the labels toggle.
    expect(ids).not.toContain('stone-path');
    expect(ids).not.toContain('stone-place-town');
  });

  it('draws each line over its own dark casing, in the imagery palette', () => {
    const s = buildOsmStyle(TILE, 'satellite', true, { imageryContours });
    const ids = layerIds(s);
    const paint = (id: string) =>
      s.layers.find((l) => l.id === id)?.paint as Record<string, unknown> | undefined;
    for (const kind of ['minor', 'major']) {
      expect(ids.indexOf(`stone-contour-${kind}-casing`)).toBe(
        ids.indexOf(`stone-contour-${kind}`) - 1,
      );
      expect(paint(`stone-contour-${kind}`)?.['line-color']).toBe('#F2ECE0');
      expect(paint(`stone-contour-${kind}-casing`)?.['line-color']).toBe('#14181C');
    }
  });

  it('puts the contours under the roads and names, and EVERY contour under the PDF maps', () => {
    const ids = layerIds(
      buildOsmStyle(TILE, 'satellite', true, { imageryContours, imageryLabels }),
    );
    const at = (id: string) => ids.indexOf(id);
    expect(at('stone-contour-major')).toBeGreaterThan(at('osm'));
    expect(at('stone-contour-major')).toBeLessThan(at('stone-road-minor'));
    expect(at('stone-path')).toBeLessThan(at('stone-place-town'));
    for (const id of ids.filter((x) => x.includes('contour'))) {
      expect([id, at(id) < at(PDF_MAPS_ANCHOR)]).toEqual([id, true]);
    }
  });

  it('is ignored on the Map base (its contours are part of the stone body)', () => {
    const s = buildOsmStyle(TILE, 'map', true, { imageryContours });
    expect(s.sources['basemap-contours']).toBeUndefined();
    expect(layerIds(s).some((id) => id.startsWith('stone-contour'))).toBe(false);
  });

  it('stays under weather — like the map body', () => {
    const weather = buildOsmStyle(TILE, 'satellite', true, {
      imageryContours,
      weatherMuted: { dimColor: '#101418', dimOpacity: 0.45 },
    });
    const ids = layerIds(weather);
    expect(ids.indexOf('stone-contour-major')).toBeLessThan(ids.indexOf('weather-dim'));
  });

  it('falls back to Noto from OpenFreeMap without our glyph host', () => {
    const s = buildOsmStyle(TILE, 'satellite', true, {
      imageryContours: { tiles: imageryContours.tiles },
    });
    expect(s.glyphs).toContain('openfreemap');
    const label = s.layers.find((l) => l.id === 'stone-contour-label');
    expect((label?.layout as Record<string, unknown>)['text-font']).toEqual(['Noto Sans Regular']);
  });
});

// #492 — ONE stack for both base maps. Builds the style the main map would
// for every combination of toggles, on both base maps, in both themes, and
// holds it to `mapDrawOrder` (the pure statement of the order in
// `@core/map/layerSlots`): every element drawn appears in exactly that order.
describe('one layer order on both base maps (#492)', () => {
  const VECTOR = ['https://vector.example/{z}/{x}/{y}.pbf'];
  const CONTOURS = 'https://contours.example/{z}/{x}/{y}.mvt';
  const GLYPHS = 'https://glyphs.example/{fontstack}/{range}.pbf';

  function withFlag(): typeof buildOsmStyle {
    let build: typeof buildOsmStyle = buildOsmStyle;
    jest.isolateModules(() => {
      jest.doMock('@core/features/flags', () => ({
        ...jest.requireActual<object>('@core/features/flags'),
        VECTOR_BASEMAP_ENABLED: true,
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      build = (require('./mapStyle') as typeof import('./mapStyle')).buildOsmStyle;
    });
    return build;
  }
  const build = withFlag();
  const mask = {
    data: buildDownloadedMask([{ minLng: -71, minLat: 46, maxLng: -70, maxLat: 47 }]),
    color: '#FFFFFF',
  };

  /** The options MapScreen passes for these toggles. */
  function styleFor(i: MapStackInput) {
    const satellite = i.basemap === 'satellite';
    return build(TILE, i.basemap, i.shadedRelief, {
      tiltRelief: i.tiltRelief ? 'natural' : 'off',
      ...(!satellite
        ? {
            vectorBasemap: {
              tiles: VECTOR,
              dark: i.dark,
              glyphs: GLYPHS,
              ...(i.contours ? { contours: CONTOURS } : {}),
            },
          }
        : {}),
      ...(satellite && i.satelliteLabels
        ? { imageryLabels: { tiles: VECTOR, glyphs: GLYPHS } }
        : {}),
      ...(satellite && i.contours ? { imageryContours: { tiles: CONTOURS, glyphs: GLYPHS } } : {}),
      ...(i.weather ? { weatherMuted: { dimColor: '#101418', dimOpacity: 0.45 } } : {}),
      ...(i.marine ? { marineChart: { wmsFallback: false } } : {}),
      ...(i.weather || i.marine
        ? { overlayLabels: { dark: i.dark, tiles: ['https://ofm.example/{z}/{x}/{y}.pbf'] } }
        : {}),
      ...(i.offlineMask ? { downloadedMask: mask } : {}),
    });
  }

  /** The layer that stands for an element in the style (anchors for runtime ones). */
  function representative(e: MapElement, i: MapStackInput): string {
    switch (e) {
      case 'ground':
        return i.basemap === 'map' ? 'stone-background' : 'osm';
      case 'contours':
        return 'stone-contour-major';
      case 'linework':
        return 'stone-path';
      case 'chart':
        return 'marine-land-dim';
      case 'relief':
        return HILLSHADE_2D_LAYER_ID;
      case 'tiltRelief':
        return TILT_RELIEF_LAYER_ID;
      case 'slope':
        return TERRAIN_OVERLAY_ANCHOR;
      case 'labels':
        return 'stone-place-town';
      case 'weather':
        return WEATHER_DRAPE_ANCHOR;
      case 'pdf':
        return PDF_MAPS_ANCHOR;
      case 'heat':
      case 'trails':
        return TRAILS_ANCHOR;
      case 'reference':
        return 'overlay-town-labels';
      case 'mask':
        return 'downloaded-mask';
    }
  }

  const inputs: MapStackInput[] = [];
  for (const basemap of ['map', 'satellite'] as const) {
    for (let bits = 0; bits < 1 << 8; bits++) {
      const b = (n: number) => (bits & (1 << n)) !== 0;
      inputs.push({
        basemap,
        vector: true,
        dark: b(0),
        shadedRelief: b(1),
        tiltRelief: b(2),
        contours: b(3),
        satelliteLabels: b(4),
        weather: b(5),
        marine: b(6),
        offlineMask: b(7),
        // Runtime overlays: their anchors are always in the style.
        slope: true,
        pdf: true,
        heat: true,
        trails: true,
      });
    }
  }
  const built = inputs.map((i) => ({ i, ids: layerIds(styleFor(i)), order: mapDrawOrder(i) }));

  it(`draws every element in mapDrawOrder's order (${inputs.length} combinations)`, () => {
    for (const { i, ids, order } of built) {
      const at = order.map((e) => [e, ids.indexOf(representative(e, i))] as const);
      for (const [e, n] of at) expect([i, e, n >= 0]).toEqual([i, e, true]);
      for (let k = 1; k < at.length; k++) {
        const prev = at[k - 1];
        const cur = at[k];
        if (!prev || !cur || representative(prev[0], i) === representative(cur[0], i)) continue;
        expect([i, prev[0], cur[0], cur[1] > prev[1]]).toEqual([i, prev[0], cur[0], true]);
      }
    }
  });

  it('draws nothing mapDrawOrder leaves out (relief on satellite, names under a drape)', () => {
    for (const { i, ids, order } of built) {
      for (const e of ['contours', 'linework', 'relief', 'tiltRelief', 'labels'] as const) {
        if (!order.includes(e)) {
          expect([i, e, ids.includes(representative(e, i))]).toEqual([i, e, false]);
        }
      }
    }
  });

  it('keeps every contour, relief and slope layer under the PDF maps, always', () => {
    const underPdf = (id: string) =>
      /contour|hillshade/.test(id) || id === TERRAIN_OVERLAY_ANCHOR || id === CONTOURS_ANCHOR;
    for (const { i, ids } of built) {
      const pdf = ids.indexOf(PDF_MAPS_ANCHOR);
      for (const id of ids.filter(underPdf)) {
        expect([i.basemap, id, ids.indexOf(id) < pdf]).toEqual([i.basemap, id, true]);
      }
    }
  });
});

// #492 — satellite gains the tilted-map relief: no flat shading on the
// imagery, only the pass that fades in with the pitch, lighter.
describe('tilted relief over satellite (#492)', () => {
  const tiltOf = (s: ReturnType<typeof buildOsmStyle>) =>
    s.layers.find((l) => l.id === TILT_RELIEF_LAYER_ID);

  it.each(['natural', 'dramatic'] as const)(
    '%s: carries the hidden pass and its DEM, but no flat hillshade',
    (mode) => {
      // The flat-shading setting does not matter on imagery; the 3D one does.
      for (const shaded of [false, true]) {
        const s = buildOsmStyle(TILE, 'satellite', shaded, { tiltRelief: mode });
        expect(styleHasHillshade(s)).toBe(false);
        expect(layerIds(s)).not.toContain(HILLSHADE_2D_LAYER_ID);
        expect(styleHasTiltRelief(s)).toBe(true);
        expect(s.sources[HILLSHADE_DEM_SOURCE_ID]).toMatchObject({ type: 'raster-dem' });
        const tilt = tiltOf(s);
        // Flat it is hidden; the map screen switches it on as the map tilts.
        expect(tilt?.layout).toEqual({ visibility: 'none' });
        expect(tilt?.minzoom).toBe(HILLSHADE_2D_MIN_ZOOM);
      }
    },
  );

  it('uses the night palette — near-black shadow, no umber tint on the photo', () => {
    const s = buildOsmStyle(TILE, 'satellite', false, { tiltRelief: 'natural' });
    const paint = tiltOf(s)?.paint as Record<string, unknown>;
    expect(paint['hillshade-shadow-color']).toBe(
      tiltReliefLook('natural', MAP_MAX_PITCH_DEG, true, true)?.shadowColor,
    );
    expect(String(paint['hillshade-shadow-color'])).toMatch(/^rgba\(0, 0, 0,/);
  });

  it('sits over the imagery and its contours and roads, under the slope and the PDF maps', () => {
    const ids = layerIds(
      buildOsmStyle(TILE, 'satellite', false, {
        tiltRelief: 'natural',
        imageryContours: { tiles: 'https://c.example/{z}/{x}/{y}.mvt' },
        imageryLabels: { tiles: ['https://v.example/{z}/{x}/{y}.mvt'] },
      }),
    );
    const at = (id: string) => ids.indexOf(id);
    expect(at(TILT_RELIEF_LAYER_ID)).toBeGreaterThan(at('stone-contour-major'));
    expect(at(TILT_RELIEF_LAYER_ID)).toBeGreaterThan(at('stone-path'));
    expect(at(TILT_RELIEF_LAYER_ID)).toBe(at(TERRAIN_OVERLAY_ANCHOR) - 1);
    expect(at(TILT_RELIEF_LAYER_ID)).toBeLessThan(at(PDF_MAPS_ANCHOR));
  });

  it('stays out of offline packs (no tilt option) and the marine chart', () => {
    expect(styleHasTiltRelief(buildOsmStyle(TILE, 'satellite'))).toBe(false);
    const chart = buildOsmStyle(TILE, 'satellite', false, {
      tiltRelief: 'natural',
      marineChart: { wmsFallback: false },
    });
    expect(styleHasTiltRelief(chart)).toBe(false);
  });
});

describe('satellite imagery look + tile budget (#495)', () => {
  const osmLayer = (s: ReturnType<typeof buildOsmStyle>) => s.layers.find((l) => l.id === 'osm');

  it('brightens the imagery by default and fades tiles in fast', () => {
    const osm = osmLayer(buildOsmStyle(TILE, 'satellite'));
    expect(osm?.paint).toEqual({
      ...IMAGERY_PAINT[DEFAULT_IMAGERY_LOOK],
      'raster-fade-duration': SATELLITE_FADE_MS,
    });
    expect(osm?.paint).toMatchObject({ 'raster-brightness-min': 0.15 });
  });

  it('applies the chosen look, and Original is the tiles as served', () => {
    const brighter = osmLayer(buildOsmStyle(TILE, 'satellite', false, { imageryLook: 'brighter' }));
    expect(brighter?.paint).toMatchObject(IMAGERY_PAINT.brighter);
    const original = osmLayer(buildOsmStyle(TILE, 'satellite', false, { imageryLook: 'original' }));
    expect(original?.paint).toEqual({ 'raster-fade-duration': SATELLITE_FADE_MS });
  });

  it('yields to the night and weather paints', () => {
    const night = osmLayer(buildOsmStyle(TILE, 'satellite', false, { night: true }));
    expect(night?.paint).not.toHaveProperty('raster-brightness-min');
    const weather = osmLayer(
      buildOsmStyle(TILE, 'satellite', false, {
        weatherMuted: { dimColor: '#000', dimOpacity: 0.4 },
        imageryLook: 'brighter',
      }),
    );
    expect(weather?.paint).toMatchObject({ 'raster-saturation': -0.85 });
  });

  it('leaves the map basemap paint and tile size alone', () => {
    const s = buildOsmStyle(TILE, 'map', false, { imageryLook: 'brighter' });
    expect(osmLayer(s)?.paint).toEqual({
      'raster-saturation': -0.25,
      'raster-contrast': 0.06,
      'raster-brightness-min': 0.04,
      'raster-brightness-max': 0.96,
    });
    expect(baseSource(s).tileSize).toBe(256);
  });

  it('declares the imagery at the satellite tile size, unless a caller overrides it', () => {
    expect(baseSource(buildOsmStyle(TILE, 'satellite')).tileSize).toBe(SATELLITE_TILE_SIZE);
    // The map maker's editor still under-declares for a sharp sheet (#349).
    expect(
      baseSource(buildOsmStyle(TILE, 'satellite', false, { rasterTileSize: 128 })).tileSize,
    ).toBe(128);
  });
});
