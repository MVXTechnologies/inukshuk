#!/usr/bin/env node
/**
 * Expo Doctor as a gate that can still say something (#338).
 *
 * `expo-doctor` exits non-zero when ANY of its checks fails, so one known,
 * tracked finding — the Hermes V1 memory regression in SDK 56, whose only
 * remedy is the SDK 57 upgrade — made the nightly red every single night. A
 * gate that is always red reports nothing: a genuinely new failure looks
 * exactly like the standing one.
 *
 * This runs the same checks and applies the acknowledgements in
 * `expo-doctor-acknowledged.jsonc`, the way `audit-ci.jsonc` already does for
 * security advisories. See `expoDoctorGate.mjs` for the rules.
 *
 * Usage: node scripts/ci/expo-doctor-gate.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideDoctorGate, parseDoctorOutput, stripJsonComments } from './expoDoctorGate.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function runDoctor() {
  try {
    return execFileSync('npx', ['expo-doctor'], { encoding: 'utf8' });
  } catch (err) {
    // A non-zero exit is the normal path when a check fails; the report we
    // need is on stdout either way.
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const output = runDoctor();
process.stdout.write(output);

const config = JSON.parse(
  stripJsonComments(readFileSync(resolve(repoRoot, 'expo-doctor-acknowledged.jsonc'), 'utf8')),
);
const verdict = decideDoctorGate({
  report: parseDoctorOutput(output),
  acknowledgements: config.acknowledged ?? [],
  today: new Date().toISOString().slice(0, 10),
});

for (const line of verdict.notes) console.log(`expo-doctor gate: ${line}`);
if (verdict.ok) {
  console.log('expo-doctor gate: pass');
  process.exit(0);
}
for (const line of verdict.problems) console.error(`expo-doctor gate: ${line}`);
process.exit(1);
