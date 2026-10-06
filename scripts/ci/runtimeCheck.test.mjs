import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMMENT_MARKER,
  assessRuntime,
  buildLabel,
  changedSources,
  hotfixRemedy,
  latestBuild,
} from './runtimeCheck.mjs';

const fp = (hash, sources = []) => ({ hash, sources });
const both = (ios, android = ios) => ({ ios: fp(ios), android: fp(android) });
const build = (runtimeVersion, appBuildVersion = '18') => ({
  runtimeVersion,
  appVersion: '2.3.0',
  appBuildVersion,
  gitCommitHash: '17cfebb86db0368b0503d895ce075c6d9faa8829',
});
const REMEDY =
  ' Until then, fixes reach it as OTAs published from hotfix/2.3.x (cut at its commit 17cfebb): ' +
  'run ota-update.yml on that branch.';
const stores = (ios, android = ios) => ({ ios: build(ios), android: build(android, '61') });

const contains = (haystack, needle) =>
  assert.ok(haystack.includes(needle), `expected ${JSON.stringify(haystack)} to contain ${needle}`);

describe('buildLabel / latestBuild', () => {
  it('names the store build the way each store does', () => {
    assert.equal(buildLabel('ios', build('x')), '2.3.0 (build 18)');
    assert.equal(buildLabel('android', build('x', '61')), '2.3.0 (versionCode 61)');
  });

  it('takes the newest build and tolerates empty or odd lists', () => {
    assert.deepEqual(latestBuild([build('a'), build('b')]), build('a'));
    assert.equal(latestBuild([]), null);
    assert.equal(latestBuild(null), null);
    assert.equal(latestBuild([{ id: 'no runtime' }]), null);
  });

  it('reads the runtime from either eas-cli JSON shape', () => {
    // eas-cli 24+: runtime is an object (and the fingerprint hash is beside it).
    const v24 = {
      appVersion: '2.3.0',
      runtime: { id: 'r', version: 'abc' },
      fingerprint: { hash: 'abc' },
    };
    assert.equal(latestBuild([v24])?.runtimeVersion, 'abc');
    assert.equal(latestBuild([{ fingerprint: { hash: 'def' } }])?.runtimeVersion, 'def');
    // eas-cli 20: a top-level string.
    assert.equal(latestBuild([{ runtimeVersion: 'ghi' }])?.runtimeVersion, 'ghi');
  });
});

describe('changedSources', () => {
  it('lists changed, added and removed sources', () => {
    const before = fp('a', [
      { type: 'file', filePath: 'app.json', hash: '1' },
      { type: 'contents', id: 'expoConfig', hash: '2' },
      { type: 'dir', filePath: 'plugins', hash: '3' },
    ]);
    const after = fp('b', [
      { type: 'file', filePath: 'app.json', hash: '1' },
      { type: 'contents', id: 'expoConfig', hash: '9' },
      { type: 'dir', filePath: 'modules/x', hash: '4' },
    ]);
    assert.deepEqual(changedSources(before, after), [
      'contents:expoConfig',
      'dir:modules/x',
      'dir:plugins',
    ]);
  });
});

describe('assessRuntime on a pull request', () => {
  it('stays quiet when the PR does not touch the runtime', () => {
    const r = assessRuntime({
      event: 'pull_request',
      head: both('s'),
      base: both('s'),
      store: stores('s'),
    });
    assert.equal(r.prChangesRuntime, false);
    assert.deepEqual(r.warnings, []);
    contains(r.markdown, COMMENT_MARKER);
  });

  it('notes (without warning) that main itself already left a store build behind', () => {
    const r = assessRuntime({
      event: 'pull_request',
      head: both('drift', 's'),
      base: both('drift', 's'),
      store: stores('s'),
    });
    assert.equal(r.prChangesRuntime, false);
    assert.deepEqual(r.warnings, []);
    contains(r.markdown, 'iOS: main (not this PR) already differs from store 2.3.0 (build 18)');
    contains(r.markdown, 'hotfix/2.3.x');
  });

  it('warns that OTAs from main stop reaching the store build', () => {
    const r = assessRuntime({
      event: 'pull_request',
      head: both('new', 's'),
      base: both('s'),
      store: stores('s'),
    });
    assert.equal(r.prChangesRuntime, true);
    assert.deepEqual(r.warnings, [
      'iOS: this PR changes the native runtime; OTAs from main will no longer reach store ' +
        '2.3.0 (build 18) until the next store release.' +
        REMEDY,
    ]);
    contains(r.markdown, '### This PR changes the native runtime');
  });

  it('says when main had already diverged from the store build', () => {
    const r = assessRuntime({
      event: 'pull_request',
      head: both('newer'),
      base: both('new'),
      store: stores('s'),
    });
    assert.equal(r.warnings.length, 2);
    contains(r.warnings[0] ?? '', 'main had already diverged from store 2.3.0 (build 18)');
    contains(r.warnings[1] ?? '', 'store 2.3.0 (versionCode 61)');
  });

  it('notes, without warning, a PR that returns to the store runtime', () => {
    const r = assessRuntime({
      event: 'pull_request',
      head: both('s'),
      base: both('drift'),
      store: stores('s'),
    });
    assert.deepEqual(r.warnings, []);
    contains(r.markdown, 'reach it again after merge');
  });

  it('still warns when the store build cannot be read', () => {
    const r = assessRuntime({ event: 'pull_request', head: both('new'), base: both('s') });
    assert.equal(r.prChangesRuntime, true);
    contains(r.warnings[0] ?? '', 'could not be read');
  });

  it('lists the fingerprint sources the PR changed', () => {
    const r = assessRuntime({
      event: 'pull_request',
      head: {
        ios: fp('new', [{ type: 'dir', filePath: 'modules/inukshuk-proj', hash: '2' }]),
        android: fp('s'),
      },
      base: {
        ios: fp('s', [{ type: 'dir', filePath: 'modules/inukshuk-proj', hash: '1' }]),
        android: fp('s'),
      },
      store: stores('s'),
    });
    contains(r.markdown, 'iOS fingerprint sources that changed: `dir:modules/inukshuk-proj`');
  });
});

describe('assessRuntime on main', () => {
  it('is quiet when main matches the store builds', () => {
    const r = assessRuntime({ event: 'push', head: both('s'), store: stores('s') });
    assert.deepEqual(r.warnings, []);
    assert.equal(r.prChangesRuntime, false);
  });

  // The real case of 2026-10-06: #581 (build-proj.sh) moved main's iOS
  // runtime after iOS 2.3.0 build 18 was cut; Android main still matched vc63.
  it('flags the platform whose store build main left behind, and only that one', () => {
    const r = assessRuntime({
      event: 'push',
      head: both(
        'ceb5e692d12f26aa4274f89cc6fc2072972a0a34',
        '884f71ce994466a6eb2f4f045f1bcb16a61867d8',
      ),
      store: {
        ios: build('f81e7412f760923f6573f5ae5189cd88910e3a19'),
        android: build('884f71ce994466a6eb2f4f045f1bcb16a61867d8', '63'),
      },
    });
    assert.equal(r.warnings.length, 1);
    contains(r.warnings[0] ?? '', 'iOS: this commit');
    contains(r.warnings[0] ?? '', 'hotfix/2.3.x');
    contains(r.markdown, 'matches store 2.3.0 (versionCode 63)');
  });

  it('names the hotfix branch from the store build version', () => {
    assert.equal(
      hotfixRemedy({ appVersion: '10.12.3', gitCommitHash: 'abcdef0123' }),
      ' Until then, fixes reach it as OTAs published from hotfix/10.12.x (cut at its commit abcdef0): ' +
        'run ota-update.yml on that branch.',
    );
    contains(hotfixRemedy({}), 'a hotfix branch (cut at its commit)');
  });

  it('warns when main has diverged from a store build', () => {
    const r = assessRuntime({ event: 'push', head: both('s', 'new'), store: stores('s') });
    assert.deepEqual(r.warnings, [
      "Android: this commit's native runtime differs from store 2.3.0 (versionCode 61); OTAs " +
        'published from main no longer reach it until the next store release.' +
        REMEDY,
    ]);
  });
});
