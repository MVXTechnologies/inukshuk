import vm from 'node:vm';

/**
 * Run a worklet the way a worklet runtime does (#722): from the code string
 * the Worklets Babel plugin generated, in a FRESH realm, with only what its
 * `__closure` captured. A worklet that leans on anything the plugin did not
 * capture (e.g. a module constant used only in a parameter default, which
 * failed on device with "Property 'NO_SLOPE_FILTER' doesn't exist") or that
 * calls a non-worklet function fails here as it would on the device — plain
 * Jest calls the original function and never notices.
 */
export function asWorkletRuntime<F extends (...args: never[]) => unknown>(fn: F): F {
  const ctx = vm.createContext({});
  const seen = new Map<unknown, unknown>();
  const unpack = (v: unknown, path: string): unknown => {
    if (typeof v === 'function') {
      const w = v as unknown as {
        __initData?: { code: string };
        __closure?: Record<string, unknown>;
      };
      if (w.__initData === undefined) throw new Error(`non-worklet function captured at ${path}`);
      const hit = seen.get(v);
      if (hit !== undefined) return hit;
      const closure: Record<string, unknown> = {};
      const compiled = vm.runInContext(`(${w.__initData.code})`, ctx) as (
        ...a: unknown[]
      ) => unknown;
      const bound = compiled.bind({ __closure: closure });
      seen.set(v, bound);
      for (const [k, val] of Object.entries(w.__closure ?? {})) {
        // Under `--coverage`, istanbul's counter functions (cov_*) get captured
        // too; they only bump counters, so they pass through as they are.
        closure[k] = k.startsWith('cov_') ? val : unpack(val, `${path}.${k}`);
      }
      return bound;
    }
    if (Array.isArray(v)) return v.map((x, i) => unpack(x, `${path}[${i}]`));
    if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x, `${path}.${k}`)]));
    }
    return v;
  };
  return unpack(fn, fn.name) as F;
}
