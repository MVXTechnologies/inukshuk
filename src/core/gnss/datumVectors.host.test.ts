/**
 * The GNSS datum vectors through the app's own C++ facade + PROJ 9.8.1 on
 * the build machine (modules/inukshuk-proj/tests/host_runner). Runs only
 * under `modules/inukshuk-proj/tests/run-host.sh GRID_DIR`, which sets
 * INKPROJ_HOST_RUNNER; skipped in the normal Jest run.
 */
import { spawnSync } from 'child_process';
import { deltas, KNOWN_REPRO_M, withinTolerance } from '../convert/suite';
import vectorFile from './fixtures/datum-vectors.json';
import { planVector, VECTOR_COMPARE, type DatumVectorFile } from './datumVectors';

const RUNNER = process.env.INKPROJ_HOST_RUNNER;
const run = RUNNER ? it : it.skip;
const file = vectorFile as unknown as DatumVectorFile;

run('host PROJ reproduces the GNSS datum vectors (official tools + frozen PROJ)', () => {
  const reqs = file.vectors.map((v) => {
    const r = planVector(v);
    if (!r.ok || !r.out.plan) throw new Error(`${v.id}: no plan`);
    const coords = v.inDim === 4 ? [...v.input, v.obsEpoch] : v.input.slice(0, v.inDim);
    return `T\t${v.inDim}\t${coords.map((x) => x.toPrecision(17)).join(' ')}\t${r.out.plan.pipeline}`;
  });
  const out = spawnSync(
    RUNNER as string,
    [process.env.INKPROJ_PROJ_DB as string, ...(process.env.INKPROJ_GRIDS as string).split(':')],
    { input: `${reqs.join('\n')}\n`, encoding: 'utf8', maxBuffer: 1 << 24 },
  );
  if (out.status !== 0) throw new Error(out.stderr);
  const lines = out.stdout.split('\n').filter((l) => l.length > 0);
  const failures: string[] = [];
  file.vectors.forEach((v, i) => {
    const f = (lines[i] ?? 'ERR').split('\t');
    if (f[0] !== 'OK') {
      failures.push(`${v.id}: ${f.slice(1).join(' ')}`);
      return;
    }
    const got = (f[1] ?? '').split(' ').map(Number);
    const vsTool = deltas(VECTOR_COMPARE, got, v.expected, v.expected[1] ?? v.input[1]);
    const vsFrozen = deltas(VECTOR_COMPARE, got, v.proj, v.input[1]);
    if (!withinTolerance(vsTool, v.tol))
      failures.push(`${v.id}: vs ${v.source.tool} ${JSON.stringify(vsTool)}`);
    if (!withinTolerance(vsFrozen, { h: KNOWN_REPRO_M, v: KNOWN_REPRO_M }))
      failures.push(`${v.id}: PROJ moved since the freeze ${JSON.stringify(vsFrozen)}`);
  });
  expect(failures).toEqual([]);
});
