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
    const weather = {
      urlTemplate:
        'https://geo.weather.gc.ca/geomet?service=WMS&request=GetMap&layers=RADAR_1KM_RRAI&bbox={bbox-epsg-3857}',
      attribution: 'Data Source: Environment and Climate Change Canada',
    };

    it('is absent by default — the map is byte-identical to today with weather off', () => {
      const s = buildOsmStyle(TILE, false, 'map', true);
      expect(s.sources.weather).toBeUndefined();
      expect(layerIds(s)).not.toContain('weather');
    });

    it('adds a WMS raster source + layer with the ECCC attribution', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, { weather });
      expect(s.sources.weather).toEqual({
        type: 'raster',
        tiles: [weather.urlTemplate],
        tileSize: 256,
        attribution: weather.attribution,
      });
      const layer = s.layers.find((l) => l.id === 'weather');
      expect(layer).toMatchObject({
        type: 'raster',
        source: 'weather',
        // No cross-fade: animation swaps frame URLs and fading would smear them.
        paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 },
      });
    });

    it('honours an explicit opacity', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, { weather: { ...weather, opacity: 0.5 } });
      const layer = s.layers.find((l) => l.id === 'weather');
      expect(layer?.paint).toMatchObject({ 'raster-opacity': 0.5 });
    });

    it('draws above the basemap, marked trails and hillshade', () => {
      const s = buildOsmStyle(TILE, false, 'map', true, {
        weather,
        markedTrailsNetworks: ['hiking'],
      });
      const ids = layerIds(s);
      expect(ids.indexOf('weather')).toBeGreaterThan(ids.indexOf('osm'));
      expect(ids.indexOf('weather')).toBeGreaterThan(ids.indexOf('marked-trails-hiking'));
      expect(ids.indexOf('weather')).toBeGreaterThan(ids.indexOf('hillshade-2d'));
    });
  });

  describe('weather-mode basemap muting', () => {
    const weather = {
      urlTemplate: 'https://geo.weather.gc.ca/geomet?request=GetMap&bbox={bbox-epsg-3857}',
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
      expect(ids.indexOf('weather')).toBeGreaterThan(ids.indexOf('weather-dim'));
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
        weather: { urlTemplate: 'https://example.test/{bbox-epsg-3857}', attribution: 'ECCC' },
      });
      const ids = layerIds(s);
      expect(ids.indexOf('weather')).toBeGreaterThan(ids.indexOf('marine-bathymetry'));
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
        weather: { urlTemplate: 'https://x/{bbox-epsg-3857}', attribution: 'ECCC' },
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
