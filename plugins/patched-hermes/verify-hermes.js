#!/usr/bin/env node
// @ts-check
/**
 * Checks libhermesvm.so files against our fiber-free Hermes (#648). Directories
 * are searched recursively for libhermesvm.so; finding none is an error, so a
 * moved AGP output can never pass the check by having nothing to look at.
 *
 *   verify-hermes.js packaged <dir|.so>...
 *       Every Android build (Gradle task verifyPatchedHermes<Variant>, added by
 *       plugins/withPatchedHermes.js): each library about to be packaged must
 *       have a build-id pinned in artifact.json and no Boost.Context fibers.
 *       Exit 1 otherwise: the build fails.
 *   verify-hermes.js expect-fiber-free <dir|.so>...
 *   verify-hermes.js expect-fibers <dir|.so>...
 *       hermes-android.yml: no library of the fresh build links fibers; every
 *       library of Meta's prebuilt does (the negative control proving the
 *       check can fail).
 *   verify-hermes.js describe <dir|.so>...
 *       JSON: path → { abi, buildId, fibers, size }.
 */
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');

const { describeLib, fiberProblems, packagedProblems } = require('./hermesCheck');

const LIB = 'libhermesvm.so';

/** @param {string} p @returns {string[]} */
function findLibs(p) {
  const st = statSync(p);
  if (st.isFile()) return [p];
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const child = join(p, entry.name);
    if (entry.isDirectory()) out.push(...findLibs(child));
    else if (entry.isFile() && entry.name === LIB) out.push(child);
  }
  return out.sort();
}

/** @param {string[]} argv */
function main(argv) {
  const [mode, ...paths] = argv;
  if (!mode || paths.length === 0) {
    console.error(
      'usage: verify-hermes.js packaged|expect-fiber-free|expect-fibers|describe <dir|.so>...',
    );
    return 2;
  }
  const libs = paths.flatMap(findLibs);
  if (libs.length === 0) {
    console.error(`::error::No ${LIB} found under ${paths.join(', ')}`);
    return 1;
  }
  const infos = libs.map((path) => ({ path, info: describeLib(readFileSync(path)) }));
  if (mode === 'describe') {
    console.log(JSON.stringify(Object.fromEntries(infos.map((x) => [x.path, x.info])), null, 2));
    return 0;
  }

  /** @type {(info: import('./hermesCheck').LibInfo) => string[]} */
  let judge;
  if (mode === 'packaged') {
    const artifact = require('./artifact.json');
    judge = (info) => packagedProblems(info, artifact);
  } else if (mode === 'expect-fiber-free') {
    judge = fiberProblems;
  } else if (mode === 'expect-fibers') {
    judge = (info) =>
      info.fibers === 'present' ? [] : ['expected Boost.Context fibers, found none'];
  } else {
    console.error(`unknown mode ${mode}`);
    return 2;
  }

  let failed = 0;
  for (const { path, info } of infos) {
    const problems = judge(info);
    const rel = relative(process.cwd(), path);
    const where = rel && !rel.startsWith('..') ? rel : path;
    const summary = `${info.abi ?? '?'} build-id ${info.buildId ?? '-'} fibers ${info.fibers}`;
    if (problems.length) {
      failed++;
      for (const p of problems) console.error(`::error::${where}: ${p}`);
    } else {
      console.log(`ok  ${where}: ${summary}`);
    }
  }
  if (failed) {
    console.error(
      mode === 'packaged'
        ? `Patched Hermes check FAILED (${failed}/${infos.length}): this build would ship a Hermes ` +
            'that runs its compiler on fibers, which crashes under GWP-ASan (#648). ' +
            'See docs/CI.md › Patched Hermes.'
        : `${mode}: ${failed}/${infos.length} libraries failed`,
    );
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { findLibs, main };
