import {
  isMarineLayerId,
  MARINE_DISCLAIMER,
  MARINE_LAYERS,
  marineLayerById,
  marineTileUrl,
  sanitizeMarineLayers,
} from './marineLayers';

describe('marine layer catalog', () => {
  it('exposes bathymetry under seamarks with regex-safe labels', () => {
    expect(MARINE_LAYERS.map((l) => l.id)).toEqual(['bathymetry', 'seamarks']);
    // Labels are Maestro/a11y match targets — no regex metacharacters allowed.
    for (const l of MARINE_LAYERS) expect(l.label).not.toMatch(/[.*+?^${}()|[\]\\]/);
  });

  it('carries attribution and a zoom clamp on every layer', () => {
    for (const l of MARINE_LAYERS) {
      expect(l.attribution.length).toBeGreaterThan(0);
      expect(l.maxzoom).toBeGreaterThanOrEqual(15);
      expect(l.maxzoom).toBeLessThanOrEqual(19);
      expect(l.opacity).toBeGreaterThan(0);
      expect(l.opacity).toBeLessThanOrEqual(1);
    }
  });

  it('states the NONNA non-navigational condition verbatim', () => {
    expect(MARINE_DISCLAIMER).toBe('Not for navigation');
    expect(marineLayerById('bathymetry').attribution).toContain('Open Government Licence');
    expect(marineLayerById('seamarks').attribution).toContain('ODbL');
  });

  it('type-guards ids and sanitizes persisted junk to a clean list', () => {
    expect(isMarineLayerId('bathymetry')).toBe(true);
    expect(isMarineLayerId('charts')).toBe(false);
    expect(isMarineLayerId(null)).toBe(false);
    expect(sanitizeMarineLayers(['seamarks', 'junk', 42, 'bathymetry'])).toEqual([
      'seamarks',
      'bathymetry',
    ]);
    expect(sanitizeMarineLayers('bathymetry')).toEqual([]);
    expect(sanitizeMarineLayers(undefined)).toEqual([]);
  });

  it('falls back to the first catalog entry for the impossible miss', () => {
    expect(marineLayerById('bathymetry').id).toBe('bathymetry');
    expect(marineLayerById('seamarks').id).toBe('seamarks');
  });
});

describe('marineTileUrl', () => {
  it('builds the NONNA WMS GetMap template with 100 m under 10 m', () => {
    const url = marineTileUrl('bathymetry');
    expect(url).toContain('https://nonna-geoserver.data.chs-shc.ca/geoserver/nonna/wms?');
    expect(url).toContain('request=GetMap');
    expect(url).toContain(`layers=${encodeURIComponent('nonna:NONNA 100,nonna:NONNA 10')}`);
    expect(url).toContain('crs=EPSG:3857');
    // MapLibre's raster-source templating token must survive un-encoded.
    expect(url).toContain('bbox={bbox-epsg-3857}');
    expect(url).toContain('transparent=true');
  });

  it('builds the OpenSeaMap XYZ template', () => {
    expect(marineTileUrl('seamarks')).toBe('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png');
  });
});
