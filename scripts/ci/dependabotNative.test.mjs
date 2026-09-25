import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The native-bearing dependency globs live in two files that cannot share
 * them: the auto-merge workflow (NATIVE_DEPENDENCIES, which holds the PRs
 * back) and dependabot.yml's `native` group (which bundles them into one PR).
 * A pattern added to one and not the other is either merged unattended or
 * split out of its group. No YAML parser here — the repo has none as a
 * direct dependency — so both lists are read by their fixed layout, and a
 * layout change fails loudly rather than reading as "no patterns".
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(resolve(repoRoot, path), 'utf8').split('\n');

/** Lines of the indented block that follows the line matching `header`. */
function blockAfter(lines, header) {
  const start = lines.findIndex((line) => header.test(line));
  assert.ok(start >= 0, `no line matching ${header}`);
  const indent = /^\s*/.exec(lines[start])[0].length;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (/^\s*/.exec(line)[0].length <= indent) break;
    block.push(line.trim());
  }
  return block;
}

const workflowList = () =>
  blockAfter(read('.github/workflows/dependabot-automerge.yml'), /^\s+NATIVE_DEPENDENCIES: \|$/);

const groupList = () => {
  const lines = read('.github/dependabot.yml');
  const group = lines.findIndex((line) => /^\s+native:$/.test(line));
  assert.ok(group >= 0, 'dependabot.yml has no `native` group');
  return blockAfter(lines.slice(group), /^\s+patterns:$/).map((line) => {
    const m = /^- '([^']+)'$/.exec(line);
    assert.ok(m, `unexpected pattern line ${JSON.stringify(line)}`);
    return m[1];
  });
};

describe('native-bearing dependencies', () => {
  it('are listed identically in the auto-merge workflow and the dependabot group', () => {
    assert.deepEqual([...groupList()].sort(), [...workflowList()].sort());
  });

  // The two packages that were auto-merged mid-runtime (28498e3, 7ffb3cc,
  // c6b7a49, 91df235) must never fall off the list.
  it('include the scopes that slipped through before', () => {
    for (const pattern of ['@maplibre/*', '@dr.pogodin/*']) {
      assert.ok(workflowList().includes(pattern), `${pattern} missing`);
    }
  });
});
