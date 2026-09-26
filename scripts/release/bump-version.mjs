#!/usr/bin/env node
/**
 * Bump the release numbers in one step, the same way every time.
 *
 * `npm version patch` moved only package.json's `version` (and made a tag),
 * leaving app.config.ts — the version the stores actually see — and the
 * build numbers to be edited by hand, and the two versions drifted (the lock
 * file still says 1.5.2 after 1.5.3 shipped). This moves them together:
 *
 * - `version` in package.json, app.config.ts and package-lock.json's root;
 * - iOS `buildNumber` + 1 and Android `versionCode` + 1 (every store upload
 *   needs a new one; neither store accepts a number it has seen before).
 *
 * It refuses to go backwards or sideways, refuses when package.json and
 * app.config.ts disagree about the current version, and refuses when a file
 * does not have exactly the shape it expects — it rewrites text, and a
 * guess at a moved field is worse than stopping. It does no git: it prints
 * the tag to create once the bump is committed. Release-note comments that
 * still mention the old numbers are listed for a human to rewrite.
 *
 * Usage (from the repo root; `npm run release:bump -- …` works too):
 *   node scripts/release/bump-version.mjs --version 1.6.0
 *   node scripts/release/bump-version.mjs --version minor [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `[major, minor, patch]` for a plain `x.y.z`, else null (no pre-releases). */
export function parseVersion(version) {
  const m = SEMVER.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive, like a sort comparator. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`cannot compare ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The version after `current` for `spec`: `major`, `minor`, `patch` or an
 * explicit `x.y.z`, which must be newer than `current`.
 */
export function nextVersion(current, spec) {
  const parsed = parseVersion(current);
  if (!parsed) throw new Error(`current version ${JSON.stringify(current)} is not x.y.z`);
  const [major, minor, patch] = parsed;
  let next;
  if (spec === 'major') next = `${major + 1}.0.0`;
  else if (spec === 'minor') next = `${major}.${minor + 1}.0`;
  else if (spec === 'patch') next = `${major}.${minor}.${patch + 1}`;
  else if (parseVersion(spec)) next = spec;
  else
    throw new Error(`--version must be major, minor, patch or x.y.z, not ${JSON.stringify(spec)}`);
  if (compareVersions(next, current) <= 0) {
    throw new Error(`refusing to go from ${current} to ${next}: a release must be newer`);
  }
  return next;
}

/** Replace the single match of `pattern` (which must capture prefix, value, suffix). */
function replaceExactlyOnce(text, pattern, file, field, replace) {
  const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(
      `${file}: expected exactly one ${field} line matching ${pattern}, found ${matches.length} — ` +
        'edit it by hand or teach scripts/release/bump-version.mjs the new shape',
    );
  }
  const [, prefix, value, suffix] = matches[0];
  return { value, text: text.replace(pattern, () => `${prefix}${replace(value)}${suffix}`) };
}

// Two-space indent = top level of the config object; four = inside ios/android.
const APP_VERSION = /^(  version: ')(\d+\.\d+\.\d+)(',)$/m;
const IOS_BUILD = /^(    buildNumber: ')(\d+)(',)$/m;
const ANDROID_CODE = /^(    versionCode: )(\d+)(,)$/m;

/** The numbers app.config.ts carries now. */
export function readAppConfig(text) {
  const read = (pattern, field) =>
    replaceExactlyOnce(text, pattern, 'app.config.ts', field, (v) => v).value;
  return {
    version: read(APP_VERSION, 'version'),
    buildNumber: Number(read(IOS_BUILD, 'ios.buildNumber')),
    versionCode: Number(read(ANDROID_CODE, 'android.versionCode')),
  };
}

/** app.config.ts with the new version and both build numbers incremented. */
export function bumpAppConfig(text, version) {
  let out = replaceExactlyOnce(text, APP_VERSION, 'app.config.ts', 'version', () => version).text;
  out = replaceExactlyOnce(out, IOS_BUILD, 'app.config.ts', 'ios.buildNumber', (v) =>
    String(Number(v) + 1),
  ).text;
  out = replaceExactlyOnce(out, ANDROID_CODE, 'app.config.ts', 'android.versionCode', (v) =>
    String(Number(v) + 1),
  ).text;
  return out;
}

const PACKAGE_VERSION = /^(  "version": ")([^"]*)(",)$/m;

/** package.json's `version`. */
export function readPackageVersion(text) {
  return replaceExactlyOnce(text, PACKAGE_VERSION, 'package.json', 'version', (v) => v).value;
}

/** package.json with a new `version`; nothing else may change. */
export function bumpPackageJson(text, version) {
  const out = replaceExactlyOnce(text, PACKAGE_VERSION, 'package.json', 'version', () => version);
  const before = JSON.parse(text);
  const after = JSON.parse(out.text);
  if (
    after.version !== version ||
    JSON.stringify({ ...after, version: before.version }) !== JSON.stringify(before)
  ) {
    throw new Error('package.json: the version edit touched something else');
  }
  return out.text;
}

// The lock repeats the root version twice: top level, and packages[""].
const LOCK_TOP = /^(\{\n  "name": "[^"]+",\n  "version": ")([^"]*)(",)/;
const LOCK_ROOT = /^(    "": \{\n      "name": "[^"]+",\n      "version": ")([^"]*)(",)$/m;

/**
 * package-lock.json with its two root `version` fields set. They are only
 * labels (npm ci does not check them), so their current value is not
 * judged — the lock has drifted before — but their place is.
 */
export function bumpPackageLock(text, version) {
  let out = replaceExactlyOnce(text, LOCK_TOP, 'package-lock.json', 'version', () => version).text;
  out = replaceExactlyOnce(
    out,
    LOCK_ROOT,
    'package-lock.json',
    'packages[""].version',
    () => version,
  ).text;
  const lock = JSON.parse(out);
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error('package-lock.json: the version edit did not land where expected');
  }
  return out;
}

/**
 * Lines outside the version fields that still mention an old number — the
 * hand-written release notes above them ("1.5.3: the map front…", "Play
 * build 54 ships 1.5.3"), which only a human can rewrite. A build number
 * only counts next to a word that names it ("build 8", "vc54"); a bare 8 is
 * far more likely an issue number.
 */
export function staleMentions(text, { version, buildNumber, versionCode }) {
  const fields = [APP_VERSION, IOS_BUILD, ANDROID_CODE].map((p) => new RegExp(p.source));
  const v = version.replace(/\./g, '\\.');
  const mention = new RegExp(
    `(?:^|[^\\d.])${v}(?![\\d.]*\\d)|\\b(?:build|vc|versionCode|buildNumber)\\s*(?:${buildNumber}|${versionCode})\\b`,
    'i',
  );
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (fields.some((f) => f.test(line))) return;
    if (mention.test(line)) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

/**
 * Plan the whole bump from the three files' contents. Pure: returns the new
 * contents and what changed; the caller writes them.
 */
export function planBump({ packageJson, appConfig, packageLock }, spec) {
  const pkgVersion = readPackageVersion(packageJson);
  const app = readAppConfig(appConfig);
  if (pkgVersion !== app.version) {
    throw new Error(
      `package.json says ${pkgVersion} but app.config.ts says ${app.version}; ` +
        'make them agree by hand first — which one is right is not a guess to automate',
    );
  }
  const version = nextVersion(app.version, spec);
  const to = { version, buildNumber: app.buildNumber + 1, versionCode: app.versionCode + 1 };
  const nextAppConfig = bumpAppConfig(appConfig, version);
  return {
    from: app,
    to,
    tag: `v${version}`,
    files: {
      'package.json': bumpPackageJson(packageJson, version),
      'app.config.ts': nextAppConfig,
      'package-lock.json': bumpPackageLock(packageLock, version),
    },
    stale: staleMentions(nextAppConfig, app),
  };
}

/** `--version <spec>` and `--dry-run`. */
export function parseArgs(argv) {
  let spec;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--version') {
      spec = argv[i + 1];
      i++;
      if (spec === undefined) throw new Error('--version needs a value');
    } else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (spec === undefined)
    throw new Error('usage: bump-version.mjs --version <x.y.z|major|minor|patch> [--dry-run]');
  return { spec, dryRun };
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { spec, dryRun } = parseArgs(process.argv.slice(2));
  const names = ['package.json', 'app.config.ts', 'package-lock.json'];
  const read = (name) => readFileSync(resolve(repoRoot, name), 'utf8');
  const plan = planBump(
    { packageJson: read(names[0]), appConfig: read(names[1]), packageLock: read(names[2]) },
    spec,
  );

  const row = (label, from, to) => console.log(`${label.padEnd(20)}${from} -> ${to}`);
  row('version', plan.from.version, plan.to.version);
  row('iOS buildNumber', plan.from.buildNumber, plan.to.buildNumber);
  row('Android versionCode', plan.from.versionCode, plan.to.versionCode);
  if (dryRun) {
    console.log('(dry run: nothing written)');
  } else {
    for (const name of names) writeFileSync(resolve(repoRoot, name), plan.files[name]);
    console.log(`updated ${names.join(', ')}`);
  }
  if (plan.stale.length > 0) {
    console.log('\napp.config.ts comments still mention the old numbers — rewrite them by hand:');
    for (const { line, text } of plan.stale) console.log(`  app.config.ts:${line}  ${text}`);
  }
  console.log(`\nOnce the bump is committed, tag it (release.yml builds on v* tags):`);
  console.log(`  git tag ${plan.tag} && git push origin ${plan.tag}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`bump-version: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
