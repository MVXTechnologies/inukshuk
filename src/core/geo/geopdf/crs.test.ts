import {
  datumInfoForCode,
  epsgFromText,
  makeReprojector,
  northAmericanUtmFromEpsg,
  proj4DefForEpsg,
  resolveLgiProjection,
  utmEpsg,
  utmFromEpsg,
  utmZoneFromTmParams,
} from './crs';

describe('crs — EPSG detection', () => {
  it('reads EPSG from WKT AUTHORITY', () => {
    expect(epsgFromText('GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]]')).toBe(4326);
    expect(
      epsgFromText(
        'PROJCS["UTM 18N",GEOGCS["x",AUTHORITY["EPSG","4326"]],AUTHORITY["EPSG","32618"]]',
      ),
    ).toBe(32618);
  });

  it('reads EPSG:NNNN and urn forms', () => {
    expect(epsgFromText('EPSG:3857')).toBe(3857);
    expect(epsgFromText('urn:ogc:def:crs:EPSG::32617')).toBe(32617);
  });

  it('detects web mercator by name', () => {
    expect(epsgFromText('WGS 84 / Pseudo-Mercator')).toBe(3857);
  });

  it('detects UTM zone phrasing', () => {
    expect(epsgFromText('UTM zone 18N WGS84')).toBe(32618);
    expect(epsgFromText('UTM Zone 33 South WGS 84')).toBe(32733);
  });

  it('returns undefined for unrecognized text', () => {
    expect(epsgFromText(undefined)).toBeUndefined();
    expect(epsgFromText('some random label')).toBeUndefined();
  });
});

describe('crs — UTM helpers', () => {
  it('round-trips zone <-> epsg', () => {
    expect(utmEpsg(18, true)).toBe(32618);
    expect(utmEpsg(33, false)).toBe(32733);
    expect(utmFromEpsg(32618)).toEqual({ zone: 18, north: true });
    expect(utmFromEpsg(32733)).toEqual({ zone: 33, north: false });
    expect(utmFromEpsg(4326)).toBeNull();
  });

  it('builds proj4 defs for known EPSG codes', () => {
    expect(proj4DefForEpsg(4326)).toContain('longlat');
    expect(proj4DefForEpsg(3857)).toContain('merc');
    expect(proj4DefForEpsg(32618)).toContain('zone=18');
    expect(proj4DefForEpsg(99999)).toBeNull();
  });
});

describe('crs — reprojector', () => {
  it('passes WGS84 lon/lat through unchanged', () => {
    const r = makeReprojector({ epsg: 4326 });
    expect(r.isWgs84).toBe(true);
    expect(r.toWgs84(-75, 46)).toEqual([-75, 46]);
  });

  it('reprojects UTM 18N meters to lon/lat', () => {
    const r = makeReprojector({ epsg: 32618 });
    expect(r.isWgs84).toBe(false);
    const [lon, lat] = r.toWgs84(585000, 4511000);
    expect(lon).toBeGreaterThan(-74.5);
    expect(lon).toBeLessThan(-73.5);
    expect(lat).toBeGreaterThan(40.0);
    expect(lat).toBeLessThan(41.5);
  });

  it('falls back to pass-through for unknown CRS, and SAYS it did not resolve', () => {
    const r = makeReprojector({ epsg: 99999 });
    expect(r.isWgs84).toBe(true);
    // The pass-through is a fallback, not an answer. A caller that treats it as
    // lon/lat draws the sheet in projected metres — silently (#243).
    expect(r.resolved).toBe(false);
    expect(r.toWgs84(1, 2)).toEqual([1, 2]);
    expect(makeReprojector({ epsg: 4326 }).resolved).toBe(true);
    expect(makeReprojector({ epsg: 26919 }).resolved).toBe(true);
  });
});

describe('crs — North American UTM (#243)', () => {
  it('maps 269xx / 267xx to their zone and datum', () => {
    expect(northAmericanUtmFromEpsg(26919)).toEqual({ zone: 19, datum: 'NAD83' });
    expect(northAmericanUtmFromEpsg(26710)).toEqual({ zone: 10, datum: 'NAD27' });
    expect(northAmericanUtmFromEpsg(26999)).toBeNull();
    expect(northAmericanUtmFromEpsg(32619)).toBeNull();
  });

  it('builds proj4 defs for the North American codes', () => {
    expect(proj4DefForEpsg(26919)).toContain('+zone=19 +datum=NAD83');
    expect(proj4DefForEpsg(26719)).toContain('+zone=19 +datum=NAD27');
    expect(proj4DefForEpsg(4269)).toContain('+datum=NAD83');
    expect(proj4DefForEpsg(4267)).toContain('+datum=NAD27');
  });

  it('reprojects NAD83 / UTM 19N metres onto the New Brunswick sheet', () => {
    const r = makeReprojector({ epsg: 26919 });
    const [lon, lat] = r.toWgs84(614276, 5066406);
    expect(lon).toBeCloseTo(-67.531, 2);
    expect(lat).toBeCloseTo(45.742, 2);
  });
});

describe('crs — LGIDict /Projection', () => {
  it('recognizes a CanTopo map frame (TC parameters) as NAD83 / UTM', () => {
    // Verbatim from cantopo_021g14: the parameters ARE UTM zone 19N.
    const crs = resolveLgiProjection({
      projectionType: 'TC',
      datum: 'NAR',
      centralMeridian: -69,
      originLatitude: 0,
      scaleFactor: 0.9996,
      falseEasting: 500000,
      falseNorthing: 0,
    });
    expect(crs.epsg).toBe(26919);
    expect(crs.label).toBe('NAD83 / UTM zone 19N (EPSG:26919)');
    expect(crs.proj4Def).toContain('+zone=19');
  });

  it('follows the central meridian across zone boundaries', () => {
    // The zone comes from the sheet's OWN central meridian, so a sheet on the
    // far side of a boundary is projected in its own zone, not a guessed one.
    const zoneFor = (centralMeridian: number) =>
      resolveLgiProjection({
        projectionType: 'TC',
        datum: 'NAR',
        centralMeridian,
        originLatitude: 0,
        scaleFactor: 0.9996,
        falseEasting: 500000,
        falseNorthing: 0,
      }).epsg;
    expect(zoneFor(-135)).toBe(26908); // Yukon
    expect(zoneFor(-123)).toBe(26910); // BC
    expect(zoneFor(-51)).toBe(26922); // Newfoundland
  });

  it('keeps a plain Transverse Mercator as a tmerc, not a fake UTM', () => {
    const crs = resolveLgiProjection({
      projectionType: 'TC',
      datum: 'NAR',
      centralMeridian: -114,
      scaleFactor: 0.9999,
      falseEasting: 0,
    });
    expect(crs.epsg).toBeUndefined();
    expect(crs.proj4Def).toContain('+proj=tmerc');
    expect(crs.label).toBe('Transverse Mercator (NAD83, CM -114°)');
  });

  it('reads the UT form (type + zone + hemisphere) on any datum', () => {
    expect(resolveLgiProjection({ projectionType: 'UT', zone: 18, datum: 'WE' }).epsg).toBe(32618);
    expect(resolveLgiProjection({ projectionType: 'UT', zone: 19, datum: 'NAR' }).epsg).toBe(26919);
    const south = resolveLgiProjection({
      projectionType: 'UT',
      zone: 33,
      hemisphere: 'S',
      datum: 'WE',
    });
    expect(south.epsg).toBe(32733);
    expect(south.proj4Def).toContain('+south');
  });

  it('resolves geographic frames against their datum', () => {
    expect(resolveLgiProjection({ projectionType: 'GEOGRAPHIC', datum: 'WE' }).epsg).toBe(4326);
    expect(resolveLgiProjection({ projectionType: 'GEODETIC', datum: 'NAR' }).epsg).toBe(4269);
  });

  it('resolves the conic and cylindrical frames these sheets use', () => {
    const lcc = resolveLgiProjection({
      projectionType: 'LE',
      datum: 'NAR',
      centralMeridian: -96,
      originLatitude: 40,
      standardParallelOne: 45,
      standardParallelTwo: 82,
    });
    expect(lcc.proj4Def).toContain('+proj=lcc +lat_1=45 +lat_2=82');
    const albers = resolveLgiProjection({
      projectionType: 'AC',
      centralMeridian: -96,
      standardParallelOne: 50,
      standardParallelTwo: 70,
    });
    expect(albers.proj4Def).toContain('+proj=aea');
    const merc = resolveLgiProjection({ projectionType: 'MC', centralMeridian: 0 });
    expect(merc.proj4Def).toContain('+proj=merc');
  });

  it('prefers an explicit EPSG or a WKT over the parameters', () => {
    expect(resolveLgiProjection({ epsg: 32618, projectionType: 'TC' }).epsg).toBe(32618);
    expect(resolveLgiProjection({ wkt: 'PROJCS["x",AUTHORITY["EPSG","26920"]]' }).epsg).toBe(26920);
  });

  it('refuses a projection it cannot build, and names it', () => {
    const crs = resolveLgiProjection({ projectionType: 'PH', datum: 'NAS', centralMeridian: -96 });
    expect(crs.proj4Def).toBeNull();
    expect(crs.label).toBe('Polyconic, datum NAD27');
    expect(resolveLgiProjection({}).label).toBe('unnamed projection, datum WGS 84');
    expect(resolveLgiProjection({ projectionType: 'ZZ' }).label).toBe(
      'projection "ZZ", datum WGS 84',
    );
  });

  it('falls back to WGS 84 for an unknown datum code, keeping the code visible', () => {
    const info = datumInfoForCode('QQQ');
    expect(info.geographicEpsg).toBe(4326);
    expect(info.name).toBe('QQQ');
    expect(datumInfoForCode('NAR-C').name).toBe('NAD83');
    expect(datumInfoForCode(undefined).name).toBe('WGS 84');
  });
});

describe('crs — UTM detection from TM parameters', () => {
  const utm = {
    scaleFactor: 0.9996,
    falseEasting: 500000,
    falseNorthing: 0,
    originLatitude: 0,
  };

  it('accepts the exact UTM parameter set', () => {
    expect(utmZoneFromTmParams({ ...utm, centralMeridian: -69 })).toEqual({
      zone: 19,
      north: true,
    });
    expect(utmZoneFromTmParams({ ...utm, centralMeridian: 15, falseNorthing: 10000000 })).toEqual({
      zone: 33,
      north: false,
    });
  });

  it('rejects anything that is merely UTM-shaped', () => {
    expect(utmZoneFromTmParams({ ...utm, centralMeridian: -69, scaleFactor: 0.9999 })).toBeNull();
    expect(utmZoneFromTmParams({ ...utm, centralMeridian: -69, falseEasting: 0 })).toBeNull();
    expect(utmZoneFromTmParams({ ...utm, centralMeridian: -69, originLatitude: 45 })).toBeNull();
    expect(
      utmZoneFromTmParams({ ...utm, centralMeridian: -69, falseNorthing: 4000000 }),
    ).toBeNull();
    // Not on the 6° grid.
    expect(utmZoneFromTmParams({ ...utm, centralMeridian: -70 })).toBeNull();
  });
});
