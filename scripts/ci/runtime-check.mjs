#!/usr/bin/env node
/**
 * CLI for the OTA runtime-match check (see runtimeCheck.mjs).
 *
 *   node scripts/ci/runtime-check.mjs --event pull_request --dir <dir> --out report.md
 *
 * <dir> holds the inputs the workflow wrote:
 *   head-ios.json, head-android.json   `npx expo-updates fingerprint:generate` of this commit
 *   base-ios.json, base-android.json   the same for the PR base (PRs only; optional)
 *   store-ios.json, store-android.json `eas build:list --json` (optional: no EXPO_TOKEN → absent)
 *
 * Writes the markdown report, prints each warning as a GitHub `::warning::`
 * annotation, and sets `changed=true|false` in $GITHUB_OUTPUT. Exit status is
 * 0 whatever the verdict: the check warns, it never fails a build. Missing or
 * unreadable fingerprints of THIS commit are an error, though.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { PLATFORMS, assessRuntime, latestBuild } from './runtimeCheck.mjs';

const { values } = parseArgs({
  options: {
    event: { type: 'string', default: 'push' },
    dir: { type: 'string', default: '.' },
    out: { type: 'string' },
  },
});

const readJson = (name, required) => {
  const path = join(values.dir, name);
  if (!existsSync(path)) {
    if (required) throw new Error(`missing ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (required) throw err;
    process.stderr.write(`ignoring unreadable ${path}: ${err.message}\n`);
    return null;
  }
};

const head = {};
const base = {};
const store = {};
let haveBase = true;
for (const p of PLATFORMS) {
  head[p] = readJson(`head-${p}.json`, true);
  base[p] = readJson(`base-${p}.json`, false);
  if (!base[p]) haveBase = false;
  store[p] = latestBuild(readJson(`store-${p}.json`, false));
}

const report = assessRuntime({ event: values.event, head, base: haveBase ? base : null, store });
if (values.out) writeFileSync(values.out, report.markdown);
process.stdout.write(report.markdown);
for (const w of report.warnings) {
  // Annotation text is one line; '%' and newlines are escaped per the spec.
  process.stdout.write(
    `::warning title=Native runtime::${w.replace(/%/g, '%25').replace(/\n/g, '%0A')}\n`,
  );
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${report.prChangesRuntime}\n`);
}
