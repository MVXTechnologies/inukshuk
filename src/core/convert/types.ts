/**
 * Shared types of the Convert tool's pure core (`@core/convert`).
 *
 * Vocabulary:
 * - a **frame** is a horizontal geodetic reference frame (NAD83(CSRS),
 *   ITRF2020, ETRS89 in one country…), possibly dynamic (needs an epoch);
 * - a **coordinate system** is how a position in a frame is written
 *   (geographic, a projection zone, geocentric XYZ);
 * - a **height system** is what a height is measured from (the frame's
 *   ellipsoid, a geoid model realising a national datum, a chart datum).
 */

/** [west, south, east, north], degrees. */
export type BBox = readonly [number, number, number, number];

/** A box, or a named outline (`regions.ts`). */
export type Region = BBox | 'conus';

export type FrameId =
  | 'csrs'
  | 'nad83-ca'
  | 'nad27-qc'
  | 'nad27-on'
  | 'nad27-sk'
  | 'nad27-nb'
  | 'nad27-bc'
  | 'nad27-ca'
  | 'itrf2020'
  | 'itrf2014'
  | 'itrf2008'
  | 'wgs84'
  | 'nad83-2011'
  | 'nad83-1986-us'
  | 'nad27-us'
  | 'rgf93v2b'
  | 'etrs89-uk'
  | 'osgb36'
  | 'etrs89-ch'
  | 'ch1903p'
  | 'euref89-no'
  | 'etrs89-nl'
  | 'amersfoort';

export type Ellipsoid = 'GRS80' | 'WGS84' | 'clrk66' | 'airy' | 'bessel';

export interface Frame {
  id: FrameId;
  /** Full name, e.g. "NAD83(CSRS)". */
  name: string;
  /** Where it is used / defined; shown under the name. */
  note: string;
  ellps: Ellipsoid;
  /** A coordinate epoch is part of a position in this frame. */
  dynamic: boolean;
  /** EPSG code of its geographic 2D/3D CRS, for display. */
  epsg?: number;
  /** Where the frame's validated operations apply (suggestions + refusal). */
  region: Region;
  /** A fixed epoch the frame's coordinates refer to (static frames), for labels. */
  fixedEpoch?: number;
}

export type CoordKind = 'geographic' | 'projected' | 'geocentric';

export interface CoordSystem {
  /** Stable id, e.g. "csrs:geo", "csrs:mtm7", "wgs84:utm18n". */
  id: string;
  frame: FrameId;
  kind: CoordKind;
  /** "MTM zone 7", "UTM zone 18N", "Lambert-93", "geographic". */
  name: string;
  epsg?: number;
  /**
   * Projected: the PROJ forward step (geographic radians → E/N metres), with
   * the frame's ellipsoid written as +ellps (never +datum: TRAP 6).
   */
  proj?: string;
  /** Projected: where the projection may be used; outside it we refuse. */
  domain?: ProjDomain;
  /** Reference-suite pair ids that validate this system (or its family). */
  validation: readonly string[];
  /** How it is validated, for the panel ("NRCan TRX", "family: …"). */
  validatedBy: string;
}

export interface ProjDomain {
  /** Central meridian and the allowed |Δlon| (half the zone width + margin). */
  lon0?: number;
  maxDLon?: number;
  bbox?: BBox;
}

export type HeightKind = 'ellipsoidal' | 'geoid' | 'cd-grid' | 'cd-station' | 'station-offset';

export interface HeightSystem {
  /** "ell", "cgvd2013a", "cgvd28", "navd88", "egm96", "cd:<station>", … */
  id: string;
  kind: HeightKind;
  name: string;
  /** The subtitle in the picker. */
  note: string;
  epsg?: number;
  /** Frames whose ellipsoidal height the grid converts (the grid's frame). */
  frames: readonly FrameId[];
  region?: Region;
  /** Chart / tidal datum: never shown as an orthometric height. */
  chart?: boolean;
  validation: readonly string[];
}

/** Where a value of a pipeline's grid comes from. */
export interface GridRef {
  /** PROJ-data file name, e.g. "ca_nrc_CGG2013an83.tif". */
  file: string;
  /** Human name + version, e.g. "CGG2013a (NRCan)". */
  label: string;
  /** Bundled with the app (always there) vs from a grid pack. */
  bundled: boolean;
  agency: string;
  licence: string;
}

/** One operation of a conversion, as the accuracy panel lists it. */
export interface Step {
  /** "NAD83(CSRS)v3 to CGVD2013a(1997) height (1)", "MTM zone 7 (EPSG:2949)". */
  name: string;
  /** EPSG operation code when the step IS an EPSG operation. */
  epsgOp?: string;
  /** Stated accuracy in metres; 0 = exact (a conversion); null = not stated. */
  accuracyM: number | null;
  /** Where the stated accuracy comes from. */
  accuracySource: string;
  grids: GridRef[];
  /** PROJ pipeline steps, each starting with "+step ", in the radians domain. */
  proj: string[];
  /** Reference-suite pair ids that validate this step. */
  validation: readonly string[];
  /** Panel note: a known gap, a convention ("velocity model v7; TRX uses v8"). */
  note?: string;
  /** Status contribution beyond the stated accuracy. */
  flag?: 'amber';
  epochIn?: number;
  epochOut?: number;
  /** Uses only grid-free math (proj4js `lite.ts` can do it). */
  gridFree: boolean;
}

/** What the user asked for. */
export interface ConvertSpec {
  /** Source coordinate system id. */
  from: string;
  /** Source height system id, or null (2D input). */
  fromHeight: string | null;
  /** Target coordinate system id, or "same" (heights only, same position). */
  to: string;
  /** Target height system id, or null (no height output). */
  toHeight: string | null;
  /** Coordinate epoch of the input (dynamic frames). */
  epoch?: number;
  /** Target epoch (dynamic target frames); defaults to `epoch`. */
  toEpoch?: number;
}

/** A source point, already parsed. */
export interface SourcePoint {
  /** Geographic: [lon, lat]; projected: [E, N]; geocentric: [X, Y, Z]. */
  xy: readonly number[];
  h?: number;
  /** Approximate geographic position (for regions / zones / packs). */
  lon: number;
  lat: number;
}

export type RefusalCode =
  | 'unvalidated-pair'
  | 'outside-region'
  | 'out-of-zone'
  | 'needs-epoch'
  | 'needs-height'
  | 'missing-grid'
  | 'outside-grid'
  | 'ballpark'
  | 'cd-too-far'
  | 'cd-cross-zone'
  | 'lite-unsupported'
  | 'bad-input'
  | 'engine-error';

export interface Refusal {
  code: RefusalCode;
  /** One sentence for the red panel. */
  message: string;
  /** Grids to download (missing-grid). */
  grids?: string[];
}

export interface Plan {
  spec: ConvertSpec;
  steps: Step[];
  /** The complete pinned PROJ pipeline (degrees / metres in, degrees / metres out). */
  pipeline: string;
  /** Coordinates the pipeline takes per point: 2, 3 or 4 (x y z t). */
  inDim: 2 | 3 | 4;
  /** What the input z / output z hold. */
  zIn: 'none' | 'height' | 'zero';
  zOut: 'none' | 'height';
  outEpoch?: number;
  /** The 4th input coordinate (ITRF Helmert evaluation epoch), when inDim = 4. */
  tValue?: number;
  gridsNeeded: string[];
  /** Every step is grid-free (lite.ts can run it). */
  gridFree: boolean;
  /** Validation pair ids behind every step (the "validated" proof). */
  validation: string[];
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; refusal: Refusal };
