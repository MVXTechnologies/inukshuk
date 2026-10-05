import {
  formatBytes,
  packFor,
  packsForGrids,
  packsForRegion,
  parsePackIndex,
  resolveGrid,
  withGridPaths,
  type InstalledGrid,
} from './packs';

const index = parsePackIndex({
  version: 1,
  generated: '2026-10-05',
  packs: [
    {
      id: 'ca-qc',
      name: 'Québec',
      bbox: [-80.3, 44.5, -56.6, 63.1],
      files: [
        {
          name: 'ca_nrc_CGG2013an83.tif',
          bytes: 450000,
          md5: 'a',
          crop: [-80.3, 44.5, -56.6, 63.1],
        },
      ],
    },
    {
      id: 'ca-on',
      name: 'Ontario',
      bbox: [-95.7, 41.1, -73.8, 57.4],
      files: [
        {
          name: 'ca_nrc_CGG2013an83.tif',
          bytes: 500000,
          md5: 'b',
          crop: [-95.7, 41.1, -73.8, 57.4],
        },
      ],
    },
    {
      id: 'ca-national',
      name: 'Canada',
      national: true,
      bbox: [-142, 40, -47, 85],
      files: [
        { name: 'ca_nrc_CGG2013an83.tif', bytes: 11e6, md5: 'c', crop: null },
        { name: 'ca_nrc_ntv2_0.tif', bytes: 7.8e6, md5: 'd' },
      ],
    },
    { id: 'BAD ID', name: 'x', bbox: [0, 0, 1, 1], files: [{ name: 'x.tif', bytes: 1, md5: 'e' }] },
    {
      id: 'empty',
      name: 'x',
      bbox: [0, 0, 1, 1],
      files: [{ name: '../evil', bytes: 1, md5: 'e' }],
    },
  ],
});

describe('pack index', () => {
  it('drops malformed packs and files', () => {
    expect(index?.packs.map((p) => p.id)).toEqual(['ca-qc', 'ca-on', 'ca-national']);
    expect(parsePackIndex(null)).toBeNull();
    expect(parsePackIndex({ packs: 'x' })).toBeNull();
  });

  it('picks the smallest regional pack, national last', () => {
    if (!index) throw new Error();
    expect(packFor(index, 'ca_nrc_CGG2013an83.tif', -71.2, 46.8)?.id).toBe('ca-qc');
    expect(packFor(index, 'ca_nrc_CGG2013an83.tif', -79.4, 43.7)?.id).toBe('ca-on');
    expect(packFor(index, 'ca_nrc_CGG2013an83.tif', -114, 51)?.id).toBe('ca-national');
    expect(packFor(index, 'ca_nrc_ntv2_0.tif', -71.2, 46.8)?.id).toBe('ca-national');
    expect(packsForGrids(index, ['ca_nrc_CGG2013an83.tif', 'nope.tif'], -71.2, 46.8)).toMatchObject(
      { packs: [{ id: 'ca-qc' }], unavailable: ['nope.tif'] },
    );
    expect(packsForRegion(index, [-72, 46, -71, 47]).map((p) => p.id)).toEqual(['ca-qc']);
  });
});

describe('installed grids', () => {
  const installed: InstalledGrid[] = [
    {
      pack: 'ca-on',
      name: 'ca_nrc_CGG2013an83.tif',
      path: '/d/ca-on/ca_nrc_CGG2013an83.tif',
      crop: [-95.7, 41.1, -73.8, 57.4],
    },
    {
      pack: 'ca-qc',
      name: 'ca_nrc_CGG2013an83.tif',
      path: '/d/ca-qc/ca_nrc_CGG2013an83.tif',
      crop: [-80.3, 44.5, -56.6, 63.1],
    },
  ];
  it('uses the crop that covers the point, never the first one found', () => {
    expect(resolveGrid(installed, 'ca_nrc_CGG2013an83.tif', -71.2, 46.8)?.pack).toBe('ca-qc');
    expect(resolveGrid(installed, 'ca_nrc_CGG2013an83.tif', -79.4, 43.7)?.pack).toBe('ca-on');
    expect(resolveGrid(installed, 'ca_nrc_CGG2013an83.tif', -114, 51)).toBeNull();
    // A whole file wins over any crop.
    const whole = [
      ...installed,
      { pack: 'ca-national', name: 'ca_nrc_CGG2013an83.tif', path: '/d/n/x.tif', crop: null },
    ];
    expect(resolveGrid(whole, 'ca_nrc_CGG2013an83.tif', -71.2, 46.8)?.pack).toBe('ca-national');
  });
  it('rewrites grid names to absolute paths', () => {
    expect(
      withGridPaths(
        '+step +inv +proj=vgridshift +grids=a.tif +multiplier=1 +step +proj=x +grids=b.tif,c.tif',
        { 'a.tif': '/p/a.tif', 'c.tif': '/q/c.tif' },
      ),
    ).toBe(
      '+step +inv +proj=vgridshift +grids=/p/a.tif +multiplier=1 +step +proj=x +grids=b.tif,/q/c.tif',
    );
  });
  it('formats sizes', () => {
    expect(formatBytes(450000)).toBe('0.45 MB');
    expect(formatBytes(1.1e7)).toBe('11 MB');
    expect(formatBytes(3.8e6)).toBe('3.8 MB');
  });
});
