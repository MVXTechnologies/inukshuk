/**
 * Catalog generator — merge per-source fragments into the published catalog.
 *
 * Reads every `scripts/catalog/fragments/*.json` (written by the
 * fetch-<source>.ts crawlers, or hand-curated), merges sources + items,
 * validates the result with the SAME parsers the app ships
 * (`src/core/catalog/schema`) and refuses to write anything those parsers would
 * warn about — the generator and the client cannot drift.
 *
 * Two documents come out:
 *
 * - **`docs/catalog/v2/`** — the world catalog: a small `index.json` (sources,
 *   per-category totals, shard directory) plus `shards/<id>.json`, planned by
 *   the shared `planCatalogShards` so shard ids are identical on both sides.
 *   Alongside them, `search.json` — the token -> shard digest that lets a query
 *   reach a sheet on the other side of the world without pulling the catalog.
 *   This is what current clients read.
 * - **`docs/catalog/v1/manifest.json`** — the legacy flat manifest, still
 *   published so builds shipped before the world catalog keep working. It
 *   carries only the fragments listed in {@link LEGACY_FRAGMENTS} (the original
 *   Canadian CanTopo set): those clients have no shard support, and pouring
 *   30 000 worldwide sheets into one JSON would be a multi-megabyte download on
 *   a phone that cannot page it.
 *
 * Usage:
 *   npx tsx scripts/catalog/build-manifest.ts
 *
 * The Pages site serves docs/ as its root, so this publishes at
 * /catalog/v2/index.json once pushed.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_INDEX_SCHEMA_VERSION,
  CATALOG_SCHEMA_VERSION,
  parseCatalogIndex,
  parseCatalogManifest,
  parseCatalogShard,
  type CatalogCategory,
  type CatalogItem,
  type CatalogShardRef,
  type CatalogSource,
} from '../../src/core/catalog/schema';
import {
  buildCatalogSearchDigest,
  parseCatalogSearchDigest,
} from '../../src/core/catalog/searchDigest';
import { planCatalogShards } from '../../src/core/catalog/shard';

/** Fragments that also feed the frozen v1 manifest for pre-world-catalog apps. */
const LEGACY_FRAGMENTS = new Set(['nrcan-cantopo.json']);

interface Fragment {
  sources?: CatalogSource[];
  items?: CatalogItem[];
}

function readFragments(dir: string): { sources: CatalogSource[]; items: CatalogItem[] } {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`no fragments in ${dir} — run a fetch-<source>.ts first`);
  }
  const sources: CatalogSource[] = [];
  const items: CatalogItem[] = [];
  for (const file of files) {
    const fragment = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Fragment;
    sources.push(...(fragment.sources ?? []));
    items.push(...(fragment.items ?? []));
    console.log(
      `${file}: ${fragment.sources?.length ?? 0} sources, ${fragment.items?.length ?? 0} items`,
    );
  }
  return { sources, items };
}

/** The legacy flat manifest: one fragment set, one file, schema v1. */
function writeLegacyManifest(dir: string, outPath: string): void {
  const sources: CatalogSource[] = [];
  const items: CatalogItem[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!LEGACY_FRAGMENTS.has(file)) continue;
    const fragment = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Fragment;
    sources.push(...(fragment.sources ?? []));
    items.push(...(fragment.items ?? []));
  }
  if (items.length === 0) {
    console.log('no legacy fragments — leaving /catalog/v1/manifest.json untouched');
    return;
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  const manifest = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sources,
    items,
  };
  const { manifest: parsed, warnings } = parseCatalogManifest(manifest);
  if (parsed === null || warnings.length > 0) {
    throw new Error(`legacy manifest failed validation:\n  ${warnings.join('\n  ')}`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${outPath} (v1, ${parsed.items.length} items — legacy clients)`);
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fragmentsDir = join(scriptDir, 'fragments');
  const docsDir = join(scriptDir, '..', '..', 'docs', 'catalog');
  const v2Dir = join(docsDir, 'v2');
  const shardsDir = join(v2Dir, 'shards');

  const { sources, items } = readFragments(fragmentsDir);

  // Drop duplicate ids up front so the shard plan and the parser agree on the
  // item count (the parser would silently drop the second occurrence later).
  const byId = new Map<string, CatalogItem>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  const unique = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (unique.length !== items.length) {
    console.log(`dropped ${items.length - unique.length} duplicate item ids across fragments`);
  }

  const sourceIds = new Set(sources.map((s) => s.id));
  const orphans = unique.filter((item) => !sourceIds.has(item.sourceId));
  if (orphans.length > 0) {
    throw new Error(
      `${orphans.length} items reference an undeclared sourceId (first: ${orphans[0]?.id})`,
    );
  }

  const planned = planCatalogShards(unique);
  const categoryCounts: Partial<Record<CatalogCategory, number>> = {};
  for (const item of unique) {
    categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
  }

  // Rewrite the shard directory from scratch: a shard that no longer exists
  // must not linger and serve items the index no longer lists.
  rmSync(shardsDir, { recursive: true, force: true });
  mkdirSync(shardsDir, { recursive: true });

  const refs: CatalogShardRef[] = [];
  for (const shard of planned) {
    // Shards are minified: they are machine-read only, and at world scale the
    // indentation would be several megabytes of whitespace in git and on the
    // wire. The index below stays pretty-printed — it is small and reviewed.
    const body = `${JSON.stringify({ id: shard.id, items: shard.items })}\n`;
    // Every shard must survive the client's own parser before it is published.
    const { items: reparsed, warnings } = parseCatalogShard(JSON.parse(body), sourceIds);
    if (warnings.length > 0 || reparsed.length !== shard.items.length) {
      throw new Error(`shard ${shard.id} failed validation:\n  ${warnings.join('\n  ')}`);
    }
    writeFileSync(join(shardsDir, `${shard.id}.json`), body);
    refs.push({
      id: shard.id,
      category: shard.category,
      path: `shards/${shard.id}.json`,
      itemCount: shard.items.length,
      ...(shard.bbox !== undefined ? { bbox: shard.bbox } : {}),
      byteSize: Buffer.byteLength(body),
    });
  }

  // The search digest: which shards could match a query, anywhere in the world.
  // Published as its OWN document, not folded into the index — the index is
  // fetched on every cold start and first paint depends on it staying small,
  // while the digest is only ever paid for by someone who actually types.
  const digest = buildCatalogSearchDigest(planned);
  const digestBody = `${JSON.stringify(digest)}\n`;
  const { digest: reparsedDigest, warnings: digestWarnings } = parseCatalogSearchDigest(
    JSON.parse(digestBody),
  );
  if (reparsedDigest === null || digestWarnings.length > 0) {
    throw new Error(`search digest failed validation:\n  ${digestWarnings.join('\n  ')}`);
  }
  const digestPath = join(v2Dir, 'search.json');
  writeFileSync(digestPath, digestBody);
  const tokenCount = Object.keys(digest.tokens).length;
  console.log(
    `wrote ${digestPath} (${tokenCount} tokens over ${digest.shardIds.length} shards, ` +
      `${(digestBody.length / 1024).toFixed(1)} KB)`,
  );

  const index = {
    schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sources,
    shards: refs,
    search: { path: 'search.json', byteSize: Buffer.byteLength(digestBody), tokenCount },
    categoryCounts,
  };
  const { index: parsedIndex, warnings } = parseCatalogIndex(index);
  if (parsedIndex === null || warnings.length > 0) {
    throw new Error(`catalog index failed validation:\n  ${warnings.join('\n  ')}`);
  }
  if (refs.length === 0)
    throw new Error('catalog has zero shards — refusing to publish an empty store');

  const indexPath = join(v2Dir, 'index.json');
  const indexBody = `${JSON.stringify(index, null, 2)}\n`;
  writeFileSync(indexPath, indexBody);

  const shardBytes = refs.reduce((sum, ref) => sum + (ref.byteSize ?? 0), 0);
  console.log(
    `wrote ${indexPath} (v2, ${unique.length} items in ${refs.length} shards, ` +
      `index ${(indexBody.length / 1024).toFixed(1)} KB, shards ${(shardBytes / 1024 / 1024).toFixed(2)} MB)`,
  );
  const biggest = [...refs].sort((a, b) => (b.byteSize ?? 0) - (a.byteSize ?? 0))[0];
  if (biggest !== undefined) {
    console.log(
      `largest shard: ${biggest.id} — ${biggest.itemCount} items, ${((biggest.byteSize ?? 0) / 1024).toFixed(0)} KB`,
    );
  }

  writeLegacyManifest(fragmentsDir, join(docsDir, 'v1', 'manifest.json'));
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
