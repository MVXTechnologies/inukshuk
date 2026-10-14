/**
 * Catalog generator — merge per-source fragments into the published catalog.
 *
 * Reads every `scripts/catalog/fragments/*.json` (written by the
 * fetch-<source>.ts crawlers, or hand-curated), merges sources + items,
 * validates the result with the SAME parsers the app ships
 * (`src/core/catalog/schema`) and refuses to write anything those parsers would
 * warn about — the generator and the client cannot drift.
 *
 * Three catalogs come out:
 *
 * - **`docs/catalog/v2/`** — the world catalog every installed app reads: a
 *   small `index.json` (sources, per-category totals, shard directory) plus
 *   `shards/<id>.json`, planned by the shared `planCatalogShards` so shard ids
 *   are identical on both sides. Alongside them, `search.json` — the token ->
 *   shard digest that lets a query reach a sheet on the other side of the
 *   world without pulling the catalog — `facets.json` (per-shard
 *   kind/activity/terrain counts for the explorer) and `collections.json`
 *   (link-out collections such as Parcs Québec, from the hand-curated
 *   `scripts/catalog/collections/*.json`). It leaves out every source whose
 *   terms need credit rendering (`needsCreditRendering`: Cartes Plein-air),
 *   which apps before 2.5.2 cannot show.
 * - **`docs/catalog/v3/`** — the credited edition 2.5.2+ reads: everything,
 *   in the same layout, but each shard byte-identical to a v2 one is
 *   referenced as `../v2/shards/<id>.json` instead of copied
 *   (`@core/catalog/editions`, docs/CATALOG.md §7).
 *
 * An index whose content did not change keeps its `generatedAt`, so a rebuild
 * that only moves v3 (the weekly Cartes Plein-air crawl) leaves v2 and v1
 * byte-identical.
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
 * /catalog/v2/index.json and /catalog/v3/index.json once pushed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_SCHEMA_VERSION,
  parseCatalogManifest,
  type CatalogItem,
  type CatalogSource,
} from '../../src/core/catalog/schema';
import { classifyActivities, classifyKind } from '../../src/core/catalog/classify';
import { parseLinkOutCollections, placeActivities } from '../../src/core/catalog/collections';
import {
  buildCatalogEdition,
  CREDITED_EDITION,
  LEGACY_EDITION,
  serializeWithStableTimestamp,
  splitCatalogEditions,
  type CatalogEditionOutput,
  type SiblingEdition,
} from '../../src/core/catalog/editions';
import { countFacets } from '../../src/core/catalog/facets';
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
function writeLegacyManifest(dir: string, outPath: string, now: string): void {
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
  const body = serializeWithStableTimestamp(
    (generatedAt) =>
      `${JSON.stringify({ schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt, sources, items }, null, 2)}\n`,
    readIfExists(outPath),
    now,
  );
  const { manifest: parsed, warnings } = parseCatalogManifest(JSON.parse(body));
  if (parsed === null || warnings.length > 0) {
    throw new Error(`legacy manifest failed validation:\n  ${warnings.join('\n  ')}`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body);
  console.log(`wrote ${outPath} (v1, ${parsed.items.length} items — legacy clients)`);
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** Side documents an edition may publish; one it no longer has is removed. */
const SIDE_DOCUMENTS = ['index.json', 'search.json', 'facets.json', 'collections.json'];

/**
 * Write one edition. Its shard directory is rewritten from scratch: a shard
 * that no longer exists must not linger and serve items the index no longer
 * lists. Unchanged files are rewritten with identical bytes.
 */
function writeEdition(dir: string, name: string, edition: CatalogEditionOutput): void {
  const shardsDir = join(dir, 'shards');
  rmSync(shardsDir, { recursive: true, force: true });
  mkdirSync(shardsDir, { recursive: true });
  for (const doc of SIDE_DOCUMENTS) {
    if (!edition.files.has(doc)) rmSync(join(dir, doc), { force: true });
  }
  let shardBytes = 0;
  for (const [path, body] of edition.files) {
    writeFileSync(join(dir, path), body);
    if (path.startsWith('shards/')) shardBytes += Buffer.byteLength(body);
  }
  const indexBody = edition.files.get('index.json') ?? '';
  const searchBody = edition.files.get('search.json') ?? '';
  const facetsBody = edition.files.get('facets.json') ?? '';
  console.log(
    `wrote ${name}: ${edition.itemCount} items in ${edition.refs.length} shards ` +
      `(${edition.refs.length - edition.sharedShardCount} here, ` +
      `${(shardBytes / 1024 / 1024).toFixed(2)} MB; ${edition.sharedShardCount} shared), ` +
      `index ${(indexBody.length / 1024).toFixed(1)} KB, search ${(searchBody.length / 1024).toFixed(1)} KB ` +
      `(${edition.tokenCount} tokens), facets ${(facetsBody.length / 1024).toFixed(1)} KB`,
  );
  const biggest = [...edition.refs].sort((a, b) => (b.byteSize ?? 0) - (a.byteSize ?? 0))[0];
  if (biggest !== undefined) {
    console.log(
      `  largest shard: ${biggest.id} — ${biggest.itemCount} items, ${((biggest.byteSize ?? 0) / 1024).toFixed(0)} KB`,
    );
  }
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fragmentsDir = join(scriptDir, 'fragments');
  const withTerrain = !process.argv.includes('--no-terrain');
  const docsDir = join(scriptDir, '..', '..', 'docs', 'catalog');

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
  console.log(`kinds: ${JSON.stringify(facetTotals.kinds)}`);
  console.log(`activities: ${JSON.stringify(facetTotals.activities)}`);
  console.log(`terrain: ${JSON.stringify(facetTotals.terrain)}`);

  const collections = readCollections(join(scriptDir, 'collections'));
  if (collections.length > 0) {
    console.log(
      `collections: ${collections.map((c) => `${c.id}: ${c.places.length} places`).join(', ')}`,
    );
  }

  // Build both editions in memory first: nothing is written unless both pass.
  const now = new Date().toISOString();
  const split = splitCatalogEditions(sources, unique);
  console.log(
    `credited-only sources (${CREDITED_EDITION} only): ${split.creditedOnlySourceIds.join(', ') || 'none'}`,
  );
  const legacy = buildCatalogEdition({
    ...split.legacy,
    collections,
    now,
    previousIndex: readIfExists(join(docsDir, LEGACY_EDITION, 'index.json')),
  });
  const sibling: SiblingEdition = {
    prefix: `../${LEGACY_EDITION}/`,
    shardBodies: legacy.shardBodies,
  };
  const credited = buildCatalogEdition({
    ...split.credited,
    collections,
    now,
    previousIndex: readIfExists(join(docsDir, CREDITED_EDITION, 'index.json')),
    sibling,
  });

  writeEdition(join(docsDir, LEGACY_EDITION), LEGACY_EDITION, legacy);
  writeEdition(join(docsDir, CREDITED_EDITION), CREDITED_EDITION, credited);

  writeLegacyManifest(fragmentsDir, join(docsDir, 'v1', 'manifest.json'), now);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
