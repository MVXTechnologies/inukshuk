import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMMENT_MARKER,
  assessRuntime,
  buildLabel,
  changedSources,
  latestBuild,
} from './runtimeCheck.mjs';

const fp = (hash, sources = []) => ({ hash, sources });
const both = (ios, android = ios) => ({ ios: fp(ios), android: fp(android) });
const build = (runtimeVersion, appBuildVersion = '18') => ({
  runtimeVersion,
  appVersion: '2.3.0',
  appBuildVersion,
});
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
        '2.3.0 (build 18) until the next store release.',
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

  it('warns when main has diverged from a store build', () => {
    const r = assessRuntime({ event: 'push', head: both('s', 'new'), store: stores('s') });
    assert.deepEqual(r.warnings, [
      "Android: this commit's native runtime differs from store 2.3.0 (versionCode 61); OTAs " +
        'published from main no longer reach it until the next store release.',
    ]);
  });
});
