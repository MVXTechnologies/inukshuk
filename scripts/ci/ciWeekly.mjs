/**
 * The weekly CI health report (.github/workflows/ci-health.yml › weekly).
 * Pure functions over GitHub API objects (workflow runs, jobs, annotations),
 * so the numbers are unit-tested (ciWeekly.test.mjs); the workflow only
 * fetches and posts.
 */

/** Conclusions that count as red: no green verdict was produced. */
export const RED = new Set(['failure', 'timed_out', 'startup_failure', 'cancelled']);

/**
 * Red for the per-run tables. A cancelled run on a branch is almost always a
 * newer push superseding it (concurrency), not a failure; on main it means a
 * commit got no verdict, which is red.
 */
export function isRed(r) {
  if (r.conclusion === 'cancelled') return r.head_branch === 'main';
  return RED.has(r.conclusion);
}

const HOUR = 3600 * 1000;
const time = (iso) => new Date(iso).getTime();

/**
 * main's runs in the window plus, for each workflow that ran in the window,
 * its last run BEFORE the window, so a workflow already red at the start
 * counts from the start. A workflow that did not run on main this week is
 * left out: its months-old last run says nothing about this week.
 */
export function withStateAtStart(windowRuns, earlierRuns) {
  const active = new Set(windowRuns.map((r) => r.workflow_id));
  const last = new Map();
  for (const r of earlierRuns) {
    if (!active.has(r.workflow_id)) continue;
    const prev = last.get(r.workflow_id);
    if (!prev || time(r.updated_at) > time(prev.updated_at)) last.set(r.workflow_id, r);
  }
  return [...windowRuns, ...last.values()];
}

/**
 * Hours in [since, now] during which main had at least one red workflow.
 * A workflow is red from the end of a red run until the end of its next
 * green run (or `now`). Intervals of different workflows are merged, so two
 * workflows red at once count once.
 */
export function redHours(mainRuns, since, now) {
  const byWorkflow = new Map();
  for (const r of mainRuns) {
    if (r.status !== 'completed') continue;
    const list = byWorkflow.get(r.workflow_id) ?? [];
    list.push(r);
    byWorkflow.set(r.workflow_id, list);
  }
  const intervals = [];
  for (const runs of byWorkflow.values()) {
    runs.sort((a, b) => time(a.updated_at) - time(b.updated_at));
    let redFrom = null;
    for (const r of runs) {
      const t = time(r.updated_at);
      if (RED.has(r.conclusion)) redFrom ??= t;
      else if (r.conclusion === 'success' && redFrom !== null) {
        intervals.push([redFrom, t]);
        redFrom = null;
      }
    }
    if (redFrom !== null) intervals.push([redFrom, now]);
  }
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, since), Math.min(b, now)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of clipped) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return Math.round((total / HOUR) * 10) / 10;
}

/** Red runs counted by `workflow · branch · event`, most first. */
export function failuresBy(runs) {
  const counts = new Map();
  for (const r of runs) {
    if (r.status !== 'completed' || !isRed(r)) continue;
    const key = `${r.name} · ${r.head_branch} · ${r.event}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Per branch: red / completed runs, worst rate first (ties: more runs first). */
export function branchFailureRates(runs) {
  const per = new Map();
  for (const r of runs) {
    if (r.status !== 'completed' || r.conclusion === 'skipped') continue;
    if (r.conclusion === 'cancelled' && !isRed(r)) continue;
    const e = per.get(r.head_branch) ?? { red: 0, total: 0 };
    e.total += 1;
    if (isRed(r)) e.red += 1;
    per.set(r.head_branch, e);
  }
  return [...per.entries()]
    .map(([branch, { red, total }]) => ({ branch, red, total, rate: red / total }))
    .sort((a, b) => b.rate - a.rate || b.total - a.total || a.branch.localeCompare(b.branch));
}

/**
 * Flakes and absorbed infra retries, from warning annotations the workflows
 * emit on a pass-after-retry ("E2E flake (…)", "Android SDK download
 * retried", "Maestro install retried", …). Keyed by the annotation title with
 * the shard/attempt detail kept for E2E flakes (the flow path).
 */
export function flakes(annotations) {
  const counts = new Map();
  for (const a of annotations) {
    if (a.annotation_level !== 'warning' || !a.title) continue;
    if (!/flake|retried/i.test(a.title)) continue;
    const flow = /^(\.maestro\/\S+\.yaml)/.exec(a.message ?? '')?.[1];
    const key = flow ? `${a.title}: ${flow}` : a.title;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Top causes: the first failed step of each red job, as `workflow › job › step`. */
export function topCauses(failedJobs, limit = 5) {
  const counts = new Map();
  for (const { workflow, job } of failedJobs) {
    const step =
      (job.steps ?? []).find((s) => s.conclusion === 'failure')?.name ??
      '(no failed step: runner/platform)';
    const key = `${workflow} › ${job.name} › ${step}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

/** The comment body. */
export function renderReport({ from, to, redHoursMain, failures, rates, flaky, causes, runCount }) {
  const list = (rows, fmt, none) => (rows.length ? rows.map(fmt).join('\n') : none);
  return [
    `## CI weekly · ${from.slice(0, 10)} → ${to.slice(0, 10)}`,
    '',
    `**main red time: ${redHoursMain} h** · ${runCount} completed runs`,
    '',
    '**Failed runs (workflow · branch · event)**',
    list(failures.slice(0, 10), ([k, n]) => `- ${n}× ${k}`, '- none'),
    '',
    '**Branch failure rate**',
    list(
      rates.filter((r) => r.red > 0).slice(0, 10),
      (r) => `- \`${r.branch}\`: ${Math.round(r.rate * 100)} % (${r.red}/${r.total})`,
      '- no branch had a red run',
    ),
    '',
    '**Flaky / retried (passed after a retry)**',
    list(flaky.slice(0, 10), ([k, n]) => `- ${n}× ${k}`, '- none'),
    '',
    '**Top causes (first failed step)**',
    list(causes, ([k, n]) => `- ${n}× ${k}`, '- none'),
  ].join('\n');
}
