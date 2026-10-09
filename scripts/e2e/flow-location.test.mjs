import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = new URL('./flow-location.sh', import.meta.url).pathname;
const REPO = new URL('../../', import.meta.url).pathname;

function run(flowText) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-location-'));
  const file = join(dir, 'flow.yaml');
  writeFileSync(file, flowText);
  return spawnSync('bash', [SCRIPT, file], { encoding: 'utf8' });
}

test("prints the flow's first setLocation", () => {
  const r = run(
    [
      'appId: x',
      '---',
      '- launchApp',
      '- setLocation:',
      '    latitude: 47.4',
      '    longitude: -53.85',
      '- tapOn: Map',
      '- setLocation:',
      '    latitude: 1',
      '    longitude: 2',
    ].join('\n'),
  );
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '47.4 -53.85');
});

test('fails when the flow sets no location', () => {
  const r = run(['appId: x', '---', '- launchApp', '- tapOn: Map'].join('\n'));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

test('reads pdf-overlays.yaml (the flow the runner polls)', () => {
  const r = spawnSync('bash', [SCRIPT, join(REPO, '.maestro/pdf-overlays.yaml')], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^-?\d+(\.\d+)? -?\d+(\.\d+)?$/);
});
