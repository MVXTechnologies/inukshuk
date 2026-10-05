import { buildGeodeticCard, displayAccuracyM, formatLatLng, groupDigits } from './card';
import { GEODETIC_CATALOG, OSM_SOURCE_INDEX } from './catalog';
import { parseGeodeticFeature, type GeodeticMark } from './record';
import type { CardLine } from './card';

/** What a line SHOWS (its copy payload is tested on its own). */
const shown = (lines: readonly CardLine[] | undefined) =>
  (lines ?? []).map(({ copy: _c, copyName: _n, ...rest }) => rest);

const src = (key: string) => GEODETIC_CATALOG.sources.findIndex((s) => s.key === key);
const datum = (key: string) => GEODETIC_CATALOG.datums.findIndex((d) => d.key === key);
const vdatum = (name: string) => GEODETIC_CATALOG.vdatums.findIndex((v) => v.name === name);

function mark(props: Record<string, unknown>): GeodeticMark {
  const m = parseGeodeticFeature({ x: -71.20762704, y: 46.81315813, ...props });
  if (!m) throw new Error('bad fixture');
  return m;
}

const SHEET = mark({
  i: 'M15KM007',
  s: src('qc-mrnf'),
  k: '3d',
  d: datum('nad83csrs-qc'),
  H: '51.158',
  hd: vdatum('CGVD2013'),
  H2: '51.54',
  hd2: vdatum('CGVD28'),
  h: '23.393',
  gc: '46° 48\' 47.36926" N, 71° 12\' 27.45735" W',
  g1: 'UTM zone 19N;331582.278;5186767.681',
  g2: 'MTM zone 7 (SCOPQ);250798.875;5186200.480',
  m: 'disk',
  mt: 'Médaillon convexe ancré(e) sur un trottoir de béton',
  v: '2018-04-26',
});

describe('buildGeodeticCard', () => {
  it('shows the published values verbatim, every height with its datum', () => {
    const card = buildGeodeticCard(SHEET);
    expect(card.title).toBe('M15KM007');
    expect(card.subtitle).toBe('MRNF Québec · Réseau géodésique du Québec');
    expect(card.chips.map((c) => c.label)).toEqual(['3D', 'Good condition']);
    const rows = Object.fromEntries(card.rows.map((r) => [r.key, shown(r.lines)]));
    expect(rows.native).toEqual([
      { text: 'NAD83(CSRS) · epoch 1997.0' },
      { text: '46° 48\' 47.36926" N, 71° 12\' 27.45735" W' },
      { text: 'E 331 582.278 · N 5 186 767.681', note: 'UTM zone 19N', muted: true },
      { text: 'E 250 798.875 · N 5 186 200.480', note: 'MTM zone 7 (SCOPQ)', muted: true },
    ]);
    expect(rows.heights).toEqual([
      { text: '51.158 m', note: 'CGVD2013' },
      { text: '51.54 m', note: 'CGVD28', muted: true },
      { text: '23.393 m', note: 'ellipsoidal · NAD83(CSRS) · epoch 1997.0', muted: true },
    ]);
    expect(rows.monument).toEqual([
      { text: 'Médaillon convexe ancré(e) sur un trottoir de béton' },
      { text: 'Last visited 2018-04-26', muted: true },
    ]);
    expect(card.link).toEqual({
      url: 'https://fichegeodesique.mern.gouv.qc.ca/matricule-datum/M15KM007/2',
      label: 'Datasheet',
    });
    expect(card.credit).toBe('© Gouvernement du Québec (MRNF) · CC BY 4.0');
  });

  it('labels the only computed value: the display position', () => {
    const wgs = buildGeodeticCard(SHEET).rows.find((r) => r.key === 'wgs84');
    expect(wgs?.label).toBe('≈ WGS 84');
    expect(shown(wgs?.lines)).toEqual([
      { text: '46.813158° N, 71.207627° W', note: 'display, ±2 m' },
    ]);
  });

  it('copies the published values, labelled', () => {
    const text = buildGeodeticCard(SHEET).copyText;
    expect(text).toContain('MTM zone 7 (SCOPQ): E 250798.875 N 5186200.480');
    expect(text).toContain('H 51.158 m CGVD2013');
    expect(text).toContain('(≈ WGS 84, display ±2 m)');
  });

  it('gives every coordinate and height line its own copy: value plus its label', () => {
    const copies = buildGeodeticCard(SHEET)
      .rows.flatMap((r) => r.lines)
      .flatMap((l) => (l.copy ? [[l.copy, l.copyName]] : []));
    expect(copies).toEqual([
      ['46° 48\' 47.36926" N, 71° 12\' 27.45735" W (NAD83(CSRS) · epoch 1997.0)', 'coordinates'],
      ['UTM zone 19N: E 331582.278 N 5186767.681 (NAD83(CSRS) · epoch 1997.0)', 'UTM zone 19N'],
      [
        'MTM zone 7 (SCOPQ): E 250798.875 N 5186200.480 (NAD83(CSRS) · epoch 1997.0)',
        'MTM zone 7 (SCOPQ)',
      ],
      ['46.813158° N, 71.207627° W (≈ WGS 84, display ±2 m)', 'WGS 84 display position'],
      ['H 51.158 m CGVD2013', 'CGVD2013 height'],
      ['H 51.54 m CGVD28', 'CGVD28 height'],
      ['h 23.393 m ellipsoidal NAD83(CSRS) · epoch 1997.0', 'ellipsoidal height'],
    ]);
    // the datum label and the monument prose have no button
    const datumLine = buildGeodeticCard(SHEET).rows[0]?.lines[0];
    expect(datumLine?.copy).toBeUndefined();
  });

  it('has no empty rows when the mark has nothing but a position (bulk layer)', () => {
    const card = buildGeodeticCard(
      mark({ i: '22298', s: src('qc-mrnf'), k: 'h', d: datum('nad83csrs-qc'), p: 20 }),
    );
    expect(card.rows.map((r) => r.key)).toEqual(['native', 'wgs84']);
    expect(card.rows.every((r) => r.lines.every((l) => l.text !== ''))).toBe(true);
    expect(card.link.label).toBe('Datasheet');
  });

  it('never shows a chart datum as an orthometric height', () => {
    const card = buildGeodeticCard(
      mark({
        i: 'TIDAL1',
        s: src('us-ngs'),
        k: 'v',
        d: datum('nad83-2011'),
        H: '1.234',
        hd: vdatum('Chart datum (local tidal)'),
      }),
    );
    expect(card.rows.find((r) => r.key === 'heights')).toBeUndefined();
    expect(shown(card.rows.find((r) => r.key === 'chart')?.lines)).toEqual([
      { text: '1.234 m', note: 'Chart datum (local tidal)' },
    ]);
  });

  it('flags legacy datums and damaged marks; the ± follows the datum', () => {
    const m = mark({ i: 'OLD', s: src('us-ngs'), k: 'h', d: datum('nad27'), l: 1, c: 1 });
    const card = buildGeodeticCard(m);
    expect(card.chips.map((c) => c.label)).toEqual(['Horizontal', 'Damaged', 'Legacy datum']);
    expect(displayAccuracyM(m)).toBe(100);
  });

  it('OSM: no status chip, elevation without a datum, the node page as link', () => {
    const card = buildGeodeticCard(
      mark({ i: '4242', s: OSM_SOURCE_INDEX, k: 'u', H: '312', n: 'Repère 12' }),
    );
    expect(card.chips.map((c) => c.label)).toEqual(['Survey point']);
    expect(shown(card.rows.find((r) => r.key === 'elevation')?.lines)).toEqual([
      { text: '312 m', note: 'datum not stated' },
    ]);
    expect(card.link).toEqual({
      url: 'https://www.openstreetmap.org/node/4242',
      label: 'OpenStreetMap',
    });
    expect(card.credit).toBe('© OpenStreetMap contributors');
  });

  it("links to the agency's page when it has no per-mark datasheet", () => {
    const card = buildGeodeticCard(mark({ i: 'TP0001', s: src('uk-os-trig'), d: datum('osgb36') }));
    expect(card.link.label).toBe('Agency page');
    expect(card.link.url).toMatch(/^https:\/\//);
  });

  it('formats digits without changing them', () => {
    expect(groupDigits('5186200.480')).toBe('5 186 200.480');
    expect(groupDigits('163000.')).toBe('163 000.');
    expect(groupDigits('-123.4')).toBe('-123.4');
    expect(groupDigits('n/a')).toBe('n/a');
    expect(formatLatLng(-33.5, 151.25)).toBe('33.500000° S, 151.250000° E');
  });
});
