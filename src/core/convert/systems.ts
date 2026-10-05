/**
 * The Convert catalogue: frames, coordinate systems and height systems —
 * ONLY those whose operations were validated against the defining agency's
 * own tool (`fixtures/reference.json`, CONVERT.md §5). A system missing here
 * is hidden from the picker on purpose (owner decision Q11a); see
 * `HIDDEN_SYSTEMS` for what and why.
 *
 * Projections are written with `+ellps` (never `+datum`, TRAP 6) and are the
 * exact strings of the validated pipelines. Zones of a family (UTM, MTM)
 * that the agency tool did not hit individually share the validated method
 * and differ only in EPSG parameters; the on-device suite checks each such
 * zone against proj.db's own definition (`familyChecks`).
 */
import { BOX } from './regions';
import type { CoordSystem, Frame, FrameId, HeightSystem } from './types';

export const FRAMES: Record<FrameId, Frame> = {
  csrs: {
    id: 'csrs',
    name: 'NAD83(CSRS)',
    note: 'Canada · needs a coordinate epoch',
    ellps: 'GRS80',
    dynamic: true,
    epsg: 4617,
    region: BOX.canada,
  },
  'nad83-ca': {
    id: 'nad83-ca',
    name: 'NAD83 (original)',
    note: 'Canada, pre-CSRS · ↔ NAD27 (NTv2.0); ↔ NAD83(CSRS) in Québec (NA83SCRS)',
    ellps: 'GRS80',
    dynamic: false,
    epsg: 4269,
    region: BOX.canada,
  },
  'nad27-qc': {
    id: 'nad27-qc',
    name: 'NAD27 · Québec',
    note: 'QUE27-98 grid (NA27SCRS) ↔ NAD83(CSRS) 1997.0',
    ellps: 'clrk66',
    dynamic: false,
    epsg: 4267,
    region: BOX.qc,
  },
  'nad27-on': {
    id: 'nad27-on',
    name: 'NAD27 · Ontario',
    note: 'ON27CSv1 grid ↔ NAD83(CSRS) 1997.0',
    ellps: 'clrk66',
    dynamic: false,
    epsg: 4267,
    region: BOX.on,
  },
  'nad27-sk': {
    id: 'nad27-sk',
    name: 'NAD27 · Saskatchewan',
    note: 'SK27-98 grid ↔ NAD83(CSRS) 1997.0',
    ellps: 'clrk66',
    dynamic: false,
    epsg: 4267,
    region: BOX.sk,
  },
  'nad27-nb': {
    id: 'nad27-nb',
    name: 'NAD27 · New Brunswick',
    note: 'NB2783v2 grid ↔ NAD83(CSRS) 1997.0',
    ellps: 'clrk66',
    dynamic: false,
    epsg: 4267,
    region: BOX.nb,
  },
  'nad27-bc': {
    id: 'nad27-bc',
    name: 'NAD27 · British Columbia',
    note: 'BC_27_05 grid ↔ NAD83(CSRS) 2002.0',
    ellps: 'clrk66',
    dynamic: false,
    epsg: 4267,
    region: BOX.bc,
  },
  'nad27-ca': {
    id: 'nad27-ca',
    name: 'NAD27 · Canada (national)',
    note: 'NTv2.0 ↔ NAD83 original',
    ellps: 'clrk66',
    dynamic: false,
    epsg: 4267,
    region: BOX.canada,
  },
  itrf2020: {
    id: 'itrf2020',
    name: 'ITRF2020',
    note: 'Global · at a coordinate epoch (Canada: via NAD83(CSRS))',
    ellps: 'GRS80',
    dynamic: true,
    epsg: 9989,
    region: BOX.canada,
  },
  itrf2014: {
    id: 'itrf2014',
    name: 'ITRF2014',
    note: 'Global · at a coordinate epoch (Canada: via NAD83(CSRS))',
    ellps: 'GRS80',
    dynamic: true,
    epsg: 7912,
    region: BOX.canada,
  },
  itrf2008: {
    id: 'itrf2008',
    name: 'ITRF2008',
    note: 'Global · at a coordinate epoch (Canada: via NAD83(CSRS))',
    ellps: 'GRS80',
    dynamic: true,
    epsg: 5332,
    region: BOX.canada,
  },
  wgs84: {
    id: 'wgs84',
    name: 'WGS 84',
    note: 'GPS · formats, UTM, ECEF and EGM96/EGM2008 heights',
    ellps: 'WGS84',
    dynamic: false,
    epsg: 4326,
    region: BOX.world,
  },
  'nad83-2011': {
    id: 'nad83-2011',
    name: 'NAD83(2011)',
    note: 'United States · epoch 2010.0',
    ellps: 'GRS80',
    dynamic: false,
    epsg: 6318,
    region: 'conus',
    fixedEpoch: 2010,
  },
  'nad83-1986-us': {
    id: 'nad83-1986-us',
    name: 'NAD83(1986) · US',
    note: 'NADCON5 CONUS ↔ NAD83(2011)',
    ellps: 'GRS80',
    dynamic: false,
    epsg: 4269,
    region: 'conus',
  },
  'nad27-us': {
    id: 'nad27-us',
    name: 'NAD27 · US',
    note: 'NADCON5 CONUS ↔ NAD83(2011)',
    ellps: 'clrk66',
    dynamic: false,
    epsg: 4267,
    region: 'conus',
  },
  rgf93v2b: {
    id: 'rgf93v2b',
    name: 'RGF93 v2b',
    note: 'France (ETRS89)',
    ellps: 'GRS80',
    dynamic: false,
    epsg: 9777,
    region: BOX.france,
  },
  'etrs89-uk': {
    id: 'etrs89-uk',
    name: 'ETRS89 · UK',
    note: 'Great Britain and Northern Ireland',
    ellps: 'GRS80',
    dynamic: false,
    epsg: 4258,
    region: BOX.uk,
  },
  osgb36: {
    id: 'osgb36',
    name: 'OSGB36',
    note: 'Great Britain · from ETRS89 by OSTN15',
    ellps: 'airy',
    dynamic: false,
    epsg: 4277,
    region: BOX.gb,
  },
  'etrs89-ch': {
    id: 'etrs89-ch',
    name: 'ETRS89 · Switzerland',
    note: 'CHTRS95',
    ellps: 'GRS80',
    dynamic: false,
    epsg: 4258,
    region: BOX.switzerland,
  },
  ch1903p: {
    id: 'ch1903p',
    name: 'CH1903+',
    note: 'Switzerland · LV95',
    ellps: 'bessel',
    dynamic: false,
    epsg: 4150,
    region: BOX.switzerland,
  },
  'euref89-no': {
    id: 'euref89-no',
    name: 'EUREF89',
    note: 'Norway (ETRS89)',
    ellps: 'GRS80',
    dynamic: false,
    epsg: 4258,
    region: BOX.norway,
  },
  'etrs89-nl': {
    id: 'etrs89-nl',
    name: 'ETRS89 · Netherlands',
    note: 'RDNAPTRANS2018',
    ellps: 'GRS80',
    dynamic: false,
    epsg: 4258,
    region: BOX.rdFallback,
  },
  amersfoort: {
    id: 'amersfoort',
    name: 'Amersfoort (RD)',
    note: 'Netherlands · from ETRS89 by RDNAPTRANS2018',
    ellps: 'bessel',
    dynamic: false,
    epsg: 4289,
    region: BOX.rdFallback,
  },
};

const tm = (lon0: number, k: number, x0: number) =>
  `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=${k} +x_0=${x0} +y_0=0 +ellps=GRS80 +units=m`;

const geo = (frame: FrameId, validation: string[], validatedBy: string): CoordSystem => ({
  id: `${frame}:geo`,
  frame,
  kind: 'geographic',
  name: 'geographic',
  ...(FRAMES[frame].epsg !== undefined ? { epsg: FRAMES[frame].epsg } : {}),
  validation,
  validatedBy,
});

const xyz = (frame: FrameId): CoordSystem => ({
  id: `${frame}:xyz`,
  frame,
  kind: 'geocentric',
  name: 'geocentric XYZ (ECEF)',
  validation: ['US-ECEF', 'GN72-Geocentric-inverse'],
  validatedBy: 'NGS datasheets (17 marks) + IOGP GN 7-2',
});

// ---- UTM ---------------------------------------------------------------------

const CSRS_UTM_VALIDATED: Record<number, string> = {
  8: 'CA-PROJ-EPSG3155',
  9: 'CA-PROJ-EPSG3156',
  10: 'CA-PROJ-EPSG3157',
  11: 'CA-PROJ-EPSG2955',
  12: 'CA-PROJ-EPSG2956',
  14: 'CA-PROJ-EPSG3158',
  16: 'CA-PROJ-EPSG3160',
  17: 'CA-PROJ-EPSG2958',
  18: 'CA-PROJ-EPSG2959',
  19: 'CA-PROJ-EPSG2960',
  20: 'CA-PROJ-EPSG2961',
  22: 'CA-PROJ-EPSG3761',
};
const CSRS_UTM_EPSG: Record<number, number> = {
  7: 3154,
  8: 3155,
  9: 3156,
  10: 3157,
  11: 2955,
  12: 2956,
  13: 2957,
  14: 3158,
  15: 3159,
  16: 3160,
  17: 2958,
  18: 2959,
  19: 2960,
  20: 2961,
  21: 2962,
  22: 3761,
  23: 9709,
  24: 9713,
};
const US_UTM_VALIDATED: Record<number, string> = {
  10: 'US-UTM-EPSG6339',
  11: 'US-UTM-EPSG6340',
  12: 'US-UTM-EPSG6341',
  13: 'US-UTM-EPSG6342',
  14: 'US-UTM-EPSG6343',
  15: 'US-UTM-EPSG6344',
  16: 'US-UTM-EPSG6345',
  17: 'US-UTM-EPSG6346',
  18: 'US-UTM-EPSG6347',
  19: 'US-UTM-EPSG6348',
};
const NO_UTM_VALIDATED: Record<number, string> = {
  32: 'NO-UTM-EPSG25832',
  33: 'NO-UTM-EPSG25833',
  35: 'NO-UTM-EPSG25835',
};
/** Every UTM zone is the same validated method; these pairs prove it. */
const UTM_FAMILY = ['CA-PROJ-EPSG2959', 'US-UTM-EPSG6347', 'NO-UTM-EPSG25832'];

/**
 * Allowed distance from a zone's central meridian. The agency tools agree
 * with PROJ to the millimetre up to 3.96° (Kartverket UTM 33 at Tromsø, NRCan
 * TRX MTM 5 at 3.91°) and diverge by km at 5.8°: we allow 4.0° and refuse
 * beyond, for UTM and MTM alike.
 */
export const UTM_MAX_DLON = 4.0;
export const MTM_MAX_DLON = 4.0;

function utm(
  frame: FrameId,
  zone: number,
  south: boolean,
  epsg: number | undefined,
  pair: string | undefined,
): CoordSystem {
  const ellps = FRAMES[frame].ellps;
  return {
    id: `${frame}:utm${zone}${south ? 's' : 'n'}`,
    frame,
    kind: 'projected',
    name: `UTM zone ${zone}${south ? 'S' : 'N'}`,
    ...(epsg !== undefined ? { epsg } : {}),
    proj: `+proj=utm +zone=${zone}${south ? ' +south' : ''} +ellps=${ellps} +units=m`,
    domain: { lon0: -183 + 6 * zone, maxDLon: UTM_MAX_DLON },
    validation: pair ? [pair] : UTM_FAMILY,
    validatedBy: pair
      ? 'agency tool (NRCan TRX / NGS / Kartverket)'
      : 'UTM family: validated zones by NRCan TRX, NGS and Kartverket; this zone checked against proj.db on device',
  };
}

// ---- MTM (NAD83(CSRS)) --------------------------------------------------------

const MTM_LON0: Record<number, number> = {
  1: -53,
  2: -56,
  3: -58.5,
  4: -61.5,
  5: -64.5,
  6: -67.5,
  7: -70.5,
  8: -73.5,
  9: -76.5,
  10: -79.5,
  11: -82.5,
  12: -81,
  13: -84,
  14: -87,
  15: -90,
  16: -93,
  17: -96,
};
const MTM_EPSG: Record<number, number> = {
  1: 26898,
  2: 26899,
  3: 2945,
  4: 2946,
  5: 2947,
  6: 2948,
  7: 2949,
  8: 2950,
  9: 2951,
  10: 2952,
  11: 26891,
  12: 26892,
  13: 26893,
  14: 26894,
  15: 26895,
  16: 26896,
  17: 26897,
};
const MTM_VALIDATED: Record<number, string> = {
  1: 'CA-PROJ-EPSG26898',
  5: 'CA-PROJ-EPSG2947',
  7: 'CA-PROJ-EPSG2949',
  8: 'CA-PROJ-EPSG2950',
  10: 'CA-PROJ-EPSG2952',
  11: 'CA-PROJ-EPSG26891',
  16: 'CA-PROJ-EPSG26896',
};
const MTM_FAMILY = ['CA-PROJ-EPSG2949', 'CA-PROJ-EPSG2952', 'CA-PROJ-EPSG26898'];

function mtm(zone: number): CoordSystem {
  const lon0 = MTM_LON0[zone] ?? 0;
  const pair = MTM_VALIDATED[zone];
  const epsg = MTM_EPSG[zone];
  return {
    id: `csrs:mtm${zone}`,
    frame: 'csrs',
    kind: 'projected',
    name: `MTM zone ${zone}`,
    ...(epsg !== undefined ? { epsg } : {}),
    proj: tm(lon0, 0.9999, 304800),
    domain: { lon0, maxDLon: MTM_MAX_DLON },
    validation: pair ? [pair] : MTM_FAMILY,
    validatedBy: pair
      ? 'NRCan TRX'
      : 'MTM family: zones 1, 5, 7, 8, 10, 11, 16 validated by NRCan TRX; this zone checked against proj.db on device',
  };
}

function projected(
  id: string,
  frame: FrameId,
  name: string,
  epsg: number,
  proj: string,
  validation: string[],
  validatedBy: string,
  domain: CoordSystem['domain'],
): CoordSystem {
  return {
    id,
    frame,
    kind: 'projected',
    name,
    epsg,
    proj,
    ...(domain ? { domain } : {}),
    validation,
    validatedBy,
  };
}

// US State Plane: the 17 zones (metres) validated against NGS datasheets.
const SPC: [number, string, string, readonly [number, number, number, number]][] = [
  [
    6404,
    'Arizona Central',
    '+proj=tmerc +lat_0=31 +lon_0=-111.916666666667 +k=0.9999 +x_0=213360 +y_0=0 +ellps=GRS80 +units=m',
    [-113.4, 31.3, -110.4, 37.0],
  ],
  [
    6423,
    'California zone 5',
    '+proj=lcc +lat_0=33.5 +lon_0=-118 +lat_1=35.4666666666667 +lat_2=34.0333333333333 +x_0=2000000 +y_0=500000 +ellps=GRS80 +units=m',
    [-121.4, 32.7, -114.1, 35.8],
  ],
  [
    6427,
    'Colorado Central',
    '+proj=lcc +lat_0=37.8333333333333 +lon_0=-105.5 +lat_1=39.75 +lat_2=38.45 +x_0=914401.8289 +y_0=304800.6096 +ellps=GRS80 +units=m',
    [-109.1, 38.1, -102.0, 40.1],
  ],
  [
    6437,
    'Florida East',
    '+proj=tmerc +lat_0=24.3333333333333 +lon_0=-81 +k=0.999941177 +x_0=200000 +y_0=0 +ellps=GRS80 +units=m',
    [-82.4, 24.4, -79.9, 30.8],
  ],
  [
    6446,
    'Georgia West',
    '+proj=tmerc +lat_0=30 +lon_0=-84.1666666666667 +k=0.9999 +x_0=700000 +y_0=0 +ellps=GRS80 +units=m',
    [-85.7, 30.6, -82.9, 35.1],
  ],
  [
    6454,
    'Illinois East',
    '+proj=tmerc +lat_0=36.6666666666667 +lon_0=-88.3333333333333 +k=0.999975 +x_0=300000 +y_0=0 +ellps=GRS80 +units=m',
    [-89.3, 37.0, -87.0, 42.6],
  ],
  [
    6478,
    'Louisiana South',
    '+proj=lcc +lat_0=28.5 +lon_0=-91.3333333333333 +lat_1=30.7 +lat_2=29.3 +x_0=1000000 +y_0=0 +ellps=GRS80 +units=m',
    [-93.9, 28.8, -88.7, 31.1],
  ],
  [
    6483,
    'Maine East',
    '+proj=tmerc +lat_0=43.6666666666667 +lon_0=-68.5 +k=0.9999 +x_0=300000 +y_0=0 +ellps=GRS80 +units=m',
    [-70.1, 43.8, -66.8, 47.5],
  ],
  [
    6487,
    'Maryland',
    '+proj=lcc +lat_0=37.6666666666667 +lon_0=-77 +lat_1=39.45 +lat_2=38.3 +x_0=400000 +y_0=0 +ellps=GRS80 +units=m',
    [-79.5, 37.9, -75.0, 39.8],
  ],
  [
    6491,
    'Massachusetts Mainland',
    '+proj=lcc +lat_0=41 +lon_0=-71.5 +lat_1=42.6833333333333 +lat_2=41.7166666666667 +x_0=200000 +y_0=750000 +ellps=GRS80 +units=m',
    [-73.6, 41.4, -69.8, 42.9],
  ],
  [
    6504,
    'Minnesota South',
    '+proj=lcc +lat_0=43 +lon_0=-94 +lat_1=45.2166666666667 +lat_2=43.7833333333333 +x_0=800000 +y_0=100000 +ellps=GRS80 +units=m',
    [-96.9, 43.4, -91.2, 45.6],
  ],
  [
    6513,
    'Missouri West',
    '+proj=tmerc +lat_0=36.1666666666667 +lon_0=-94.5 +k=0.999941177 +x_0=850000 +y_0=0 +ellps=GRS80 +units=m',
    [-95.8, 36.4, -93.4, 40.7],
  ],
  [
    6526,
    'New Jersey',
    '+proj=tmerc +lat_0=38.8333333333333 +lon_0=-74.5 +k=0.9999 +x_0=150000 +y_0=0 +ellps=GRS80 +units=m',
    [-75.6, 38.9, -73.9, 41.4],
  ],
  [
    6546,
    'North Dakota South',
    '+proj=lcc +lat_0=45.6666666666667 +lon_0=-100.5 +lat_1=47.4833333333333 +lat_2=46.1833333333333 +x_0=600000 +y_0=0 +ellps=GRS80 +units=m',
    [-104.1, 45.9, -96.5, 47.9],
  ],
  [
    6587,
    'Texas South Central',
    '+proj=lcc +lat_0=27.8333333333333 +lon_0=-99 +lat_1=30.2833333333333 +lat_2=28.3833333333333 +x_0=600000 +y_0=4000000 +ellps=GRS80 +units=m',
    [-105.0, 27.8, -93.7, 30.7],
  ],
  [
    6596,
    'Washington North',
    '+proj=lcc +lat_0=47 +lon_0=-120.833333333333 +lat_1=48.7333333333333 +lat_2=47.5 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m',
    [-124.8, 47.0, -117.0, 49.1],
  ],
  [
    6619,
    'Utah Central',
    '+proj=lcc +lat_0=38.3333333333333 +lon_0=-111.5 +lat_1=40.65 +lat_2=39.0166666666667 +x_0=500000 +y_0=2000000 +ellps=GRS80 +units=m',
    [-114.1, 38.4, -109.0, 41.1],
  ],
];

const SPC_MARGIN = 0.5;

function buildCoordSystems(): CoordSystem[] {
  const out: CoordSystem[] = [];
  // Canada
  out.push(geo('csrs', ['CA-EPOCH-CSRS-math', 'CA-NTV2-NA27SCRS'], 'NRCan TRX / NTv2'));
  out.push(xyz('csrs'));
  for (let z = 7; z <= 24; z++)
    out.push(utm('csrs', z, false, CSRS_UTM_EPSG[z], CSRS_UTM_VALIDATED[z]));
  for (let z = 1; z <= 17; z++) out.push(mtm(z));
  out.push(
    projected(
      'csrs:qclambert',
      'csrs',
      'Québec Lambert',
      6622,
      '+proj=lcc +lat_0=44 +lon_0=-68.5 +lat_1=60 +lat_2=46 +x_0=0 +y_0=0 +ellps=GRS80 +units=m',
      ['CA-PROJ-EPSG6622'],
      'NRCan TRX',
      { bbox: BOX.qc },
    ),
    projected(
      'csrs:nbstereo',
      'csrs',
      'New Brunswick Stereographic',
      2953,
      '+proj=sterea +lat_0=46.5 +lon_0=-66.5 +k=0.999912 +x_0=2500000 +y_0=7500000 +ellps=GRS80 +units=m',
      ['CA-PROJ-EPSG2953'],
      'NRCan TRX',
      { bbox: BOX.nb },
    ),
    projected(
      'csrs:pestereo',
      'csrs',
      'PEI Stereographic',
      2954,
      '+proj=sterea +lat_0=47.25 +lon_0=-63 +k=0.999912 +x_0=400000 +y_0=800000 +ellps=GRS80 +units=m',
      ['CA-PROJ-EPSG2954'],
      'NRCan TRX',
      { bbox: BOX.pe },
    ),
    projected(
      'csrs:nsmtm4',
      'csrs',
      'MTM NS 2010 zone 4',
      8082,
      '+proj=tmerc +lat_0=0 +lon_0=-61.5 +k=0.9999 +x_0=24500000 +y_0=0 +ellps=GRS80 +units=m',
      ['CA-PROJ-EPSG8082'],
      'NRCan TRX',
      { lon0: -61.5, maxDLon: MTM_MAX_DLON },
    ),
    projected(
      'csrs:nsmtm5',
      'csrs',
      'MTM NS 2010 zone 5',
      8083,
      '+proj=tmerc +lat_0=0 +lon_0=-64.5 +k=0.9999 +x_0=25500000 +y_0=0 +ellps=GRS80 +units=m',
      ['CA-PROJ-EPSG8083'],
      'NRCan TRX',
      { lon0: -64.5, maxDLon: MTM_MAX_DLON },
    ),
  );
  for (const f of [
    'nad83-ca',
    'nad27-qc',
    'nad27-on',
    'nad27-sk',
    'nad27-nb',
    'nad27-bc',
    'nad27-ca',
  ] as const) {
    out.push(geo(f, ['CA-NTV2-NTV2'], 'NRCan NTv2'));
  }
  for (const f of ['itrf2020', 'itrf2014', 'itrf2008'] as const) {
    out.push(geo(f, [`CA-CSRS-${f.toUpperCase()}-math`], 'NRCan TRX'));
    out.push(xyz(f));
  }
  // WGS 84: formats, UTM (WGS 84 ellipsoid), ECEF, EGM heights. No frame change (G2296 not validated separately).
  out.push(geo('wgs84', ['WGS84-EGM96'], 'NGA / GN 7-2'));
  out.push(xyz('wgs84'));
  for (let z = 1; z <= 60; z++) {
    out.push(utm('wgs84', z, false, 32600 + z, undefined));
    out.push(utm('wgs84', z, true, 32700 + z, undefined));
  }
  // United States
  out.push(
    geo('nad83-2011', ['US-NADCON5-NAD83_2011-to-NAD27', 'US-GEOID18'], 'NOAA NCAT / GEOID18 API'),
  );
  out.push(xyz('nad83-2011'));
  for (let z = 10; z <= 19; z++)
    out.push(utm('nad83-2011', z, false, 6320 + z + 9, US_UTM_VALIDATED[z]));
  for (const [epsg, name, proj, bbox] of SPC) {
    const b = [
      bbox[0] - SPC_MARGIN,
      bbox[1] - SPC_MARGIN,
      bbox[2] + SPC_MARGIN,
      bbox[3] + SPC_MARGIN,
    ] as const;
    out.push(
      projected(
        `nad83-2011:spc${epsg}`,
        'nad83-2011',
        `State Plane ${name} (m)`,
        epsg,
        proj,
        [`US-SPC-EPSG${epsg}`],
        'NGS datasheets',
        { bbox: b },
      ),
    );
  }
  out.push(geo('nad83-1986-us', ['US-NADCON5-NAD83_2011-to-NAD83_1986'], 'NOAA NCAT'));
  out.push(geo('nad27-us', ['US-NADCON5-NAD83_2011-to-NAD27'], 'NOAA NCAT'));
  // France
  out.push(geo('rgf93v2b', ['FR-L93', 'FR-RAF20-Circe'], 'IGN fiches + Circé 5.5.0'));
  out.push(
    projected(
      'rgf93v2b:l93',
      'rgf93v2b',
      'Lambert-93',
      9794,
      '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m',
      ['FR-L93', 'FR-L93-Circe'],
      'IGN fiches + Circé 5.5.0',
      { bbox: BOX.france },
    ),
  );
  for (let zone = 42; zone <= 50; zone++) {
    const y0 = (zone - 41) * 1_000_000 + 200_000;
    out.push(
      projected(
        `rgf93v2b:cc${zone}`,
        'rgf93v2b',
        `CC${zone}`,
        9800 + zone,
        `+proj=lcc +lat_0=${zone} +lon_0=3 +lat_1=${zone - 0.75} +lat_2=${zone + 0.75} +x_0=1700000 +y_0=${y0} +ellps=GRS80 +units=m`,
        ['FR-CC43-Circe', 'FR-CC44-Circe'],
        zone === 43 || zone === 44
          ? 'IGN Circé 5.5.0'
          : 'CC family: CC43/CC44 validated by IGN Circé 5.5.0; this zone checked against proj.db on device',
        { bbox: [-5.2, zone - 1.0, 9.6, zone + 1.0] },
      ),
    );
  }
  // UK
  out.push(
    geo('etrs89-uk', ['GB-OSTN15-OSGM15-fwd', 'GB-OSGM15-Belfast'], 'Ordnance Survey test files'),
  );
  out.push(geo('osgb36', ['GB-OSTN15-OSGM15-rev'], 'Ordnance Survey test files'));
  out.push(
    projected(
      'osgb36:bng',
      'osgb36',
      'British National Grid',
      27700,
      '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy',
      ['GB-OSTN15-OSGM15-fwd', 'GB-OSTN15-OSGM15-rev'],
      'Ordnance Survey test files (OSTN15)',
      { bbox: BOX.gb },
    ),
  );
  // Switzerland
  out.push(geo('etrs89-ch', ['CH-ETRS89-to-LV95'], 'swisstopo REFRAME'));
  out.push(
    projected(
      'ch1903p:lv95',
      'ch1903p',
      'LV95',
      2056,
      '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +units=m',
      ['CH-ETRS89-to-LV95', 'CH-LV95LN02-to-ETRS89'],
      'swisstopo REFRAME',
      { bbox: BOX.switzerland },
    ),
  );
  // Norway
  out.push(geo('euref89-no', ['NO-NN2000'], 'Kartverket'));
  for (const z of [32, 33, 34, 35])
    out.push(utm('euref89-no', z, false, 25800 + z, NO_UTM_VALIDATED[z]));
  // Netherlands
  out.push(geo('etrs89-nl', ['NL-RDNAPTRANS2018-fwd'], 'NSGI'));
  out.push(
    projected(
      'amersfoort:rd',
      'amersfoort',
      'RD New',
      28992,
      '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +units=m',
      ['NL-RDNAPTRANS2018-fwd', 'NL-RDNAPTRANS2018-rev', 'NL-RDNAPTRANS2018-RDonly'],
      'NSGI validation file + validation service',
      { bbox: BOX.rdFallback },
    ),
  );
  return out;
}

export const COORD_SYSTEMS: readonly CoordSystem[] = buildCoordSystems();
const COORD_BY_ID = new Map(COORD_SYSTEMS.map((c) => [c.id, c]));

export function coordSystem(id: string): CoordSystem | undefined {
  return COORD_BY_ID.get(id);
}

// ---- Heights -------------------------------------------------------------------

export const HEIGHT_SYSTEMS: readonly HeightSystem[] = [
  {
    id: 'ell',
    kind: 'ellipsoidal',
    name: 'Ellipsoidal height',
    note: 'of the coordinate frame (h)',
    frames: Object.keys(FRAMES) as FrameId[],
    validation: [],
  },
  {
    id: 'cgvd2013a',
    kind: 'geoid',
    name: 'CGVD2013 (CGG2013a)',
    note: 'Canada · official since 2013',
    epsg: 9245,
    frames: ['csrs'],
    region: BOX.canada,
    validation: ['CA-H-CGG2013a', 'CA-H-CGG2013a-1997', 'CA-H-datasheet-CGVD2013'],
  },
  {
    id: 'cgvd2013',
    kind: 'geoid',
    name: 'CGVD2013 (CGG2013, 2013 model)',
    note: 'Canada · original CGG2013 · epoch 2010.0',
    epsg: 6647,
    frames: ['csrs'],
    region: BOX.canada,
    validation: ['CA-H-CGG2013'],
  },
  {
    id: 'cgvd28',
    kind: 'geoid',
    name: 'CGVD28 (HTv2.0)',
    note: 'Canada, legacy',
    epsg: 5713,
    frames: ['csrs'],
    region: BOX.canada,
    validation: ['CA-H-HT2_1997', 'CA-H-HT2_2002v70', 'CA-H-HT2_2010v70', 'CA-H-datasheet-CGVD28'],
  },
  {
    id: 'navd88',
    kind: 'geoid',
    name: 'NAVD88 (GEOID18)',
    note: 'United States (CONUS)',
    epsg: 5703,
    frames: ['nad83-2011'],
    region: 'conus',
    validation: ['US-GEOID18', 'US-GEOID18-levelled'],
  },
  {
    id: 'egm96',
    kind: 'geoid',
    name: 'EGM96',
    note: 'Global geoid · GPS-receiver default',
    epsg: 5773,
    frames: ['wgs84', 'itrf2020', 'itrf2014', 'itrf2008'],
    validation: ['WGS84-EGM96'],
  },
  {
    id: 'egm2008',
    kind: 'geoid',
    name: 'EGM2008',
    note: 'Global geoid · 2.5′ grid',
    epsg: 3855,
    frames: ['wgs84', 'itrf2020', 'itrf2014', 'itrf2008'],
    validation: ['WGS84-EGM2008'],
  },
  {
    id: 'odn',
    kind: 'geoid',
    name: 'ODN (OSGM15)',
    note: 'Great Britain',
    epsg: 5701,
    frames: ['etrs89-uk'],
    region: BOX.gb,
    validation: ['GB-OSTN15-OSGM15-fwd', 'GB-OSTN15-OSGM15-rev'],
  },
  {
    id: 'belfast',
    kind: 'geoid',
    name: 'Belfast height (OSGM15)',
    note: 'Northern Ireland',
    epsg: 5732,
    frames: ['etrs89-uk'],
    region: BOX.ni,
    validation: ['GB-OSGM15-Belfast'],
  },
  {
    id: 'ngf-ign69',
    kind: 'geoid',
    name: 'NGF-IGN69 (RAF20)',
    note: 'France',
    epsg: 5720,
    frames: ['rgf93v2b'],
    region: BOX.france,
    validation: ['FR-RAF20', 'FR-RAF20-Circe'],
  },
  {
    id: 'lhn95',
    kind: 'geoid',
    name: 'LHN95 (CHGeo2004)',
    note: 'Switzerland',
    epsg: 5729,
    frames: ['etrs89-ch'],
    region: BOX.switzerland,
    validation: ['CH-ETRS89-to-LHN95'],
  },
  {
    id: 'ln02',
    kind: 'geoid',
    name: 'LN02',
    note: 'Switzerland, usual heights',
    epsg: 5728,
    frames: ['etrs89-ch'],
    region: BOX.switzerland,
    validation: ['CH-LV95LN02-to-ETRS89'],
  },
  {
    id: 'nn2000',
    kind: 'geoid',
    name: 'NN2000 (HREF2018B)',
    note: 'Norway',
    epsg: 5941,
    frames: ['euref89-no'],
    region: BOX.norway,
    validation: ['NO-NN2000'],
  },
  {
    id: 'cd-no',
    kind: 'cd-grid',
    name: 'Chart datum · Norway',
    note: 'Sjøkartnull (Kartverket grid v2023b)',
    epsg: 9672,
    frames: ['euref89-no'],
    region: BOX.norway,
    chart: true,
    validation: ['CD-NO-station-vs-grid'],
  },
  {
    id: 'nap',
    kind: 'geoid',
    name: 'NAP (NLGEO2018)',
    note: 'Netherlands',
    epsg: 5709,
    frames: ['etrs89-nl'],
    region: BOX.netherlands,
    validation: ['NL-RDNAPTRANS2018-fwd', 'NL-RDNAPTRANS2018-rev'],
  },
  {
    id: 'lat-nl',
    kind: 'cd-grid',
    name: 'LAT · Netherlands',
    note: 'Chart datum (NLLAT2018)',
    epsg: 9287,
    frames: ['etrs89-nl'],
    region: BOX.netherlands,
    chart: true,
    validation: ['CD-NL-NAPLAT-vs-grids'],
  },
];
const HEIGHT_BY_ID = new Map(HEIGHT_SYSTEMS.map((h) => [h.id, h]));

/** Static height systems; chart-datum stations are added by the caller (`stationHeights`). */
export function heightSystem(id: string): HeightSystem | undefined {
  return HEIGHT_BY_ID.get(id);
}

/**
 * Hidden on purpose (not validated against an official tool yet, or blocked).
 * Shown nowhere; listed so the decision is explicit and testable.
 */
export const HIDDEN_SYSTEMS: readonly { what: string; why: string }[] = [
  {
    what: 'WGS 84 (G2296) ↔ NAD83(CSRS) / ITRF',
    why: 'no separate official oracle (CONVERT §5.1); use ITRF2020 at an epoch',
  },
  { what: 'ITRF epochs outside Canada, pre-2000 ITRF', why: 'not validated' },
  { what: 'NADCON5 Alaska / Hawaii / territories, GEOID18 outside CONUS', why: 'not validated' },
  {
    what: 'US State Plane zones other than the 17 validated, and US-foot variants',
    why: 'not validated (GN 7-2 only)',
  },
  {
    what: 'DHDN / GCG2016, GDA2020 / AUSGeoid2020, NZGD2000 / NZVD2016, Irish Grid',
    why: 'no official oracle run',
  },
  {
    what: 'France chart datum (BathyElli / SHOM)',
    why: 'SHOM datasets disagree by up to 1.6 m (owner Q15a)',
  },
  {
    what: 'US MLLW as a surface (VDatum grids)',
    why: 'grids not built and validated; station offsets only',
  },
  { what: 'Approximate LAT (global model)', why: 'no official oracle to validate against yet' },
  { what: 'MGRS / USNG', why: 'not in the reference suite yet' },
  { what: 'NAD83(CSRS) v8 velocity grid', why: 'not in PROJ-data; v7 is used and labelled (Q13a)' },
];
