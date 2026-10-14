import {
  buildCatalogFacets,
  countFacets,
  parseCatalogFacets,
  serializeCatalogFacets,
} from './facets';
import {
  CATALOG_INDEX_SCHEMA_VERSION,
  parseCatalogIndex,
  parseCatalogShard,
  type CatalogCategory,
  type CatalogItem,
  type CatalogShardRef,
  type CatalogSource,
} from './schema';
import { buildCatalogSearchDigest, parseCatalogSearchDigest } from './searchDigest';
import { planCatalogShards } from './shard';
import type { LinkOutCollection } from './taxonomy';

/**
 * Catalog editions: one set of fragments, two published catalogs (#680).
 *
 * Pages serves `main:/docs`, so whatever lands in `/catalog/v2/` reaches every
 * installed app at once. Some sources may only be listed by an app that can
 * honour their terms: Cartes Plein-air requires each map's author credit and
 * "Available free at cartespleinair.org", and only 2.5.2+ renders those
 * (`./credit`). So the generator writes:
 *
 * - **v2, the legacy edition** — every source an app of any age can list
 *   correctly. Read by 2.5.1 and earlier, which never learn the credited
 *   sources exist.
 * - **v3, the credited edition** — everything. Read by 2.5.2+. Its shards that
 *   are byte-identical to a v2 shard are not published twice: the v3 index
 *   points at `../v2/shards/<id>.json` (the one climb the path rules allow,
 *   `isCatalogRelativePath`), so only the shards that differ live under v3.
 *
 * Both editions are built here, purely, so the split is tested without a
 * filesystem; `scripts/catalog/build-manifest.ts` only reads fragments and
 * writes the files this returns.
 */

/** The edition every installed app reads. */
export const LEGACY_EDITION = 'v2';
/** The edition 2.5.2+ reads: the legacy one plus the sources that need credit rendering. */
export const CREDITED_EDITION = 'v3';

/**
 * Does listing this source need an app that renders credits (2.5.2+)? True
 * when the source asks for a "free at" line or any of its rows names an
 * author: an older app would show neither, and listing a map without the
 * credit its publisher requires is exactly what must not happen.
 */
export function needsCreditRendering(
  source: CatalogSource,
  items: readonly CatalogItem[],
): boolean {
  if (source.freeAt !== undefined) return true;
  return items.some((item) => item.sourceId === source.id && item.author !== undefined);
}

export interface CatalogEditionContent {
  sources: CatalogSource[];
  items: CatalogItem[];
}

export interface CatalogEditionSplit {
  /** What v2 publishes: no source that needs credit rendering, nor its rows. */
  legacy: CatalogEditionContent;
  /** What v3 publishes: everything. */
  credited: CatalogEditionContent;
  /** Sources only the credited edition lists, sorted. */
  creditedOnlySourceIds: string[];
}

/** Split merged fragments into the two editions. Order is preserved. */
export function splitCatalogEditions(
  sources: readonly CatalogSource[],
  items: readonly CatalogItem[],
): CatalogEditionSplit {
  const creditedOnly = new Set(
    sources.filter((source) => needsCreditRendering(source, items)).map((source) => source.id),
  );
  return {
    legacy: {
      sources: sources.filter((source) => !creditedOnly.has(source.id)),
      // An author on a row of an otherwise plain source keeps that row out too.
      items: items.filter((item) => !creditedOnly.has(item.sourceId) && item.author === undefined),
    },
    credited: { sources: [...sources], items: [...items] },
    creditedOnlySourceIds: [...creditedOnly].sort(),
  };
}

/**
 * Serialize a document that carries a `generatedAt`, keeping the previous
 * timestamp when nothing else changed. A rebuild that only moves another
 * edition (the weekly Cartes Plein-air crawl touches v3 alone) then leaves
 * this one byte-identical instead of churning a timestamp every installed app
 * would re-download the index for.
 */
export function serializeWithStableTimestamp(
  render: (generatedAt: string) => string,
  previous: string | undefined,
  now: string,
): string {
  if (previous !== undefined) {
    let previousAt: unknown;
    try {
      previousAt = (JSON.parse(previous) as { generatedAt?: unknown }).generatedAt;
    } catch {
      previousAt = undefined;
    }
    if (typeof previousAt === 'string') {
      const unchanged = render(previousAt);
      if (unchanged === previous) return unchanged;
    }
  }
  return render(now);
}

/** A published edition another one may share shards with. */
export interface SiblingEdition {
  /** Path prefix from this edition's index to the sibling's, e.g. `../v2/`. */
  prefix: string;
  /** The sibling's shard bodies by shard id. */
  shardBodies: ReadonlyMap<string, string>;
}

export interface CatalogEditionInput extends CatalogEditionContent {
  /** Link-out collections, already validated (published as collections.json). */
  collections: readonly LinkOutCollection[];
  /** Timestamp for a changed index (ISO 8601). */
  now: string;
  /** The index this edition last published, to keep its timestamp when unchanged. */
  previousIndex?: string;
  /** Reuse this sibling's identical shards instead of writing copies. */
  sibling?: SiblingEdition;
}

export interface CatalogEditionOutput {
  /** Files to write, by path relative to the edition's directory. */
  files: Map<string, string>;
  /** Every shard body of this edition by id, shared or not (a sibling input). */
  shardBodies: Map<string, string>;
  refs: CatalogShardRef[];
  /** Shards pointing into the sibling edition instead of written here. */
  sharedShardCount: number;
  itemCount: number;
  tokenCount: number;
}

/**
 * Build one edition: shard plan, shard bodies, search digest, facet digest,
 * collections and index, each validated with the app's own parser. Throws on
 * anything the app would warn about; the caller publishes nothing then.
 */
export function buildCatalogEdition(input: CatalogEditionInput): CatalogEditionOutput {
  const { sources, sibling } = input;
  // Sorted here too, so the counts' key order (and so the bytes) never depends
  // on the order fragments were read in.
  const items = [...input.items].sort((a, b) => a.id.localeCompare(b.id));
  const sourceIds = new Set(sources.map((s) => s.id));
  const orphan = items.find((item) => !sourceIds.has(item.sourceId));
  if (orphan !== undefined) {
    throw new Error(`item ${orphan.id} references an undeclared sourceId "${orphan.sourceId}"`);
  }

  const planned = planCatalogShards(items);
  if (planned.length === 0) throw new Error('catalog has zero shards: refusing an empty store');

  const files = new Map<string, string>();
  const shardBodies = new Map<string, string>();
  const refs: CatalogShardRef[] = [];
  let sharedShardCount = 0;
  for (const shard of planned) {
    // Minified: machine-read only; indentation would be megabytes at world scale.
    const body = `${JSON.stringify({ id: shard.id, items: shard.items })}\n`;
    const { items: reparsed, warnings } = parseCatalogShard(JSON.parse(body), sourceIds);
    if (warnings.length > 0 || reparsed.length !== shard.items.length) {
      throw new Error(`shard ${shard.id} failed validation:\n  ${warnings.join('\n  ')}`);
    }
    shardBodies.set(shard.id, body);
    const shared = sibling !== undefined && sibling.shardBodies.get(shard.id) === body;
    const path = shared ? `${sibling.prefix}shards/${shard.id}.json` : `shards/${shard.id}.json`;
    if (shared) sharedShardCount++;
    else files.set(path, body);
    refs.push({
      id: shard.id,
      category: shard.category,
      path,
      itemCount: shard.items.length,
      ...(shard.bbox !== undefined ? { bbox: shard.bbox } : {}),
      byteSize: byteLength(body),
    });
  }

  // The search digest: its own document, paid for only by someone who types.
  const digest = buildCatalogSearchDigest(planned);
  const digestBody = `${JSON.stringify(digest)}\n`;
  const { digest: reparsedDigest, warnings: digestWarnings } = parseCatalogSearchDigest(
    JSON.parse(digestBody),
  );
  if (reparsedDigest === null || digestWarnings.length > 0) {
    throw new Error(`search digest failed validation:\n  ${digestWarnings.join('\n  ')}`);
  }
  files.set('search.json', digestBody);
  const tokenCount = Object.keys(digest.tokens).length;

  const facetsBody = `${JSON.stringify(serializeCatalogFacets(buildCatalogFacets(planned)))}\n`;
  const { facets: reparsedFacets, warnings: facetWarnings } = parseCatalogFacets(
    JSON.parse(facetsBody),
  );
  if (reparsedFacets === null || facetWarnings.length > 0) {
    throw new Error(`facets failed validation:\n  ${facetWarnings.join('\n  ')}`);
  }
  files.set('facets.json', facetsBody);

  let collectionsRef: { path: string; byteSize: number } | undefined;
  if (input.collections.length > 0) {
    const body = `${JSON.stringify(input.collections, null, 2)}\n`;
    files.set('collections.json', body);
    collectionsRef = { path: 'collections.json', byteSize: byteLength(body) };
  }

  const categoryCounts: Partial<Record<CatalogCategory, number>> = {};
  for (const item of items) {
    categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
  }
  const facetTotals = countFacets(items);
  // Key order is the wire order every published index has had: keep it, or an
  // unchanged catalog stops being byte-identical.
  const renderIndex = (generatedAt: string): string => {
    const index = {
      schemaVersion: CATALOG_INDEX_SCHEMA_VERSION,
      generatedAt,
      sources,
      shards: refs,
      search: { path: 'search.json', byteSize: byteLength(digestBody), tokenCount },
      facets: { path: 'facets.json', byteSize: byteLength(facetsBody) },
      ...(collectionsRef !== undefined ? { collections: collectionsRef } : {}),
      categoryCounts,
      kindCounts: facetTotals.kinds,
      activityCounts: facetTotals.activities,
      terrainCounts: facetTotals.terrain,
    };
    return `${JSON.stringify(index, null, 2)}\n`;
  };
  const indexBody = serializeWithStableTimestamp(renderIndex, input.previousIndex, input.now);
  const { index: parsedIndex, warnings } = parseCatalogIndex(JSON.parse(indexBody));
  if (parsedIndex === null || warnings.length > 0) {
    throw new Error(`catalog index failed validation:\n  ${warnings.join('\n  ')}`);
  }
  files.set('index.json', indexBody);

  return { files, shardBodies, refs, sharedShardCount, itemCount: items.length, tokenCount };
}

const encoder = new TextEncoder();

/** UTF-8 byte length (no Node `Buffer`: this module stays platform-free). */
function byteLength(text: string): number {
  return encoder.encode(text).length;
}
