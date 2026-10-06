import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  clearsState,
  flowTags,
  ownsLocation,
  shardFlows,
  shardNames,
  validateShards,
} from './e2eShards.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const maestroDir = join(repoRoot, '.maestro');

const plan = (over = {}) => ({
  shards: { a: ['one.yaml', 'two.yaml'], b: ['three.yaml'] },
  requires: {},
  parked: {},
  ...over,
});
const FILES = ['one.yaml', 'two.yaml', 'three.yaml'];
const SOURCES = Object.fromEntries(FILES.map((f) => [f, 'appId: x\n---\n- launchApp\n']));

describe('the real plan (.maestro/shards.json)', () => {
  it('puts every flow in exactly one shard or parks it, and respects its ordering rules', () => {
    const manifest = JSON.parse(readFileSync(join(maestroDir, 'shards.json'), 'utf8'));
    const files = readdirSync(maestroDir).filter((f) => f.endsWith('.yaml'));
    const sources = Object.fromEntries(
      files.map((f) => [f, readFileSync(join(maestroDir, f), 'utf8')]),
    );
    assert.deepEqual(validateShards(manifest, files, sources), []);
  });

  it('marks the flows that place the user themselves (position taps, far-away fixtures) as owning the location', () => {
    for (const flow of ['heatmap.yaml', 'waypoint-bubble.yaml', 'pdf-overlays.yaml']) {
      assert.ok(ownsLocation(readFileSync(join(maestroDir, flow), 'utf8')), flow);
    }
  });
});

describe('shardNames', () => {
  it('lists every shard by default and for "all"', () => {
    assert.deepEqual(shardNames(plan()), ['a', 'b']);
    assert.deepEqual(shardNames(plan(), 'all'), ['a', 'b']);
  });

  it('narrows to the named shards, keeping manifest order', () => {
    assert.deepEqual(shardNames(plan(), 'b, a'), ['a', 'b']);
    assert.deepEqual(shardNames(plan(), 'b'), ['b']);
  });

  it('refuses an unknown name instead of running nothing', () => {
    assert.throws(() => shardNames(plan(), 'a,typo'), /unknown shard\(s\): typo/);
  });
});

describe('shardFlows', () => {
  it('returns the flows in run order', () => {
    assert.deepEqual(shardFlows(plan(), 'a'), ['one.yaml', 'two.yaml']);
  });

  it('refuses an unknown shard', () => {
    assert.throws(() => shardFlows(plan(), 'zzz'), /unknown shard: zzz/);
  });
});

describe('flowTags / ownsLocation / clearsState', () => {
  it('reads block-list tags from the header only', () => {
    const src = 'appId: x\ntags:\n  - own-location\n  - slow\n---\n- tapOn: own-location\n';
    assert.deepEqual(flowTags(src), ['own-location', 'slow']);
    assert.equal(ownsLocation(src), true);
  });

  it('reads inline tags', () => {
    assert.deepEqual(flowTags("appId: x\ntags: ['own-location', b]\n---\n"), ['own-location', 'b']);
  });

  it('ignores the tag word in comments and commands', () => {
    assert.equal(ownsLocation('# own-location\nappId: x\n---\n- tapOn: own-location\n'), false);
  });

  it('spots a launchApp that clears state', () => {
    assert.equal(clearsState('---\n- launchApp:\n    clearState: true\n'), true);
    assert.equal(clearsState('---\n- launchApp:\n    clearState: false\n'), false);
  });
});

describe('validateShards', () => {
  it('accepts a valid plan', () => {
    assert.deepEqual(validateShards(plan(), FILES, SOURCES), []);
  });

  it('flags a flow that is in no shard and not parked', () => {
    const files = [...FILES, 'new.yaml'];
    assert.deepEqual(validateShards(plan(), files, SOURCES), [
      'new.yaml is in no shard and not parked: add it to a shard (or park it, with why)',
    ]);
    assert.deepEqual(
      validateShards(plan({ parked: { 'new.yaml': 'flagged off' } }), files, SOURCES),
      [],
    );
  });

  it('flags duplicates, missing files and reasonless parking', () => {
    const problems = validateShards(
      plan({
        shards: { a: ['one.yaml', 'two.yaml'], b: ['three.yaml', 'one.yaml', 'gone.yaml'] },
        parked: { 'two.yaml': ' ' },
      }),
      FILES,
      SOURCES,
    );
    assert.ok(problems.includes('one.yaml is in both a and b'));
    assert.ok(problems.includes('gone.yaml (shard b) does not exist'));
    assert.ok(problems.includes('two.yaml is both parked and in shard a'));
    assert.ok(problems.includes('parked two.yaml needs a reason'));
  });

  it('requires dependencies earlier in the same shard', () => {
    const ok = plan({ requires: { 'two.yaml': ['one.yaml'] } });
    assert.deepEqual(validateShards(ok, FILES, SOURCES), []);
    const otherShard = plan({ requires: { 'three.yaml': ['one.yaml'] } });
    assert.deepEqual(validateShards(otherShard, FILES, SOURCES), [
      'three.yaml requires one.yaml earlier in the same shard (b)',
    ]);
    const wrongOrder = plan({ requires: { 'one.yaml': ['two.yaml'] } });
    assert.deepEqual(validateShards(wrongOrder, FILES, SOURCES), [
      'one.yaml requires two.yaml earlier in the same shard (a)',
    ]);
  });

  it('keeps clearState flows and declared "last" flows at the end of their shard', () => {
    const sources = { ...SOURCES, 'one.yaml': '---\n- launchApp:\n    clearState: true\n' };
    assert.deepEqual(validateShards(plan(), FILES, sources), [
      'one.yaml must be the last flow of shard a',
    ]);
    assert.deepEqual(validateShards(plan({ last: { 'one.yaml': 'why' } }), FILES, SOURCES), [
      'one.yaml must be the last flow of shard a',
    ]);
  });
});
