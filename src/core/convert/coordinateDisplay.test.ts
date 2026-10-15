import { formatLatLng } from '@core/geo/formatCoords';

import {
  COORDINATE_FORMATS,
  DEFAULT_COORDINATE_FORMAT,
  formatCoordinate,
  formatUtm,
  isCoordinateFormat,
  latitudeBand,
  mgrsSquare,
  toMgrs,
  toUtm,
  utmZone,
  wrapLongitude,
} from './coordinateDisplay';
import { parseAngle } from './format';

const QC = { lat: 46.81394, lon: -71.20761 };

describe('UTM against published values', () => {
  it('CN Tower: 17T 630084 m E, 4833438 m N (Wikipedia, "Universal Transverse Mercator")', () => {
    // 43°38′33.24″N 79°23′13.7″W
    const u = toUtm(43 + 38 / 60 + 33.24 / 3600, -(79 + 23 / 60 + 13.7 / 3600));
    expect(u).toMatchObject({ zone: 17, band: 'T', south: false });
    expect(Math.floor(u?.easting ?? 0)).toBe(630084);
    expect(Math.floor(u?.northing ?? 0)).toBe(4833438);
  });

  it('GeographicLib GeoConvert: 33.33424 44.40363 → 38n 444500 3688500', () => {
    const u = toUtm(33.33424, 44.40363);
    expect(u?.zone).toBe(38);
    expect(u?.easting).toBeCloseTo(444500, -1);
    expect(u?.northing).toBeCloseTo(3688500, -1);
  });

  it('0°, 0°: the textbook 166 021.443 m easting on the equator', () => {
    const u = toUtm(0, 0);
    expect(u).toMatchObject({ zone: 31, band: 'N' });
    expect(u?.easting).toBeCloseTo(166021.443, 2);
    expect(u?.northing).toBeCloseTo(0, 6);
  });

  it('southern hemisphere: a 10 000 km false northing', () => {
    // Cross-checked with the independent `mgrs` 1.0.0 package (which rounds
    // the last digit where we truncate).
    expect(formatUtm(-33.856784, 151.215297)).toBe('56H 334900.2 6252290.5'); // Sydney Opera House
    expect(formatUtm(-22.9519, -43.2105)).toBe('23K 683476.5 7460687.3'); // Cristo Redentor
    expect(toUtm(-1e-9, 0)?.northing).toBeCloseTo(10_000_000, 1);
  });

  it('truncates to the decimetre the point is in (#701)', () => {
    // CN Tower's northing is 4 833 438.59: rounding would print …438.6.
    expect(formatUtm(43.642567, -79.387139)).toBe('17T 630084.3 4833438.5');
  });

  it('agrees with MGRS on every whole metre', () => {
    const utm = formatUtm(QC.lat, QC.lon)?.split(' ') ?? [];
    const mgrs = toMgrs(QC.lat, QC.lon)?.split(' ') ?? [];
    expect(utm[1]?.slice(1, 6)).toBe(mgrs[2]);
    expect(utm[2]?.slice(2, 7)).toBe(mgrs[3]);
  });
});

describe('MGRS against published values', () => {
  it('GeographicLib GeoConvert: E44d24 N33d20 → 38SMB4488 (1 km)', () => {
    expect(toMgrs(33 + 20 / 60, 44.4, 2)).toBe('38S MB 44 88');
  });

  it.each([
    // Cross-checked with the independent `mgrs` 1.0.0 package: same zone,
    // band and square everywhere, the last digit only where it rounds.
    ['CN Tower', 43.642567, -79.387139, '17T PJ 30084 33438'],
    ['Québec', QC.lat, QC.lon, '19T CM 31586 86854'],
    ['Sydney Opera House', -33.856784, 151.215297, '56H LH 34900 52290'],
    ['Cristo Redentor', -22.9519, -43.2105, '23K PQ 83476 60687'],
    ['0°, 0°', 0, 0, '31N AA 66021 00000'],
    ['near 80°S', -79.9, 10, '32C NS 19576 29407'],
  ])('%s', (_name, lat, lon, ref) => {
    expect(toMgrs(lat, lon)).toBe(ref);
  });

  it('10 m and 1 m references share their leading digits', () => {
    expect(toMgrs(QC.lat, QC.lon, 4)).toBe('19T CM 3158 8685');
  });

  it('even zones offset the row letters by five', () => {
    // Same easting/northing, adjacent zones: rows A vs F.
    expect(mgrsSquare(31, 166_021, 0)).toBe('AA');
    expect(mgrsSquare(32, 166_021, 0)).toBe('JF');
    expect(mgrsSquare(33, 166_021, 0)).toBe('SA');
  });

  it('a square outside the zone letters is refused, not invented', () => {
    expect(mgrsSquare(31, 50_000, 0)).toBeNull();
  });
});

describe('zones and bands', () => {
  it.each([
    // Regular 6° zones and their boundaries (west edge belongs to the zone).
    [46.8, -71.2, 19],
    [10, -180, 1],
    [10, 180, 1], // GeographicLib: 180° wraps to −180°, zone 1
    [10, 179.999, 60],
    [10, -174, 2],
    [10, -174.0000001, 1],
    // Norway: 32V spans 3–12°E between 56°N and 64°N.
    [60.39, 5.32, 32], // Bergen
    [60, 2.9, 31],
    [56, 3, 32],
    [55.999, 3, 31],
    [64, 5, 31], // 64°N is band W: no exception
    [60, 12, 33],
    // Svalbard (band X, 72–84°N): only 31, 33, 35, 37, widened.
    [78.22, 15.63, 33], // Longyearbyen
    [75, 8.99, 31],
    [75, 9, 33],
    [75, 21, 35],
    [80, 34, 37],
    [80, 41.99, 37],
    [80, 42, 38],
    [84, 10, 33], // the band's top edge is still band X
    [71.99, 10, 32],
  ])('(%f, %f) → zone %i', (lat, lon, zone) => {
    expect(utmZone(lat, lon)).toBe(zone);
  });

  it.each([
    [-80, 'C'],
    [-72.0001, 'C'],
    [-72, 'D'],
    [-0.0001, 'M'],
    [0, 'N'],
    [46.8, 'T'],
    [71.999, 'W'],
    [72, 'X'],
    [84, 'X'],
  ])('latitude %f is band %s', (lat, band) => {
    expect(latitudeBand(lat)).toBe(band);
  });

  it('outside 80°S–84°N there is no band, no UTM and no MGRS', () => {
    expect(latitudeBand(-80.0001)).toBeNull();
    expect(latitudeBand(84.0001)).toBeNull();
    expect(latitudeBand(Number.NaN)).toBeNull();
    expect(toUtm(85, 0)).toBeNull();
    expect(toMgrs(-85, 0)).toBeNull();
    expect(formatUtm(-85, 0)).toBeNull();
    expect(toUtm(10, Number.NaN)).toBeNull();
  });

  it('projects a point across the antimeridian from its zone', () => {
    // 180°E is zone 1; its easting is west of the 177°W central meridian.
    const a = toUtm(10, 180);
    const b = toUtm(10, -180);
    expect(a?.zone).toBe(1);
    expect(a?.easting).toBeCloseTo(b?.easting ?? NaN, 6);
    expect(a?.easting).toBeLessThan(500_000);
  });
});

describe('wrapLongitude', () => {
  it.each([
    [0, 0],
    [-180, -180],
    [180, -180],
    [190, -170],
    [-190, 170],
    [540, -180],
    [-71.2, -71.2],
  ])('%f → %f', (input, out) => {
    expect(wrapLongitude(input)).toBeCloseTo(out, 9);
  });
});

describe('formatCoordinate', () => {
  it('decimal degrees is exactly the app’s existing lat, lon readout', () => {
    for (const [lat, lon] of [
      [QC.lat, QC.lon],
      [-33.856784, 151.215297],
      [0.5, -0.5],
      [89.999999, 179.999994],
    ] as const) {
      expect(formatCoordinate(lat, lon, 'dd')).toBe(formatLatLng(lat, lon));
    }
  });

  it.each([
    ['dd', '46.813940, -71.207610'],
    ['dms', '46°48′50.18″N, 71°12′27.40″W'],
    ['ddm', '46°48.8364′N, 71°12.4566′W'],
    ['utm', '19T 331586.0 5186854.5'],
    ['mgrs', '19T CM 31586 86854'],
  ] as const)('%s, at about a decimetre (#701)', (fmt, out) => {
    expect(formatCoordinate(QC.lat, QC.lon, fmt)).toBe(out);
  });

  it('carries rounding into the next minute and degree', () => {
    expect(formatCoordinate(59.9999999, 10, 'dms')).toBe('60°00′00.00″N, 10°00′00.00″E');
    expect(formatCoordinate(45.99999999, 10, 'ddm')).toBe('46°00.0000′N, 10°00.0000′E');
  });

  it('never prints a negative zero', () => {
    expect(formatCoordinate(-0.0000001, -0.0000001, 'dd')).toBe('0.000000, 0.000000');
  });

  it('wraps a camera longitude past the antimeridian', () => {
    expect(formatCoordinate(10, 200, 'dd')).toBe('10.000000, -160.000000');
    expect(formatCoordinate(10, -190, 'dms')).toBe('10°00′00.00″N, 170°00′00.00″E');
    expect(formatCoordinate(10, 180, 'utm')).toBe(formatCoordinate(10, -180, 'utm'));
  });

  it('falls back to decimal degrees where UTM and MGRS are undefined (UPS)', () => {
    expect(formatCoordinate(-85, 10, 'mgrs')).toBe('-85.000000, 10.000000');
    expect(formatCoordinate(86, 10, 'utm')).toBe('86.000000, 10.000000');
  });

  it('every format resolves a point to within about 0.3 m (no format is coarser)', () => {
    // Metres per degree of latitude; a degree of longitude is cos(lat) of it.
    const M = 111_320;
    for (const fmt of ['dd', 'dms', 'ddm'] as const) {
      const [la, lo] = formatCoordinate(QC.lat, QC.lon, fmt).split(', ');
      const lat = fmt === 'dd' ? Number(la) : (parseAngle(la ?? '', 'lat')?.value ?? NaN);
      const lon = fmt === 'dd' ? Number(lo) : (parseAngle(lo ?? '', 'lon')?.value ?? NaN);
      expect(Math.abs(lat - QC.lat) * M).toBeLessThan(0.16);
      expect(Math.abs(lon - QC.lon) * M * Math.cos((QC.lat * Math.PI) / 180)).toBeLessThan(0.16);
    }
  });

  it('DD is one string, the same one the clipboard gets (no ± suffix, no short form)', () => {
    const s = formatCoordinate(QC.lat, QC.lon, 'dd');
    expect(s).not.toMatch(/±/);
    expect(s.split(', ').map((p) => p.split('.')[1]?.length)).toEqual([6, 6]);
  });
});

describe('the setting', () => {
  it('defaults to decimal degrees and lists five formats in settings order', () => {
    expect(DEFAULT_COORDINATE_FORMAT).toBe('dd');
    expect(COORDINATE_FORMATS.map((f) => f.value)).toEqual(['dd', 'dms', 'ddm', 'utm', 'mgrs']);
  });

  it('validates persisted values', () => {
    expect(isCoordinateFormat('mgrs')).toBe(true);
    expect(isCoordinateFormat('UTM')).toBe(false);
    expect(isCoordinateFormat(null)).toBe(false);
    expect(isCoordinateFormat(3)).toBe(false);
  });
});
