import { GEODETIC_CATALOG } from '@core/geodetic/catalog';
import type { GeodeticMark } from '@core/geodetic/record';
import {
  cdStationOf,
  defaultTarget,
  frameOfDatum,
  fromParams,
  prefillFromMark,
  prefillFromPoint,
  prefillFromTideStation,
  splitGeo,
  systemOfGrid,
  toParams,
} from './prefill';
import { coordSystem, FRAMES } from './systems';
import type { FrameId } from './types';

const di = (key: string) => GEODETIC_CATALOG.datums.findIndex((d) => d.key === key);
const vi = (name: string) => GEODETIC_CATALOG.vdatums.findIndex((v) => v.name === name);

const mark81KM003: GeodeticMark = {
  id: '81KM003',
  source: 0,
  osm: false,
  type: '3d',
  status: 'ok',
  legacy: false,
  lat: 46.851168,
  lng: -71.238585,
  datum: di('nad83csrs-qc'),
  heights: [
    { text: '24.488', vdatum: vi('CGVD2013') },
    { text: '24.870', vdatum: vi('CGVD28') },
  ],
  hEll: '-3.127',
  geo: '46° 51\' 04.2048" N, 71° 14\' 18.9060" W',
  grids: [
    { system: 'UTM zone 19N', e: '331582.278', n: '5186767.681' },
    { system: 'MTM zone 7 (SCOPQ)', e: '248476.150', n: '5190447.200' },
  ],
};

describe('prefill from a survey mark', () => {
  it('opens on the published values, datum and epoch (mockup 08)', () => {
    const r = prefillFromMark(mark81KM003);
    expect(r.spec).toEqual({
      from: 'csrs:geo',
      fromHeight: 'ell',
      to: 'csrs:mtm7',
      toHeight: 'cgvd2013a',
    });
    expect(r.a).toBe('46° 51\' 04.2048" N');
    expect(r.b).toBe('71° 14\' 18.9060" W');
    expect(r.h).toBe('-3.127');
    expect(r.epoch).toBe('1997.0');
    expect(r.origin?.label).toBe('From mark 81KM003');
    expect(r.published).toEqual([
      { heightId: 'cgvd2013a', text: '24.488' },
      { heightId: 'cgvd28', text: '24.870' },
      { heightId: 'ell', text: '-3.127' },
    ]);
  });

  it('falls back to a published grid when there is no geographic text', () => {
    const { geo: _g, ...noGeo } = mark81KM003;
    const r = prefillFromMark(noGeo);
    expect(r.spec.from).toBe('csrs:utm19n');
    expect(r.spec.to).toBe('csrs:mtm7');
    expect([r.a, r.b]).toEqual(['331582.278', '5186767.681']);
  });

  it('starts from the orthometric height when no h is published', () => {
    const { hEll: _h, ...noH } = mark81KM003;
    const r = prefillFromMark(noH);
    expect(r.spec.fromHeight).toBe('cgvd2013a');
    expect(r.spec.toHeight).toBe('ell');
  });

  it('never invents coordinates for an unsupported datum', () => {
    const r = prefillFromMark({ ...mark81KM003, datum: di('gda2020'), lat: -33, lng: 151 });
    expect(r.a).toBe('');
    expect(r.notice).toMatch(/GDA2020/);
  });

  it('needs the epoch from the datasheet for NRCan marks', () => {
    const r = prefillFromMark({ ...mark81KM003, datum: di('nad83csrs') });
    expect(r.epoch).toBeUndefined();
  });
});

describe('datum and grid mapping', () => {
  it('maps catalogue datums to Convert frames at the mark', () => {
    expect(frameOfDatum('nad27', -71.2, 46.8)?.frame).toBe('nad27-qc');
    expect(frameOfDatum('nad27', -122.3, 47.6)?.frame).toBe('nad27-us');
    expect(frameOfDatum('nad83-2011', -71.2, 46.8)).toBeNull();
    expect(frameOfDatum('etrs89', 7.4, 46.9)?.frame).toBe('etrs89-ch');
    expect(frameOfDatum('etrs89', 5, 52)?.frame).toBe('etrs89-nl');
    expect(frameOfDatum('etrs89', 10.7, 59.9)?.frame).toBe('euref89-no');
    expect(frameOfDatum('etrs89', -2, 54)?.frame).toBe('etrs89-uk');
    expect(frameOfDatum('etrs89', 20, 40)).toBeNull();
    expect(frameOfDatum('rgf93', 2.3, 48.8)?.frame).toBe('rgf93v2b');
    for (const k of ['wgs84', 'osgb36', 'lv95', 'rd-bessel', 'etrs89-rd', 'nad83-1986'])
      expect(frameOfDatum(k, -77, 39)).not.toBeUndefined();
    expect(frameOfDatum('sirgas2000', -47, -15)).toBeNull();
  });
  it('maps published grid labels', () => {
    expect(systemOfGrid('csrs', 'MTM zone 7 (SCOPQ)')).toBe('csrs:mtm7');
    expect(systemOfGrid('nad83-2011', 'UTM zone 18')).toBe('nad83-2011:utm18n');
    expect(systemOfGrid('ch1903p', 'LV95')).toBe('ch1903p:lv95');
    expect(systemOfGrid('rgf93v2b', 'Lambert-93')).toBe('rgf93v2b:l93');
    expect(systemOfGrid('osgb36', 'British National Grid')).toBe('osgb36:bng');
    expect(systemOfGrid('amersfoort', 'RD')).toBe('amersfoort:rd');
    expect(systemOfGrid('csrs', 'SPC WA N-4601')).toBeNull();
    // MRNF's open-data layer, old and new tile labels (field report 2.3.0).
    expect(systemOfGrid('csrs', 'Québec Lambert (approximate)')).toBe('csrs:qclambert');
    expect(systemOfGrid('csrs', 'Québec Lambert (bulk layer, ±2 m)')).toBe('csrs:qclambert');
    expect(systemOfGrid('nad27-qc', 'Québec Lambert (approximate)')).toBeNull();
    // A lettered 10 m square is not a BNG easting/northing.
    expect(systemOfGrid('osgb36', 'British National Grid TQ (10 m)')).toBeNull();
  });
  it('every frame’s default target is a system Convert knows', () => {
    for (const f of Object.keys(FRAMES) as FrameId[]) {
      const t = defaultTarget(f, 5, 50);
      expect([f, coordSystem(t.to)?.id]).toEqual([f, t.to]);
    }
  });
  it('splits published geographic text', () => {
    expect(splitGeo('43 57 56.12345 (N), 073 07 00.12345 (W)')).toEqual([
      '43 57 56.12345 (N)',
      '073 07 00.12345 (W)',
    ]);
    expect(splitGeo('46.85° N, 71.23° W')).not.toBeNull();
    expect(splitGeo('nonsense')).toBeNull();
  });
  it('picks a regional target', () => {
    expect(defaultTarget('csrs', -71.2, 46.8)).toEqual({ to: 'csrs:mtm7', toHeight: 'cgvd2013a' });
    expect(defaultTarget('csrs', -115, 51).to).toBe('csrs:utm11n');
    expect(defaultTarget('nad83-2011', -122.3, 47.6)).toEqual({
      to: 'nad83-2011:utm10n',
      toHeight: 'navd88',
    });
    expect(defaultTarget('etrs89-uk', -5.9, 54.6).toHeight).toBe('belfast');
    expect(defaultTarget('wgs84', 151, -33).to).toBe('wgs84:utm56s');
    for (const f of ['rgf93v2b', 'etrs89-ch', 'euref89-no', 'etrs89-nl', 'nad27-qc'] as const)
      expect(defaultTarget(f, 5, 50).to).toBeTruthy();
  });
});

describe('tide stations', () => {
  const lauzon = {
    id: '03248',
    name: 'Vieux-Québec',
    lat: 46.8121,
    lng: -71.2022,
    agency: 'CHS',
    country: 'ca',
    national: [
      { datum: 'CGVD2013', text: '-2.34' },
      { datum: 'IGLD85', text: '-1.99' },
      { datum: 'NAD83_CSRS', text: '-30.11' },
    ],
  };
  it('turns published offsets into a chart-datum context', () => {
    expect(cdStationOf(lauzon)).toMatchObject({
      key: 'ca-chs:03248',
      offsets: { cgvd2013: -2.34, igld85: -1.99 },
    });
    expect(cdStationOf({ ...lauzon, national: [{ datum: 'IGLD85', text: '-1.99' }] })).toBeNull();
    expect(cdStationOf({ ...lauzon, country: 'fr' })).toBeNull();
  });
  it('takes the tides branch’s own TideStation as is (country and agency from its offsets)', () => {
    const tideStation = {
      id: '03248',
      source: 0,
      name: 'Vieux-Québec',
      lat: 46.8121,
      lng: -71.2022,
      kind: 'gauge',
      levels: [],
      national: [{ datum: 'CGVD2013', text: '-2.34' }],
    };
    expect(cdStationOf(tideStation)).toMatchObject({
      key: 'ca-chs:03248',
      agency: 'CHS',
      country: 'ca',
    });
    const battery = {
      id: '8518750',
      name: 'The Battery',
      lat: 40.7,
      lng: -74.01,
      national: [{ datum: 'NAVD88', text: '-0.846' }],
    };
    expect(prefillFromTideStation(battery).spec).toMatchObject({
      from: 'nad83-2011:geo',
      fromHeight: 'cd@us-noaacoops:8518750',
      toHeight: 'navd88',
    });
    expect(cdStationOf({ ...battery, national: [{ datum: 'NN2000', text: '1' }] })).toBeNull();
  });

  it('opens on CD → CGVD2013, heights only (mockup 09)', () => {
    const r = prefillFromTideStation(lauzon, {
      heightAboveCd: '8.422',
      benchmark: { id: '19L760B', lat: 46.812056, lng: -71.20222 },
    });
    expect(r.spec).toMatchObject({
      from: 'csrs:geo',
      fromHeight: 'cd@ca-chs:03248',
      to: 'same',
      toHeight: 'cgvd2013a',
    });
    expect(r.h).toBe('8.422');
    expect(r.origin?.label).toBe('From benchmark 19L760B');
    expect(prefillFromTideStation({ ...lauzon, national: [] }).notice).toMatch(/no chart-datum/);
    expect(
      prefillFromTideStation({
        ...lauzon,
        country: 'us',
        national: [{ datum: 'NAVD88', text: '-0.846' }],
      }).spec.toHeight,
    ).toBe('navd88');
  });
});

describe('route params / deep link', () => {
  it('round-trips a request', () => {
    const r = prefillFromMark(mark81KM003);
    const back = fromParams(toParams(r));
    expect(back?.spec).toEqual({ ...r.spec, epoch: 1997 });
    expect(back?.a).toBe(r.a);
    expect(back?.published).toEqual(r.published);
    expect(back?.origin).toEqual({ kind: 'mark', label: 'From mark 81KM003' });
  });
  it('reads a hand-written deep link and drops junk', () => {
    const r = fromParams({
      from: 'csrs:geo',
      epoch: '1997',
      a: '46.85',
      b: '-71.23',
      to: 'csrs:mtm7',
      st: '{bad json',
    });
    expect(r?.spec.epoch).toBe(1997);
    expect(r?.near).toEqual({ lon: -71.23, lat: 46.85 });
    expect(fromParams({ from: 'nope' })).toBeNull();
    expect(fromParams({ from: ['wgs84:geo'], a: '1', b: '2' })?.spec.to).toBe('same');
  });
  it('carries an approximate source position; junk never makes it more precise', () => {
    const base = { from: 'csrs:qclambert', a: '-208379.906', b: '317906.512' };
    expect(fromParams({ ...base, pacc: '2', pwhy: 'Approx' })?.approxPosition).toEqual({
      accM: 2,
      why: 'Approx',
    });
    expect(fromParams({ ...base, pacc: '2' })?.approxPosition?.why).toMatch(/approximate/);
    for (const pacc of ['0', '-1', 'abc', ''])
      expect(fromParams({ ...base, pacc })?.approxPosition).toBeUndefined();
  });
  it('opens a map point as WGS 84', () => {
    expect(prefillFromPoint(46.851168, -71.238585).spec).toEqual({
      from: 'wgs84:geo',
      fromHeight: null,
      to: 'wgs84:utm19n',
      toHeight: null,
    });
  });
});
