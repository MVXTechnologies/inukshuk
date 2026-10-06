/**
 * The grid-free fallback engine (CONVERT §1 option D): proj4js (already in
 * the bundle) runs the projection and geocentric steps of a pinned pipeline,
 * so an OTA bundle on a store build without the PROJ module still converts
 * between geographic, UTM / MTM / Lambert / stereographic and ECEF in the
 * same frame. Anything else — a grid, a Helmert, an epoch — is refused with
 * "update the app", never approximated.
 *
 * `lite.test.ts` holds it to every grid-free pair of the reference suite.
 */
import proj4 from 'proj4';
import type { Engine, EngineReply, EngineRequest } from './run';

const ELLPS: Record<string, [number, number]> = {
  GRS80: [6378137, 298.257222101],
  WGS84: [6378137, 298.257223563],
  clrk66: [6378206.4, 294.9786982138982],
  airy: [6377563.396, 299.3249646],
  bessel: [6377397.155, 299.1528128],
  evrstSS: [6377298.556, 300.8017],
};

type Op = (c: number[]) => number[];

const RAD = Math.PI / 180;

function ellipsoidOf(def: string): { a: number; e2: number } | null {
  const ell = /\+ellps=(\S+)/.exec(def)?.[1];
  let a: number | undefined;
  let rf: number | undefined;
  if (ell) [a, rf] = ELLPS[ell] ?? [];
  const ma = /\+a=(\S+)/.exec(def)?.[1];
  const mrf = /\+rf=(\S+)/.exec(def)?.[1];
  if (ma) a = Number(ma);
  if (mrf) rf = Number(mrf);
  if (a === undefined || rf === undefined) return null;
  const f = 1 / rf;
  return { a, e2: f * (2 - f) };
}

/** Geographic (radians, h) → geocentric, EPSG method 9602. */
function cart(def: string, inverse: boolean): Op | null {
  const el = ellipsoidOf(def);
  if (!el) return null;
  const { a, e2 } = el;
  if (!inverse) {
    return ([lam = 0, phi = 0, h = 0, ...rest]) => {
      const s = Math.sin(phi);
      const n = a / Math.sqrt(1 - e2 * s * s);
      return [
        (n + h) * Math.cos(phi) * Math.cos(lam),
        (n + h) * Math.cos(phi) * Math.sin(lam),
        (n * (1 - e2) + h) * s,
        ...rest,
      ];
    };
  }
  return ([x = 0, y = 0, z = 0, ...rest]) => {
    const b = a * Math.sqrt(1 - e2);
    const ep2 = e2 / (1 - e2);
    const p = Math.hypot(x, y);
    const q = Math.atan2(z * a, p * b);
    let phi = Math.atan2(z + ep2 * b * Math.sin(q) ** 3, p - e2 * a * Math.cos(q) ** 3);
    for (let i = 0; i < 6; i++) {
      const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
      const h = p / Math.cos(phi) - n;
      phi = Math.atan2(z, p * (1 - (e2 * n) / (n + h)));
    }
    const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    return [Math.atan2(y, x), phi, p / Math.cos(phi) - n, ...rest];
  };
}

const PROJECTIONS = new Set(['tmerc', 'utm', 'lcc', 'sterea', 'somerc', 'omerc']);

function projection(def: string, inverse: boolean): Op | null {
  const name = /\+proj=(\S+)/.exec(def)?.[1];
  if (!name || !PROJECTIONS.has(name)) return null;
  const el = ellipsoidOf(def);
  if (!el) return null;
  const ellArg = /\+ellps=\S+/.exec(def)?.[0] ?? `+a=${el.a} +rf=${/\+rf=(\S+)/.exec(def)?.[1]}`;
  // proj4js has no meaning for +units=us-ft output beyond the factor: keep the string as is.
  const geog = `+proj=longlat ${ellArg} +no_defs`;
  const conv = proj4(geog, `${def} +no_defs`);
  return ([x = 0, y = 0, ...rest]) => {
    if (inverse) {
      const [lon = NaN, lat = NaN] = conv.inverse([x, y]);
      return [lon * RAD, lat * RAD, ...rest];
    }
    const [e = NaN, n = NaN] = conv.forward([x / RAD, y / RAD]);
    return [e, n, ...rest];
  };
}

/** Parse a pinned pipeline into proj4js-runnable ops, or null if any step isn't grid-free math we support. */
export function compileLite(pipeline: string): Op[] | null {
  const parts = pipeline.split(/\s+\+step\s+/);
  if (parts[0]?.trim() !== '+proj=pipeline') return null;
  const ops: Op[] = [];
  for (const raw of parts.slice(1)) {
    const inverse = raw.startsWith('+inv ');
    const def = inverse ? raw.slice(5) : raw;
    if (def === '+proj=unitconvert +xy_in=deg +xy_out=rad') {
      ops.push(([x = 0, y = 0, ...r]) => [x * RAD, y * RAD, ...r]);
    } else if (def === '+proj=unitconvert +xy_in=rad +xy_out=deg') {
      ops.push(([x = 0, y = 0, ...r]) => [x / RAD, y / RAD, ...r]);
    } else if (/^\+proj=cart /.test(def)) {
      const op = cart(def, inverse);
      if (!op) return null;
      ops.push(op);
    } else {
      const op = projection(def, inverse);
      if (!op) return null;
      ops.push(op);
    }
  }
  return ops;
}

export const liteEngine: Engine = {
  kind: 'lite',
  transform(req: EngineRequest): EngineReply {
    const ops = compileLite(req.pipeline);
    if (!ops) {
      return {
        ok: false,
        error: 'lite-unsupported',
        message:
          'This conversion needs the PROJ engine of the current app version: update the app from the store',
      };
    }
    const out: number[] = [];
    for (let i = 0; i < req.coords.length; i += req.dim) {
      let c = req.coords.slice(i, i + req.dim);
      for (const op of ops) c = op(c);
      if (c.slice(0, 2).some((x) => !Number.isFinite(x))) {
        return { ok: false, error: 'point-failed', message: 'non-finite result' };
      }
      out.push(...c.slice(0, req.dim));
    }
    return { ok: true, coords: out };
  },
};
