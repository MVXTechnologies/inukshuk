/**
 * The JS face of the Convert tool's PROJ module (modules/inukshuk-proj).
 * Optional: a JS bundle that reaches a store build without the module (an
 * OTA on an older runtime) gets `null` here, and Convert runs `lite.ts`
 * (grid-free conversions only; everything else says "update the app").
 */
import type { Engine, EngineReply, EngineRequest } from '@core/convert/run';
import type { SuiteEngine, SuiteReply, SuiteRequest } from '@core/convert/nativeSuite';
import { requireOptionalNativeModule } from 'expo';

interface NativeTransform {
  ok: boolean;
  error: string;
  message: string;
  coords: number[];
  failedIndex: number;
  grids: { name: string; available: boolean }[];
  ballpark: boolean;
}

interface NativeInit {
  ok: boolean;
  error: string;
  projVersion?: string;
  epsgVersion?: string;
  epsgDate?: string;
  bundledGridDir?: string;
}

interface NativeProjModule {
  supported: boolean;
  init(gridDirs: string[]): NativeInit;
  transform(pipeline: string, coords: number[], dim: number): NativeTransform;
  transformCrs(src: string, dst: string, coords: number[], dim: number): NativeTransform;
  epsgOperation(code: string): {
    ok: boolean;
    error: string;
    name: string;
    accuracy: number;
    ballpark: boolean;
  };
}

const mod = requireOptionalNativeModule<NativeProjModule>('InukshukProj');

export const nativeProjAvailable = mod !== null && mod.supported === true;

let initInfo: NativeInit | null = null;
let initKey = '';

/** (Re)open PROJ with these extra grid directories (packs); no-op if unchanged. */
export function initNativeProj(gridDirs: string[] = []): NativeInit | null {
  if (!mod) return null;
  const key = gridDirs.join('|');
  if (initInfo?.ok && key === initKey) return initInfo;
  initInfo = mod.init(gridDirs);
  initKey = key;
  return initInfo;
}

export function nativeProjInfo(): NativeInit | null {
  return initInfo;
}

function toReply(r: NativeTransform): EngineReply {
  if (!r.ok) {
    const missing = r.grids.filter((g) => !g.available).map((g) => g.name);
    return {
      ok: false,
      error: r.error,
      message: r.message,
      ...(missing.length ? { grids: missing } : {}),
    };
  }
  return {
    ok: true,
    coords: r.coords,
    ballpark: r.ballpark,
    gridsUsed: r.grids.filter((g) => g.available).map((g) => g.name),
  };
}

/** The native engine, or null when the module isn't in this build. */
export function nativeEngine(): Engine | null {
  if (!mod) return null;
  return {
    kind: 'native',
    transform(req: EngineRequest): EngineReply {
      if (!initInfo?.ok) initNativeProj();
      if (!initInfo?.ok)
        return {
          ok: false,
          error: 'not-initialized',
          message: initInfo?.error ?? 'PROJ did not start',
        };
      return toReply(mod.transform(req.pipeline, req.coords, req.dim));
    },
  };
}

/** The self-test engine (scripts/convert-native-suite.sh): every suite request, synchronously. */
export function nativeSuiteEngine(): SuiteEngine | null {
  if (!mod) return null;
  return {
    async run(reqs: readonly SuiteRequest[]): Promise<SuiteReply[]> {
      return reqs.map((r) => {
        if (r.kind === 'E') {
          const o = mod.epsgOperation(r.code);
          return o.ok
            ? { ok: true, accuracy: o.accuracy, name: o.name }
            : { ok: false, error: 'unknown', message: o.error };
        }
        const t =
          r.kind === 'T'
            ? mod.transform(r.pipeline, r.coords, r.dim)
            : mod.transformCrs(r.src, r.dst, r.coords, r.dim);
        return t.ok
          ? { ok: true, coords: t.coords }
          : { ok: false, error: t.error, message: t.message };
      });
    },
  };
}
