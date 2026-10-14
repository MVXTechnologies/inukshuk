import { parseCatalogIndex, parseCatalogShard, type CatalogSource } from './schema';

/**
 * Recover the generator's per-source fragments from the PUBLISHED v2 catalog.
 *
 * `build-manifest.ts` rebuilds the whole catalog from
 * `scripts/catalog/fragments/*.json`, but the bulk fragments (US Topo,
 * FSTopo…) are gitignored build inputs that only ever lived on the machine
 * that last published. Publishing one new source from a checkout without them
 * would silently DROP every other source. This turns the published index +
 * shards back into fragments the generator reproduces them from.
 *
 * Rows are kept **verbatim** — same keys, same key order, same values — so the
 * regenerated shards are byte-identical. The one exception is `terrain`, which
 * `build-manifest.ts` recomputes from the DEM on every run (and which it would
 * otherwise keep stale on an item whose recomputed terrain is empty); it is
 * removed so the rebuild is a genuine reproduction, not a copy. `kind` and
 * `scale` stay: the generator's classification keeps a value an item already
 * carries, so leaving them in is equivalent to re-deriving them.
 *
 * Strict by design: the catalog is public data every installed app reads, so
 * anything inconsistent (a missing or extra shard, a count that disagrees, a
 * row the app's own parser would drop, an id in two shards) is an error, never
 * a best effort.
 */

/** Fields `build-manifest.ts` recomputes on every run; never carried by a fragment. */
export const BUILD_RECOMPUTED_FIELDS = ['terrain'] as const;

/** One fragment, in the shape the `fetch-*.ts` crawlers write. */
export interface RecoveredFragment {
  sources: CatalogSource[];
  items: Record<string, unknown>[];
}

export interface FragmentRecovery {
  /** Fragments keyed by source id, in the index's source order. */
  fragments: Map<string, RecoveredFragment>;
  /** Item count per source id. */
  counts: Map<string, number>;
  /** Total rows read across all shards. */
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebuild fragments from a published index and its shard bodies (keyed by
 * shard id, as found on disk). Throws with every problem found when the
 * published catalog is not self-consistent.
 */
export function recoverFragmentsFromPublished(
  rawIndex: unknown,
  rawShards: ReadonlyMap<string, unknown>,
): FragmentRecovery {
  const errors: string[] = [];
  const { index, warnings } = parseCatalogIndex(rawIndex);
  if (index === null || warnings.length > 0 || !isRecord(rawIndex)) {
    throw new Error(`published index does not parse cleanly:\n  ${warnings.join('\n  ')}`);
  }
  if (index.items.length > 0) {
    errors.push(`index carries ${index.items.length} inline items (not a generator output)`);
  }

  // Sources verbatim from the raw index (the parser would drop unknown fields).
  const rawSources = (Array.isArray(rawIndex.sources) ? rawIndex.sources : []).filter(isRecord);
  const sourceIds = new Set(index.sources.map((s) => s.id));
  const fragments = new Map<string, RecoveredFragment>();
  for (const source of rawSources) {
    fragments.set(String(source.id), { sources: [source as unknown as CatalogSource], items: [] });
  }

  const listed = new Set(index.shards.map((s) => s.id));
  for (const id of rawShards.keys()) {
    if (!listed.has(id)) errors.push(`shard "${id}" exists but the index does not list it`);
  }

  const seen = new Set<string>();
  const perCategory = new Map<string, number>();
  let total = 0;
  for (const ref of index.shards) {
    const body = rawShards.get(ref.id);
    if (body === undefined) {
      errors.push(`shard "${ref.id}" is listed but missing`);
      continue;
    }
    if (!isRecord(body) || body.id !== ref.id || !Array.isArray(body.items)) {
      errors.push(`shard "${ref.id}": body is not { id: "${ref.id}", items: [...] }`);
      continue;
    }
    const { items, warnings: shardWarnings } = parseCatalogShard(body, sourceIds);
    for (const w of shardWarnings) errors.push(`shard "${ref.id}": ${w}`);
    if (items.length !== ref.itemCount || body.items.length !== ref.itemCount) {
      errors.push(
        `shard "${ref.id}": index says ${ref.itemCount} items, body holds ${body.items.length}`,
      );
    }
    for (const raw of body.items) {
      if (!isRecord(raw)) continue; // already reported by the parser
      const id = String(raw.id);
      if (seen.has(id)) errors.push(`item "${id}" appears in more than one shard`);
      seen.add(id);
      if (raw.category !== ref.category) {
        errors.push(`item "${id}" (${String(raw.category)}) sits in ${ref.category} shard`);
      }
      perCategory.set(ref.category, (perCategory.get(ref.category) ?? 0) + 1);
      const row: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!(BUILD_RECOMPUTED_FIELDS as readonly string[]).includes(key)) row[key] = value;
      }
      fragments.get(String(raw.sourceId))?.items.push(row);
      total += 1;
    }
  }

  for (const [category, declared] of Object.entries(index.categoryCounts)) {
    const found = perCategory.get(category) ?? 0;
    if (found !== declared) {
      errors.push(`categoryCounts.${category} is ${declared} but the shards hold ${found}`);
    }
  }
  for (const category of perCategory.keys()) {
    if (!(category in index.categoryCounts)) {
      errors.push(`shards hold ${category} items the index does not count`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`published catalog is inconsistent:\n  ${errors.join('\n  ')}`);
  }

  // The crawlers write their rows sorted by id; so does this.
  const counts = new Map<string, number>();
  for (const [id, fragment] of fragments) {
    fragment.items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    counts.set(id, fragment.items.length);
  }
  return { fragments, counts, total };
}
