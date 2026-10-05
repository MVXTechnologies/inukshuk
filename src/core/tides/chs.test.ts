// SYNTHETIC input shaped like CHS IWLS responses: no CHS data in this repo
// (the app fetches CHS live; owner decision). Every name, id and value is made up.
import fx from './__fixtures__/chs-synthetic.json';
import { buildTideCard } from './card';
import {
  CHS_CGVD2013_NOTE,
  CHS_NOTICE,
  CHS_SOURCE_INDEX,
  chsStation,
  chsText,
  createRateLimiter,
  parseChsHeightTypes,
  parseChsMetadata,
  parseChsStationList,
} from './chs';
import { parseTideStation, type TideStation } from './station';

const M = '−';
const types = parseChsHeightTypes(fx.heightTypes);

function stub(code: string): TideStation {
  const f = parseChsStationList(fx.stations).features.find((x) => x.properties.i === code);
  const s = parseTideStation(f?.properties, f?.geometry.coordinates);
  if (!s) throw new Error(`no ${code}`);
  return s;
}

describe('CHS stations, fetched live by the phone', () => {
  it('turns /stations into tile-schema features (one style, one parser)', () => {
    const fc = parseChsStationList(fx.stations);
    expect(fc.features).toHaveLength(2);
    expect(stub('09901')).toMatchObject({
      name: 'Anse-Fictive',
      source: CHS_SOURCE_INDEX,
      kind: 'gauge',
      live: 'chs',
      cdKind: 'cd-ca',
      iwlsId: 'synth0000000000000000aa',
    });
    // Not operating, predictions only: a reference / prediction station.
    expect(stub('09902')).toMatchObject({ kind: 'ref' });
    expect(parseChsStationList({ nope: 1 }).features).toEqual([]);
    expect(parseChsStationList([{ id: 'x' }, null, 3]).features).toEqual([]);
  });

  it('reads the levels and offsets verbatim, at the stated precision, skipping unknown datums', () => {
    const d = parseChsMetadata(fx.metadata['09901'], types);
    expect(d.levels).toEqual([
      { code: 'HHWLT', text: '5.00' },
      { code: 'MHHW', text: '4.00' },
      { code: 'MWL', text: '2.00' },
      { code: 'MLLW', text: '0.50' },
      { code: 'LLWLT', text: '0.10' },
    ]);
    expect(d.extremes).toEqual([
      { code: 'HOWL', text: '6.00', date: '2020-01-15' },
      { code: 'LOWL', text: '-0.50', date: '2015-02-20' },
    ]);
    expect(d.national).toEqual([
      { datum: 'CGVD2013', text: '-1.50' },
      { datum: 'CGVD28', text: '-1.20' },
      { datum: 'IGLD85', text: '-1.25' },
    ]);
    expect(d.ellipsoid).toBeUndefined(); // no NAD83_CSRS offset: none derived
    expect(d.referencePortId).toBe('synth0000000000000000bb');
    expect(chsText(-0.004, 2)).toBe('0.00');
    expect(chsText(1.5, 3)).toBe('1.500');
  });

  it('reads a published NAD83(CSRS) offset as CHS’s own ellipsoidal CD', () => {
    const withEll = {
      ...fx.metadata['09901'],
      datums: [{ code: 'NAD83_CSRS', offset: -28.5, offsetPrecision: 2 }],
    };
    expect(parseChsMetadata(withEll, types).ellipsoid).toMatchObject({
      text: '-28.50',
      frame: 'NAD83(CSRS)',
      how: 'published',
    });
  });

  it('builds the three-datum card, CHS-labelled, with the reference port and the notice', () => {
    const s = chsStation(stub('09901'), parseChsMetadata(fx.metadata['09901'], types), {
      id: '09902',
      name: 'Port-Exemple',
      detail: parseChsMetadata(fx.metadata['09902'], types),
    });
    const card = buildTideCard(s);
    expect(card.columns.map((c) => c.label)).toEqual(['CD', 'CGVD2013']);
    // H_CGVD2013 = H_CD + CD_in_CGVD2013: 4.00 − 1.50 = 2.50.
    expect(card.rows.find((r) => r.code === 'MHHW')?.cells.map((c) => c?.text)).toEqual([
      '4.00',
      '2.50',
    ]);
    expect(card.rows.at(-1)?.cells.map((c) => c?.text)).toEqual(['0', `${M}1.50`]);
    expect(card.cdBox.values.map((v) => v.copy)).toEqual([
      'CD (CD) = -1.50 m CGVD2013',
      'CD (CD) = -1.20 m CGVD28',
      'CD (CD) = -1.25 m IGLD 1985',
    ]);
    expect(card.cdBox.notes).toContain(CHS_CGVD2013_NOTE);
    expect(card.cdBox.notes).toContain(
      'No ellipsoidal height: CHS publishes no NAD83(CSRS) offset here, and none is derived on the device.',
    );
    expect(card.refPort?.title).toBe(
      'Reference port Port-Exemple (09902) · its own levels above its CD',
    );
    expect(card.refPort?.rows.map((r) => [r.code, r.cell.text])).toEqual([
      ['HAT', '4.80'],
      ['LAT', `${M}0.30`],
    ]);
    expect(card.subtitle).toBe('09901 · CHS');
    expect(card.notice).toBe(CHS_NOTICE);
    expect(card.credit).toBe(
      'Contains data of the Canadian Hydrographic Service (DFO), fetched live from IWLS · Not for navigation',
    );
    expect(card.link.url).toBe('https://www.tides.gc.ca/en/stations/09901');
    expect(card.live).toBe('chs');
  });

  it('keeps to 30 requests/min and 3/s', () => {
    const lim = createRateLimiter(30, 3);
    let t = 0;
    let sent = 0;
    for (let i = 0; i < 100; i++) {
      if (lim.take(t)) sent++;
      t += 100;
    }
    expect(sent).toBe(30);
    expect(lim.take(59_000)).toBe(false);
    expect(lim.waitMs(59_000)).toBeGreaterThan(0);
    expect(lim.take(61_000)).toBe(true);
  });
});
