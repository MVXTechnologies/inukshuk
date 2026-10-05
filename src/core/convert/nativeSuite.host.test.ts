/**
 * The native gate on the build machine: the app's own C++ facade + PROJ
 * 9.8.1 (modules/inukshuk-proj/tests/host_runner), real PROJ-data grids.
 * Runs only under `modules/inukshuk-proj/tests/run-host.sh GRID_DIR`
 * (it sets INKPROJ_HOST_RUNNER); skipped in the normal Jest run.
 */
import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import reference from './fixtures/reference.json';
import { formatReport, runNativeSuite, type SuiteReply, type SuiteRequest } from './nativeSuite';
import type { Suite } from './suite';

const RUNNER = process.env.INKPROJ_HOST_RUNNER;
const run = RUNNER ? it : it.skip;

function encode(r: SuiteRequest): string {
  if (r.kind === 'E') return `E\t${r.code}`;
  const c = r.coords.map((x) => x.toPrecision(17)).join(' ');
  return r.kind === 'T'
    ? `T\t${r.dim}\t${c}\t${r.pipeline}`
    : `C\t${r.dim}\t${c}\t${r.src}\t${r.dst}`;
}

function decode(line: string, req: SuiteRequest): SuiteReply {
  const f = line.split('\t');
  if (f[0] !== 'OK') return { ok: false, error: f[1] ?? 'error', message: f[2] ?? '' };
  if (req.kind === 'E') return { ok: true, accuracy: Number(f[1]), name: f[2] ?? '' };
  return { ok: true, coords: (f[1] ?? '').split(' ').map(Number) };
}

run(
  'PROJ (host build) reproduces the official-tool reference suite',
  async () => {
    const engine = {
      async run(reqs: readonly SuiteRequest[]): Promise<SuiteReply[]> {
        if (reqs.length === 0) return [];
        const out = spawnSync(
          RUNNER as string,
          [
            process.env.INKPROJ_PROJ_DB as string,
            ...(process.env.INKPROJ_GRIDS as string).split(':'),
          ],
          {
            input: reqs.map(encode).join('\n') + '\n',
            maxBuffer: 1 << 28,
            encoding: 'utf8',
          },
        );
        if (out.status !== 0) throw new Error(out.stderr);
        const lines = out.stdout.split('\n').filter((l) => l.length > 0);
        return reqs.map((r, i) => decode(lines[i] ?? 'ERR\tno-reply\t', r));
      },
    };
    const report = await runNativeSuite(engine, reference as unknown as Suite);
    const text = formatReport(report, 'Convert native suite — host (PROJ 9.8.1)');
    const tsv = report.pairs.map((p) =>
      [p.pair, p.n, p.pass, p.known, p.fail, p.skip, p.maxH ?? '', p.maxV ?? '', p.tool].join('\t'),
    );
    if (process.env.INKPROJ_REPORT) {
      writeFileSync(
        process.env.INKPROJ_REPORT,
        `${text}\n\npair\tn\tpass\tknown\tfail\tskip\tmaxH_m\tmaxV_m\ttool\n${tsv.join('\n')}\n\n${report.checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'}\t${c.kind}\t${c.id}\t${c.detail}`).join('\n')}\n`,
      );
    }
    console.log(text);
    expect(report.totals.fail).toBe(0);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  },
  600_000,
);
