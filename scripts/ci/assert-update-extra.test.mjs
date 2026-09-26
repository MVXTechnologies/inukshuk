import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkExtra, parseArgs, parseConfigOutput, parseKeyList } from './assert-update-extra.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'assert-update-extra.mjs');

/** The shape `expo config --type public --json` prints, trimmed to what matters. */
const config = (extra) => ({ name: 'Inukshuk', runtimeVersion: { policy: 'fingerprint' }, extra });
const STRAVA = ['stravaClientId', 'stravaClientSecret'];
const REPORTS = ['errorReportEndpoint', 'errorReportToken'];

describe('checkExtra', () => {
  it('passes when every required key is set, and names them without their values', () => {
    const verdict = checkExtra(
      config({ stravaClientId: '12345', stravaClientSecret: 's3cret', errorReportToken: 'ghp_x' }),
      { require: STRAVA, anyOf: REPORTS },
    );
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.warnings, []);
    const printed = [...verdict.notes, ...verdict.problems, ...verdict.warnings].join('\n');
    assert.match(printed, /extra\.stravaClientId is set/);
    for (const secret of ['12345', 's3cret', 'ghp_x']) assert.ok(!printed.includes(secret));
  });

  // The field bug: Strava keys lived only in EAS, the runner had none.
  it('fails when a required key is missing', () => {
    const verdict = checkExtra(config({ eas: { projectId: 'p' } }), { require: STRAVA });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.problems.length, 2);
    assert.match(verdict.problems[0], /extra\.stravaClientId is empty/);
  });

  // GitHub renders an unset secret as '' — present, but empty.
  it('treats empty and whitespace-only values as missing', () => {
    for (const value of ['', '   ', null, 42]) {
      const verdict = checkExtra(config({ stravaClientId: value, stravaClientSecret: 'x' }), {
        require: STRAVA,
      });
      assert.equal(verdict.ok, false, `value ${JSON.stringify(value)}`);
    }
  });

  it('fails every required key when there is no extra at all', () => {
    assert.equal(checkExtra({ name: 'Inukshuk' }, { require: STRAVA }).problems.length, 2);
    assert.equal(checkExtra(null, { require: STRAVA }).ok, false);
  });

  it('only warns when no error-report channel is set', () => {
    const verdict = checkExtra(config({ stravaClientId: 'a', stravaClientSecret: 'b' }), {
      require: STRAVA,
      anyOf: REPORTS,
    });
    assert.equal(verdict.ok, true);
    assert.match(verdict.warnings.join(' '), /none of extra\.errorReportEndpoint/);
  });

  it('is satisfied by either error-report channel', () => {
    const verdict = checkExtra(config({ errorReportEndpoint: 'https://relay.example' }), {
      anyOf: REPORTS,
    });
    assert.deepEqual(verdict.warnings, []);
  });

  it('passes with nothing required', () => {
    assert.equal(checkExtra(config({}), {}).ok, true);
  });
});

describe('argument parsing', () => {
  it('reads comma lists, trimming blanks', () => {
    assert.deepEqual(parseKeyList(' a, b ,,c '), ['a', 'b', 'c']);
  });

  // The repo variable OTA_REQUIRED_EXTRA=none turns the requirement off.
  it('treats none and an empty list as no keys', () => {
    assert.deepEqual(parseKeyList('none'), []);
    assert.deepEqual(parseKeyList(''), []);
    assert.deepEqual(parseArgs(['--require', 'none']).require, []);
  });

  it('reads every flag', () => {
    assert.deepEqual(parseArgs(['--require', 'a,b', '--any-of', 'c', '--config', 'x.json']), {
      require: ['a', 'b'],
      anyOf: ['c'],
      config: 'x.json',
    });
  });

  it('rejects unknown flags and flags without a value', () => {
    assert.throws(() => parseArgs(['--requires', 'a']), /unknown argument/);
    assert.throws(() => parseArgs(['--require']), /needs a value/);
  });
});

describe('parseConfigOutput', () => {
  it('parses plain JSON', () => {
    assert.deepEqual(parseConfigOutput('{"extra":{"a":"b"}}\n'), { extra: { a: 'b' } });
  });

  it('skips a notice printed ahead of the JSON', () => {
    assert.deepEqual(parseConfigOutput('Some CLI notice\n{"extra":{}}'), { extra: {} });
  });

  it('throws when there is no JSON at all', () => {
    assert.throws(() => parseConfigOutput('npm ERR! missing script'), /no JSON object/);
  });
});

describe('the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assert-update-extra-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const run = (extra, ...args) => {
    const file = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(config(extra)));
    return spawnSync(process.execPath, [script, '--config', file, ...args], { encoding: 'utf8' });
  };

  it('exits 0 and annotates nothing when the credentials are there', () => {
    const extra = { stravaClientId: 'id-1', stravaClientSecret: 'secret-1' };
    const result = run(extra, '--require', STRAVA.join(','));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pass/);
    assert.ok(!result.stdout.includes('secret-1'), 'a secret value was printed');
  });

  it('exits 1 with a GitHub error annotation when one is missing', () => {
    const result = run({ stravaClientId: 'id-1' }, '--require', STRAVA.join(','));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::assert-update-extra: extra\.stravaClientSecret is empty/);
  });
});
