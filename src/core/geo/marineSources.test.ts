import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFloat32Grid } from './floatTiff';
import type { GeoBbox } from './marineDepth';
import {
  EMODNET_CELL_DEG,
  MARINE_SOURCES,
  bboxContains,
  bboxIntersects,
  bestPackableSource,
  emodnetCoverageUrl,
  gridCornersFor,
  gridXToLon,
  gridYToLat,
  isMarineSourceId,
  latToGridY,
  lonToGridX,
  marineGridUrls,
  marinePointUrl,
  marineRasterUrl,
  marineSourceById,
  marineSourceCaption,
  marineSourceLadder,
  nceiCoverageUrl,
  parseMarinePointDepth,
  pickMarineSource,
  sampleGridDepth,
  sourceCovers,
} from './marineSources';

/** A tight viewport around a point (the shape the map hands the ladder). */
function around(lat: number, lon: number, span = 0.05): GeoBbox {
  return { west: lon - span, south: lat - span, east: lon + span, north: lat + span };
}

const QUEBEC = around(46.8, -71.2);
const BOSTON = around(42.33, -70.9);
const NORTH_SEA = around(54, 2);
const FIJI = around(-18, 178);

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(__dirname, '__fixtures__', name)));
}

describe('catalog shape', () => {
  it('is ordered national-survey first and ends worldwide', () => {
    // Catalog order IS ladder priority: the two national hydrographic
    // surveys, then the regional compilation, then the global grid. (NOAA's
    // inshore CUDEM is finer than NONNA's 10 m, so this is a jurisdiction
    // order, not a resolution sort — inside Canada, CHS is the right answer.)
    expect(MARINE_SOURCES.map((s) => s.id)).toEqual(['nonna', 'noaa', 'emodnet', 'gebco']);
    expect(MARINE_SOURCES[2]?.cellSizeM).toBeLessThan(MARINE_SOURCES[3]?.cellSizeM ?? 0);
    const last = MARINE_SOURCES[MARINE_SOURCES.length - 1];
    expect(last?.coverage).toEqual([]);
  });

  it('keeps the non-navigational notice on EVERY source (a licence condition)', () => {
    for (const source of MARINE_SOURCES) {
      expect(source.attribution.toLowerCase()).toContain('not for navigation');
    }
  });

  it('marks a source packable only when it can answer a raw grid', () => {
    for (const source of MARINE_SOURCES) {
      if (source.packable) expect(source.grid).not.toBeNull();
    }
  });

  it('credits GEBCO by its live release, which is 2025 and not 2026', () => {
    const gebco = marineSourceById('gebco');
    expect(gebco.attribution).toContain('GEBCO Compilation Group (2025)');
    expect(gebco.grid).toBeNull();
  });

  it('round-trips ids and falls back to the global source for junk', () => {
    expect(isMarineSourceId('nonna')).toBe(true);
    expect(isMarineSourceId('navionics')).toBe(false);
    expect(isMarineSourceId(7)).toBe(false);
    expect(marineSourceById('emodnet').id).toBe('emodnet');
  });

  it('captions a source honestly for the legend', () => {
    expect(marineSourceCaption(marineSourceById('gebco'))).toBe('GEBCO 2025 · ~450 m');
    expect(marineSourceCaption(marineSourceById('nonna'))).toBe('CHS NONNA · 10 m');
  });
});

describe('bbox predicates', () => {
  const box: GeoBbox = { west: -10, south: 0, east: 10, north: 20 };

  it('detects overlap but not mere edge contact', () => {
    expect(bboxIntersects(box, { west: 5, south: 5, east: 15, north: 15 })).toBe(true);
    expect(bboxIntersects(box, { west: 10, south: 0, east: 20, north: 20 })).toBe(false);
    expect(bboxIntersects(box, { west: 20, south: 0, east: 30, north: 20 })).toBe(false);
  });

  it('detects containment', () => {
    expect(bboxContains(box, { west: -5, south: 5, east: 5, north: 15 })).toBe(true);
    expect(bboxContains(box, { west: -5, south: 5, east: 25, north: 15 })).toBe(false);
  });

  it('treats an empty coverage list as worldwide', () => {
    expect(sourceCovers(marineSourceById('gebco'), FIJI)).toBe(true);
    expect(sourceCovers(marineSourceById('nonna'), FIJI)).toBe(false);
  });
});

describe('the coverage ladder', () => {
  it('picks NONNA on the St. Lawrence', () => {
    expect(pickMarineSource(QUEBEC).id).toBe('nonna');
  });

  it('picks NOAA off Boston', () => {
    expect(pickMarineSource(BOSTON).id).toBe('noaa');
  });

  it('picks EMODnet in the North Sea', () => {
    expect(pickMarineSource(NORTH_SEA).id).toBe('emodnet');
  });

  it('falls through to GEBCO in the South Pacific', () => {
    expect(pickMarineSource(FIJI).id).toBe('gebco');
  });

  it('always ends the ladder at the global source', () => {
    for (const view of [QUEBEC, BOSTON, NORTH_SEA, FIJI]) {
      const ladder = marineSourceLadder(view);
      expect(ladder.length).toBeGreaterThan(0);
      expect(ladder[ladder.length - 1]?.id).toBe('gebco');
    }
  });

  it('keeps Canadian waters on NONNA where the US and Canadian boxes overlap', () => {
    // The Alaska panhandle box reaches into British Columbia; NONNA's higher
    // priority must win there, with NOAA available as the next rung.
    const ladder = marineSourceLadder(around(54.3, -130.3));
    expect(ladder.map((s) => s.id)).toEqual(['nonna', 'noaa', 'gebco']);
  });

  it('offers the finest packable source, and none in the open Pacific', () => {
    expect(bestPackableSource(QUEBEC)?.id).toBe('nonna');
    expect(bestPackableSource(NORTH_SEA)?.id).toBe('emodnet');
    expect(bestPackableSource(FIJI)).toBeNull();
  });
});

describe('grid request URLs', () => {
  it('asks NONNA for the dense grid first, then the coarse fringe', () => {
    const urls = marineGridUrls(marineSourceById('nonna'), QUEBEC, 256);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('NONNA%2010%20Coverage');
    expect(urls[1]).toContain('NONNA%20100%20Coverage');
  });

  it('returns nothing for the imagery-only global source', () => {
    expect(marineGridUrls(marineSourceById('gebco'), FIJI, 256)).toEqual([]);
  });

  it('builds an EMODnet WCS subset on the Lat/Long axes it advertises', () => {
    const url = emodnetCoverageUrl(NORTH_SEA, 4096);
    expect(url).toContain('coverageId=emodnet__mean');
    expect(url).toContain('subset=Lat(53.95000,54.05000)');
    expect(url).toContain('subset=Long(1.95000,2.05000)');
    expect(url).toContain('format=image/tiff');
    // 0.1° at 1/960° per cell is 96 cells — well under the cap, so no scaling.
    expect(url).not.toContain('scalesize');
  });

  it('scales an EMODnet request down when the native grid busts the cap', () => {
    const url = emodnetCoverageUrl({ west: 0, south: 50, east: 5, north: 55 }, 256);
    expect(url).toContain('scalesize=i(256),j(256)');
    expect(5 / EMODNET_CELL_DEG).toBeGreaterThan(256);
  });

  it('sizes the NCEI export directly (it has no scaling extension)', () => {
    const url = nceiCoverageUrl(BOSTON, 512);
    expect(url).toContain('/exportImage?');
    expect(url).toContain('pixelType=F32');
    expect(url).toContain('format=tiff');
    expect(url).toContain('size=512,512');
    expect(url).toContain('bbox=-70.95000,42.28000,-70.85000,42.38000');
  });
});

describe('point-depth access', () => {
  it('routes each source to the endpoint that answered live', () => {
    expect(marinePointUrl(marineSourceById('nonna'), 46.8, -71.2)).toContain('request=GetCoverage');
    expect(marinePointUrl(marineSourceById('emodnet'), 54, 2)).toBe(
      'https://rest.emodnet-bathymetry.eu/depth_sample?geom=POINT(2%2054)',
    );
    const identify = marinePointUrl(marineSourceById('gebco'), -18, 178);
    expect(identify).toContain('/identify?');
    expect(identify).toContain('returnCatalogItems=false');
    expect(identify).toContain(encodeURIComponent('"x":178'));
  });

  it('parses the live EMODnet JSON shape', () => {
    expect(parseMarinePointDepth('emodnet-json', { min: -71.69, avg: -71.69 })).toBe(-71.69);
    expect(parseMarinePointDepth('emodnet-json', { avg: null })).toBeNull();
  });

  it('parses the ArcGIS identify shape, where the value is a STRING', () => {
    expect(parseMarinePointDepth('arcgis-identify', { value: '-0.290487' })).toBeCloseTo(-0.290487);
    expect(parseMarinePointDepth('arcgis-identify', { value: 'NoData' })).toBeNull();
    expect(parseMarinePointDepth('arcgis-identify', { value: -12 })).toBeNull();
  });

  it('never throws on junk bodies', () => {
    expect(parseMarinePointDepth('emodnet-json', null)).toBeNull();
    expect(parseMarinePointDepth('arcgis-identify', 'nope')).toBeNull();
    expect(parseMarinePointDepth('wcs-grid', { value: '-1' })).toBeNull();
  });
});

describe('raster fallback drapes', () => {
  it('templates the GEBCO WMS with MapLibre bbox substitution', () => {
    const url = marineRasterUrl(marineSourceById('gebco'));
    expect(url).toContain('wms.gebco.net/mapserv');
    expect(url).toContain('layers=GEBCO_LATEST_2');
    expect(url).toContain('bbox={bbox-epsg-3857}');
  });

  it('templates NOAA ENC Online (never the WMTS URL that died)', () => {
    const url = marineRasterUrl(marineSourceById('noaa'));
    expect(url).toContain('MaritimeChartService');
    expect(url).toContain('bbox={bbox-epsg-3857}');
    expect(url).not.toContain('NOAAChartDisplay');
  });

  it('leaves NONNA to the legacy WMS pair in marineLayers', () => {
    expect(marineRasterUrl(marineSourceById('nonna'))).toBeNull();
  });

  it('uses the plain EMODnet XYZ tiles', () => {
    expect(marineRasterUrl(marineSourceById('emodnet'))).toContain('{z}/{x}/{y}.png');
  });
});

describe('CRS handling', () => {
  it('is the identity for the EPSG:4326 grids', () => {
    expect(lonToGridX('EPSG:4326', -71.2)).toBe(-71.2);
    expect(latToGridY('EPSG:4326', 46.8)).toBe(46.8);
    expect(gridXToLon('EPSG:4326', 2)).toBe(2);
    expect(gridYToLat('EPSG:4326', 54)).toBe(54);
  });

  it('round-trips mercator', () => {
    expect(gridXToLon('EPSG:3857', lonToGridX('EPSG:3857', -71.2))).toBeCloseTo(-71.2, 9);
    expect(gridYToLat('EPSG:3857', latToGridY('EPSG:3857', 46.8))).toBeCloseTo(46.8, 9);
  });

  it('derives image corners in MapLibre order for both CRSs', () => {
    const corners = gridCornersFor('EPSG:4326', {
      x0: 1.9,
      y0: 54.1,
      dx: 0.001,
      dy: 0.001,
      width: 100,
      height: 100,
    });
    expect(corners).toEqual([
      [1.9, 54.1],
      [2, 54.1],
      [2, 54],
      [1.9, 54],
    ]);
  });
});

describe('the live grid fixtures each source answers with', () => {
  it('decodes the EMODnet WCS response (big-endian, tiled, 4326)', () => {
    const grid = parseFloat32Grid(fixture('emodnet-small.tif'));
    expect(grid).not.toBeNull();
    if (grid === null) return;
    const corners = gridCornersFor('EPSG:4326', grid);
    expect(corners[0][0]).toBeCloseTo(1.99, 2);
    expect(corners[0][1]).toBeCloseTo(54.02, 2);
    // North Sea depths: tens of metres below datum, never positive.
    const values = Array.from(grid.data).filter((v) => Number.isFinite(v));
    expect(values.length).toBeGreaterThan(0);
    expect(Math.max(...values)).toBeLessThan(0);
    expect(Math.min(...values)).toBeGreaterThan(-200);
  });

  it('decodes the NCEI exportImage response (little-endian, tiled, 4326)', () => {
    const grid = parseFloat32Grid(fixture('ncei-small.tif'));
    expect(grid).not.toBeNull();
    if (grid === null) return;
    expect(grid.width).toBe(100);
    expect(grid.height).toBe(100);
    const corners = gridCornersFor('EPSG:4326', grid);
    expect(corners[0][0]).toBeCloseTo(-70.98, 2);
    expect(corners[2][1]).toBeCloseTo(42.305, 3);
    // It is a terrain model: it holds land elevations, which is exactly why
    // the source carries a landCutoffM.
    const values = Array.from(grid.data).filter((v) => Number.isFinite(v));
    expect(Math.max(...values)).toBeGreaterThan(0);
    expect(Math.min(...values)).toBeLessThan(-1);
    expect(marineSourceById('noaa').grid?.landCutoffM).toBe(0.5);
  });
});

describe('sampleGridDepth (the offline half of tap-for-depth)', () => {
  /** 4×4 cells of 0.01° starting at 2.00E / 54.04N, one nodata hole. */
  const grid = {
    width: 4,
    height: 4,
    data: Float32Array.from([
      -10,
      -11,
      -12,
      -13,
      -14,
      NaN,
      -16,
      -17,
      -18,
      -19,
      -20,
      -21,
      -22,
      -23,
      -24,
      -25,
    ]),
    x0: 2,
    y0: 54.04,
    dx: 0.01,
    dy: 0.01,
  };

  it('reads the cell under the point', () => {
    expect(sampleGridDepth(grid, 'EPSG:4326', 54.035, 2.005)).toBe(-10);
    expect(sampleGridDepth(grid, 'EPSG:4326', 54.005, 2.035)).toBe(-25);
  });

  it('steps over a nodata hole to the nearest valid neighbour', () => {
    const v = sampleGridDepth(grid, 'EPSG:4326', 54.025, 2.015);
    expect(v).not.toBeNull();
    expect(Number.isNaN(v ?? NaN)).toBe(false);
    expect([-11, -14, -16, -19]).toContain(v);
  });

  it('returns null well outside the grid', () => {
    expect(sampleGridDepth(grid, 'EPSG:4326', 60, 2.005)).toBeNull();
    expect(sampleGridDepth(grid, 'EPSG:4326', 54.035, -71)).toBeNull();
  });

  it('honours the mercator CRS for a NONNA-shaped grid', () => {
    const merc = {
      width: 3,
      height: 3,
      data: Float32Array.from([-5, -6, -7, -8, -9, -10, -11, -12, -13]),
      x0: lonToGridX('EPSG:3857', -71.3),
      y0: latToGridY('EPSG:3857', 46.9),
      dx: 100,
      dy: 100,
    };
    const centre = sampleGridDepth(merc, 'EPSG:3857', 46.9 - 0.0009, -71.3 + 0.0012);
    expect(centre).not.toBeNull();
    expect(centre).toBeLessThan(0);
    // A point a long way off the 300 m grid has nothing to answer with.
    expect(sampleGridDepth(merc, 'EPSG:3857', 46.9, -60)).toBeNull();
  });

  it('treats float32-max nodata as missing, like the NONNA nilValue', () => {
    const allNoData = { ...grid, data: Float32Array.from(Array<number>(16).fill(3.4028235e38)) };
    expect(sampleGridDepth(allNoData, 'EPSG:4326', 54.035, 2.005)).toBeNull();
  });
});
