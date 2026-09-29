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
 *   reach a sheet on the other side of the world without pulling the catalog —
 *   `facets.json` (per-shard kind/activity/terrain counts for the explorer)
 *   and `collections.json` (link-out collections such as Parcs Québec, from
 *   the hand-curated `scripts/catalog/collections/*.json`).
 *   This is what current clients read.
 *
 * Every item is **classified** on the way through (`@core/catalog/classify`):
 * `kind`, evidence-based `activities`, the source's `scale`, and — from open
 * DEM + Natural Earth data — `terrain` (`./terrain.ts`, cached under
 * `scripts/catalog/.cache/`; first run downloads ~1 GB of DEM tiles but keeps
 * only ~40 MB of summaries, re-runs take about a minute).
 * - **`docs/catalog/v1/manifest.json`** — the legacy flat manifest, still
 *   published so builds shipped before the world catalog keep working. It
 *   carries only the fragments listed in {@link LEGACY_FRAGMENTS} (the original
 *   Canadian CanTopo set): those clients have no shard support, and pouring
 *   30 000 worldwide sheets into one JSON would be a multi-megabyte download on
 *   a phone that cannot page it.
 *
 * Usage:
 *   npx tsx scripts/catalog/build-manifest.ts [--no-terrain]
 *
 * The Pages site serves docs/ as its root, so this publishes at
 * /catalog/v2/index.json once pushed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { classifyActivities, classifyKind } from '../../src/core/catalog/classify';
import { parseLinkOutCollections, placeActivities } from '../../src/core/catalog/collections';
import {
  buildCatalogFacets,
  countFacets,
  parseCatalogFacets,
  serializeCatalogFacets,
} from '../../src/core/catalog/facets';
import { CATALOG_ACTIVITIES, type LinkOutCollection } from '../../src/core/catalog/taxonomy';
import { computeTerrain } from './terrain';

/** Scale denominator per source (US Topo: Alaska is 1:25 000). */
function sourceScale(item: CatalogItem): number | undefined {
  switch (item.sourceId) {
    case 'usgs-ustopo':
      if (item.region === 'US-AK') return 25000;
      // Territories use other scales (Puerto Rico 1:20 000); say nothing rather than guess.
      return /^US-(PR|VI|GU|AS|MP)$/.test(item.region ?? '') ? undefined : 24000;
    case 'nrcan-cantopo':
      return 50000;
    case 'ga-austopo':
      return 250000;
    default:
      return undefined;
  }
}

/** Kind, activities and scale from the item itself (terrain is added later). */
function classifyItem(item: CatalogItem): CatalogItem {
  const kind = item.kind ?? classifyKind(item);
  const evidence = classifyActivities({ kind, category: item.category, title: item.title });
  const present = new Set([...(item.activities ?? []), ...evidence]);
  const activities = CATALOG_ACTIVITIES.filter((a) => present.has(a));
  const scale = item.scale ?? sourceScale(item);
  return {
    ...item,
    kind,
    ...(activities.length > 0 ? { activities } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
}

/** Hand-curated link-out collections, validated with the app's parser. */
function readCollections(dir: string): LinkOutCollection[] {
  if (!existsSync(dir)) return [];
  const raw = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      // `_comment` and per-place `evidence` are provenance for reviewers, not wire data.
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
      const places = (Array.isArray(doc.places) ? doc.places : []) as Record<string, unknown>[];
      return {
        id: doc.id,
        name: doc.name,
        publisher: doc.publisher,
        blurb: doc.blurb,
        homepage: doc.homepage,
        places: places.map(({ evidence: _evidence, ...place }) => place),
      };
    });
  const { collections, warnings } = parseLinkOutCollections(raw);
  if (warnings.length > 0) {
    throw new Error(`collections failed validation:\n  ${warnings.join('\n  ')}`);
  }
  return collections.map((c) => ({
    ...c,
    places: c.places.map((place) => {
      const activities = placeActivities(place);
      return { ...place, ...(activities.length > 0 ? { activities } : {}) };
    }),
  }));
}

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

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fragmentsDir = join(scriptDir, 'fragments');
  const withTerrain = !process.argv.includes('--no-terrain');
  const docsDir = join(scriptDir, '..', '..', 'docs', 'catalog');
  const v2Dir = join(docsDir, 'v2');
  const shardsDir = join(v2Dir, 'shards');

  const { sources, items } = readFragments(fragmentsDir);

  // Drop duplicate ids up front so the shard plan and the parser agree on the
  // item count (the parser would silently drop the second occurrence later).
  const byId = new Map<string, CatalogItem>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, classifyItem(item));
  let unique = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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

  if (withTerrain) {
    const { terrain } = await computeTerrain(unique, join(scriptDir, '.cache'));
    unique = unique.map((item) => {
      const found = terrain.get(item.id);
      return found === undefined ? item : { ...item, terrain: found };
    });
  } else {
    console.log('--no-terrain: items keep whatever terrain their fragment carries');
  }
  const facetTotals = countFacets(unique);

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

  // Per-shard facet counts: which shards hold glacier maps, paddling maps…
  const facetsBody = `${JSON.stringify(serializeCatalogFacets(buildCatalogFacets(planned)))}\n`;
  const { facets: reparsedFacets, warnings: facetWarnings } = parseCatalogFacets(
    JSON.parse(facetsBody),
  );
  if (reparsedFacets === null || facetWarnings.length > 0) {
    throw new Error(`facets failed validation:\n  ${facetWarnings.join('\n  ')}`);
  }
  writeFileSync(join(v2Dir, 'facets.json'), facetsBody);
  console.log(`wrote facets.json (${(facetsBody.length / 1024).toFixed(1)} KB)`);

  const collections = readCollections(join(scriptDir, 'collections'));
  const collectionsPath = join(v2Dir, 'collections.json');
  let collectionsRef: { path: string; byteSize: number } | undefined;
  if (collections.length > 0) {
    const body = `${JSON.stringify(collections, null, 2)}\n`;
    writeFileSync(collectionsPath, body);
    collectionsRef = { path: 'collections.json', byteSize: Buffer.byteLength(body) };
    console.log(
      `wrote collections.json (${collections.map((c) => `${c.id}: ${c.places.length} places`).join(', ')})`,
    );
  } else {
    rmSync(collectionsPath, { force: true });
  }

  const index = {
    schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sources,
    shards: refs,
    search: { path: 'search.json', byteSize: Buffer.byteLength(digestBody), tokenCount },
    facets: { path: 'facets.json', byteSize: Buffer.byteLength(facetsBody) },
    ...(collectionsRef !== undefined ? { collections: collectionsRef } : {}),
    categoryCounts,
    kindCounts: facetTotals.kinds,
    activityCounts: facetTotals.activities,
    terrainCounts: facetTotals.terrain,
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
  console.log(`kinds: ${JSON.stringify(facetTotals.kinds)}`);
  console.log(`activities: ${JSON.stringify(facetTotals.activities)}`);
  console.log(`terrain: ${JSON.stringify(facetTotals.terrain)}`);
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

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
