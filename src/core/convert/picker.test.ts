import type { CdStation } from './graph';
import { coordinateSections, heightSections } from './picker';
import type { ConvertSpec } from './types';

const quebec = { lon: -71.238585, lat: 46.851168 };
const base: ConvertSpec = {
  from: 'csrs:geo',
  fromHeight: 'ell',
  to: 'csrs:mtm7',
  toHeight: 'cgvd2013a',
  epoch: 1997,
};
const ids = (s: ReturnType<typeof coordinateSections>) =>
  s.flatMap((x) => x.items.map((i) => i.id));

describe('coordinate picker', () => {
  it('suggests the Québec systems at Québec City, with only the local zones', () => {
    const s = coordinateSections('to', base, quebec);
    expect(s[0]?.title).toBe('Suggested here · Québec');
    const all = ids(s);
    expect(all).toEqual(
      expect.arrayContaining([
        'csrs:geo',
        'csrs:mtm7',
        'csrs:utm19n',
        'csrs:qclambert',
        'nad27-qc:geo',
      ]),
    );
    expect(all).not.toContain('csrs:mtm3');
    expect(all).not.toContain('nad83-2011:geo'); // no validated route from NAD83(CSRS)
    expect(all).not.toContain('wgs84:geo'); // TRAP 1: hidden, not red
  });

  it('finds other systems by search, never invalid targets', () => {
    expect(ids(coordinateSections('to', base, quebec, 'mtm 8'))).toEqual([]);
    expect(ids(coordinateSections('to', base, quebec, 'MTM zone 8'))).toContain('csrs:mtm8');
    expect(ids(coordinateSections('from', base, quebec, '2949'))).toContain('csrs:mtm7');
    expect(ids(coordinateSections('from', base, quebec, 'lambert-93'))).toContain('rgf93v2b:l93');
  });

  it('offers WGS 84 globally as a source', () => {
    const s = coordinateSections('from', base, { lon: 150, lat: -33 });
    expect(ids(s)).toEqual(expect.arrayContaining(['wgs84:geo', 'wgs84:utm56s']));
  });
});

describe('height picker', () => {
  it('lists the Canadian heights and EGM through ITRF for a CSRS source', () => {
    const s = heightSections('to', base, quebec);
    const all = s.flatMap((x) => x.items.map((i) => i.id));
    expect(all).toEqual(
      expect.arrayContaining(['cgvd2013a', 'cgvd28', 'cgvd2013', 'ell', 'egm96', 'egm2008']),
    );
    expect(all).not.toContain('navd88');
    expect(all).not.toContain('ngf-ign69');
  });

  it('adds a nearby station’s chart datum and its offsets', () => {
    const st: CdStation = {
      key: 'ca-chs:03248',
      name: 'Vieux-Québec (03248)',
      agency: 'CHS',
      country: 'ca',
      lon: -71.2022,
      lat: 46.8121,
      cdName: 'Chart datum',
      offsets: { cgvd2013: -2.34, igld85: -1.99 },
    };
    const s = heightSections(
      'to',
      { ...base, fromHeight: 'ell' },
      { lon: -71.2, lat: 46.81 },
      { stations: [st] },
    );
    const chart = s.find((x) => x.title === 'Chart datum');
    expect(chart?.items.map((i) => i.id)).toEqual(['cd@ca-chs:03248', 'igld85@ca-chs:03248']);
    // …and drops it 30 km away.
    const far = heightSections('to', base, { lon: -71.6, lat: 46.9 }, { stations: [st] });
    expect(far.find((x) => x.title === 'Chart datum')).toBeUndefined();
  });

  it('badges grids by availability', () => {
    const s = heightSections('to', base, quebec, {
      available: (g) => g === 'us_nga_egm96_15.tif',
      gridOf: (id) => ({ egm96: 'us_nga_egm96_15.tif', cgvd2013a: 'ca_nrc_CGG2013an83.tif' })[id],
    });
    const items = s.flatMap((x) => x.items);
    expect(items.find((i) => i.id === 'egm96')?.badge).toBe('bundled');
    expect(items.find((i) => i.id === 'cgvd2013a')?.badge).toBe('needs a grid pack');
  });

  it('lists source heights valid for the source frame', () => {
    const s = heightSections('from', base, quebec);
    const all = s.flatMap((x) => x.items.map((i) => i.id));
    expect(all).toEqual(expect.arrayContaining(['ell', 'cgvd2013a', 'cgvd28']));
    expect(all).not.toContain('odn');
  });
});
