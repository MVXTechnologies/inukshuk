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

    it('sits above the base raster layer for every basemap', () => {
      for (const basemap of ['map', 'satellite', 'relief'] as const) {
        const ids = layerIds(buildOsmStyle(TILE, false, basemap, true, { downloadedMask: mask }));
        expect(ids.indexOf('downloaded-mask')).toBeGreaterThan(ids.indexOf('osm'));
      }
    });
  });
});
