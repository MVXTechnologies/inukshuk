import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decideDoctorGate, parseDoctorOutput, stripJsonComments } from './expoDoctorGate.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The nightly's real output on 2026-09-10, trimmed to the shape that matters. */
const HERMES_CHECK = 'Check for Expo SDK versions affected by Hermes V1 regressions';
const REAL_OUTPUT = `Running 22 checks on your project...
21/22 checks passed. 1 checks failed. Possible issues detected:
Use the --verbose flag to see more details about passed checks.

✖ ${HERMES_CHECK}
This project uses Hermes V1 with expo@56.0.21, which is affected by a known memory regression.
Advice:
Upgrade to Expo SDK 57 and expo@57.0.9 or later
1 check failed, indicating possible issues with the project.
`;
const CLEAN_OUTPUT = 'Running 22 checks on your project...\n22/22 checks passed.\n';

const ack = (over = {}) => ({
  check: HERMES_CHECK,
  reason: 'no fix inside SDK 56',
  exitPlan: 'the SDK 57 upgrade',
  until: '2026-12-31',
  ...over,
});

const contains = (haystack, needle) =>
  assert.ok(String(haystack).includes(needle), `expected to contain ${JSON.stringify(needle)}`);

describe('parseDoctorOutput', () => {
  it('reads the failed check names and the totals', () => {
    const report = parseDoctorOutput(REAL_OUTPUT);
    assert.deepEqual(report.failed, [HERMES_CHECK]);
    assert.equal(report.passed, 21);
    assert.equal(report.total, 22);
    assert.equal(report.ran, true);
  });

  it('reads a clean run', () => {
    const report = parseDoctorOutput(CLEAN_OUTPUT);
    assert.deepEqual(report.failed, []);
    assert.equal(report.ran, true);
  });

  // A crash must never look like "nothing failed".
  it('marks output with no summary as not having run', () => {
    assert.equal(parseDoctorOutput('npm ERR! network timeout').ran, false);
  });
});

describe('decideDoctorGate', () => {
  const decide = (over = {}) =>
    decideDoctorGate({
      report: parseDoctorOutput(REAL_OUTPUT),
      acknowledgements: [ack()],
      today: '2026-09-10',
      ...over,
    });

  it('accepts the acknowledged finding and says so', () => {
    const verdict = decide();
    assert.equal(verdict.ok, true);
    contains(verdict.notes.join(' '), 'until 2026-12-31');
  });

  it('fails on a check nobody acknowledged', () => {
    const output = REAL_OUTPUT.replace(
      `✖ ${HERMES_CHECK}`,
      `✖ ${HERMES_CHECK}\n✖ Check that packages match versions required by installed Expo SDK`,
    );
    const verdict = decide({ report: parseDoctorOutput(output) });
    assert.equal(verdict.ok, false);
    contains(verdict.problems.join(' '), 'unacknowledged check failed');
    contains(verdict.problems.join(' '), 'packages match versions');
  });

  // The whole point: an accepted finding is re-argued on a date, not inherited.
  it('fails once the acknowledgement has expired', () => {
    const verdict = decide({ today: '2027-01-01' });
    assert.equal(verdict.ok, false);
    contains(verdict.problems.join(' '), 'expired on 2026-12-31');
    contains(verdict.problems.join(' '), 'the SDK 57 upgrade');
  });

  it('accepts it on the expiry date itself', () => {
    assert.equal(decide({ today: '2026-12-31' }).ok, true);
  });

  // A spent entry is worse than none: it hides the next real failure.
  it('fails when an acknowledged check has started passing', () => {
    const verdict = decide({ report: parseDoctorOutput(CLEAN_OUTPUT) });
    assert.equal(verdict.ok, false);
    contains(verdict.problems.join(' '), 'passes now');
  });

  it('fails when doctor itself did not run', () => {
    const verdict = decide({ report: parseDoctorOutput('npm ERR! network timeout') });
    assert.equal(verdict.ok, false);
    contains(verdict.problems.join(' '), 'did not produce a report');
  });

  it('rejects an acknowledgement missing its reason, exit plan or date', () => {
    for (const missing of ['reason', 'exitPlan', 'until']) {
      const entry = ack();
      delete entry[missing];
      const verdict = decide({ acknowledgements: [entry] });
      assert.equal(verdict.ok, false);
      contains(verdict.problems.join(' '), 'needs check, reason, exitPlan and until');
    }
  });

  it('passes a clean run with nothing acknowledged', () => {
    const verdict = decide({ report: parseDoctorOutput(CLEAN_OUTPUT), acknowledgements: [] });
    assert.equal(verdict.ok, true);
    contains(verdict.notes.join(' '), '22/22');
  });
});

describe('the checked-in acknowledgement file', () => {
  const config = JSON.parse(
    stripJsonComments(readFileSync(resolve(repoRoot, 'expo-doctor-acknowledged.jsonc'), 'utf8')),
  );

  it('parses, and every entry carries a reason, an exit plan and a date', () => {
    assert.ok(Array.isArray(config.acknowledged));
    for (const entry of config.acknowledged) {
      assert.equal(typeof entry.check, 'string');
      assert.ok(entry.reason.length > 20, 'a reason has to be a reason');
      assert.ok(entry.exitPlan.length > 20, 'an exit plan has to be a plan');
      assert.match(entry.until, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("accepts the nightly's real output", () => {
    const verdict = decideDoctorGate({
      report: parseDoctorOutput(REAL_OUTPUT),
      acknowledgements: config.acknowledged,
      today: new Date().toISOString().slice(0, 10),
    });
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.ok, true);
  });
});

describe('stripJsonComments', () => {
  it('removes line and block comments but not comment-like text in strings', () => {
    const parsed = JSON.parse(
      stripJsonComments('{\n // note\n "url": "https://x/y", /* mid */ "n": 1\n}'),
    );
    assert.deepEqual(parsed, { url: 'https://x/y', n: 1 });
  });
});
