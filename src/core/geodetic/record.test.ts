import { GEODETIC_CATALOG, OSM_SOURCE_INDEX } from './catalog';
import { markKey, parseGeodeticFeature, pickTappedMark } from './record';

const QC = GEODETIC_CATALOG.sources.findIndex((s) => s.key === 'qc-mrnf');

/** A Québec datasheet mark as the build writes it (infra/tiles/nas/geodetic/tiles.py). */
const M15KM007 = {
  i: 'M15KM007',
  s: QC,
  k: '3d',
  y: 46.81315813,
  x: -71.20762704,
  d: 0,
  H: '51.158',
  hd: 0,
  H2: '51.54',
  hd2: 1,
  h: '23.393',
  gc: '46° 48\' 47.36926" N, 71° 12\' 27.45735" W',
  g1: 'UTM zone 19N;331582.278;5186767.681',
  g2: 'MTM zone 7 (SCOPQ);250798.875;5186200.480',
  m: 'disk',
  mt: 'Médaillon convexe ancré(e) sur un trottoir de béton',
  v: '2018-04-26',
};

describe('parseGeodeticFeature', () => {
  it('keeps every published value as the agency printed it', () => {
    const m = parseGeodeticFeature(M15KM007);
    expect(m).toMatchObject({
      id: 'M15KM007',
      source: QC,
      osm: false,
      type: '3d',
      status: 'ok',
      legacy: false,
      lat: 46.81315813,
      lng: -71.20762704,
      heights: [
        { text: '51.158', vdatum: 0 },
        { text: '51.54', vdatum: 1 },
      ],
      hEll: '23.393',
      geo: '46° 48\' 47.36926" N, 71° 12\' 27.45735" W',
      grids: [
        { system: 'UTM zone 19N', e: '331582.278', n: '5186767.681' },
        { system: 'MTM zone 7 (SCOPQ)', e: '250798.875', n: '5186200.480' },
      ],
      monumentCode: 'disk',
      lastVisit: '2018-04-26',
    });
    // the trailing zero of 5186200.480 survives
    expect(m?.grids[1]?.n).toBe('5186200.480');
  });

  it('makes a mark from the bare minimum (id, source, position)', () => {
    const m = parseGeodeticFeature({ i: 'X1', s: QC }, [-71, 46]);
    expect(m).toEqual({
      id: 'X1',
      source: QC,
      osm: false,
      type: 'u',
      status: 'ok',
      legacy: false,
      lat: 46,
      lng: -71,
      heights: [],
      grids: [],
    });
  });

  it('reads status, legacy, precision and OSM fields', () => {
    expect(parseGeodeticFeature({ i: 'a', s: 1, c: 1, l: 1, p: 100, x: 1, y: 2 })).toMatchObject({
      status: 'damaged',
      legacy: true,
      posAccM: 10,
    });
    expect(parseGeodeticFeature({ i: 'a', s: 1, c: 4, x: 1, y: 2 })?.status).toBe('unknown');
    const osm = parseGeodeticFeature({
      i: '123',
      s: OSM_SOURCE_INDEX,
      k: 'h',
      H: '102.5',
      w: 'https://example.org/sheet/1',
      x: 1,
      y: 2,
    });
    expect(osm).toMatchObject({ osm: true, url: 'https://example.org/sheet/1' });
    expect(osm?.heights).toEqual([{ text: '102.5' }]);
  });

  it('accepts old tiles that carried heights as numbers', () => {
    expect(parseGeodeticFeature({ i: 'a', s: 2, H: 117.719, hd: 2, x: 1, y: 2 })?.heights).toEqual([
      { text: '117.719', vdatum: 2 },
    ]);
  });

  it('rejects junk', () => {
    expect(parseGeodeticFeature(null)).toBeNull();
    expect(parseGeodeticFeature({ s: 1, x: 1, y: 2 })).toBeNull();
    expect(parseGeodeticFeature({ i: 'a', x: 1, y: 2 })).toBeNull();
    expect(parseGeodeticFeature({ i: 'a', s: 1 })).toBeNull();
    expect(parseGeodeticFeature({ i: 'a', s: 1, x: 200, y: 2 })).toBeNull();
    expect(parseGeodeticFeature({ i: 'a', s: 1, x: 1, y: 2, w: 'javascript:alert(1)' })?.url).toBe(
      undefined,
    );
    expect(parseGeodeticFeature({ i: 'a', s: 1, x: 1, y: 2, g1: 'only;two' })?.grids).toEqual([]);
  });
});

describe('pickTappedMark', () => {
  const feature = (props: Record<string, unknown>) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [props.x, props.y] },
    properties: props,
  });

  it('picks the nearest mark to the finger', () => {
    const near = feature({ i: 'NEAR', s: QC, x: -71.2, y: 46.8 });
    const far = feature({ i: 'FAR', s: QC, x: -71.21, y: 46.8 });
    expect(pickTappedMark([far, near], [-71.2001, 46.8])?.id).toBe('NEAR');
  });

  it('prefers the official mark over an OSM point at the same spot', () => {
    const osm = feature({ i: '9', s: OSM_SOURCE_INDEX, x: -71.2, y: 46.8 });
    const official = feature({ i: 'OFF', s: QC, x: -71.2, y: 46.8 });
    expect(pickTappedMark([osm, official], [-71.2, 46.8])?.id).toBe('OFF');
  });

  it('ignores features that are not marks', () => {
    expect(pickTappedMark([null, 3, { properties: { name: 'x' } }], [0, 0])).toBeNull();
  });

  it('keys marks by source and id', () => {
    expect(markKey({ source: 2, id: 'RG0364' })).toBe('2:RG0364');
  });
});
