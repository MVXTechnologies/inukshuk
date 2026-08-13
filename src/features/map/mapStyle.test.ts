import { buildDownloadedMask } from '@core/geo/downloadedMask';
import {
  DRAPE_ANCHORS_BOTTOM_TO_TOP,
  MARINE_DRAPE_ANCHOR,
  MARINE_SOUNDINGS_ANCHOR,
  WEATHER_DRAPE_ANCHOR,
} from '@core/geo/mapLayerStack';
import type { RasterSourceSpecification } from '@maplibre/maplibre-react-native';
import { buildOsmStyle } from './mapStyle';

const TILE = 'https://tile.example/{z}/{x}/{y}.png';
const layerIds = (s: ReturnType<typeof buildOsmStyle>) => s.layers.map((l) => l.id);
const baseSource = (s: ReturnType<typeof buildOsmStyle>) =>
  s.sources.osm as RasterSourceSpecification;

describe('buildOsmStyle', () => {
  it('renders a plain raster base with no relief by default (offline-pack style)', () => {
    const s = buildOsmStyle(TILE, false, 'map');
    expect(s.sources.dem).toBeUndefined();
    expect(layerIds(s)).toEqual(['background', 'osm']);
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

    it('adds none of them on a plain map — an idle style stays byte-identical', () => {
      const ids = layerIds(buildOsmStyle(TILE, false, 'map', true));
      for (const a of DRAPE_ANCHORS_BOTTOM_TO_TOP) expect(ids).not.toContain(a);
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
        markedTrailsNetworks: ['hiking'],
        marineLayers: ['bathymetry'],
      });
      const ids = layerIds(s);
      expect(ids.indexOf('weather-dim')).toBeGreaterThan(ids.indexOf('osm'));
      expect(ids.indexOf('weather-dim')).toBeGreaterThan(ids.indexOf('marked-trails-hiking'));
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
    const OVERLAY_LAYER_IDS = ['overlay-water-line', 'overlay-town-labels', 'overlay-city-labels'];

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
        markedTrailsNetworks: ['hiking'],
      });
      const ids = layerIds(s);
      expect(ids.indexOf('marine-bathymetry')).toBeGreaterThan(ids.indexOf('osm'));
      expect(ids.indexOf('marine-bathymetry')).toBeGreaterThan(ids.indexOf('marked-trails-hiking'));
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
