#!/usr/bin/env node
/**
 * CLI over the E2E shard plan (.maestro/shards.json, see e2eShards.mjs).
 *
 *   node scripts/ci/e2e-shards.mjs names [only]   JSON array of shard names
 *                                                 (the e2e.yml job matrix)
 *   node scripts/ci/e2e-shards.mjs flows <shard>  one line per flow, in order:
 *                                                 "<path> <own-location 0|1>"
 *   node scripts/ci/e2e-shards.mjs check          validate the plan
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ownsLocation, shardFlows, shardNames, validateShards } from './e2eShards.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const maestroDir = join(repoRoot, '.maestro');
const manifest = JSON.parse(readFileSync(join(maestroDir, 'shards.json'), 'utf8'));
const read = (flow) => readFileSync(join(maestroDir, flow), 'utf8');

const [command, arg = ''] = process.argv.slice(2);
try {
  if (command === 'names') {
    process.stdout.write(`${JSON.stringify(shardNames(manifest, arg))}\n`);
  } else if (command === 'flows') {
    for (const flow of shardFlows(manifest, arg)) {
      process.stdout.write(`.maestro/${flow} ${ownsLocation(read(flow)) ? 1 : 0}\n`);
    }
  } else if (command === 'check') {
    const files = readdirSync(maestroDir).filter((f) => f.endsWith('.yaml'));
    const sources = Object.fromEntries(files.map((f) => [f, read(f)]));
    const problems = validateShards(manifest, files, sources);
    for (const p of problems) process.stderr.write(`shards.json: ${p}\n`);
    process.exitCode = problems.length > 0 ? 1 : 0;
  } else {
    process.stderr.write('usage: e2e-shards.mjs names [only] | flows <shard> | check\n');
    process.exitCode = 2;
  }
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
