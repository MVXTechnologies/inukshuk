/**
 * Geodetic card → Convert, end to end, on REAL tile features (field report,
 * Android 2.3.0, 2026-10-07: "when I click Convert, every point says there is
 * no usable data Convert can read").
 *
 * The features below are verbatim properties of the live geodetic tiles
 * (z13, fetched 2026-10-07) for several agencies. Each one goes through what
 * the app does: parse the tile feature → prefillFromMark → route params →
 * the URL a deep link / Android intent carries → fromParams → evaluate.
 *
 * Cause of the report: MRNF's open-data layer gives most Québec marks (every
 * levelling benchmark, every mark whose datasheet isn't harvested yet) only as
 * a Québec Lambert grid coordinate, and Convert did not read Québec Lambert.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGeodeticFeature, type GeodeticMark } from '@core/geodetic/record';
import mrnf from './fixtures/mrnf-layer-vs-datasheet.json';
import { parseAngle } from './format';
import { plan } from './graph';
import { liteEngine } from './lite';
import {
  bngSquareOrigin,
  fromParams,
  gridSource,
  prefillFromMark,
  toParams,
  type ConvertRequest,
} from './prefill';
import { evaluate, parseSource } from './session';

/** Live tile properties, 2026-10-07 (geodetic/13/{x}/{y}.mvt?v=2). */
const TILE: Record<string, Record<string, unknown>> = {
  // MRNF, datasheet harvested: published geographic + UTM + MTM.
  M10KM131: {
    i: 'M10KM131',
    s: 0,
    k: '3d',
    y: 46.83069973,
    x: -71.23386884,
    d: 0,
    H: '12.150',
    hd: 0,
    H2: '12.52',
    hd2: 1,
    h: '-15.556',
    gc: '46° 49\' 50.51902" N, 71° 14\' 01.92783" W',
    g1: 'UTM zone 19N;329635.826;5188773.465',
    g2: 'MTM zone 7 (SCOPQ);248814.505;5188168.697',
    m: 'disk',
    v: '2018-04-26',
  },
  // MRNF levelling benchmark: only the open-data layer's Québec Lambert position.
  '84KM654': {
    i: '84KM654',
    s: 0,
    k: 'v',
    y: 46.82080556,
    x: -71.23569444,
    d: 0,
    n: 'VQZ-8352',
    H: '6.49',
    hd: 1,
    g1: 'Québec Lambert (bulk layer, ±2 m);-208379.906;317906.512',
    m: 'disk',
    v: '1996-04-26',
    p: 20,
  },
  '22L610': {
    i: '22L610',
    s: 0,
    k: 'v',
    y: 46.811,
    x: -71.23588889,
    d: 0,
    n: '10QC',
    H: '17.946',
    hd: 0,
    H2: '18.292',
    hd2: 1,
    g1: 'Québec Lambert (bulk layer, ±2 m);-208436.310;316819.530',
    m: 'disk',
    v: '2013-02-25',
    p: 20,
    z: 14,
  },
  // MRNF, Montréal: datasheet not harvested yet — nothing but the layer.
  '26KM097': {
    i: '26KM097',
    s: 0,
    k: 'h',
    y: 45.52223333,
    x: -73.60208833,
    d: 0,
    n: 'BM-772',
    g1: 'Québec Lambert (bulk layer, ±2 m);-398674.583;183846.030',
    p: 20,
  },
  // NOAA NGS: NAD83(1986) levelling benchmark (scaled position), NAVD88.
  DL6619: {
    i: 'DL6619',
    s: 2,
    k: 'v',
    l: 1,
    y: 38.89150556,
    x: -77.03246667,
    d: 4,
    H: '2.958',
    hd: 2,
    gc: '38 53 29.42 (N), 077 01 56.88 (W)',
    p: 50,
  },
  // NOAA NGS: NAD83(2011) 3D mark.
  UA0024: {
    i: 'UA0024',
    s: 2,
    k: '3d',
    y: 38.889804,
    x: -77.03654496,
    d: 3,
    H: '7.022',
    hd: 2,
    h: '-25.066',
    gc: '38 53 23.29439(N), 077 02 11.56187(W)',
    g1: 'SPC MD;396829.496;135774.099',
    g2: 'UTM zone 18;323370.831;4306519.391',
  },
  // Ordnance Survey benchmark: a 10 m square in 100 km square TQ, ODN height.
  TQ30058054: {
    i: 'TQ30058054',
    s: 8,
    k: 'v',
    c: 4,
    l: 1,
    y: 51.50887735,
    x: -0.12733599,
    d: 14,
    H: '14.2564',
    hd: 9,
    g1: 'British National Grid TQ (10 m);3005;8054',
    v: '1970',
    p: 100,
    z: 14,
  },
  // Ordnance Survey trig pillar: full BNG digits.
  TQ47I283: {
    i: 'TQ47I283',
    s: 7,
    k: 'h',
    l: 1,
    y: 51.50070065,
    x: -0.12456852,
    d: 14,
    n: 'Big Ben',
    g1: 'British National Grid;530270.35;179640.66',
  },
  // IGN France levelling benchmarks (one prints 60.0″: the grid is used instead).
  'nivf-495857': {
    i: 'nivf-495857',
    s: 4,
    k: 'v',
    y: 48.86068,
    x: 2.329985,
    d: 12,
    H: '28.919',
    hd: 5,
    gc: "48° 51' 38.4'' N, 2° 19' 47.9'' E",
    g1: 'Lambert-93;650840;6862500',
    p: 50,
  },
  'nivf-495757': {
    i: 'nivf-495757',
    s: 4,
    k: 'v',
    y: 48.84999,
    x: 2.359354,
    d: 12,
    H: '29.997',
    hd: 5,
    gc: "48° 50' 60.0'' N, 2° 21' 33.7'' E",
    g1: 'Lambert-93;652990;6861300',
    p: 50,
  },
  // swisstopo: LV95 + LN02.
  CH0200000BES_33: {
    i: 'CH0200000BES_33',
    s: 5,
    k: 'v',
    y: 46.94375817,
    x: 7.43765035,
    d: 13,
    H: '529.656',
    hd: 7,
    g1: 'LV95;2599925.219;1199185.720',
  },
  // Rijkswaterstaat: RD + NAP.
  '025E0011': {
    i: '025E0011',
    s: 10,
    k: 'v',
    l: 1,
    y: 52.37608613,
    x: 4.90199767,
    d: 22,
    H: '1.412',
    hd: 11,
    g1: 'RD;121960;487690',
    p: 10,
  },
  // Kartverket: EUREF89 geographic, NN2000.
  G35N0002: {
    i: 'G35N0002',
    s: 12,
    k: 'v',
    c: 4,
    y: 59.910982,
    x: 10.750767,
    d: 15,
    H: '2.906',
    hd: 12,
    H2: '2.747',
    hd2: 13,
    gc: '59.910982, 10.750767',
    g1: 'EUREF89 UTM 32;597908.39;6642791.99',
    p: 1000,
  },
};

function markOf(id: string): GeodeticMark {
  const m = parseGeodeticFeature(TILE[id]);
  if (!m) throw new Error(`bad fixture ${id}`);
  return m;
}

/**
 * The trip a request makes from the card to the Convert screen: route params,
 * then the URL (expo-router / an Android intent percent-encode every value),
 * then back.
 */
function throughUrl(req: ConvertRequest): ConvertRequest {
  const url = `inukshuk://convert?${new URLSearchParams(toParams(req)).toString()}`;
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const back = fromParams(params);
  if (!back) throw new Error(`fromParams refused ${url}`);
  return back;
}

/** Lite runs projections only; a grid the plan needs is a device download. */
const ENV = { engine: liteEngine, installed: [] };

describe('every agency’s marks open in Convert with coordinates (no "no usable data")', () => {
  it.each(Object.keys(TILE))('%s', (id) => {
    const mark = markOf(id);
    const req = prefillFromMark(mark);
    expect(req.notice).toBeUndefined();
    expect(req.a).not.toBe('');
    const back = throughUrl(req);
    expect(back.a).toBe(req.a);
    expect(back.b).toBe(req.b);
    expect(back.spec.from).toBe(req.spec.from);
    expect(back.approxPosition).toEqual(req.approxPosition);
    const parsed = parseSource(back);
    if ('errors' in parsed) throw new Error(JSON.stringify(parsed.errors));
    // The parsed source lands on the mark (not in another country).
    const cos = Math.cos((mark.lat * Math.PI) / 180);
    const offM =
      Math.hypot((parsed.point.lon - mark.lng) * cos, parsed.point.lat - mark.lat) * 111_320;
    expect(offM).toBeLessThan(250);
    // A validated plan exists; only a per-area grid download may stand between it and a result.
    const p = plan(
      { ...back.spec, ...(back.epoch ? { epoch: Number(back.epoch) } : {}) },
      parsed.point,
    );
    if (!p.ok) throw new Error(`${id}: ${p.refusal.message}`);
    const ev = evaluate(back, ENV);
    if (ev.status !== 'ok') expect(ev.refusal?.code).toBe('missing-grid');
  });
});

describe('MRNF Québec (the field report)', () => {
  it('reads the open-data layer’s Québec Lambert (EPSG:6622) and says the position is approximate', () => {
    const r = prefillFromMark(markOf('84KM654'));
    expect(r.spec).toEqual({
      from: 'csrs:qclambert',
      fromHeight: 'cgvd28',
      to: 'csrs:mtm7',
      toHeight: 'ell',
    });
    expect([r.a, r.b, r.h, r.epoch]).toEqual(['-208379.906', '317906.512', '6.49', '1997.0']);
    expect(r.approxPosition).toEqual({
      accM: 2,
      why: '84KM654 is a levelling benchmark: its height is precise, its position only approximate',
    });
  });

  it('positions-only conversion: a result, amber, with the approximate-position line instead of "type more decimals"', () => {
    const r = prefillFromMark(markOf('26KM097'));
    expect(r.spec.from).toBe('csrs:qclambert');
    const ev = evaluate(throughUrl(r), ENV);
    expect(ev.status).toBe('ok');
    expect(ev.rows.map((x) => x.key)).toEqual(['e', 'n']);
    expect(ev.panel?.status).toBe('amber');
    const leads = ev.panel?.lines.map((l) => l.lead);
    expect(leads).toContain('Approximate position:');
    expect(leads).not.toContain('Input limits the result:');
    expect(ev.copyAll).toContain('Source position: approximate, ±2.0 m');
  });

  it('is what the E2E flow opens (.maestro/convert.yaml): the card’s exact link', () => {
    const p = toParams(prefillFromMark(markOf('84KM654')));
    const query = Object.entries(p)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const flow = readFileSync(join(__dirname, '../../../.maestro/convert.yaml'), 'utf8');
    expect(flow).toContain(`openLink: 'inukshuk://convert?${query}'`);
  });

  it('heights from a benchmark need only the grid pack, never better coordinates', () => {
    const ev = evaluate(throughUrl(prefillFromMark(markOf('22L610'))), ENV);
    expect(ev.status).toBe('refused');
    expect(ev.refusal?.code).toBe('missing-grid');
    expect(ev.refusal?.message).toMatch(/CGG2013a/);
  });

  it('typing coordinates is the user’s position again (no approximate flag on params without it)', () => {
    const r = prefillFromMark(markOf('26KM097'));
    const { approxPosition: _a, ...typed } = r;
    const ev = evaluate(throughUrl(typed), ENV);
    expect(ev.panel?.lines.map((l) => l.lead)).not.toContain('Approximate position:');
  });

  /*
   * The layer against the agency's own datasheets (fixture: 67 marks, random
   * province-wide + Québec City + Montréal, fetched 2026-10-07). Where the
   * datasheet publishes a NAD83(CSRS) position, the layer converted by
   * Convert matches the datasheet's own MTM / UTM to ≤ 3 cm — so reading it
   * is right. Where it doesn't (levelling benchmarks, marks without CSRS
   * coordinates) the layer is only as good as the datasheet's "position
   * approchée" — so flagging it approximate is right too.
   */
  const LAYER = (m: { id: string; lambert: string[] }): GeodeticMark => ({
    id: m.id,
    source: 0,
    osm: false,
    type: 'h',
    status: 'ok',
    legacy: false,
    lat: 47,
    lng: -71,
    datum: 0,
    heights: [],
    grids: [
      { system: 'Québec Lambert (approximate)', e: m.lambert[0] ?? '', n: m.lambert[1] ?? '' },
    ],
    posAccM: 2,
  });

  const precise = mrnf.marks.filter(
    (m): m is (typeof mrnf.marks)[number] & { grids: { system: string; e: string; n: string }[] } =>
      Array.isArray(m.grids) && m.grids.length > 0,
  );
  it('has a real sample', () => {
    expect(precise.length).toBeGreaterThanOrEqual(30);
    expect(mrnf.marks.filter((m) => m.approx).length).toBeGreaterThanOrEqual(30);
  });

  it.each(precise.map((m) => [m.id, m] as const))(
    '%s: layer → datasheet grids within 3 cm',
    (_id, m) => {
      for (const g of m.grids) {
        const read = gridSource('csrs', g);
        expect(read).not.toBeNull();
        const req = prefillFromMark(LAYER(m));
        const ev = evaluate(
          {
            ...req,
            spec: { ...req.spec, to: read?.system ?? '', toHeight: null, fromHeight: null },
          },
          ENV,
        );
        expect(ev.status).toBe('ok');
        const [e = NaN, n = NaN] = ev.output?.xy ?? [];
        expect(Math.hypot(e - Number(g.e), n - Number(g.n))).toBeLessThan(0.03);
      }
    },
  );

  it.each(mrnf.marks.filter((m) => m.approx).map((m) => [m.id, m] as const))(
    '%s: only an approximate datasheet position, and the layer is that position',
    (_id, m) => {
      const req = prefillFromMark(LAYER(m));
      const ev = evaluate({ ...req, spec: { ...req.spec, to: 'csrs:geo' } }, ENV);
      const [lon = NaN, lat = NaN] = ev.output?.xy ?? [];
      const [aLat, aLon] = (m.approx ?? '').split(', ');
      const la = parseAngle(aLat ?? '', 'lat')?.value ?? NaN;
      const lo = parseAngle(aLon ?? '', 'lon')?.value ?? NaN;
      const dN = (lat - la) * 111_132;
      const dE = (lon - lo) * 111_320 * Math.cos((la * Math.PI) / 180);
      // Within the datasheet's own 0.1″ rounding (≤ 1.6 m) for benchmarks;
      // a few metres for marks whose CSRS position is "non diffusable".
      expect(Math.hypot(dN, dE)).toBeLessThan(m.type === 'Altimétrie' ? 1.6 : 3.5);
    },
  );
});

describe('Ordnance Survey 10 m benchmark refs', () => {
  it('knows the 100 km squares (OS lettering)', () => {
    expect(bngSquareOrigin('SV')).toEqual({ e: 0, n: 0 });
    expect(bngSquareOrigin('TQ')).toEqual({ e: 500000, n: 100000 });
    expect(bngSquareOrigin('TG')).toEqual({ e: 600000, n: 300000 });
    expect(bngSquareOrigin('NN')).toEqual({ e: 200000, n: 700000 });
    expect(bngSquareOrigin('HP')).toEqual({ e: 400000, n: 1200000 });
    expect(bngSquareOrigin('IA')).toBeNull();
    expect(bngSquareOrigin('Q')).toBeNull();
  });

  it('writes TQ 3005 8054 out at its square’s centre, ±7.1 m — not 3005 / 8054 off the Scilly Isles', () => {
    const r = prefillFromMark(markOf('TQ30058054'));
    expect(r.spec).toEqual({
      from: 'osgb36:bng',
      fromHeight: 'odn',
      to: 'etrs89-uk:geo',
      toHeight: 'ell',
    });
    expect([r.a, r.b]).toEqual(['530055', '180545']);
    // The mark's own (tile) accuracy, 10 m, is the worse of the two.
    expect(r.approxPosition?.accM).toBe(10);
  });
});

describe('classical frames: an orthometric height goes to the GNSS-era h, never a refused pair', () => {
  it.each([
    ['DL6619', 'nad83-2011:geo'],
    ['TQ30058054', 'etrs89-uk:geo'],
    ['CH0200000BES_33', 'etrs89-ch:geo'],
    ['025E0011', 'etrs89-nl:geo'],
  ])('%s → %s, h', (id, to) => {
    const r = prefillFromMark(markOf(id));
    expect(r.spec.to).toBe(to);
    expect(r.spec.toHeight).toBe('ell');
  });

  it('a mark whose geographic text is unreadable (60.0″) uses its grid and never converts X → X', () => {
    const r = prefillFromMark(markOf('nivf-495757'));
    expect(r.spec.from).toBe('rgf93v2b:l93');
    expect(r.spec.to).toBe('rgf93v2b:geo');
  });
});
