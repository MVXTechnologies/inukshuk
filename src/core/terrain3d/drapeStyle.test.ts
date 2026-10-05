import {
  DRAPE_HILLSHADE_MIN_ZOOM,
  drapeStyle,
  scaleRgbaAlpha,
  scaleStyleValue,
  settledZoomValue,
  type DrapeStyleInput,
} from './drapeStyle';

const style: DrapeStyleInput = {
  version: 8,
  sources: {},
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#fff' } },
    {
      id: 'hillshade-2d',
      type: 'hillshade',
      minzoom: 11,
      paint: {
        'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 11, 0, 12, 0.6],
        'hillshade-shadow-color': '#000',
      },
    },
    { id: 'hillshade-tilt', type: 'hillshade', layout: { visibility: 'none' } },
    { id: 'contours', type: 'line', minzoom: 8 },
    { id: 'contour-labels', type: 'symbol' },
    { id: 'hidden', type: 'fill', layout: { visibility: 'none' } },
    { id: 'drop-me', type: 'fill' },
  ],
};

describe('drapeStyle', () => {
  it('drops names, hidden layers and the requested ids, keeps the rest in order', () => {
    const d = drapeStyle(style, { dropLayerIds: ['drop-me'], hillshadeLayerId: 'hillshade-2d' });
    expect(d.layers.map((l) => l.id)).toEqual(['bg', 'hillshade-2d', 'contours']);
    expect(d.version).toBe(8);
  });

  it('lets the hillshade shade every zoom the terrain shows, at its settled strength', () => {
    const d = drapeStyle(style, { hillshadeLayerId: 'hillshade-2d' });
    const h = d.layers.find((l) => l.id === 'hillshade-2d');
    expect(h?.minzoom).toBe(DRAPE_HILLSHADE_MIN_ZOOM);
    expect(h?.paint?.['hillshade-exaggeration']).toBe(0.6);
    expect(h?.paint?.['hillshade-shadow-color']).toBe('#000');
  });

  it('never raises a lower minzoom and leaves the input untouched', () => {
    const d = drapeStyle(style, { hillshadeLayerId: 'hillshade-2d', hillshadeMinZoom: 13 });
    expect(d.layers.find((l) => l.id === 'hillshade-2d')?.minzoom).toBe(11);
    expect(style.layers).toHaveLength(7);
    expect(style.layers[1]?.minzoom).toBe(11);
  });

  it('is a no-op on the hillshade when none is named', () => {
    const d = drapeStyle(style);
    expect(d.layers.find((l) => l.id === 'hillshade-2d')).toBe(style.layers[1]);
  });
});

describe('settledZoomValue', () => {
  it('takes the last stop of a zoom ramp', () => {
    expect(settledZoomValue(['interpolate', ['linear'], ['zoom'], 1, 0, 5, 2])).toBe(2);
    expect(settledZoomValue(['step', ['zoom'], 0, 5, 3])).toBe(3);
  });
  it('passes everything else through', () => {
    expect(settledZoomValue(0.4)).toBe(0.4);
    const byProp = ['interpolate', ['linear'], ['get', 'x'], 0, 1];
    expect(settledZoomValue(byProp)).toBe(byProp);
    expect(settledZoomValue(['zoom'])).toEqual(['zoom']);
  });
});

describe('scaleStyleValue', () => {
  it('scales numbers and wraps data expressions', () => {
    expect(scaleStyleValue(0.8, 0.5)).toBe(0.4);
    expect(scaleStyleValue(['get', 'o'], 0.5)).toEqual(['*', ['get', 'o'], 0.5]);
    expect(scaleStyleValue('x', 0.5)).toBe('x');
    expect(scaleStyleValue(['get', 'o'], 1)).toEqual(['get', 'o']);
  });
  it('scales the outputs of a top-level zoom ramp, never its stops', () => {
    expect(scaleStyleValue(['interpolate', ['linear'], ['zoom'], 10, 0.2, 14, 1], 0.5)).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      10,
      0.1,
      14,
      0.5,
    ]);
    expect(scaleStyleValue(['step', ['zoom'], 0.2, 12, 1], 0.5)).toEqual([
      'step',
      ['zoom'],
      0.1,
      12,
      0.5,
    ]);
  });
  it('leaves other zoom expressions alone', () => {
    const v = ['coalesce', ['zoom'], 1];
    expect(scaleStyleValue(v, 0.5)).toBe(v);
  });
});

describe('drapeStyle softening', () => {
  it('softens contours and boosts the hillshade (capped at 1)', () => {
    const d = drapeStyle(style, {
      hillshadeLayerId: 'hillshade-2d',
      hillshadeBoost: 2,
      contourLayerIds: ['contours'],
      contourOpacity: 0.5,
    });
    expect(d.layers.find((l) => l.id === 'contours')?.paint?.['line-opacity']).toBe(0.5);
    expect(d.layers.find((l) => l.id === 'hillshade-2d')?.paint?.['hillshade-exaggeration']).toBe(
      1,
    );
  });
});

describe('drapeStyle DEM detail', () => {
  const withDem: DrapeStyleInput = {
    sources: {
      dem: { type: 'raster-dem', tiles: ['x'], tileSize: 256 },
      vec: { type: 'vector', tiles: ['y'] },
    },
    layers: [],
  };
  it('lowers the declared DEM tile size (deeper DEM in the drape)', () => {
    const d = drapeStyle(withDem, { demSourceId: 'dem', demTileSize: 128 });
    const sources = d.sources as Record<string, Record<string, unknown>>;
    expect(sources.dem?.tileSize).toBe(128);
    expect(sources.vec).toBe((withDem.sources as Record<string, unknown>).vec);
    expect((withDem.sources as Record<string, Record<string, unknown>>).dem?.tileSize).toBe(256);
  });
  it('ignores a missing or non-DEM source', () => {
    expect(drapeStyle(withDem, { demSourceId: 'vec', demTileSize: 128 }).sources).toBe(
      withDem.sources,
    );
    expect(drapeStyle(withDem, { demSourceId: 'nope', demTileSize: 128 }).sources).toBe(
      withDem.sources,
    );
  });
});

describe('scaleRgbaAlpha', () => {
  it('scales an rgba alpha, capped at 1', () => {
    expect(scaleRgbaAlpha('rgba(74, 62, 45, 0.55)', 1.4)).toBe('rgba(74, 62, 45, 0.77)');
    expect(scaleRgbaAlpha('rgba(1,2,3,0.8)', 2)).toBe('rgba(1, 2, 3, 1)');
  });
  it('leaves other colours alone', () => {
    expect(scaleRgbaAlpha('#000', 2)).toBe('#000');
    expect(scaleRgbaAlpha(undefined, 2)).toBeUndefined();
  });
  it('is applied to the drape hillshade', () => {
    const d = drapeStyle(
      {
        layers: [
          {
            id: 'h',
            type: 'hillshade',
            paint: {
              'hillshade-shadow-color': 'rgba(0, 0, 0, 0.5)',
              'hillshade-highlight-color': 'rgba(255, 255, 255, 0.2)',
            },
          },
        ],
      },
      { hillshadeLayerId: 'h', hillshadeAlpha: { shadow: 1.5, highlight: 2, accent: 1 } },
    );
    expect(d.layers[0]?.paint?.['hillshade-shadow-color']).toBe('rgba(0, 0, 0, 0.75)');
    expect(d.layers[0]?.paint?.['hillshade-highlight-color']).toBe('rgba(255, 255, 255, 0.4)');
  });
});

describe('drapeStyle raster detail', () => {
  const withRaster: DrapeStyleInput = {
    sources: {
      osm: { type: 'raster', tiles: ['s'], tileSize: 362 },
      dem: { type: 'raster-dem', tiles: ['d'], tileSize: 256 },
    },
    layers: [],
  };
  it('reads the imagery source deeper, alongside the DEM', () => {
    const d = drapeStyle(withRaster, {
      rasterSourceId: 'osm',
      rasterTileSize: 256,
      demSourceId: 'dem',
      demTileSize: 128,
    });
    const s = d.sources as Record<string, Record<string, unknown>>;
    expect(s.osm?.tileSize).toBe(256);
    expect(s.dem?.tileSize).toBe(128);
  });
  it('only resizes a raster source', () => {
    const d = drapeStyle(withRaster, { rasterSourceId: 'dem', rasterTileSize: 64 });
    expect(d.sources).toBe(withRaster.sources);
  });
});
