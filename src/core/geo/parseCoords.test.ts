import { parseLatLng } from './parseCoords';

/** Québec City's Plaines d'Abraham, the fixture the e2e suite also uses. */
const QC = { latitude: 46.8139, longitude: -71.2082 };

const near = (
  got: ReturnType<typeof parseLatLng>,
  want: { latitude: number; longitude: number },
  places = 4,
): void => {
  expect(got).not.toBeNull();
  expect(got?.latitude).toBeCloseTo(want.latitude, places);
  expect(got?.longitude).toBeCloseTo(want.longitude, places);
};

describe('parseLatLng — decimal degrees', () => {
  it('reads the plain signed pair', () => {
    expect(parseLatLng('46.8139, -71.2082')).toEqual(QC);
    expect(parseLatLng('46.8139,-71.2082')).toEqual(QC);
    expect(parseLatLng('  46.8139   -71.2082 ')).toEqual(QC);
    expect(parseLatLng('46.8139; -71.2082')).toEqual(QC);
    expect(parseLatLng('46.8139 / -71.2082')).toEqual(QC);
  });

  it('reads hemisphere suffixes and prefixes', () => {
    near(parseLatLng('46.8139 N, 71.2082 W'), QC);
    near(parseLatLng('46.8139°N 71.2082°W'), QC);
    near(parseLatLng('N 46.8139 W 71.2082'), QC);
    near(parseLatLng('n46.8139 w71.2082'), QC);
  });

  it('lets the hemisphere letters decide the order, not the position', () => {
    near(parseLatLng('W 71.2082 N 46.8139'), QC);
    near(parseLatLng('71.2082 W, 46.8139 N'), QC);
    // Trailing letter on the first, leading letter on the second: still unambiguous.
    near(parseLatLng('46.8139 N W 71.2082'), QC);
  });

  it('accepts an explicit plus and the southern/eastern hemispheres', () => {
    expect(parseLatLng('+46.8139, +71.2082')).toEqual({ latitude: 46.8139, longitude: 71.2082 });
    near(parseLatLng('33.8688 S, 151.2093 E'), { latitude: -33.8688, longitude: 151.2093 });
  });

  it('accepts the extremes and the origin', () => {
    expect(parseLatLng('0,0')).toEqual({ latitude: 0, longitude: 0 });
    expect(parseLatLng('90, 180')).toEqual({ latitude: 90, longitude: 180 });
    expect(parseLatLng('-90, -180')).toEqual({ latitude: -90, longitude: -180 });
  });
});

describe('parseLatLng — degrees decimal minutes', () => {
  it('reads the symbol form', () => {
    near(parseLatLng("46°48.834'N, 71°12.492'W"), QC);
    near(parseLatLng("N 46° 48.834' W 71° 12.492'"), QC);
  });

  it('reads the bare four-number form', () => {
    near(parseLatLng('46 48.834 N 71 12.492 W'), QC);
    near(parseLatLng('46 48.834, -71 12.492'), QC);
    // No letters, no symbols: four numbers can only be a DDM pair.
    near(parseLatLng('46 48.834 -71 12.492'), QC);
  });

  it('applies the sign to the whole coordinate, not just the degrees', () => {
    near(parseLatLng('-71 12.492, 0'), { latitude: -71.2082, longitude: 0 });
  });
});

describe('parseLatLng — degrees minutes seconds', () => {
  it('reads the symbol form', () => {
    near(parseLatLng('46°48\'50.0"N 71°12\'29.5"W'), QC);
    near(parseLatLng('46°48\'50.0"N, 71°12\'29.5"W'), QC);
  });

  it('reads the doubled-apostrophe and typographic-quote seconds', () => {
    near(parseLatLng("46°48'50.0''N 71°12'29.5''W"), QC);
    near(parseLatLng('46°48′50.0″N 71°12′29.5″W'), QC);
  });

  it('reads the bare six-number form', () => {
    near(parseLatLng('46 48 50 N, 71 12 29.5 W'), QC, 3);
    near(parseLatLng('46 48 50 -71 12 29.5'), QC, 3);
  });
});

describe('parseLatLng — rejections', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['hello world', 'prose'],
    ['46.8139', 'one coordinate only'],
    ['46.8139, -71.2082, 120', 'a third value (elevation)'],
    ['46.8139 -71.2082 12.0', 'three bare numbers'],
    ['46 48 50', 'an odd run of numbers'],
    ['46.8139N', 'a lone labelled coordinate'],
    ['91, 0', 'latitude past the pole'],
    ['-90.5, 0', 'latitude past the south pole'],
    ['0, 181', 'longitude past the antimeridian'],
    ['0, -180.001', 'longitude past the antimeridian westward'],
    ["46°60.0'N 71°12'W", 'minutes at 60'],
    ['46°48\'60"N 71°12\'29"W', 'seconds at 60'],
    ["46.5°30'N 71°12'W", 'fractional degrees in front of minutes'],
    ['46°48.5\'30"N 71°12\'29"W', 'fractional minutes in front of seconds'],
    ['-46.8139N, -71.2082W', 'a sign and a hemisphere letter together'],
    ['46.8139 N, 71.2082 S', 'two latitude hemispheres'],
    ['71.2082 W, 46.8139 E', 'two longitude hemispheres'],
    ['46.8139 N, -71.2082', 'a half-labelled pair'],
    ['46,8139 71,2082', 'a European decimal comma'],
    ['46.8139* -71.2082', 'an unknown symbol'],
    ['46. , -71.', 'a trailing decimal point'],
    ['.5, .5', 'a leading decimal point'],
    ["46'48 N 71'12 W", 'a prime before the degrees'],
    ['46 48 N 71 12 W 33', 'trailing junk after the pair'],
    ['46.8139 N S, 71.2082 W', 'two hemispheres on one coordinate'],
    ['N, W', 'hemispheres with no numbers'],
  ])('rejects %p (%s)', (input) => {
    expect(parseLatLng(input)).toBeNull();
  });

  it('rejects non-string input defensively', () => {
    expect(parseLatLng(undefined as unknown as string)).toBeNull();
    expect(parseLatLng(42 as unknown as string)).toBeNull();
  });
});
