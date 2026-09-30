import { buildDownloadedMask } from '@core/geo/downloadedMask';
import {
  ALWAYS_PRESENT_ANCHORS,
  DRAPE_ANCHORS_BOTTOM_TO_TOP,
  MARINE_DRAPE_ANCHOR,
  MARINE_SOUNDINGS_ANCHOR,
  WEATHER_DRAPE_ANCHOR,
} from '@core/geo/mapLayerStack';
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
import {
  basemapAttribution,
  buildOsmStyle,
  HILLSHADE_2D_DEM_TILE_SIZE,
  HILLSHADE_2D_LAYER_ID,
  HILLSHADE_2D_MIN_ZOOM,
  HILLSHADE_DEM_SOURCE_ID,
  styleHasHillshade,
  styleHasTiltRelief,
  TILT_RELIEF_LAYER_ID,
} from './mapStyle';
import { tiltReliefLook } from '@core/map/tiltRelief';

const TILE = 'https://tile.example/{z}/{x}/{y}.png';
const layerIds = (s: ReturnType<typeof buildOsmStyle>) => s.layers.map((l) => l.id);
const baseSource = (s: ReturnType<typeof buildOsmStyle>) =>
  s.sources.osm as RasterSourceSpecification;

describe('buildOsmStyle', () => {
  it('renders a plain raster base with no relief by default (offline-pack style)', () => {
    const s = buildOsmStyle(TILE, false, 'map');
    expect(s.sources.dem).toBeUndefined();
    // The three puck anchors ride along in every style (#332); invisible, sourceless.
    expect(layerIds(s)).toEqual(['background', 'osm', ...ALWAYS_PRESENT_ANCHORS]);
    expect(s.terrain).toBeUndefined();
  });

  it('adds a 2D hillshade + DEM source when shaded relief is requested', () => {
    const s = buildOsmStyle(TILE, false, 'map', true);
    expect(s.sources.dem).toBeDefined();
    expect(layerIds(s)).toContain('hillshade-2d');
    expect(s.terrain).toBeUndefined(); // shaded relief is flat — no 3D terrain spec
  });

  it('mutes the OSM "map" basemap via raster paint', () => {
    const osm = buildOsmStyle(TILE, false, 'map', true).layers.find((l) => l.id === 'osm');
    expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.25 });
  });

  it('does NOT shade satellite imagery even when shaded relief is requested', () => {
    const s = buildOsmStyle(TILE, false, 'satellite', true);
    expect(s.sources.dem).toBeUndefined();
    expect(layerIds(s)).not.toContain('hillshade-2d');
  });

  it('omits the shaded relief in 3D mode (the terrain surface owns the DEM there)', () => {
    const s = buildOsmStyle(TILE, true, 'map', true);
    expect(layerIds(s)).toContain('hillshade'); // the 3D hillshade
    expect(layerIds(s)).not.toContain('hillshade-2d');
    expect(s.terrain).toEqual({ source: 'dem', exaggeration: 2.2 });
  });

  it('keeps offline packs lean: shadedRelief defaults off so the DEM never enters a pack style', () => {
    // The offline-download path calls buildOsmStyle(tileUrl, false, basemap) with
    // no shadedRelief arg — assert that path yields no DEM source/tiles.
    const s = buildOsmStyle(TILE, false, 'relief');
    expect(s.sources.dem).toBeUndefined();
  });

  /**
   * #230 — map/relief stutter on zoom-out on iOS, satellite is smooth. The
   * arithmetic behind these constants lives in `@core/geo/tiles`
   * ("live-viewport DEM tile load"); this pins the style that spends it.
   */
  describe('shaded-relief cost controls (#230)', () => {
    const hillshade2d = (s: ReturnType<typeof buildOsmStyle>) =>
      s.layers.find((l) => l.id === 'hillshade-2d');

    it.each(['map', 'relief'] as const)('zoom-gates the %s hillshade at z11', (basemap) => {
      const layer = hillshade2d(buildOsmStyle(TILE, false, basemap, true));
      expect(layer).toBeDefined();
      expect(layer?.minzoom).toBe(HILLSHADE_2D_MIN_ZOOM);
      expect(HILLSHADE_2D_MIN_ZOOM).toBe(11);
    });

    it('ramps the exaggeration up from 0 at the gate so the shading fades in', () => {
      const layer = hillshade2d(buildOsmStyle(TILE, false, 'map', true));
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
      const dem = buildOsmStyle(TILE, false, 'map', true).sources
        .dem as RasterDEMSourceSpecification;
      expect(dem.tileSize).toBe(256);
      expect(HILLSHADE_2D_DEM_TILE_SIZE).toBe(256);
      expect(dem.encoding).toBe('terrarium');
      expect(dem.maxzoom).toBe(15);
    });

    it('leaves the 3D terrain DEM at 256 px (there the DEM is the geometry)', () => {
      const dem = buildOsmStyle(TILE, true, 'map', true).sources
        .dem as RasterDEMSourceSpecification;
      expect(dem.tileSize).toBe(256);
      // ...and the 3D hillshade keeps its flat exaggeration and no zoom gate.
      const layer = buildOsmStyle(TILE, true, 'map', true).layers.find((l) => l.id === 'hillshade');
      expect(layer?.minzoom).toBeUndefined();
      expect(layer?.paint).toMatchObject({ 'hillshade-exaggeration': 0.7 });
    });

    it('emits NO hillshade layer and NO DEM source when the setting is off', () => {
      // showHillshade=false must cost zero DEM fetches, not a hidden layer.
      for (const basemap of ['map', 'relief'] as const) {
        const s = buildOsmStyle(TILE, false, basemap, false);
        expect(layerIds(s)).not.toContain('hillshade-2d');
        expect(s.sources.dem).toBeUndefined();
        expect(JSON.stringify(s)).not.toContain('elevation-tiles-prod');
      }
    });

    it('still shades nothing on satellite, gate or no gate', () => {
      const s = buildOsmStyle(TILE, false, 'satellite', true);
      expect(layerIds(s)).not.toContain('hillshade-2d');
      expect(s.sources.dem).toBeUndefined();
    });
  });

  describe('overzoom (blurry upscaled tiles instead of "map unavailable")', () => {
    it("caps each raster SOURCE at its service's real-data zoom, under the camera max of 18", () => {
      // Esri serves HTTP-200 "Map data not yet available" placeholders past its
      // real data (imagery ends ~z17 in remote areas, topo ~z15), so the source
      // maxzoom must stop fetching before that zone; OSM is real through z19.
      expect(baseSource(buildOsmStyle(TILE, false, 'map')).maxzoom).toBe(19);
      expect(baseSource(buildOsmStyle(TILE, false, 'satellite')).maxzoom).toBe(17);
      expect(baseSource(buildOsmStyle(TILE, false, 'relief')).maxzoom).toBe(15);
    });

    it('leaves the raster LAYER without a maxzoom so tiles overscale past the source cap', () => {
      for (const basemap of ['map', 'satellite', 'relief'] as const) {
        const osmLayer = buildOsmStyle(TILE, false, basemap, true).layers.find(
          (l) => l.id === 'osm',
        );
        expect(osmLayer).toBeDefined();
        expect(osmLayer && 'maxzoom' in osmLayer ? osmLayer.maxzoom : undefined).toBeUndefined();
      }
    });

    it("caps the source at an offline pack's top stored zoom via rasterMaxZoom", () => {
      const s = buildOsmStyle(TILE, false, 'map', true, { rasterMaxZoom: 15 });
      expect(baseSource(s).maxzoom).toBe(15);
    });

    it("never raises the source cap above the service's real-data zoom", () => {
      const s = buildOsmStyle(TILE, false, 'relief', true, { rasterMaxZoom: 17 });
      expect(baseSource(s).maxzoom).toBe(15);
    });
  });

  describe('weather drape', () => {
    // The frames themselves are NOT style layers any more (perf fix
    // 2026-08-10): they mount as MapView children (`WeatherDrapeLayers`)
    // because a changed style object reloads the ENTIRE native style, which
    // blanked the drape twice per playback tick. Stacking is covered by
    // `@core/geo/mapLayerStack`; the style only owns the muting below.
    it('never declares a frame source or layer, playback or not', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const ids = layerIds(buildOsmStyle(TILE, false, 'map', true));
      const conditional = DRAPE_ANCHORS_BOTTOM_TO_TOP.filter(
        (a) => !(ALWAYS_PRESENT_ANCHORS as readonly string[]).includes(a),
      );
      for (const a of conditional) expect(ids).not.toContain(a);
      for (const a of ALWAYS_PRESENT_ANCHORS) expect(ids).toContain(a);
    });

    it('is invisible and sourceless — a marker must never paint or fetch', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, { weatherMuted });
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
        const ids = layerIds(buildOsmStyle(TILE, false, 'map', true, opts));
        expect(ids.indexOf(MARINE_SOUNDINGS_ANCHOR)).toBeGreaterThan(
          ids.indexOf(WEATHER_DRAPE_ANCHOR),
        );
        expect(ids.indexOf(WEATHER_DRAPE_ANCHOR)).toBeGreaterThan(ids.indexOf(MARINE_DRAPE_ANCHOR));
      }
    });

    it('puts the weather anchor directly above the dim, and the chart anchor below it', () => {
      const ids = layerIds(
        buildOsmStyle(TILE, false, 'map', true, { weatherMuted, marineChart: chart }),
      );
      expect(ids.indexOf(WEATHER_DRAPE_ANCHOR)).toBe(ids.indexOf('weather-dim') + 1);
      // A chart under a weather field must be dimmed with everything else.
      expect(ids.indexOf(MARINE_DRAPE_ANCHOR)).toBeLessThan(ids.indexOf('weather-dim'));
    });

    it('keeps the depth bands under the seamark symbols', () => {
      const ids = layerIds(
        buildOsmStyle(TILE, false, 'map', true, {
          marineLayers: ['bathymetry', 'seamarks'],
          marineChart: chart,
          overlayLabels,
        }),
      );
      expect(ids.indexOf(MARINE_DRAPE_ANCHOR)).toBeLessThan(ids.indexOf('marine-seamarks'));
    });

    it('keeps every anchor under wave B labels — colour never swallows geography', () => {
      const ids = layerIds(
        buildOsmStyle(TILE, false, 'map', true, {
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
        buildOsmStyle(TILE, false, 'map', true, { marineChart: chart, downloadedMask: mask }),
      );
      expect(ids[ids.length - 1]).toBe('downloaded-mask');
      for (const a of [MARINE_DRAPE_ANCHOR, MARINE_SOUNDINGS_ANCHOR]) {
        expect(ids.indexOf(a)).toBeGreaterThan(-1);
        expect(ids.indexOf(a)).toBeLessThan(ids.indexOf('downloaded-mask'));
      }
    });
  });

  describe('weather-mode basemap muting', () => {
    const weatherMuted = { dimColor: '#F4F1EC', dimOpacity: 0.42 };

    it('is absent by default — no dim layer, normal raster paint', () => {
      const s = buildOsmStyle(TILE, false, 'map', true);
      expect(layerIds(s)).not.toContain('weather-dim');
      const osm = s.layers.find((l) => l.id === 'osm');
      expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.25 });
    });

    it('desaturates the raster and screens it with the dim backdrop', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, { weatherMuted });
      const osm = s.layers.find((l) => l.id === 'osm');
      expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.85 });
      const dim = s.layers.find((l) => l.id === 'weather-dim');
      expect(dim).toMatchObject({
        type: 'background',
        paint: { 'background-color': '#F4F1EC', 'background-opacity': 0.42 },
      });
    });

    it('stacks dim above every basemap-side raster (the drape rides above it)', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        weatherMuted,
        marineLayers: ['bathymetry'],
      });
      const ids = layerIds(s);
      expect(ids.indexOf('weather-dim')).toBeGreaterThan(ids.indexOf('osm'));
      expect(ids.indexOf('weather-dim')).toBeGreaterThan(ids.indexOf('marine-bathymetry'));
    });

    it('suppresses the shaded-relief hillshade (terrain shading under weather is noise)', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, { weatherMuted });
      expect(layerIds(s)).not.toContain('hillshade-2d');
      expect(s.sources.dem).toBeUndefined();
    });

    it('mutes satellite imagery too — under weather the drape is the content', () => {
      const s = buildOsmStyle(TILE, false, 'satellite', true, { weatherMuted });
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
      const s = buildOsmStyle(TILE, false, 'map', true);
      expect(s.sources['overlay-labels']).toBeUndefined();
      expect(s.glyphs).toBeUndefined();
      for (const id of OVERLAY_LAYER_IDS) expect(layerIds(s)).not.toContain(id);
    });

    it('adds the OpenFreeMap vector source, glyphs and the three reference layers', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true, {
        marineLayers: ['bathymetry'],
        overlayLabels: { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      const ids = layerIds(s);
      expect(ids.indexOf('overlay-water-line')).toBeGreaterThan(ids.indexOf('marine-bathymetry'));
    });

    it('draws each reference line as a casing UNDER its core, and wider', () => {
      // Owner, 2026-08-13: a single hairline could not be told apart from the
      // drape. The pair is what carries contrast over an arbitrary colour.
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const withRoads = buildOsmStyle(TILE, false, 'map', true, {
        overlayLabels: {
          dark: false,
          tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'],
          roads: true,
        },
      });
      const without = buildOsmStyle(TILE, false, 'map', true, {
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
        const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const light = buildOsmStyle(TILE, false, 'map', true, {
        overlayLabels: { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      const dark = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true);
      expect(s.sources['marine-bathymetry']).toBeUndefined();
      expect(s.sources['marine-seamarks']).toBeUndefined();
      expect(layerIds(s)).not.toContain('marine-bathymetry');
    });

    it('adds a raster source + layer per checked marine layer, with attribution and zoom clamp', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true);
      for (const id of ['marine-land-dim', 'marine-water-fill']) {
        expect(layerIds(s)).not.toContain(id);
      }
    });

    it('restyles land tan, fills water chart-blue and mutes the raster', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true, {
        marineLayers: ['bathymetry'],
        overlayLabels,
        marineChart: { wmsFallback: true },
      });
      expect(layerIds(s)).toContain('marine-bathymetry');
    });

    it('skips the water fill when the vector overlay did not resolve', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
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
      const s = buildOsmStyle(TILE, false, 'map', true);
      expect(s.sources['downloaded-mask']).toBeUndefined();
      expect(layerIds(s)).not.toContain('downloaded-mask');
    });

    it('adds an opaque fill in the requested colour as the TOP style layer', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, { downloadedMask: mask });
      expect(s.sources['downloaded-mask']).toEqual({ type: 'geojson', data: mask.data });
      const ids = layerIds(s);
      expect(ids[ids.length - 1]).toBe('downloaded-mask'); // above raster + hillshade
      const layer = s.layers[s.layers.length - 1];
      expect(layer).toMatchObject({
        type: 'fill',
        source: 'downloaded-mask',
        paint: { 'fill-color': '#FFFFFF', 'fill-opacity': 1 },
      });
    });

    it('stays the TOP layer even in weather mode', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        downloadedMask: mask,
        weatherMuted: { dimColor: '#111', dimOpacity: 0.4 },
      });
      const ids = layerIds(s);
      expect(ids[ids.length - 1]).toBe('downloaded-mask');
    });

    it('sits above the base raster layer for every basemap', () => {
      for (const basemap of ['map', 'satellite', 'relief'] as const) {
        const ids = layerIds(buildOsmStyle(TILE, false, basemap, true, { downloadedMask: mask }));
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
  const variants: [string, Parameters<typeof buildOsmStyle>[4]][] = [
    ['plain map', undefined],
    ['satellite', undefined],
    ['weather', { weatherMuted, overlayLabels }],
    ['marine', { marineChart: { wmsFallback: false }, overlayLabels }],
    ['labels only', { overlayLabels }],
  ];

  it.each(variants)('%s: carries all three, in order, above every drape anchor', (name, opts) => {
    const ids = layerIds(
      buildOsmStyle(TILE, false, name === 'satellite' ? 'satellite' : 'map', true, opts),
    );
    const at = (id: string) => ids.indexOf(id);
    for (const a of ALWAYS_PRESENT_ANCHORS) expect(at(a)).toBeGreaterThanOrEqual(0);
    expect(at(ALWAYS_PRESENT_ANCHORS[0])).toBeLessThan(at(ALWAYS_PRESENT_ANCHORS[1]));
    expect(at(ALWAYS_PRESENT_ANCHORS[1])).toBeLessThan(at(ALWAYS_PRESENT_ANCHORS[2]));
    for (const drape of [MARINE_DRAPE_ANCHOR, WEATHER_DRAPE_ANCHOR, MARINE_SOUNDINGS_ANCHOR]) {
      if (at(drape) >= 0) expect(at(drape)).toBeLessThan(at(ALWAYS_PRESENT_ANCHORS[0]));
    }
  });

  it('keeps the reference labels above the overlays (ink beats maps)', () => {
    const ids = layerIds(buildOsmStyle(TILE, false, 'map', true, { overlayLabels }));
    const lastAnchor = ids.indexOf(ALWAYS_PRESENT_ANCHORS[2]);
    const labelIds = ids.filter((id) => /label|overlay-labels|coast/i.test(id));
    expect(labelIds.length).toBeGreaterThan(0);
    for (const id of labelIds) expect(ids.indexOf(id)).toBeGreaterThan(lastAnchor);
  });
});

describe('basemapAttribution', () => {
  it.each([
    ['map' as const, '© OpenStreetMap'],
    ['relief' as const, '© Esri, USGS'],
    ['satellite' as const, '© Esri, Maxar'],
  ])('credits the %s basemap', (basemap, credit) => {
    expect(basemapAttribution(basemap)).toBe(credit);
  });

  it('credits Protomaps on the vector base map only', () => {
    expect(basemapAttribution('map', true)).toBe('© OpenStreetMap · Protomaps');
    expect(basemapAttribution('satellite', true)).toBe('© Esri, Maxar');
  });
});

describe('night red raster (decision 4)', () => {
  const osmPaint = (night: boolean) => {
    const style = buildOsmStyle('https://tiles/{z}/{x}/{y}.png', false, 'map', false, { night });
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
    const s = withFlag(false)(TILE, false, 'map', false, { vectorBasemap });
    expect(baseSource(s).tiles).toEqual([TILE]);
    expect(s.sources['basemap-vector']).toBeUndefined();
    expect(s.glyphs).toBeUndefined();
    expect(layerIds(s).some((id) => id.startsWith('stone-'))).toBe(false);
  });

  it('flag off: identical to a style built without the option', () => {
    const build = withFlag(false);
    expect(build(TILE, false, 'map', true, { vectorBasemap })).toEqual(
      build(TILE, false, 'map', true),
    );
  });

  it('flag on + map: swaps the raster for the vector source and stone layers', () => {
    const s = withFlag(true)(TILE, false, 'map', true, { vectorBasemap });
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
    expect(at('stone-place-town')).toBeLessThan(at(ALWAYS_PRESENT_ANCHORS[0]));
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
    const noto = build(TILE, false, 'map', false, { vectorBasemap });
    expect(noto.glyphs).toContain('openfreemap');
    expect(fontsOf(noto).every((f) => f.includes('Noto Sans'))).toBe(true);
    const ours = 'https://tiles.example/fonts/{fontstack}/{range}.pbf';
    const atkinson = build(TILE, false, 'map', false, {
      vectorBasemap: { ...vectorBasemap, glyphs: ours },
    });
    expect(atkinson.glyphs).toBe(ours);
    expect(fontsOf(atkinson).every((f) => f.includes('Atkinson Hyperlegible Next'))).toBe(true);
  });

  it('flag on: adds served contour tiles only when asked', () => {
    const build = withFlag(true);
    const without = build(TILE, false, 'map', false, { vectorBasemap });
    expect(without.sources['basemap-contours']).toBeUndefined();
    const withContours = build(TILE, false, 'map', false, {
      vectorBasemap: {
        ...vectorBasemap,
        contours: 'https://tiles.example/contours/{z}/{x}/{y}.mvt',
      },
    });
    expect(withContours.sources['basemap-contours']).toMatchObject({ type: 'vector', maxzoom: 14 });
    const ids = layerIds(withContours);
    expect(ids).toContain('stone-contour-major');
    expect(ids).toContain('stone-contour-minor');
  });

  it('flag on: labels peaks from our summit tiles when given, else from Protomaps', () => {
    const build = withFlag(true);
    const without = build(TILE, false, 'map', false, { vectorBasemap });
    expect(without.sources['basemap-peaks']).toBeUndefined();
    expect(without.layers.find((l) => l.id === 'stone-peak')).toMatchObject({
      'source-layer': 'pois',
    });
    const peaks = 'https://tiles.example/peaks/{z}/{x}/{y}.mvt';
    const withPeaks = build(TILE, false, 'map', false, {
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

  it('flag on: the dark scheme yields a different stone style', () => {
    const build = withFlag(true);
    const light = build(TILE, false, 'map', false, { vectorBasemap });
    const dark = build(TILE, false, 'map', false, {
      vectorBasemap: { ...vectorBasemap, dark: true },
    });
    expect(JSON.stringify(dark.layers)).not.toEqual(JSON.stringify(light.layers));
  });

  it.each(['relief', 'satellite'] as const)('flag on: %s stays raster', (basemap) => {
    const build = withFlag(true);
    expect(build(TILE, false, basemap, false, { vectorBasemap })).toEqual(
      build(TILE, false, basemap, false),
    );
  });

  it('flag on: offline packs (no option) stay raster', () => {
    const s = withFlag(true)(TILE, false, 'map');
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
        const s = vectorBuild()(TILE, false, 'map', false, {
          vectorBasemap: vector(dark),
          hillshadeStrength: 'heavy',
        });
        expect(hillshadePaint(s)).toBeUndefined();
        expect(s.sources.dem).toBeUndefined();
      }
    });

    it('defaults to Medium', () => {
      const paint = hillshadePaint(buildOsmStyle(TILE, false, 'map', true));
      expect(DEFAULT_HILLSHADE_STRENGTH).toBe('medium');
      expect(paint?.['hillshade-shadow-color']).toBe(hillshadeLook('medium', false).shadowColor);
    });

    it.each(HILLSHADE_STRENGTHS)(
      '%s drives the exaggeration and colours (light raster)',
      (level) => {
        const look = hillshadeLook(level, false);
        const paint = hillshadePaint(
          buildOsmStyle(TILE, false, 'relief', true, { hillshadeStrength: level }),
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
        build(TILE, false, 'map', true, { vectorBasemap: vector(true), hillshadeStrength: level }),
      );
      const light = hillshadePaint(
        build(TILE, false, 'map', true, { vectorBasemap: vector(false), hillshadeStrength: level }),
      );
      expect(dark?.['hillshade-shadow-color']).toBe(hillshadeLook(level, true).shadowColor);
      expect(light?.['hillshade-shadow-color']).toBe(hillshadeLook(level, false).shadowColor);
    });

    it('keeps the light palette on raster basemaps even in a dark app theme', () => {
      // Only the stone vector map has a night variant; the OSM raster is light.
      const s = buildOsmStyle(TILE, false, 'relief', true, { hillshadeStrength: 'heavy' });
      expect(hillshadePaint(s)?.['hillshade-shadow-color']).toBe(
        hillshadeLook('heavy', false).shadowColor,
      );
    });
  });

  describe('peak density', () => {
    it.each(PEAK_DENSITIES)('%s reaches the stone peak layer (both themes)', (density) => {
      for (const dark of [false, true]) {
        const s = vectorBuild()(TILE, false, 'map', true, {
          vectorBasemap: { ...vector(dark), peakDensity: density },
        });
        const peak = s.layers.find((l) => l.id === 'stone-peak') as { filter?: unknown };
        expect(peak.filter).toEqual(peakDueFilter(PEAK_LEAD[density]));
      }
    });

    it('defaults to normal when the caller passes none (offline packs, trail viewer)', () => {
      const s = vectorBuild()(TILE, false, 'map', false, { vectorBasemap: vector(false) });
      const peak = s.layers.find((l) => l.id === 'stone-peak') as { filter?: unknown };
      expect(peak.filter).toEqual(peakDueFilter(PEAK_LEAD.normal));
    });

    it('keeps the peaks source z5–z12 (the style filter, not the source, picks the lead)', () => {
      const s = vectorBuild()(TILE, false, 'map', false, {
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
    const s = buildOsmStyle(TILE, false, 'map', true);
    expect(styleHasHillshade(s)).toBe(true);
    expect(layerIds(s)).toContain(HILLSHADE_2D_LAYER_ID);
    const dem = s.sources[HILLSHADE_DEM_SOURCE_ID] as RasterDEMSourceSpecification;
    expect(dem.type).toBe('raster-dem');
    expect(dem.encoding).toBe('terrarium');
  });

  it('is false with shading off, over satellite, and under the weather dim', () => {
    const weatherMuted = { dimColor: '#F4F1EC', dimOpacity: 0.42 };
    expect(styleHasHillshade(buildOsmStyle(TILE, false, 'map', false))).toBe(false);
    expect(styleHasHillshade(buildOsmStyle(TILE, false, 'satellite', true))).toBe(false);
    expect(styleHasHillshade(buildOsmStyle(TILE, false, 'map', true, { weatherMuted }))).toBe(
      false,
    );
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
      const s = buildOsmStyle(TILE, false, 'map', true, { tiltRelief: mode });
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
    expect(
      tiltLayer(buildOsmStyle(TILE, false, 'map', true, { tiltRelief: 'off' })),
    ).toBeUndefined();
    expect(tiltLayer(buildOsmStyle(TILE, false, 'map', true))).toBeUndefined();
  });

  it('is absent wherever the base shading is (none, satellite, weather dim)', () => {
    const weatherMuted = { dimColor: '#F4F1EC', dimOpacity: 0.42 };
    for (const s of [
      buildOsmStyle(TILE, false, 'map', false, { tiltRelief: 'dramatic' }),
      buildOsmStyle(TILE, false, 'satellite', true, { tiltRelief: 'dramatic' }),
      buildOsmStyle(TILE, false, 'map', true, { tiltRelief: 'dramatic', weatherMuted }),
    ]) {
      expect(tiltLayer(s)).toBeUndefined();
      expect(styleHasTiltRelief(s)).toBe(false);
    }
  });
});
