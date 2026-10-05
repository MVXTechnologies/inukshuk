import { GEODETIC_CATALOG } from '@core/geodetic/catalog';
import { liteEngine } from './lite';
import { prefillFromMark, prefillFromTideStation, type ConvertRequest } from './prefill';
import type { Engine, EngineRequest } from './run';
import { evaluate, gridPaths, heightLabel, parseSource } from './session';

const di = (key: string) => GEODETIC_CATALOG.datums.findIndex((d) => d.key === key);
const vi = (name: string) => GEODETIC_CATALOG.vdatums.findIndex((v) => v.name === name);

const mark = {
  id: '81KM003',
  source: 0,
  osm: false,
  type: '3d' as const,
  status: 'ok' as const,
  legacy: false,
  lat: 46.851168,
  lng: -71.238585,
  datum: di('nad83csrs-qc'),
  heights: [{ text: '24.488', vdatum: vi('CGVD2013') }],
  hEll: '-3.127',
  geo: '46° 51\' 04.2048" N, 71° 14\' 18.9060" W',
  grids: [{ system: 'MTM zone 7 (SCOPQ)', e: '248476.150', n: '5190447.200' }],
};

/** A native stand-in: runs grid-free steps with lite and adds a fixed N for vgridshift. */
function fakeNative(N = -27.6): Engine & { calls: EngineRequest[] } {
  const calls: EngineRequest[] = [];
  return {
    kind: 'native',
    calls,
    transform(req) {
      calls.push(req);
      const stripped = req.pipeline
        .replace(
          / \+step \+inv \+proj=vgridshift \+grids=\S+ \+multiplier=1/g,
          ' +step +proj=unitconvert +xy_in=rad +xy_out=deg +step +proj=unitconvert +xy_in=deg +xy_out=rad',
        )
        .replace(
          / \+step \+proj=vgridshift \+grids=\S+ \+multiplier=1/g,
          ' +step +proj=unitconvert +xy_in=rad +xy_out=deg +step +proj=unitconvert +xy_in=deg +xy_out=rad',
        )
        .replace(/ \+step \+proj=geogoffset \+dh=\S+/g, '');
      const r = liteEngine.transform({ ...req, pipeline: stripped });
      if (!r.ok) return r;
      const inv = (req.pipeline.match(/\+inv \+proj=vgridshift/g) ?? []).length;
      const fwd = (req.pipeline.match(/\+step \+proj=vgridshift/g) ?? []).length;
      const dh = [...req.pipeline.matchAll(/geogoffset \+dh=(\S+)/g)].reduce(
        (a, m) => a + Number(m[1]),
        0,
      );
      const c = [...r.coords];
      if (req.dim >= 3) c[2] = (c[2] ?? 0) - inv * N + fwd * N + dh;
      return { ok: true, coords: c };
    },
  };
}

const allGrids = (dir = '/grids') => [
  {
    pack: 'ca-qc',
    name: 'ca_nrc_CGG2013an83.tif',
    path: `${dir}/ca_nrc_CGG2013an83.tif`,
    crop: [-80, 44, -57, 63] as const,
  },
];

describe('parseSource', () => {
  it('reads geographic, projected and refuses junk', () => {
    const r = prefillFromMark(mark);
    const p = parseSource(r);
    if ('errors' in p) throw new Error();
    expect(p.point.lat).toBeCloseTo(46.851168, 6);
    expect(p.point.h).toBe(-3.127);
    expect(p.precisionM).toBeCloseTo(0.0031, 3);
    const proj = parseSource({
      ...r,
      spec: { ...r.spec, from: 'csrs:mtm7' },
      a: '248476.150',
      b: '5190447.200',
    });
    if ('errors' in proj) throw new Error();
    expect(proj.point.lon).toBeCloseTo(-71.2386, 3);
    expect(parseSource({ ...r, a: 'abc', b: '' })).toEqual({
      errors: { a: 'Not a latitude', b: 'Not a longitude' },
    });
    expect(parseSource({ ...r, h: '' })).toEqual({ errors: { h: 'Enter the height' } });
  });
});

describe('evaluate', () => {
  it('81KM003 → MTM 7 + CGVD2013a(1997) with the published height beside it (mockup 08)', () => {
    const req = prefillFromMark(mark);
    const ev = evaluate(req, { engine: fakeNative(-27.615), installed: allGrids() });
    expect(ev.status).toBe('ok');
    expect(ev.rows.map((r) => r.key)).toEqual(['e', 'n', 'h']);
    expect(ev.rows[0]?.value).toMatch(/^248 476\.\d{3} m$/);
    expect(ev.rows[2]?.note).toBe('CGVD2013a(1997) · published 24.488');
    expect(ev.rows[2]?.value).toBe('24.488 m');
    expect(ev.panel?.status).toBe('green');
    expect(ev.copyAll).toMatch(/From mark 81KM003/);
    expect(ev.copyAll).toMatch(/Op: NAD83\(CSRS\)v3 to CGVD2013a\(1997\) height \(1\)/);
    expect(ev.copyAll).toMatch(/not for navigation/);
  });

  it('refuses with the missing grid named when no pack covers the point', () => {
    const ev = evaluate(prefillFromMark(mark), { engine: fakeNative(), installed: [] });
    expect(ev.status).toBe('refused');
    expect(ev.refusal).toMatchObject({ code: 'missing-grid', grids: ['ca_nrc_CGG2013an83.tif'] });
    expect(ev.panel?.status).toBe('red');
  });

  it('lite runs grid-free plans and refuses the rest with "update the app"', () => {
    const req: ConvertRequest = {
      ...prefillFromMark(mark),
      spec: { from: 'csrs:geo', fromHeight: null, to: 'csrs:mtm7', toHeight: null },
    };
    const ok = evaluate(req, { engine: liteEngine, installed: [] });
    expect(ok.status).toBe('ok');
    const grid = evaluate(prefillFromMark(mark), { engine: liteEngine, installed: allGrids() });
    expect(grid.refusal?.code).toBe('lite-unsupported');
  });

  it('chart datum → CGVD2013, plus the ellipsoidal height (mockup 09)', () => {
    const st = {
      id: '03248',
      name: 'Vieux-Québec',
      lat: 46.8121,
      lng: -71.2022,
      agency: 'CHS',
      country: 'ca',
      national: [{ datum: 'CGVD2013', text: '-2.34' }],
    };
    const req = prefillFromTideStation(st, {
      heightAboveCd: '8.422',
      benchmark: { id: '19L760B', lat: 46.812056, lng: -71.20222 },
    });
    const ev = evaluate(req, { engine: fakeNative(-27.77), installed: allGrids() });
    expect(ev.status).toBe('ok');
    expect(ev.rows.map((r) => [r.key, r.value])).toEqual([
      ['h', '6.082 m'],
      ['h2', '−21.688 m'],
    ]);
    expect(ev.panel?.status).toBe('amber'); // a station offset, not a surface
  });

  it('reports epoch problems and empty input', () => {
    const req = prefillFromMark(mark);
    expect(evaluate({ ...req, a: '', b: '' }, { engine: liteEngine, installed: [] }).status).toBe(
      'empty',
    );
    expect(
      evaluate({ ...req, epoch: '97' }, { engine: liteEngine, installed: [] }).inputErrors,
    ).toEqual({ epoch: 'A decimal year, e.g. 1997.0' });
    const needs = evaluate({ ...req, epoch: '' }, { engine: fakeNative(), installed: allGrids() });
    expect(needs.refusal?.code).toBe('needs-epoch');
  });

  it('uses the crop that covers the point, and bundled grids by name', () => {
    const r = evaluate(prefillFromMark(mark), {
      engine: fakeNative(),
      installed: allGrids('/abs'),
    });
    if (!r.plan || !r.sourcePoint) throw new Error();
    expect(
      gridPaths(r.plan, r.sourcePoint, { engine: liteEngine, installed: allGrids('/abs') }).paths,
    ).toEqual({ 'ca_nrc_CGG2013an83.tif': '/abs/ca_nrc_CGG2013an83.tif' });
    expect(heightLabel(r.plan, {})).toBe('CGVD2013a(1997)');
  });
});
