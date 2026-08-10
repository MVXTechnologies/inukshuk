import { buildDownloadedMask } from '@core/geo/downloadedMask';
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

  describe('weather overlay', () => {
    const URL_A =
      'https://geo.weather.gc.ca/geomet?service=WMS&request=GetMap&layers=RADAR_1KM_RRAI&bbox={bbox-epsg-3857}&time=A';
    const URL_B =
      'https://geo.weather.gc.ca/geomet?service=WMS&request=GetMap&layers=RADAR_1KM_RRAI&bbox={bbox-epsg-3857}&time=B';
    const weather = {
      slots: [URL_A, null] as const,
      activeSlot: 0 as const,
      attribution: 'Data Source: Environment and Climate Change Canada',
    };

    it('is absent by default — the map is byte-identical to today with weather off', () => {
      const s = buildOsmStyle(TILE, false, 'map', true);
      expect(s.sources['weather-a']).toBeUndefined();
      expect(s.sources['weather-b']).toBeUndefined();
      expect(layerIds(s)).not.toContain('weather-a');
      expect(layerIds(s)).not.toContain('weather-b');
    });

    it('adds a WMS raster source + layer per used slot with the ECCC attribution', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, { weather });
      expect(s.sources['weather-a']).toEqual({
        type: 'raster',
        tiles: [URL_A],
        tileSize: 256,
        attribution: weather.attribution,
      });
      expect(s.sources['weather-b']).toBeUndefined(); // null slot renders nothing
      const layer = s.layers.find((l) => l.id === 'weather-a');
      expect(layer).toMatchObject({
        type: 'raster',
        source: 'weather-a',
        // No per-tile cross-fade: it would smear consecutive radar frames.
        paint: { 'raster-opacity': 0.62, 'raster-fade-duration': 0 },
      });
    });

    it('keeps the inactive slot prefetching at opacity 0 (the anti-flicker swap)', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        weather: { ...weather, slots: [URL_A, URL_B] as const, activeSlot: 0 },
      });
      // Both sources exist — the pending frame's tiles fetch while invisible.
      expect(s.sources['weather-a']).toMatchObject({ tiles: [URL_A] });
      expect(s.sources['weather-b']).toMatchObject({ tiles: [URL_B] });
      const a = s.layers.find((l) => l.id === 'weather-a');
      const b = s.layers.find((l) => l.id === 'weather-b');
      expect(a?.paint).toMatchObject({ 'raster-opacity': 0.62 });
      expect(b?.paint).toMatchObject({ 'raster-opacity': 0 });
    });

    it('flipping activeSlot swaps which frame is visible', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        weather: { ...weather, slots: [URL_A, URL_B] as const, activeSlot: 1 },
      });
      const a = s.layers.find((l) => l.id === 'weather-a');
      const b = s.layers.find((l) => l.id === 'weather-b');
      expect(a?.paint).toMatchObject({ 'raster-opacity': 0 });
      expect(b?.paint).toMatchObject({ 'raster-opacity': 0.62 });
    });

    it('honours an explicit opacity on the active slot only', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        weather: { ...weather, slots: [URL_A, URL_B] as const, opacity: 0.5 },
      });
      const a = s.layers.find((l) => l.id === 'weather-a');
      const b = s.layers.find((l) => l.id === 'weather-b');
      expect(a?.paint).toMatchObject({ 'raster-opacity': 0.5 });
      expect(b?.paint).toMatchObject({ 'raster-opacity': 0 });
    });

    it('draws above the basemap, marked trails and hillshade', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        weather,
        markedTrailsNetworks: ['hiking'],
      });
      const ids = layerIds(s);
      expect(ids.indexOf('weather-a')).toBeGreaterThan(ids.indexOf('osm'));
      expect(ids.indexOf('weather-a')).toBeGreaterThan(ids.indexOf('marked-trails-hiking'));
      expect(ids.indexOf('weather-a')).toBeGreaterThan(ids.indexOf('hillshade-2d'));
    });
  });

  describe('weather-mode basemap muting', () => {
    const weather = {
      slots: [
        'https://geo.weather.gc.ca/geomet?request=GetMap&bbox={bbox-epsg-3857}',
        null,
      ] as const,
      activeSlot: 0 as const,
      attribution: 'ECCC',
    };
    const weatherMuted = { dimColor: '#F4F1EC', dimOpacity: 0.42 };

    it('is absent by default — no dim layer, normal raster paint', () => {
      const s = buildOsmStyle(TILE, false, 'map', true);
      expect(layerIds(s)).not.toContain('weather-dim');
      const osm = s.layers.find((l) => l.id === 'osm');
      expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.25 });
    });

    it('desaturates the raster and screens it with the dim backdrop', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, { weather, weatherMuted });
      const osm = s.layers.find((l) => l.id === 'osm');
      expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.85 });
      const dim = s.layers.find((l) => l.id === 'weather-dim');
      expect(dim).toMatchObject({
        type: 'background',
        paint: { 'background-color': '#F4F1EC', 'background-opacity': 0.42 },
      });
    });

    it('stacks dim between every basemap-side raster and the weather drape', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        weather,
        weatherMuted,
        markedTrailsNetworks: ['hiking'],
        marineLayers: ['bathymetry'],
      });
      const ids = layerIds(s);
      expect(ids.indexOf('weather-dim')).toBeGreaterThan(ids.indexOf('osm'));
      expect(ids.indexOf('weather-dim')).toBeGreaterThan(ids.indexOf('marked-trails-hiking'));
      expect(ids.indexOf('weather-dim')).toBeGreaterThan(ids.indexOf('marine-bathymetry'));
      expect(ids.indexOf('weather-a')).toBeGreaterThan(ids.indexOf('weather-dim'));
    });

    it('suppresses the shaded-relief hillshade (terrain shading under weather is noise)', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, { weather, weatherMuted });
      expect(layerIds(s)).not.toContain('hillshade-2d');
      expect(s.sources.dem).toBeUndefined();
    });

    it('mutes satellite imagery too — under weather the drape is the content', () => {
      const s = buildOsmStyle(TILE, false, 'satellite', true, { weather, weatherMuted });
      const osm = s.layers.find((l) => l.id === 'osm');
      expect(osm?.paint).toMatchObject({ 'raster-saturation': -0.85 });
    });
  });

  describe('labels + coastline overlay (wave B)', () => {
    const weather = {
      slots: [
        'https://geo.weather.gc.ca/geomet?request=GetMap&bbox={bbox-epsg-3857}',
        null,
      ] as const,
      activeSlot: 0 as const,
      attribution: 'ECCC',
    };
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

    it('draws ABOVE the dim and the weather/marine drapes (the whole point)', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        weather,
        weatherMuted: { dimColor: '#111', dimOpacity: 0.4 },
        marineLayers: ['bathymetry', 'seamarks'],
        overlayLabels: { dark: true, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
      });
      const ids = layerIds(s);
      for (const id of OVERLAY_LAYER_IDS) {
        expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf('weather'));
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

    it('stays under a weather drape (the topmost data layer)', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        marineLayers: ['bathymetry'],
        weather: {
          slots: ['https://example.test/{bbox-epsg-3857}', null] as const,
          activeSlot: 0,
          attribution: 'ECCC',
        },
      });
      const ids = layerIds(s);
      expect(ids.indexOf('weather-a')).toBeGreaterThan(ids.indexOf('marine-bathymetry'));
    });
  });

  describe('marine chart mode (wave D — the ENC chart look)', () => {
    const overlayLabels = { dark: false, tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] };
    const drape = {
      uri: 'file:///cache/overlays/depth-chart.png',
      coordinates: [
        [-71.35, 46.9],
        [-71.05, 46.9],
        [-71.05, 46.7],
        [-71.35, 46.7],
      ] as [[number, number], [number, number], [number, number], [number, number]],
    };
    const soundings = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [-71.2, 46.8] },
          properties: { label: '26.5', shallow: 0 as const, sort: 26.5 },
        },
      ],
    };
    const chart = { drape, soundings, wmsFallback: false };

    it('is absent by default — the map is byte-identical with marine off', () => {
      const s = buildOsmStyle(TILE, false, 'map', true);
      for (const id of [
        'marine-land-dim',
        'marine-water-fill',
        'marine-depth-chart',
        'marine-soundings',
      ])
        expect(layerIds(s)).not.toContain(id);
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

    it('replaces the WMS bathymetry drape with the band-chart image, under the seamarks', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        marineLayers: ['bathymetry', 'seamarks'],
        overlayLabels,
        marineChart: chart,
      });
      expect(layerIds(s)).not.toContain('marine-bathymetry');
      expect(s.sources['marine-bathymetry']).toBeUndefined();
      expect(s.sources['marine-depth-chart']).toEqual({
        type: 'image',
        url: drape.uri,
        coordinates: drape.coordinates,
      });
      const ids = layerIds(s);
      expect(ids.indexOf('marine-depth-chart')).toBeGreaterThan(ids.indexOf('marine-water-fill'));
      expect(ids.indexOf('marine-seamarks')).toBeGreaterThan(ids.indexOf('marine-depth-chart'));
      // Below the wave B labels overlay — the whole point of the image route.
      expect(ids.indexOf('overlay-city-labels')).toBeGreaterThan(ids.indexOf('marine-depth-chart'));
    });

    it('keeps the WMS drape as the silent fallback when the client pipeline failed', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        marineLayers: ['bathymetry'],
        overlayLabels,
        marineChart: { drape: null, soundings: null, wmsFallback: true },
      });
      expect(layerIds(s)).toContain('marine-bathymetry');
      expect(layerIds(s)).not.toContain('marine-depth-chart');
    });

    it('renders spot soundings as a symbol layer below the place labels', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        marineLayers: ['bathymetry'],
        overlayLabels,
        marineChart: chart,
      });
      expect(s.sources['marine-soundings']).toEqual({ type: 'geojson', data: soundings });
      const layer = s.layers.find((l) => l.id === 'marine-soundings');
      expect(layer).toMatchObject({ type: 'symbol', source: 'marine-soundings' });
      const ids = layerIds(s);
      expect(ids.indexOf('marine-soundings')).toBeGreaterThan(ids.indexOf('marine-depth-chart'));
      expect(ids.indexOf('overlay-town-labels')).toBeGreaterThan(ids.indexOf('marine-soundings'));
    });

    it('skips the water fill and soundings when the vector overlay did not resolve', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        marineLayers: ['bathymetry'],
        marineChart: chart,
      });
      expect(layerIds(s)).not.toContain('marine-water-fill');
      expect(layerIds(s)).not.toContain('marine-soundings');
      // The drape itself still draws — it needs no glyphs.
      expect(layerIds(s)).toContain('marine-depth-chart');
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

    it('stays the TOP layer even when a weather overlay is present', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        downloadedMask: mask,
        weather: {
          slots: ['https://x/{bbox-epsg-3857}', null] as const,
          activeSlot: 0,
          attribution: 'ECCC',
        },
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
