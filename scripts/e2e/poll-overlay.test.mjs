import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = new URL('./poll-overlay.sh', import.meta.url).pathname;

// A fake screen: CAPTURE writes the attempt number into the "PNG"; CHECK passes
// once the screen shows attempt >= PASS_AT (attempt 1 is the flow's own shot).
function run({ first, passAt, deadline = '5', interval = '0' }) {
  const dir = mkdtempSync(join(tmpdir(), 'poll-overlay-'));
  const counter = join(dir, 'n');
  writeFileSync(counter, '1');
  const env = {
    ...process.env,
    CAPTURE: `n=$(( $(cat ${counter}) + 1 )); echo $n > ${counter}; echo $n > "$1"`,
    CHECK: `n=$(cat "$1"); echo "samples $n"; [ "$n" -ge ${passAt} ]`,
  };
  const firstShot = join(dir, 'first.png');
  if (first) writeFileSync(firstShot, '1');
  const r = spawnSync('bash', [SCRIPT, first ? firstShot : '-', deadline, interval], {
    env,
    cwd: dir,
    encoding: 'utf8',
  });
  return { ...r, dir };
}

test("passes on the flow's own screenshot without capturing", () => {
  const r = run({ first: true, passAt: 1 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /attempt 1 at \d+ s: samples 1/);
  assert.match(r.stdout, /passed on attempt 1 at \d+ s/);
  assert.equal(existsSync(join(r.dir, 'pdf-overlays-map-passed.png')), false);
});

test('captures again until the overlay is there, logging every attempt', () => {
  const r = run({ first: true, passAt: 3 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /attempt 1 at \d+ s: samples 1\n/);
  assert.match(r.stdout, /attempt 2 at \d+ s: samples 2\n/);
  assert.match(r.stdout, /passed on attempt 3 at \d+ s/);
  assert.equal(readFileSync(join(r.dir, 'pdf-overlays-map-passed.png'), 'utf8').trim(), '3');
});

test('fails at the deadline, keeping the last screen', () => {
  const r = run({ first: true, passAt: 99, deadline: '2', interval: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /pdf-overlays pixels FAILED: \d+ attempt\(s\) in \d+ s \(deadline 2 s\)/);
  assert.ok(existsSync(join(r.dir, 'pdf-overlays-map-last.png')));
});

test('captures the first shot itself when the flow left none', () => {
  const r = run({ first: false, passAt: 2 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /passed on attempt 1 at \d+ s/);
});

test('is valid bash', () => {
  execFileSync('bash', ['-n', SCRIPT]);
});
