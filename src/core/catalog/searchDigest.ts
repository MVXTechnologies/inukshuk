import { foldText } from './filterCatalog';
import type { CatalogItem } from './schema';

/**
 * The catalog search digest — which shards *could* contain a query's matches.
 *
 * Sharding made the Search tab honest about bytes and dishonest about search:
 * the screen filters the items it happens to have pulled for the user's area,
 * so a user in Montréal typing "Grand Canyon" was told "No maps match your
 * search." about a catalog holding dozens of them. Fetching all 255 shards to
 * answer a keystroke is not an option (24 MB); fetching *none* is what shipped.
 *
 * So the generator publishes one extra document — `search.json`, a plain
 * inverted index of **folded title token → the shards that contain it** — and
 * the client fetches it lazily, the first time the user actually types. The
 * index document itself is untouched (opening the tab still costs ~62 KB); the
 * digest is a few hundred KB, cached like a shard, and only ever paid for by
 * someone who searches.
 *
 * Two properties make the digest safe to draw conclusions from:
 *
 * - **No false negatives.** A query token is matched as a *substring* of the
 *   digest's tokens, exactly as `matchesCatalogFilter` matches it against an
 *   item's haystack, and a query token is first split on non-alphanumerics so
 *   "saint-raymond" is looked up as "saint" AND "raymond" (the haystack's own
 *   token boundaries). Anything the item filter would match, the digest selects.
 * - **False positives are free.** A shard may be selected because two different
 *   items supplied the two query terms; the real filter then shows nothing from
 *   it. The cost is one shard fetch, not a wrong answer.
 *
 * That is what lets the empty state finally tell the truth: an empty *selection*
 * means the catalog genuinely has no match, and a non-empty selection that is
 * not fully loaded means "still searching", never "nothing found".
 *
 * Pure and shared, like `planCatalogShards`: the generator builds the digest
 * with `buildCatalogSearchDigest` and the client queries it with
 * `shardIdsForQuery`, so the two cannot drift on tokenization.
 */

/** Breaking changes to the digest document bump this. */
export const CATALOG_SEARCH_SCHEMA_VERSION = 1;

/**
 * Shortest run indexed, and the shortest a query term must be to constrain the
 * selection. One-character runs sit in nearly every shard: they would cost
 * postings-list bytes for no selectivity, so they are simply not a constraint.
 */
export const MIN_DIGEST_TERM_LENGTH = 2;

export interface CatalogSearchDigest {
  schemaVersion: typeof CATALOG_SEARCH_SCHEMA_VERSION;
  /** Shard ids; the postings lists below index into this array. */
  shardIds: string[];
  /** Folded token → ascending indices into {@link shardIds}. */
  tokens: Record<string, number[]>;
}

export interface CatalogSearchParseResult {
  digest: CatalogSearchDigest | null;
  warnings: string[];
}

/** One shard's identity and payload, as both the generator and tests hold it. */
export interface DigestShardInput {
  id: string;
  items: readonly CatalogItem[];
}

/**
 * The searchable text of an item — the same three fields
 * `matchesCatalogFilter` builds its haystack from, so the digest indexes
 * exactly what the on-device filter searches.
 */
function searchableText(item: CatalogItem): string {
  return `${item.title} ${item.id} ${item.region ?? ''}`;
}

/** Folded alphanumeric runs of at least {@link MIN_DIGEST_TERM_LENGTH}. */
export function digestTerms(text: string): string[] {
  const terms: string[] = [];
  for (const run of foldText(text).split(/[^a-z0-9]+/)) {
    if (run.length >= MIN_DIGEST_TERM_LENGTH) terms.push(run);
  }
  return terms;
}

/**
 * Build the digest for a planned catalog. Tokens are inserted in sorted order
 * and postings are sorted, so an unchanged catalog regenerates byte-identically
 * (JSON.stringify preserves insertion order — bar integer-like tokens such as
 * "11", which the language always emits first; that ordering is fixed too).
 */
export function buildCatalogSearchDigest(shards: readonly DigestShardInput[]): CatalogSearchDigest {
  const shardIds = shards.map((shard) => shard.id);
  const postings = new Map<string, Set<number>>();
  shards.forEach((shard, shardIndex) => {
    for (const item of shard.items) {
      for (const term of digestTerms(searchableText(item))) {
        const list = postings.get(term);
        if (list === undefined) postings.set(term, new Set([shardIndex]));
        else list.add(shardIndex);
      }
    }
  });
  const tokens: Record<string, number[]> = {};
  for (const term of [...postings.keys()].sort()) {
    tokens[term] = [...(postings.get(term) ?? [])].sort((a, b) => a - b);
  }
  return { schemaVersion: CATALOG_SEARCH_SCHEMA_VERSION, shardIds, tokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse any JSON value into a digest. Never throws; a malformed postings list
 * is dropped with a warning rather than blanking search, and an unusable
 * document yields null so the caller falls back to "area only" honestly.
 */
export function parseCatalogSearchDigest(raw: unknown): CatalogSearchParseResult {
  const warnings: string[] = [];
  if (!isRecord(raw)) return { digest: null, warnings: ['search digest is not a JSON object'] };
  if (raw.schemaVersion !== CATALOG_SEARCH_SCHEMA_VERSION) {
    return {
      digest: null,
      warnings: [
        `unsupported search digest schemaVersion ${String(raw.schemaVersion)} ` +
          `(expected ${CATALOG_SEARCH_SCHEMA_VERSION})`,
      ],
    };
  }
  if (!Array.isArray(raw.shardIds) || raw.shardIds.some((id) => typeof id !== 'string')) {
    return { digest: null, warnings: ['search digest has no shardIds array'] };
  }
  if (!isRecord(raw.tokens)) {
    return { digest: null, warnings: ['search digest has no tokens map'] };
  }
  const shardIds = raw.shardIds as string[];
  const tokens: Record<string, number[]> = {};
  for (const [term, list] of Object.entries(raw.tokens)) {
    if (!Array.isArray(list)) {
      warnings.push(`dropped postings for "${term}": not an array`);
      continue;
    }
    // An out-of-range index would silently select nothing; drop it loudly.
    const indices = list.filter(
      (i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < shardIds.length,
    );
    if (indices.length !== list.length) warnings.push(`dropped out-of-range postings for "${term}"`);
    if (indices.length > 0) tokens[term] = indices;
  }
  return { digest: { schemaVersion: CATALOG_SEARCH_SCHEMA_VERSION, shardIds, tokens }, warnings };
}

/**
 * Every shard that could hold a match for `query`.
 *
 * Returns `null` when the query carries no term long enough to constrain
 * anything (empty, or a single character): the caller must then treat the
 * result as "unknown", never as "nothing exists". An empty **array** is a real
 * answer — no shard in the catalog contains the query.
 */
export function shardIdsForQuery(digest: CatalogSearchDigest, query: string): string[] | null {
  const terms = digestTerms(query);
  if (terms.length === 0) return null;

  const allTokens = Object.keys(digest.tokens);
  let selected: Set<number> | null = null;
  for (const term of terms) {
    const matches = new Set<number>();
    for (const token of allTokens) {
      // Substring, not equality: the item filter matches "gran" inside
      // "grand", and the digest must not be narrower than the filter.
      if (!token.includes(term)) continue;
      for (const shardIndex of digest.tokens[token] ?? []) matches.add(shardIndex);
    }
    // Every term must be satisfied — the same "all tokens must match" rule the
    // item filter applies.
    selected = selected === null ? matches : intersect(selected, matches);
    if (selected.size === 0) return [];
  }
  if (selected === null) return null;

  const ids: string[] = [];
  for (const shardIndex of [...selected].sort((a, b) => a - b)) {
    const id = digest.shardIds[shardIndex];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

function intersect(a: ReadonlySet<number>, b: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  for (const value of a) if (b.has(value)) out.add(value);
  return out;
}
