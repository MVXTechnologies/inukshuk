#!/usr/bin/env node
/**
 * Refuse to publish an OTA update whose `extra` has lost a credential.
 *
 * Installed apps read `extra` from the RUNNING update's manifest, not from
 * the store binary, and the manifest's `extra` is whatever app.config.ts
 * evaluated to on the machine that published it. A key missing there is
 * missing on every install that takes the update: Strava reports "not
 * configured in this build" (src/lib/strava.ts), error reports stop leaving
 * the device. Nothing fails at publish time — which is how the Strava keys,
 * registered only as EAS variables, went missing from OTA updates.
 *
 * ota-update.yml runs this right before `eas update`, in the same
 * environment, over the same public config the update manifest is built from
 * (`npx expo config --type public --json`). It prints which keys are present,
 * never their values.
 *
 * Usage:
 *   node scripts/ci/assert-update-extra.mjs \
 *     --require stravaClientId \
 *     --any-of errorReportEndpoint,errorReportToken
 *
 *   --require   keys that must be non-empty strings; `none` (or empty)
 *               requires nothing
 *   --any-of    keys of which at least one should be set; only a warning,
 *               because a build without an error-report channel is legal
 *               (reports queue on the device)
 *   --config    read the public config JSON from this file instead of
 *               running `expo config` (tests, debugging)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Split a comma-separated key list; `none` and blanks mean "no keys". */
export function parseKeyList(value) {
  if (value === undefined) return [];
  const keys = value
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return keys.length === 1 && keys[0] === 'none' ? [] : keys;
}

/** Read `--require`, `--any-of` and `--config` from argv (after the script path). */
export function parseArgs(argv) {
  const options = { require: [], anyOf: [], config: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== '--require' && flag !== '--any-of' && flag !== '--config') {
      throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    if (flag === '--require') options.require.push(...parseKeyList(value));
    else if (flag === '--any-of') options.anyOf.push(...parseKeyList(value));
    else options.config = value;
  }
  return options;
}

/**
 * Parse `expo config --json` output. The JSON is the whole of stdout today,
 * but a CLI notice printed ahead of it must not turn into a false failure,
 * so parsing starts at the first `{`.
 */
export function parseConfigOutput(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('expo config printed no JSON object');
  return JSON.parse(stdout.slice(start));
}

const isSet = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Judge a public Expo config. `problems` fail the publish; `warnings` are
 * printed as annotations; `notes` say what was found. None of them ever
 * contains a value — some of these keys are secrets.
 */
export function checkExtra(config, { require = [], anyOf = [] } = {}) {
  const extra =
    config !== null && typeof config === 'object' && typeof config.extra === 'object'
      ? (config.extra ?? {})
      : {};
  const problems = [];
  const warnings = [];
  const notes = [];

  for (const key of require) {
    if (isSet(extra[key])) notes.push(`extra.${key} is set`);
    else problems.push(`extra.${key} is empty — installs that take this update would lose it`);
  }
  if (anyOf.length > 0) {
    const present = anyOf.filter((key) => isSet(extra[key]));
    if (present.length > 0) notes.push(`extra.${present.join(', extra.')} set`);
    else warnings.push(`none of extra.${anyOf.join(', extra.')} is set`);
  }
  return { ok: problems.length === 0, problems, warnings, notes };
}

function loadPublicConfig(configPath) {
  if (configPath !== undefined) return parseConfigOutput(readFileSync(configPath, 'utf8'));
  // Inherits this process's environment: the check sees exactly what
  // `eas update` will evaluate app.config.ts with.
  const stdout = execFileSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return parseConfigOutput(stdout);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const verdict = checkExtra(loadPublicConfig(options.config), options);
  for (const line of verdict.notes) console.log(`assert-update-extra: ${line}`);
  for (const line of verdict.warnings) console.log(`::warning::assert-update-extra: ${line}`);
  for (const line of verdict.problems) console.log(`::error::assert-update-extra: ${line}`);
  if (!verdict.ok) {
    console.error(
      'assert-update-extra: not publishing. Set the missing values for this job ' +
        '(docs/DEPLOYMENT.md § Field updates), or narrow OTA_REQUIRED_EXTRA.',
    );
    process.exit(1);
  }
  console.log('assert-update-extra: pass');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
