#!/usr/bin/env node
/**
 * Relay CI gates (security review 2026-10 §6.3). Plain Node, no
 * dependencies; exits 1 with one line per violation.
 *
 *   node gates.mjs [workerDir]
 *
 * 1. R-RLY-1 / R-META-2: no storage, no writes, no logging in the Worker's
 *    sources (tests excluded): `storage.`, `.put(`, `console.`, SQL, KV/R2/D1
 *    types.
 * 2. wrangler.toml: Workers Logs off, the three rate-limiting bindings present,
 *    no KV / R2 / D1 / Analytics Engine / queue binding, Durable Object classes
 *    declared SQLite-backed only (the Free plan's kind; left unused), the
 *    Worker named inukshuk-rtc (never the tiles Worker), no secret in [vars].
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] ?? dirname(fileURLToPath(import.meta.url));
const problems = [];

const FORBIDDEN_CODE = [
  [/storage\./, 'storage access'],
  [/\.put\(/, 'a .put( write'],
  [/console\./, 'a console call'],
  [/\.sql\b/, 'SQL access'],
  [/\b(KVNamespace|R2Bucket|D1Database|AnalyticsEngineDataset)\b/, 'a storage binding type'],
];

function walk(path) {
  if (statSync(path).isDirectory()) return readdirSync(path).flatMap((f) => walk(join(path, f)));
  return [path];
}

const srcDir = join(dir, 'src');
for (const file of walk(srcDir)) {
  if (!/\.(ts|js|mjs)$/.test(file) || /\.test\.(ts|js|mjs)$/.test(file)) continue;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const [re, what] of FORBIDDEN_CODE) {
        if (re.test(line))
          problems.push(`${relative(dir, file)}:${i + 1}: ${what}: ${line.trim()}`);
      }
    });
}

const toml = readFileSync(join(dir, 'wrangler.toml'), 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*$/, '').trim())
  .filter((l) => l !== '');

/** `key = value` lines of one `[table]` (not array tables). */
function table(name) {
  const out = {};
  let inside = false;
  for (const line of toml) {
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      inside = header[1] === name && !line.startsWith('[[');
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (inside && kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const top = {};
for (const line of toml) {
  if (line.startsWith('[')) break;
  const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
  if (kv) top[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
}
if (top.name !== 'inukshuk-rtc')
  problems.push(`wrangler.toml: name must be "inukshuk-rtc" (R-OPS-1), is ${top.name}`);

const obs = table('observability');
const logs = table('observability.logs');
if (obs.enabled !== 'false')
  problems.push('wrangler.toml: [observability] enabled must be false (R-META-2)');
if (logs.invocation_logs !== 'false')
  problems.push('wrangler.toml: invocation_logs must be false (R-META-2)');

for (const banned of [
  'kv_namespaces',
  'r2_buckets',
  'd1_databases',
  'analytics_engine_datasets',
  'queues.producers',
  'queues.consumers',
  'vectorize',
  'hyperdrive',
]) {
  if (toml.some((l) => l === `[[${banned}]]` || l === `[${banned}]`)) {
    problems.push(`wrangler.toml: [[${banned}]] is storage; the relay stores nothing (R-RLY-1)`);
  }
}
if (toml.some((l) => /^new_classes\s*=/.test(l))) {
  problems.push(
    'wrangler.toml: Durable Object classes must be new_sqlite_classes (Free plan), never new_classes',
  );
}

const limiters = toml
  .map((l, i) =>
    l === '[[ratelimits]]' ? /name\s*=\s*"([^"]+)"/.exec(toml[i + 1] ?? '')?.[1] : undefined,
  )
  .filter(Boolean);
for (const name of ['WS_LIMITER', 'AUTH_FAIL_LIMITER', 'TURN_LIMITER']) {
  if (!limiters.includes(name))
    problems.push(`wrangler.toml: rate-limiting binding ${name} missing (R-RL-1)`);
}

const vars = table('vars');
for (const secret of [
  'TURN_KEY_ID',
  'TURN_KEY_API_TOKEN',
  'CF_ACCOUNT_ID',
  'CF_ANALYTICS_TOKEN',
  'IP_TAG_KEY',
]) {
  if (secret in vars)
    problems.push(`wrangler.toml: ${secret} is a secret; use wrangler secret put`);
}
if (vars.TURN_ENABLED === undefined || vars.RTC_ENABLED === undefined) {
  problems.push(
    'wrangler.toml: the kill switches RTC_ENABLED and TURN_ENABLED must be in [vars] (R-TURN-4)',
  );
}

if (problems.length > 0) {
  process.stderr.write(problems.map((p) => `rtc gate: ${p}`).join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('rtc gates: ok\n');
