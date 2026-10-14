/**
 * Recover missing catalog fragments from the published `docs/catalog/v2/`.
 *
 * `build-manifest.ts` rebuilds the WHOLE catalog from
 * `scripts/catalog/fragments/*.json`. The bulk fragments (US Topo, FSTopo) are
 * gitignored and only exist where the catalog was last published, so a
 * checkout that adds one source would otherwise publish a catalog missing
 * every source it does not have a fragment for. Run this first:
 *
 *   npx tsx scripts/catalog/recover-fragments-from-published.ts
 *   npx tsx scripts/catalog/build-manifest.ts
 *   git diff --stat docs/catalog    # only generatedAt, plus what you added
 *
 * For every source the published index declares:
 * - **no fragment on disk** → writes `fragments/<sourceId>.json` from the
 *   published rows (minus the recomputed `terrain`; see
 *   `@core/catalog/recoverFragments`), minified like the bulk crawlers write;
 * - **a fragment on disk** → leaves it alone and checks it still describes the
 *   published rows (same ids, same crawler fields), so a rebuild cannot
 *   silently change that source either. A mismatch exits 1.
 *
 * It never deletes anything and never touches the network.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recoverFragmentsFromPublished } from '../../src/core/catalog/recoverFragments';

/** Fields the generator adds on top of what a crawler writes. */
const GENERATOR_FIELDS = new Set(['kind', 'activities', 'scale', 'terrain']);

type Row = Record<string, unknown>;

/** Problems between an on-disk fragment and the published rows of its source. */
function compareExisting(fragmentRows: Row[], publishedRows: Row[]): string[] {
  const problems: string[] = [];
  const published = new Map(publishedRows.map((row) => [String(row.id), row]));
  const onDisk = new Set(fragmentRows.map((row) => String(row.id)));
  for (const id of published.keys()) {
    if (!onDisk.has(id)) problems.push(`published "${id}" is missing from the fragment`);
  }
  for (const row of fragmentRows) {
    const id = String(row.id);
    const pub = published.get(id);
    if (pub === undefined) {
      problems.push(`fragment "${id}" is not published`);
      continue;
    }
    for (const [key, value] of Object.entries(row)) {
      if (JSON.stringify(pub[key]) !== JSON.stringify(value)) {
        problems.push(`"${id}".${key}: fragment ${JSON.stringify(value)} ≠ published`);
      }
    }
    for (const key of Object.keys(pub)) {
      if (!(key in row) && !GENERATOR_FIELDS.has(key)) {
        problems.push(`"${id}".${key} is published but not in the fragment`);
      }
    }
  }
  return problems;
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fragmentsDir = join(scriptDir, 'fragments');
  const v2Dir = join(scriptDir, '..', '..', 'docs', 'catalog', 'v2');
  const shardsDir = join(v2Dir, 'shards');

  const rawIndex = JSON.parse(readFileSync(join(v2Dir, 'index.json'), 'utf8')) as unknown;
  const rawShards = new Map<string, unknown>();
  for (const file of readdirSync(shardsDir).sort()) {
    if (!file.endsWith('.json')) continue;
    rawShards.set(
      file.slice(0, -'.json'.length),
      JSON.parse(readFileSync(join(shardsDir, file), 'utf8')),
    );
  }

  const { fragments, total } = recoverFragmentsFromPublished(rawIndex, rawShards);
  console.log(`published: ${total} items in ${rawShards.size} shards`);

  let failed = false;
  for (const [sourceId, fragment] of fragments) {
    const path = join(fragmentsDir, `${sourceId}.json`);
    if (existsSync(path)) {
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { items?: Row[] };
      const problems = compareExisting(onDisk.items ?? [], fragment.items);
      if (problems.length > 0) {
        failed = true;
        console.error(`${sourceId}: on-disk fragment disagrees with the published catalog:`);
        for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
        if (problems.length > 20) console.error(`  … ${problems.length - 20} more`);
      } else {
        console.log(
          `${sourceId}: kept the fragment on disk (${fragment.items.length} items, matches)`,
        );
      }
      continue;
    }
    writeFileSync(path, `${JSON.stringify(fragment)}\n`);
    console.log(`${sourceId}: recovered ${fragment.items.length} items → ${path}`);
  }
  if (failed) process.exitCode = 1;
}

main();
