/**
 * The planner must emit EXACTLY the pipelines that were validated against
 * the agencies' tools (fixtures/reference.json), and refuse everything the
 * study found wrong (TRAPs 1–10).
 */
import reference from './fixtures/reference.json';
import { framePath, plan, type CdStation } from './graph';
import { fillPipeline, type Suite, type SuitePair } from './suite';
import { COORD_SYSTEMS } from './systems';
import type { ConvertSpec, SourcePoint } from './types';

const suite = reference as unknown as Suite;
const pairById = (id: string): SuitePair => {
  const p = suite.pairs.find((x) => x.id === id);
  if (!p) throw new Error(`no pair ${id}`);
  return p;
};

const at = (lon: number, lat: number, xy?: number[]): SourcePoint => ({
  xy: xy ?? [lon, lat],
  lon,
  lat,
});

/** pair → the app conversion that must reproduce its pipeline, at its first point. */
type Case = {
  spec: (pt: { input: (number | null)[]; params?: Record<string, number> }) => ConvertSpec;
  ctx?: { rdFallback?: boolean };
};

const CA_PROJ: Record<string, string> = {
  2947: 'csrs:mtm5',
  2949: 'csrs:mtm7',
  2950: 'csrs:mtm8',
  2952: 'csrs:mtm10',
  2953: 'csrs:nbstereo',
  2954: 'csrs:pestereo',
  2955: 'csrs:utm11n',
  2956: 'csrs:utm12n',
  2958: 'csrs:utm17n',
  2959: 'csrs:utm18n',
  2960: 'csrs:utm19n',
  2961: 'csrs:utm20n',
  3155: 'csrs:utm8n',
  3156: 'csrs:utm9n',
  3157: 'csrs:utm10n',
  3158: 'csrs:utm14n',
  3160: 'csrs:utm16n',
  3761: 'csrs:utm22n',
  6622: 'csrs:qclambert',
  8082: 'csrs:nsmtm4',
  8083: 'csrs:nsmtm5',
  26891: 'csrs:mtm11',
  26896: 'csrs:mtm16',
  26898: 'csrs:mtm1',
};

const ell =
  (from: string, to: string, toHeight: string | null, epoch?: number): Case['spec'] =>
  () => ({
    from,
    fromHeight: 'ell',
    to,
    toHeight,
    ...(epoch !== undefined ? { epoch } : {}),
  });

const CASES: Record<string, Case> = {
  'CA-EPOCH-CSRS-math': {
    spec: (pt) => ({
      from: 'csrs:geo',
      fromHeight: 'ell',
      to: 'csrs:geo',
      toHeight: 'ell',
      epoch: 2010,
      toEpoch: 2010 + (pt.params?.dt ?? 0),
    }),
  },
  'CA-CSRS-ITRF2020-math': {
    spec: (pt) => ({
      from: 'csrs:geo',
      fromHeight: 'ell',
      to: 'itrf2020:geo',
      toHeight: 'ell',
      epoch: 2010,
      toEpoch: pt.input[3] as number,
    }),
  },
  'CA-CSRS-ITRF2014-math': {
    spec: (pt) => ({
      from: 'csrs:geo',
      fromHeight: 'ell',
      to: 'itrf2014:geo',
      toHeight: 'ell',
      epoch: 2010,
      toEpoch: pt.input[3] as number,
    }),
  },
  'CA-CSRS-ITRF2008-math': {
    spec: (pt) => ({
      from: 'csrs:geo',
      fromHeight: 'ell',
      to: 'itrf2008:geo',
      toHeight: 'ell',
      epoch: 2010,
      toEpoch: pt.input[3] as number,
    }),
  },
  'CA-H-CGG2013a': { spec: ell('csrs:geo', 'csrs:geo', 'cgvd2013a', 2010) },
  'CA-H-CGG2013a-1997': { spec: ell('csrs:geo', 'csrs:geo', 'cgvd2013a', 1997) },
  'CA-H-datasheet-CGVD2013': { spec: ell('csrs:geo', 'csrs:geo', 'cgvd2013a', 2010) },
  'CA-H-CGG2013': { spec: ell('csrs:geo', 'csrs:geo', 'cgvd2013', 2010) },
  'CA-H-HT2_1997': { spec: ell('csrs:geo', 'csrs:geo', 'cgvd28', 1997) },
  'CA-H-HT2_2002v70': { spec: ell('csrs:geo', 'csrs:geo', 'cgvd28', 2002) },
  'CA-H-HT2_2010v70': { spec: ell('csrs:geo', 'csrs:geo', 'cgvd28', 2010) },
  'CA-H-datasheet-CGVD28': { spec: ell('csrs:geo', 'csrs:geo', 'cgvd28', 2010) },
  'CA-NTV2-NA27SCRS': {
    spec: () => ({
      from: 'csrs:geo',
      fromHeight: null,
      to: 'nad27-qc:geo',
      toHeight: null,
      epoch: 1997,
    }),
  },
  'CA-NTV2-ON27CSv1': {
    spec: () => ({
      from: 'csrs:geo',
      fromHeight: null,
      to: 'nad27-on:geo',
      toHeight: null,
      epoch: 1997,
    }),
  },
  'CA-NTV2-SK27-98': {
    spec: () => ({
      from: 'csrs:geo',
      fromHeight: null,
      to: 'nad27-sk:geo',
      toHeight: null,
      epoch: 1997,
    }),
  },
  'CA-NTV2-NB2783v2': {
    spec: () => ({
      from: 'csrs:geo',
      fromHeight: null,
      to: 'nad27-nb:geo',
      toHeight: null,
      epoch: 1997,
    }),
  },
  'CA-NTV2-BC_27_05': {
    spec: () => ({
      from: 'csrs:geo',
      fromHeight: null,
      to: 'nad27-bc:geo',
      toHeight: null,
      epoch: 2002,
    }),
  },
  'CA-NTV2-NA83SCRS': {
    spec: () => ({
      from: 'csrs:geo',
      fromHeight: null,
      to: 'nad83-ca:geo',
      toHeight: null,
      epoch: 1997,
    }),
  },
  'CA-NTV2-NTV2': {
    spec: () => ({ from: 'nad83-ca:geo', fromHeight: null, to: 'nad27-ca:geo', toHeight: null }),
  },
  'US-NADCON5-NAD83_2011-to-NAD27': {
    spec: () => ({ from: 'nad83-2011:geo', fromHeight: null, to: 'nad27-us:geo', toHeight: null }),
  },
  'US-NADCON5-NAD83_2011-to-NAD83_1986': {
    spec: () => ({
      from: 'nad83-2011:geo',
      fromHeight: null,
      to: 'nad83-1986-us:geo',
      toHeight: null,
    }),
  },
  'US-NADCON5-NAD27-to-NAD83_2011': {
    spec: () => ({ from: 'nad27-us:geo', fromHeight: null, to: 'nad83-2011:geo', toHeight: null }),
  },
  'US-NADCON5-NAD83_1986-to-NAD83_2011': {
    spec: () => ({
      from: 'nad83-1986-us:geo',
      fromHeight: null,
      to: 'nad83-2011:geo',
      toHeight: null,
    }),
  },
  'US-GEOID18': { spec: ell('nad83-2011:geo', 'nad83-2011:geo', 'navd88') },
  'US-GEOID18-levelled': { spec: ell('nad83-2011:geo', 'nad83-2011:geo', 'navd88') },
  'US-ECEF': { spec: ell('nad83-2011:geo', 'nad83-2011:xyz', null) },
  'GB-OSTN15-OSGM15-fwd': { spec: ell('etrs89-uk:geo', 'osgb36:bng', 'odn') },
  'GB-OSTN15-OSGM15-rev': {
    spec: () => ({ from: 'osgb36:bng', fromHeight: 'odn', to: 'etrs89-uk:geo', toHeight: 'ell' }),
  },
  'GB-OSGM15-Belfast': { spec: ell('etrs89-uk:geo', 'etrs89-uk:geo', 'belfast') },
  'FR-L93': {
    spec: () => ({ from: 'rgf93v2b:geo', fromHeight: null, to: 'rgf93v2b:l93', toHeight: null }),
  },
  'FR-L93-Circe': {
    spec: () => ({ from: 'rgf93v2b:geo', fromHeight: null, to: 'rgf93v2b:l93', toHeight: null }),
  },
  'FR-CC43-Circe': {
    spec: () => ({ from: 'rgf93v2b:geo', fromHeight: null, to: 'rgf93v2b:cc43', toHeight: null }),
  },
  'FR-CC44-Circe': {
    spec: () => ({ from: 'rgf93v2b:geo', fromHeight: null, to: 'rgf93v2b:cc44', toHeight: null }),
  },
  'FR-RAF20': { spec: ell('rgf93v2b:geo', 'rgf93v2b:geo', 'ngf-ign69') },
  'FR-RAF20-Circe': { spec: ell('rgf93v2b:geo', 'rgf93v2b:geo', 'ngf-ign69') },
  'CH-ETRS89-to-LV95': { spec: ell('etrs89-ch:geo', 'ch1903p:lv95', null) },
  'CH-LV95LN02-to-ETRS89': {
    spec: () => ({
      from: 'ch1903p:lv95',
      fromHeight: 'ln02',
      to: 'etrs89-ch:geo',
      toHeight: 'ell',
    }),
  },
  'CH-ETRS89-to-LHN95': { spec: ell('etrs89-ch:geo', 'etrs89-ch:geo', 'lhn95') },
  'NO-NN2000': { spec: ell('euref89-no:geo', 'euref89-no:geo', 'nn2000') },
  'NO-UTM-EPSG25832': {
    spec: () => ({
      from: 'euref89-no:geo',
      fromHeight: null,
      to: 'euref89-no:utm32n',
      toHeight: null,
    }),
  },
  'NO-UTM-EPSG25833': {
    spec: () => ({
      from: 'euref89-no:geo',
      fromHeight: null,
      to: 'euref89-no:utm33n',
      toHeight: null,
    }),
  },
  'NO-UTM-EPSG25835': {
    spec: () => ({
      from: 'euref89-no:geo',
      fromHeight: null,
      to: 'euref89-no:utm35n',
      toHeight: null,
    }),
  },
  'CD-NO-station-vs-grid': {
    spec: () => ({
      from: 'euref89-no:geo',
      fromHeight: 'cd-no',
      to: 'euref89-no:geo',
      toHeight: 'nn2000',
    }),
  },
  'NL-RDNAPTRANS2018-fwd': { spec: ell('etrs89-nl:geo', 'amersfoort:rd', 'nap') },
  'NL-RDNAPTRANS2018-rev': {
    spec: () => ({
      from: 'amersfoort:rd',
      fromHeight: 'nap',
      to: 'etrs89-nl:geo',
      toHeight: 'ell',
    }),
  },
  'NL-RDNAPTRANS2018-RDonly': {
    spec: () => ({ from: 'etrs89-nl:geo', fromHeight: null, to: 'amersfoort:rd', toHeight: null }),
    ctx: { rdFallback: true },
  },
  'CD-NL-NAPLAT-vs-grids': {
    spec: () => ({
      from: 'etrs89-nl:geo',
      fromHeight: 'lat-nl',
      to: 'etrs89-nl:geo',
      toHeight: 'nap',
    }),
  },
  'WGS84-EGM96': { spec: ell('wgs84:geo', 'wgs84:geo', 'egm96') },
  'WGS84-EGM2008': { spec: ell('wgs84:geo', 'wgs84:geo', 'egm2008') },
};
for (const [code, sys] of Object.entries(CA_PROJ)) {
  CASES[`CA-PROJ-EPSG${code}`] = {
    spec: () => ({ from: 'csrs:geo', fromHeight: null, to: sys, toHeight: null, epoch: 2010 }),
  };
}
for (const p of suite.pairs) {
  const m = /^US-(SPC|UTM)-EPSG(\d+)$/.exec(p.id);
  if (!m) continue;
  const code = Number(m[2]);
  const sys = m[1] === 'SPC' ? `nad83-2011:spc${code}` : `nad83-2011:utm${code - 6329}n`;
  CASES[p.id] = {
    spec: () => ({ from: 'nad83-2011:geo', fromHeight: null, to: sys, toHeight: null }),
  };
}

/** The input point of a fixture point, as a SourcePoint. */
function sourcePoint(pair: SuitePair, input: (number | null)[], spec: ConvertSpec): SourcePoint {
  const v = input.map((x) => x ?? 0);
  if (pair.io.input[0] === 'lon_deg') return at(v[0] ?? 0, v[1] ?? 0, v.slice(0, 2));
  // Projected inputs: an approximate position for region / zone checks.
  const approx: Record<string, [number, number]> = {
    'osgb36:bng': [-2, 54],
    'ch1903p:lv95': [7.5, 46.9],
    'amersfoort:rd': [5.4, 52.2],
  };
  const [lon, lat] = approx[spec.from] ?? [0, 0];
  return at(lon, lat, v.slice(0, 2));
}

describe('graph emits the validated pipelines', () => {
  const ids = Object.keys(CASES);
  it.each(ids)('%s', (id) => {
    const pair = pairById(id);
    const c = CASES[id] as Case;
    const pt = pair.points.find((q) => q.status !== 'informational') ?? pair.points[0];
    if (!pt) throw new Error('no point');
    const spec = c.spec(pt);
    const res = plan(spec, sourcePoint(pair, pt.input, spec), c.ctx ?? {});
    if (!res.ok) throw new Error(`${id} refused: ${res.refusal.message}`);
    expect(res.plan.pipeline).toBe(fillPipeline(pair.pipeline as string, pt.params));
    // Every step of the plan is backed by a validation pair.
    expect(res.plan.validation.length).toBeGreaterThan(0);
  });

  it('covers every PROJ-pipeline pair of the suite except the documented ones', () => {
    const notApp = new Set([
      // engine-maths checks of the frozen study, not an app conversion of their own:
      'CA-EPOCH-CSRS-TRXdefault',
      'CA-CSRS-ITRF2020-TRXdefault',
      'CA-CSRS-ITRF2014-TRXdefault',
      'CA-CSRS-ITRF2008-TRXdefault',
      // GN 7-2 worked examples (foreign systems; run by lite.test and the native suite):
      'GN72-LCC2SP',
      'GN72-LCC1SP',
      'GN72-TM',
      'GN72-HotineB',
      'GN72-ObliqueStereo',
      'GN72-Geocentric-inverse',
      'GN72-Helmert-PV',
      'GN72-Helmert-TimeDep-CF',
      'GN72-Helmert-TimeDep-CF-reverse',
      // out-of-zone informational point only:
      'CA-PROJ-EPSG26899',
      // chart datum: data-vs-data checks (station offsets / FR blocked), see stations tests below:
      'CD-CHS-NAD83-vs-CGVD2013+CGG2013a',
      'CD-CHS-NAD83-vs-CGVD28+HT2_2010v70',
      'CD-FR-RAM-vs-RAF20',
    ]);
    const missing = suite.pairs
      .filter((p) => p.pipeline && !CASES[p.id] && !notApp.has(p.id))
      .map((p) => p.id);
    expect(missing).toEqual([]);
  });
});

describe('the TRX-default pairs use the same pipeline as the math pairs', () => {
  it.each(['CA-EPOCH-CSRS', 'CA-CSRS-ITRF2020', 'CA-CSRS-ITRF2014', 'CA-CSRS-ITRF2008'])(
    '%s',
    (p) => {
      expect(pairById(`${p}-TRXdefault`).pipeline).toBe(pairById(`${p}-math`).pipeline);
    },
  );
});

describe('refusals (TRAPs from the validation study)', () => {
  const qc = at(-71.2386, 46.8512);

  it('TRAP 1: NAD83(CSRS) → WGS 84 is not offered (no silent ballpark)', () => {
    const r = plan(
      { from: 'csrs:geo', fromHeight: null, to: 'wgs84:geo', toHeight: null, epoch: 1997 },
      qc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('unvalidated-pair');
  });

  it('TRAP 2: CSRS → CGVD2013 never routes through ITRF2008', () => {
    const r = plan(
      { from: 'csrs:geo', fromHeight: 'ell', to: 'csrs:geo', toHeight: 'cgvd2013a', epoch: 1997 },
      qc,
    );
    if (!r.ok) throw new Error(r.refusal.message);
    expect(r.plan.pipeline).not.toMatch(/helmert/);
    expect(r.plan.gridsNeeded).toEqual(['ca_nrc_CGG2013an83.tif']);
  });

  it('TRAP 3/4: CSRS → NAD27 in Québec uses the QUE27-98 grid at epoch 1997.0, never a Helmert', () => {
    const r = plan(
      { from: 'csrs:geo', fromHeight: null, to: 'nad27-qc:geo', toHeight: null, epoch: 2010 },
      qc,
    );
    if (!r.ok) throw new Error(r.refusal.message);
    expect(r.plan.pipeline).toContain('ca_nrc_NA27SCRS.tif');
    expect(r.plan.pipeline).toContain('+dt=-13 '); // carried to 1997.0 first
    expect(r.plan.pipeline).not.toMatch(/helmert|towgs84/);
  });

  it('TRAP 5: NAD83(1986) → NAD27 with the US grids is refused in Québec City', () => {
    const r = plan(
      { from: 'nad83-1986-us:geo', fromHeight: null, to: 'nad27-us:geo', toHeight: null },
      qc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('outside-region');
  });

  it('TRAP 6: no pipeline ever carries +datum / +towgs84 / +nadgrids', () => {
    for (const sys of COORD_SYSTEMS)
      expect(sys.proj ?? '').not.toMatch(/\+datum|\+towgs84|\+nadgrids/);
  });

  it('TRAP 7: every CSRS epoch step says it uses the v7 velocity model', () => {
    const r = plan(
      {
        from: 'csrs:geo',
        fromHeight: 'ell',
        to: 'csrs:geo',
        toHeight: 'ell',
        epoch: 1997,
        toEpoch: 2010,
      },
      qc,
    );
    if (!r.ok) throw new Error(r.refusal.message);
    const s = r.plan.steps.find((x) => x.grids.some((g) => g.file === 'ca_nrc_NAD83v70VG.tif'));
    expect(s?.note).toMatch(/v7.*TRX uses v8/);
  });

  it('TRAP 8: RD outside the grid uses NSGI’s Helmert with h = 43 m (only on the engine’s request)', () => {
    const spec: ConvertSpec = {
      from: 'etrs89-nl:geo',
      fromHeight: null,
      to: 'amersfoort:rd',
      toHeight: null,
    };
    const inside = plan(spec, at(5.4, 52.2));
    const outside = plan(spec, at(5.4, 52.2), { rdFallback: true });
    if (!inside.ok || !outside.ok) throw new Error('refused');
    expect(inside.plan.pipeline).toContain('rdtrans2018');
    expect(outside.plan.pipeline).toContain('+proj=set +v_3=43');
  });

  it('TRAP 9: EGM2008 from NAD83(CSRS) goes through ITRF2020 (never on a NAD83 height)', () => {
    const r = plan(
      { from: 'csrs:geo', fromHeight: 'ell', to: 'csrs:geo', toHeight: 'egm2008', epoch: 2010 },
      qc,
    );
    if (!r.ok) throw new Error(r.refusal.message);
    const iV = r.plan.pipeline.indexOf('vgridshift');
    const iH = r.plan.pipeline.indexOf('helmert');
    expect(iH).toBeGreaterThan(0);
    expect(iV).toBeGreaterThan(iH);
    expect(r.plan.inDim).toBe(4);
    expect(r.plan.tValue).toBe(2010);
  });

  it('TRAP 10: LV95 without a height is refused', () => {
    const r = plan(
      { from: 'etrs89-ch:geo', fromHeight: null, to: 'ch1903p:lv95', toHeight: null },
      at(7.4, 46.9),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('needs-height');
  });

  it('refuses an MTM zone far from the point (TRX and PROJ diverge by km there)', () => {
    const r = plan(
      { from: 'csrs:geo', fromHeight: null, to: 'csrs:mtm2', toHeight: null, epoch: 2010 },
      at(-61.82, 47.41),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('out-of-zone');
  });

  it('needs an epoch for NAD83(CSRS)', () => {
    const r = plan({ from: 'csrs:geo', fromHeight: null, to: 'csrs:mtm7', toHeight: null }, qc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('needs-epoch');
  });

  it('refuses a CGVD28 source height at an epoch HTv2.0 does not define', () => {
    const r = plan(
      { from: 'csrs:geo', fromHeight: 'cgvd28', to: 'csrs:geo', toHeight: 'ell', epoch: 2026.5 },
      qc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('needs-epoch');
  });

  it('carries a CGVD2013 target at an odd epoch through 2010.0 (CGVD2013a(2010))', () => {
    const r = plan(
      { from: 'csrs:geo', fromHeight: 'ell', to: 'csrs:geo', toHeight: 'cgvd2013a', epoch: 2026.5 },
      qc,
    );
    if (!r.ok) throw new Error(r.refusal.message);
    expect(r.plan.steps.some((s) => s.epsgOp === '10109')).toBe(true);
    // …and back to the requested epoch for the coordinates, keeping the height.
    expect(r.plan.pipeline).toMatch(/push \+v_3.*dt=16\.5 .*pop \+v_3/);
  });

  it('refuses an ellipsoidal height in NAD27', () => {
    const r = plan(
      { from: 'csrs:geo', fromHeight: 'ell', to: 'nad27-qc:geo', toHeight: 'ell', epoch: 1997 },
      qc,
    );
    expect(r.ok).toBe(false);
  });

  it('keeps an orthometric height through a NAD27 shift', () => {
    const r = plan(
      {
        from: 'nad27-qc:geo',
        fromHeight: 'cgvd28',
        to: 'csrs:mtm7',
        toHeight: 'cgvd28',
        epoch: 1997,
      },
      qc,
    );
    if (!r.ok) throw new Error(r.refusal.message);
    expect(r.plan.zOut).toBe('height');
  });
});

describe('chart-datum stations', () => {
  const lauzon: CdStation = {
    key: 'ca-chs:03248',
    name: 'Vieux-Québec',
    agency: 'CHS',
    country: 'ca',
    lon: -71.2022,
    lat: 46.8121,
    cdName: 'Chart datum',
    offsets: { cgvd2013: -2.34, cgvd28: -1.98, igld85: -1.99 },
  };
  const near = at(-71.20222, 46.812056);

  it('CD → CGVD2013 is the station offset only', () => {
    const r = plan(
      {
        from: 'csrs:geo',
        fromHeight: 'cd@ca-chs:03248',
        to: 'same',
        toHeight: 'cgvd2013@ca-chs:03248',
        epoch: 2010,
      },
      near,
      { stations: [lauzon] },
    );
    // cgvd2013 is the hub: it isn't offered as a separate station system.
    expect(r.ok).toBe(false);
    const r2 = plan(
      {
        from: 'csrs:geo',
        fromHeight: 'cd@ca-chs:03248',
        to: 'same',
        toHeight: 'igld85@ca-chs:03248',
        epoch: 2010,
      },
      near,
      { stations: [lauzon] },
    );
    if (!r2.ok) throw new Error(r2.refusal.message);
    expect(r2.plan.pipeline).toContain('+proj=geogoffset +dh=-1.99');
    expect(r2.plan.gridsNeeded).toEqual([]);
  });

  it('CD → ellipsoidal = offset, then CGG2013a at 2010.0 (the validated CHS check)', () => {
    const r = plan(
      { from: 'csrs:geo', fromHeight: 'cd@ca-chs:03248', to: 'same', toHeight: 'ell', epoch: 2010 },
      near,
      { stations: [lauzon] },
    );
    if (!r.ok) throw new Error(r.refusal.message);
    const fixture = pairById('CD-CHS-NAD83-vs-CGVD2013+CGG2013a').pipeline as string;
    // The fixture applies the same forward CGG2013a step (H → h) after the offset.
    const vstep = '+step +proj=vgridshift +grids=ca_nrc_CGG2013an83.tif +multiplier=1';
    expect(fixture).toContain(vstep);
    expect(r.plan.pipeline).toContain(`+step +proj=geogoffset +dh=-2.34 ${vstep}`);
    expect(r.plan.validation).toContain('CD-CHS-NAD83-vs-CGVD2013+CGG2013a');
  });

  it('CD ↔ the station’s own national datum is the offset alone (no geoid round trip)', () => {
    const r = plan(
      {
        from: 'csrs:geo',
        fromHeight: 'cd@ca-chs:03248',
        to: 'same',
        toHeight: 'cgvd2013a',
        epoch: 2010,
      },
      near,
      { stations: [lauzon] },
    );
    if (!r.ok) throw new Error(r.refusal.message);
    expect(r.plan.gridsNeeded).toEqual([]);
    expect(r.plan.pipeline).toContain('+proj=geogoffset +dh=-2.34');
    const back = plan(
      {
        from: 'csrs:geo',
        fromHeight: 'cgvd2013a',
        to: 'same',
        toHeight: 'cd@ca-chs:03248',
        epoch: 2010,
      },
      near,
      { stations: [lauzon] },
    );
    if (!back.ok) throw new Error(back.refusal.message);
    expect(back.plan.pipeline).toContain('+proj=geogoffset +dh=2.34');
  });

  it('refuses beyond 10 km from the gauge', () => {
    const r = plan(
      { from: 'csrs:geo', fromHeight: 'cd@ca-chs:03248', to: 'same', toHeight: 'ell', epoch: 2010 },
      at(-71.5, 46.9),
      { stations: [lauzon] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('cd-too-far');
  });

  it('refuses across the Portneuf ↔ Trois-Rivières break', () => {
    const portneuf: CdStation = {
      ...lauzon,
      key: 'ca-chs:03360',
      name: 'Portneuf',
      lon: -72.21,
      lat: 46.69,
    };
    const r = plan(
      { from: 'csrs:geo', fromHeight: 'cd@ca-chs:03360', to: 'same', toHeight: 'ell', epoch: 2010 },
      at(-72.3, 46.69),
      { stations: [portneuf] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('cd-cross-zone');
  });
});

describe('frame graph', () => {
  it('has no route between countries', () => {
    expect(framePath('csrs', 'nad83-2011')).toBeNull();
    expect(framePath('csrs', 'wgs84')).toBeNull();
    expect(framePath('etrs89-uk', 'rgf93v2b')).toBeNull();
  });
  it('reaches NAD27 (national) from CSRS only through NAD83 original', () => {
    expect(framePath('csrs', 'nad27-ca')).toEqual(['csrs', 'nad83-ca', 'nad27-ca']);
  });
});
