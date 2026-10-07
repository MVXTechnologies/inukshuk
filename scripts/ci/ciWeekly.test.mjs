import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  branchFailureRates,
  failuresBy,
  flakes,
  isRed,
  redHours,
  renderReport,
  topCauses,
} from './ciWeekly.mjs';

const H = 3600 * 1000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const at = (h) => new Date(T0 + h * H).toISOString();
const run = (over) => ({
  status: 'completed',
  conclusion: 'success',
  workflow_id: 1,
  name: 'CI',
  head_branch: 'main',
  event: 'push',
  updated_at: at(0),
  ...over,
});

describe('redHours', () => {
  it('counts a red run until the next green run of the same workflow', () => {
    const runs = [run({ conclusion: 'failure', updated_at: at(1) }), run({ updated_at: at(4) })];
    assert.equal(redHours(runs, T0, T0 + 10 * H), 3);
  });

  it('keeps a still-red workflow red until now, and merges overlapping workflows', () => {
    const runs = [
      run({ conclusion: 'failure', updated_at: at(1) }),
      run({ updated_at: at(4) }),
      run({ workflow_id: 2, name: 'E2E', conclusion: 'failure', updated_at: at(3) }),
    ];
    // CI red 1→4, E2E red 3→10: union 1→10.
    assert.equal(redHours(runs, T0, T0 + 10 * H), 9);
  });

  it('clips to the window and ignores runs still in progress', () => {
    const runs = [
      run({ conclusion: 'failure', updated_at: at(-5) }),
      run({ updated_at: at(2) }),
      run({ status: 'in_progress', conclusion: null, updated_at: at(3) }),
    ];
    assert.equal(redHours(runs, T0, T0 + 10 * H), 2);
  });

  it('treats a cancelled run (no verdict) as red', () => {
    const runs = [run({ conclusion: 'cancelled', updated_at: at(1) }), run({ updated_at: at(2) })];
    assert.equal(redHours(runs, T0, T0 + 10 * H), 1);
  });
});

describe('isRed', () => {
  it('ignores branch cancellations (superseded pushes) but not main ones', () => {
    assert.equal(isRed(run({ conclusion: 'cancelled', head_branch: 'feat/x' })), false);
    assert.equal(isRed(run({ conclusion: 'cancelled' })), true);
    assert.equal(isRed(run({ conclusion: 'failure', head_branch: 'feat/x' })), true);
    assert.equal(isRed(run({})), false);
  });
});

describe('failuresBy / branchFailureRates', () => {
  const runs = [
    run({ conclusion: 'failure', head_branch: 'feat/a', event: 'pull_request' }),
    run({ conclusion: 'failure', head_branch: 'feat/a', event: 'pull_request' }),
    run({ head_branch: 'feat/a', event: 'pull_request' }),
    run({ conclusion: 'skipped', head_branch: 'feat/a' }),
    run({ name: 'E2E', conclusion: 'timed_out' }),
    run({}),
  ];

  it('groups red runs by workflow, branch and event', () => {
    assert.deepEqual(failuresBy(runs), [
      ['CI · feat/a · pull_request', 2],
      ['E2E · main · push', 1],
    ]);
  });

  it('rates branches over completed, non-skipped runs, worst first', () => {
    const [a, main] = branchFailureRates(runs);
    assert.deepEqual(a, { branch: 'feat/a', red: 2, total: 3, rate: 2 / 3 });
    assert.equal(main?.branch, 'main');
    assert.equal(main?.rate, 0.5);
  });
});

describe('flakes', () => {
  it('counts pass-after-retry and download-retry warnings, keyed by flow', () => {
    const ann = [
      {
        annotation_level: 'warning',
        title: 'E2E flake (map)',
        message: '.maestro/smoke.yaml failed once and passed on retry; see …',
      },
      {
        annotation_level: 'warning',
        title: 'E2E flake (map)',
        message: '.maestro/smoke.yaml failed once …',
      },
      {
        annotation_level: 'warning',
        title: 'Android SDK download retried',
        message: 'attempt 2 …',
      },
      { annotation_level: 'warning', title: 'The ubuntu-latest label will migrate', message: '…' },
      { annotation_level: 'failure', title: 'E2E flake (x)', message: 'not a warning' },
    ];
    assert.deepEqual(flakes(ann), [
      ['E2E flake (map): .maestro/smoke.yaml', 2],
      ['Android SDK download retried', 1],
    ]);
  });
});

describe('topCauses', () => {
  it('names the first failed step, or the platform when no step failed', () => {
    const jobs = [
      {
        workflow: 'E2E',
        job: { name: 'Flows (catalog)', steps: [{ name: 'Run flows', conclusion: 'failure' }] },
      },
      {
        workflow: 'E2E',
        job: { name: 'Flows (catalog)', steps: [{ name: 'Run flows', conclusion: 'failure' }] },
      },
      { workflow: 'Native', job: { name: 'iOS', steps: [] } },
    ];
    assert.deepEqual(topCauses(jobs), [
      ['E2E › Flows (catalog) › Run flows', 2],
      ['Native › iOS › (no failed step: runner/platform)', 1],
    ]);
  });
});

describe('renderReport', () => {
  it('renders every section, with explicit "none" lines', () => {
    const body = renderReport({
      from: at(0),
      to: at(168),
      redHoursMain: 0,
      failures: [],
      rates: [],
      flaky: [],
      causes: [],
      runCount: 0,
    });
    assert.match(body, /main red time: 0 h/);
    for (const s of ['Failed runs', 'Branch failure rate', 'Flaky', 'Top causes']) {
      assert.ok(body.includes(s), s);
    }
    assert.equal((body.match(/- none/g) ?? []).length, 3);
  });
});
