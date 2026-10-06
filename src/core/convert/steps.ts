/**
 * Every PROJ step the Convert engine may emit, each one a copy of a step of
 * a validated pipeline in `fixtures/reference.json`, with its EPSG name and
 * stated accuracy (proj.db EPSG v12.029; the on-device suite re-reads them
 * from the bundled proj.db and fails if they drift).
 *
 * Steps work in the radians domain: geographic lon/lat in radians, z in
 * metres. Nothing here chooses an operation; `graph.ts` decides which step
 * applies and refuses when none does.
 */
import { GRIDS } from './grids';
import type { Ellipsoid, GridRef, Step } from './types';

/** Shortest round-trip decimal, never an exponent (PROJ parses both, tests compare strings). */
export function num(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

const step = (s: Omit<Step, 'gridFree'> & { gridFree?: boolean }): Step => ({
  ...s,
  gridFree: s.gridFree ?? s.grids.length === 0,
});

const EPSG_DB = 'EPSG-stated (proj.db v12.029)';

// ---- conversions (exact) -----------------------------------------------------

export function projectionStep(
  name: string,
  epsg: number | undefined,
  proj: string,
  inverse: boolean,
  validation: readonly string[],
): Step {
  return step({
    name: `${name}${epsg ? ` (EPSG:${epsg})` : ''}`,
    accuracyM: 0,
    accuracySource: 'map projection: exact formulas',
    grids: [],
    proj: [`+step ${inverse ? '+inv ' : ''}${proj}`],
    validation,
  });
}

export function geocentricStep(ellps: Ellipsoid, inverse: boolean): Step {
  return step({
    name: 'Geographic ↔ geocentric (EPSG method 9602)',
    accuracyM: 0,
    accuracySource: 'exact formulas',
    grids: [],
    proj: [`+step ${inverse ? '+inv ' : ''}+proj=cart +ellps=${ellps}`],
    validation: ['US-ECEF', 'GN72-Geocentric-inverse'],
  });
}

// ---- NAD83(CSRS) epochs and ITRF -----------------------------------------------

/** Epochs at which NAD83(CSRS) realisations and the Canadian height grids are defined. */
export const CSRS_REALISATION: Record<number, string> = {
  1997: 'v2/v3',
  2002: 'v4',
  2010: 'v6–v8',
};

function cartWrap(inner: string[], ellps = 'GRS80'): string[] {
  return [`+step +proj=cart +ellps=${ellps}`, ...inner, `+step +inv +proj=cart +ellps=${ellps}`];
}

/** Coordinate epoch t1 → t2 with the NRCan v7 velocity grid (TRAP 7: TRX uses v8). */
export function csrsEpochStep(t1: number, t2: number, keepZ: boolean): Step {
  const dt = t2 - t1;
  const inner = [`+step +proj=deformation +dt=${num(dt)} +grids=${GRIDS.vel7.file} +ellps=GRS80`];
  const proj = cartWrap(inner);
  return step({
    name: `NAD83(CSRS) epoch ${t1.toFixed(1)} → ${t2.toFixed(1)} (velocity grid)`,
    epsgOp: dt < 0 ? '10534' : '10534',
    accuracyM: 0.025,
    accuracySource: `${EPSG_DB}, e.g. NAD83(CSRS)v3 to NAD83(CSRS)v7 (2)`,
    grids: [GRIDS.vel7],
    proj: keepZ ? ['+step +proj=push +v_3', ...proj, '+step +proj=pop +v_3'] : proj,
    validation: ['CA-EPOCH-CSRS-math', 'CA-EPOCH-CSRS-TRXdefault'],
    note: 'Velocity model v7 (NAD83v70VG); NRCan TRX uses v8, not published for PROJ — up to 1 cm at Québec City, 10 cm on the west coast over 15 years',
    epochIn: t1,
    epochOut: t2,
  });
}

interface Helmert14 {
  code: string;
  name: string;
  params: string;
}

/** ITRF → NAD83(CSRS) 14-parameter Helmerts (EPSG), position-vector convention. */
export const ITRF_HELMERT: Record<'itrf2020' | 'itrf2014' | 'itrf2008', Helmert14> = {
  itrf2020: {
    code: '10415',
    name: 'ITRF2020 to NAD83(CSRS)v8 (1)',
    params:
      '+x=1.0039 +y=-1.90961 +z=-0.54117 +rx=-0.02678138 +ry=0.00042027 +rz=-0.01093206 +s=-5.109e-05 +dx=0.00079 +dy=-0.0007 +dz=-0.00124 +drx=-6.667e-05 +dry=0.00075744 +drz=5.133e-05 +ds=-7.201e-05 +t_epoch=2010 +convention=position_vector',
  },
  itrf2014: {
    code: '8265',
    name: 'ITRF2014 to NAD83(CSRS)v7 (1)',
    params:
      '+x=1.0053 +y=-1.90921 +z=-0.54157 +rx=-0.02678138 +ry=0.00042027 +rz=-0.01093206 +s=0.00036891 +dx=0.00079 +dy=-0.0006 +dz=-0.00144 +drx=-6.667e-05 +dry=0.00075744 +drz=5.133e-05 +ds=-7.201e-05 +t_epoch=2010 +convention=position_vector',
  },
  itrf2008: {
    code: '8264',
    name: 'ITRF2008 to NAD83(CSRS)v6 (1)',
    params:
      '+x=0.99343 +y=-1.90331 +z=-0.52655 +rx=-0.02591467 +ry=-0.00942645 +rz=-0.01159935 +s=0.00171504 +dx=0.00079 +dy=-0.0006 +dz=-0.00134 +drx=-6.667e-05 +dry=0.00075744 +drz=5.133e-05 +ds=-0.000102 +t_epoch=1997 +convention=position_vector',
  },
};

/**
 * NAD83(CSRS) at epoch t → ITRF at epoch T, the NRCan TRX convention: the
 * velocity grid carries the point to T, then the Helmert is evaluated at T
 * (the 4th coordinate). PROJ's automatic route skips the velocity grid and
 * differs by 5–6.5 cm (CONVERT §4).
 */
export function csrsToItrfStep(
  frame: keyof typeof ITRF_HELMERT,
  t: number,
  T: number,
  toItrf: boolean,
  keepZ: boolean,
): Step {
  const h = ITRF_HELMERT[frame];
  const deform = `+step +proj=deformation +dt=${num(toItrf ? T - t : t - T)} +grids=${GRIDS.vel7.file} +ellps=GRS80`;
  const helm = `+step ${toItrf ? '+inv ' : ''}+proj=helmert ${h.params}`;
  const inner = toItrf ? [deform, helm] : [helm, deform];
  const proj = cartWrap(inner);
  const label = frame.toUpperCase();
  return step({
    name: toItrf
      ? `NAD83(CSRS) ${t.toFixed(1)} → ${label} @ ${T.toFixed(2)} (inverse of ${h.name}, TRX convention)`
      : `${label} @ ${T.toFixed(2)} → NAD83(CSRS) ${t.toFixed(1)} (${h.name}, TRX convention)`,
    epsgOp: h.code,
    accuracyM: 0.025,
    accuracySource: `${EPSG_DB}: Helmert exact by definition; the velocity grid carries ±0.025 m`,
    grids: [GRIDS.vel7],
    proj: keepZ ? ['+step +proj=push +v_3', ...proj, '+step +proj=pop +v_3'] : proj,
    validation: [`CA-CSRS-${label}-math`, `CA-CSRS-${label}-TRXdefault`],
    note: 'Velocity model v7 (NAD83v70VG); NRCan TRX uses v8 — up to 10 cm on the west coast',
    epochIn: toItrf ? t : T,
    epochOut: toItrf ? T : t,
  });
}

// ---- horizontal grids ------------------------------------------------------------

function hgrid(
  grid: GridRef,
  forward: boolean,
  name: string,
  epsgOp: string | undefined,
  accuracyM: number | null,
  validation: string[],
  note?: string,
): Step {
  return step({
    name,
    ...(epsgOp ? { epsgOp } : {}),
    accuracyM,
    accuracySource: accuracyM === null ? 'not stated in EPSG' : EPSG_DB,
    grids: [grid],
    proj: [`+step ${forward ? '' : '+inv '}+proj=hgridshift +grids=${grid.file}`],
    validation,
    ...(note ? { note } : {}),
  });
}

/** NAD27 ↔ NAD83(CSRS) provincial NTv2 grids; `toNad27` = the validated direction. */
export const NTV2_CA = {
  'nad27-qc': {
    grid: GRIDS.na27scrs,
    epoch: 1997,
    op: '1574',
    name: 'NAD27 to NAD83(CSRS98) (1) [QUE27-98]',
    acc: null,
    pair: 'CA-NTV2-NA27SCRS',
  },
  'nad27-on': {
    grid: GRIDS.on27,
    epoch: 1997,
    op: '9107',
    name: 'NAD27 to NAD83(CSRS)v3 (5) [ON27CSv1]',
    acc: 1.5,
    pair: 'CA-NTV2-ON27CSv1',
  },
  'nad27-sk': {
    grid: GRIDS.sk27,
    epoch: 1997,
    op: '9886',
    name: 'NAD27 to NAD83(CSRS)v2 (2) [SK27-98]',
    acc: 1.5,
    pair: 'CA-NTV2-SK27-98',
  },
  'nad27-nb': {
    grid: GRIDS.nb27,
    epoch: 1997,
    op: '9238',
    name: 'NAD27 to NAD83(CSRS)v2 (4) [NB2783v2]',
    acc: 0.8,
    pair: 'CA-NTV2-NB2783v2',
  },
  'nad27-bc': {
    grid: GRIDS.bc27,
    epoch: 2002,
    op: '9115',
    name: 'NAD27 to NAD83(CSRS)v4 (10) [BC_27_05]',
    acc: 1.5,
    pair: 'CA-NTV2-BC_27_05',
  },
} as const;

export function ntv2CaStep(frame: keyof typeof NTV2_CA, toNad27: boolean): Step {
  const d = NTV2_CA[frame];
  return hgrid(
    d.grid,
    !toNad27,
    toNad27 ? `Inverse of ${d.name}` : d.name,
    d.op,
    d.acc,
    [d.pair],
    'NAD27 itself is only good to about a metre; the grid models it as NRCan published it',
  );
}

export function ntv2NationalStep(toNad27: boolean): Step {
  return hgrid(
    GRIDS.ntv2_0,
    !toNad27,
    toNad27 ? 'Inverse of NAD27 to NAD83 (4) [NTv2.0]' : 'NAD27 to NAD83 (4) [NTv2.0]',
    '1313',
    1.5,
    ['CA-NTV2-NTV2'],
    'National NTv2.0 links NAD27 to the original NAD83, not to NAD83(CSRS)',
  );
}

export function na83scrsStep(toNad83: boolean): Step {
  return hgrid(
    GRIDS.na83scrs,
    !toNad83,
    toNad83
      ? 'Inverse of NAD83 to NAD83(CSRS98) [NA83SCRS, Québec]'
      : 'NAD83 to NAD83(CSRS98) [NA83SCRS, Québec]',
    undefined,
    null,
    ['CA-NTV2-NA83SCRS'],
  );
}

/** NADCON5 CONUS, NAD83(2011) → NAD27 or NAD83(1986) (validated direction = inverse grids). */
export function nadcon5Step(target: 'nad27-us' | 'nad83-1986-us', toOld: boolean): Step {
  const chain = [
    `+inv +proj=gridshift +no_z_transform +grids=${GRIDS.n5_2007_2011.file}`,
    `+inv +proj=gridshift +no_z_transform +grids=${GRIDS.n5_fbn_2007.file}`,
    `+inv +proj=gridshift +no_z_transform +grids=${GRIDS.n5_harn_fbn.file}`,
    `+inv +proj=gridshift +grids=${GRIDS.n5_1986_harn.file}`,
  ];
  const grids: GridRef[] = [
    GRIDS.n5_2007_2011,
    GRIDS.n5_fbn_2007,
    GRIDS.n5_harn_fbn,
    GRIDS.n5_1986_harn,
  ];
  if (target === 'nad27-us') {
    chain.push(`+inv +proj=gridshift +grids=${GRIDS.n5_27_1986.file}`);
    grids.push(GRIDS.n5_27_1986);
  }
  const fwd = chain.map((s) => `+step ${s}`);
  const rev = [...chain].reverse().map((s) => `+step ${s.replace('+inv ', '')}`);
  const nad27 = target === 'nad27-us';
  return step({
    name: nad27 ? 'NAD27 to NAD83(2011) (NADCON5, CONUS)' : 'NAD83 to NAD83(2011) (NADCON5, CONUS)',
    accuracyM: nad27 ? 0.18 : 0.1,
    accuracySource: 'PROJ-registered NADCON5 concatenation (proj.db)',
    grids,
    proj: toOld ? fwd : rev,
    validation: nad27
      ? ['US-NADCON5-NAD83_2011-to-NAD27', 'US-NADCON5-NAD27-to-NAD83_2011']
      : ['US-NADCON5-NAD83_2011-to-NAD83_1986', 'US-NADCON5-NAD83_1986-to-NAD83_2011'],
    note: 'NOAA NCAT agrees in both directions to 0.01 mm (NCAT itself does not round-trip closer than ~3 mm)',
  });
}

export function ostn15Step(toOsgb: boolean): Step {
  return step({
    name: toOsgb ? 'Inverse of OSGB36 to ETRS89 (2) [OSTN15]' : 'OSGB36 to ETRS89 (2) [OSTN15]',
    epsgOp: '7709',
    accuracyM: 0.03,
    accuracySource: EPSG_DB,
    grids: [GRIDS.ostn15],
    proj: [`+step ${toOsgb ? '+inv ' : ''}+proj=hgridshift +grids=${GRIDS.ostn15.file}`],
    validation: ['GB-OSTN15-OSGM15-fwd', 'GB-OSTN15-OSGM15-rev'],
    note: 'PROJ uses the OSTN15 NTv2 file: within 7.8 mm (RMS 2.4 mm) of Ordnance Survey’s definitive method — shown as ±1 cm',
  });
}

export function rdtransStep(toRd: boolean): Step {
  return step({
    name: toRd
      ? 'Inverse of Amersfoort to ETRS89 (9) [RDNAPTRANS2018]'
      : 'Amersfoort to ETRS89 (9) [RDNAPTRANS2018]',
    epsgOp: '9282',
    accuracyM: 0.001,
    accuracySource: 'NSGI RDNAPTRANS2018 (validation service: 100 %)',
    grids: [GRIDS.rdtrans],
    proj: [`+step ${toRd ? '+inv ' : ''}+proj=hgridshift +grids=${GRIDS.rdtrans.file}`],
    validation: ['NL-RDNAPTRANS2018-fwd', 'NL-RDNAPTRANS2018-rev'],
  });
}

/** TRAP 8: outside the rdtrans2018 grid NSGI applies the datum Helmert with h fixed at 43 m. */
export function rdFallbackStep(): Step {
  return step({
    name: 'Amersfoort to ETRS89 (8), inverse — RDNAPTRANS2018 outside its grid (h fixed at 43 m)',
    epsgOp: '9281',
    accuracyM: 0.25,
    accuracySource: EPSG_DB,
    grids: [],
    proj: [
      '+step +proj=push +v_3',
      '+step +proj=set +v_3=43',
      '+step +proj=cart +ellps=GRS80',
      '+step +inv +proj=helmert +x=565.7381 +y=50.4018 +z=465.2904 +rx=0.395025981036064 +ry=-0.330772431242031 +rz=1.87607329462821 +s=4.07244 +convention=coordinate_frame',
      '+step +inv +proj=cart +ellps=bessel',
      '+step +proj=pop +v_3',
    ],
    validation: ['NL-RDNAPTRANS2018-RDonly'],
    note: 'Outside the RDNAPTRANS2018 grid (offshore / abroad): NSGI’s own fallback, validated by the NSGI service',
    flag: 'amber',
  });
}

/** ETRS89 → CH1903+ (needs the real ellipsoidal height, TRAP 10). */
export function chHelmertStep(toCh: boolean, keepZ: boolean): Step {
  const t = '+proj=helmert +x=674.374 +y=15.056 +z=405.346';
  const inner = toCh
    ? ['+step +proj=cart +ellps=GRS80', `+step +inv ${t}`, '+step +inv +proj=cart +ellps=bessel']
    : ['+step +proj=cart +ellps=bessel', `+step ${t}`, '+step +inv +proj=cart +ellps=GRS80'];
  return step({
    name: toCh ? 'Inverse of CH1903+ to ETRS89 (1)' : 'CH1903+ to ETRS89 (1)',
    epsgOp: '1647',
    accuracyM: 0.1,
    accuracySource: EPSG_DB,
    grids: [],
    proj: keepZ ? ['+step +proj=push +v_3', ...inner, '+step +proj=pop +v_3'] : inner,
    validation: ['CH-ETRS89-to-LV95', 'CH-LV95LN02-to-ETRS89'],
    note: 'swisstopo REFRAME agrees to 0.1 mm horizontally',
  });
}

// ---- heights -----------------------------------------------------------------------

export interface VGrid {
  grid: GridRef;
  epsgOp?: string;
  opName: string;
  accuracyM: number | null;
  accuracySource?: string;
  validation: string[];
  note?: string;
  flag?: 'amber';
}

/** h → H (`toHeight`) or H → h, on the grid's frame. */
export function vgridStep(v: VGrid, toHeight: boolean): Step {
  return step({
    name: toHeight ? v.opName : `Inverse of ${v.opName}`,
    ...(v.epsgOp ? { epsgOp: v.epsgOp } : {}),
    accuracyM: v.accuracyM,
    accuracySource: v.accuracySource ?? (v.accuracyM === null ? 'not stated in EPSG' : EPSG_DB),
    grids: [v.grid],
    proj: [`+step ${toHeight ? '+inv ' : ''}+proj=vgridshift +grids=${v.grid.file} +multiplier=1`],
    validation: v.validation,
    ...(v.note ? { note: v.note } : {}),
    ...(v.flag ? { flag: v.flag } : {}),
  });
}

const GPSH_NOTE =
  'NRCan GPS·H differs by 4–8 mm at 3 of 28 steep-gradient marks (undocumented interpolation)';

/** The Canadian height grids by coordinate epoch (EPSG names the epoch in the datum). */
export function canadianVGrid(
  sys: 'cgvd2013a' | 'cgvd2013' | 'cgvd28',
  epoch: 1997 | 2002 | 2010,
): VGrid {
  if (sys === 'cgvd2013a') {
    const op =
      epoch === 1997
        ? { code: '10111', name: 'NAD83(CSRS)v3 to CGVD2013a(1997) height (1)', acc: 0.05 }
        : epoch === 2002
          ? { code: '10110', name: 'NAD83(CSRS)v4 to CGVD2013a(2002) height (1)', acc: 0.05 }
          : { code: '10109', name: 'NAD83(CSRS)v7 to CGVD2013a(2010) height (1)', acc: 0.03 };
    return {
      grid: GRIDS.cgg2013a,
      epsgOp: op.code,
      opName: op.name,
      accuracyM: op.acc,
      validation: ['CA-H-CGG2013a', 'CA-H-CGG2013a-1997', 'CA-H-datasheet-CGVD2013'],
      note: GPSH_NOTE,
    };
  }
  if (sys === 'cgvd2013') {
    return {
      grid: GRIDS.cgg2013,
      epsgOp: '9246',
      opName: 'NAD83(CSRS)v6 to CGVD2013(CGG2013) height (1)',
      accuracyM: 0.03,
      validation: ['CA-H-CGG2013'],
      note: GPSH_NOTE,
    };
  }
  const op =
    epoch === 1997
      ? {
          grid: GRIDS.ht2_1997,
          code: '10609',
          name: 'NAD83(CSRS)v3 to CGVD28(HTv2.0) height (1)',
          acc: null,
          pair: 'CA-H-HT2_1997',
        }
      : epoch === 2002
        ? {
            grid: GRIDS.ht2_2002,
            code: '10610',
            name: 'NAD83(CSRS)v4 to CGVD28(HTv2.0) height (1)',
            acc: 0.02,
            pair: 'CA-H-HT2_2002v70',
          }
        : {
            grid: GRIDS.ht2_2010,
            code: '10612',
            name: 'NAD83(CSRS)v7 to CGVD28(HTv2.0) height (1)',
            acc: 0.03,
            pair: 'CA-H-HT2_2010v70',
          };
  return {
    grid: op.grid,
    epsgOp: op.code,
    opName: op.name,
    // EPSG 10609 states 0 (undefined); NRCan states 5 cm for HTv2.0.
    accuracyM: op.acc ?? 0.05,
    accuracySource: op.acc === null ? 'NRCan (HTv2.0 ±5 cm); EPSG 10609 states none' : EPSG_DB,
    validation: [op.pair, 'CA-H-datasheet-CGVD28'],
    note: `${GPSH_NOTE}; NRCan’s v80 grids are not in PROJ-data (≤ 13 mm)`,
  };
}

export const VGRIDS = {
  navd88: {
    grid: GRIDS.geoid18,
    epsgOp: '9229',
    opName: 'NAD83(2011) to NAVD88 height (3) [GEOID18]',
    accuracyM: 0.015,
    validation: ['US-GEOID18', 'US-GEOID18-levelled'],
  },
  egm96: {
    grid: GRIDS.egm96,
    epsgOp: '10084',
    opName: 'WGS 84 to EGM96 height (1)',
    accuracyM: 1.0,
    validation: ['WGS84-EGM96'],
    note: 'EPSG states the model ±1 m; PROJ’s bilinear grid is within 5.6 cm of NGA’s own spline program',
  },
  egm2008: {
    grid: GRIDS.egm08,
    epsgOp: '3858',
    opName: 'WGS 84 to EGM2008 height (1)',
    accuracyM: 0.113,
    validation: ['WGS84-EGM2008'],
    note: '2.5′ grid: within 1.1 cm of NRCan GPS·H EGM08',
  },
  odn: {
    grid: GRIDS.osgm15,
    epsgOp: '7711',
    opName: 'ETRS89 to ODN height (2) [OSGM15]',
    accuracyM: 0.008,
    validation: ['GB-OSTN15-OSGM15-fwd', 'GB-OSTN15-OSGM15-rev'],
  },
  belfast: {
    grid: GRIDS.osgm15ni,
    epsgOp: '7958',
    opName: 'ETRS89 to Belfast height (2) [OSGM15]',
    accuracyM: 0.014,
    validation: ['GB-OSGM15-Belfast'],
  },
  'ngf-ign69': {
    grid: GRIDS.raf20,
    epsgOp: '9876',
    opName: 'RGF93 v2b to NGF-IGN69 height (5) [RAF20]',
    accuracyM: 0.01,
    validation: ['FR-RAF20', 'FR-RAF20-Circe'],
    note: 'Identical to IGN Circé 5.5.0; Circé states its RAF20 precision as 2–5 cm, and levelled fiche altitudes may differ by up to 12 cm',
  },
  lhn95: {
    grid: GRIDS.chLhn95,
    opName: 'ETRS89 to LHN95 height [CHGeo2004]',
    accuracyM: null,
    validation: ['CH-ETRS89-to-LHN95'],
    note: 'swisstopo REFRAME agrees to 0.2 mm',
  },
  ln02: {
    grid: GRIDS.chLn02,
    opName: 'ETRS89 to LN02 height [CHGeo2004 HTRANS]',
    accuracyM: null,
    validation: ['CH-LV95LN02-to-ETRS89'],
    note: 'One combined swisstopo grid; REFRAME’s chain differs by up to 12 mm at high altitude',
    flag: 'amber',
  },
  nn2000: {
    grid: GRIDS.nn2000,
    epsgOp: '9485',
    opName: 'ETRS89-NOR [EUREF89] to NN2000 height (1) [HREF2018B]',
    accuracyM: 0.02,
    validation: ['NO-NN2000'],
  },
  'cd-no': {
    grid: GRIDS.noCd,
    epsgOp: '10509',
    opName: 'ETRS89-NOR [EUREF89] to CD Norway depth (4)',
    accuracyM: 0.5,
    validation: ['CD-NO-station-vs-grid'],
    note: 'Matches Kartverket’s tide-gauge levels within 3.3 cm at 32 stations',
  },
  nap: {
    grid: GRIDS.nlgeo,
    epsgOp: '9283',
    opName: 'ETRS89 to NAP height (2) [NLGEO2018]',
    accuracyM: 0.001,
    validation: ['NL-RDNAPTRANS2018-fwd', 'NL-RDNAPTRANS2018-rev'],
  },
  'lat-nl': {
    grid: GRIDS.nllat,
    epsgOp: '10350',
    opName: 'ETRS89 to LAT NL depth (1) [NLLAT2018]',
    accuracyM: 0.1,
    validation: ['CD-NL-NAPLAT-vs-grids'],
  },
} as const satisfies Record<string, VGrid>;

/**
 * Every EPSG operation the steps cite with an "EPSG-stated" accuracy, so the
 * on-device suite can re-read name + accuracy from the bundled proj.db and
 * fail if a claim drifts.
 */
export function epsgClaims(): { code: string; name: string; accuracyM: number | null }[] {
  const steps: Step[] = [
    ...(['cgvd2013a', 'cgvd28'] as const).flatMap((s) =>
      ([1997, 2002, 2010] as const).map((e) => vgridStep(canadianVGrid(s, e), true)),
    ),
    vgridStep(canadianVGrid('cgvd2013', 2010), true),
    ...Object.values(VGRIDS).map((v) => vgridStep(v, true)),
    ...(Object.keys(NTV2_CA) as (keyof typeof NTV2_CA)[]).map((f) => ntv2CaStep(f, false)),
    ntv2NationalStep(false),
    ostn15Step(false),
    rdtransStep(false),
    rdFallbackStep(),
    chHelmertStep(false, false),
  ];
  return steps
    .filter((s) => s.epsgOp && s.accuracySource.startsWith('EPSG-stated'))
    .map((s) => ({
      code: s.epsgOp as string,
      name: s.name.replace(/^Inverse of /, '').replace(/ \[.*\]$/, ''),
      accuracyM: s.accuracyM,
    }));
}

/** A chart datum ↔ national height offset published by a tide station (H_X = H_CD + CD_in_X). */
export function stationOffsetStep(
  stationName: string,
  agency: string,
  from: string,
  to: string,
  dh: number,
  validation: string[],
): Step {
  return step({
    name: `${agency} station ${stationName}: ${from} → ${to} (${dh >= 0 ? '+' : '−'}${Math.abs(dh).toFixed(3)} m)`,
    accuracyM: 0.05,
    accuracySource: `${agency} published offsets (2 decimals); validated within 5 cm against geodetic heights`,
    grids: [],
    proj: [`+step +proj=geogoffset +dh=${num(dh)}`],
    validation,
    note: 'A station offset, not a surface: valid near this gauge only',
    flag: 'amber',
    gridFree: false,
  });
}
