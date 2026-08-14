# The world catalog (`/catalog/v2/`)

How the Search tab's catalog is generated, sharded, published and read.
Design background: `docs/plans/plan-map-store.md`.

The rule that shapes everything below: **we link, we never rehost.** The
manifest points at each publisher's own download URLs and the phone fetches the
bytes from them directly. That keeps us on the "attribute + link" side of every
licence rather than the "redistribute" side, and it means a source's own
takedown or update is instantly effective.

## 1. Wire format

Three document kinds, all static JSON on the GitHub Pages site (`docs/` is the
Pages root, so `docs/catalog/v2/index.json` serves at
`https://inukshuk.mvxtechnologies.com/catalog/v2/index.json`).

### `v2/index.json` — what every client fetches first

```jsonc
{
  "schemaVersion": 2,
  "generatedAt": "2026-08-10T00:00:00Z",
  "sources": [
    {
      "id": "nrcan-cantopo",
      "name": "NRCan CanTopo",
      "licence": "OGL-Canada-2.0",
      "attribution": "Natural Resources Canada",
      "homepage": "https://…",
    },
  ],
  "categoryCounts": { "topo": 65877 },
  "shards": [
    {
      "id": "topo-n40w080-3",
      "category": "topo",
      "path": "shards/topo-n40w080-3.json",
      "itemCount": 96,
      "bbox": [-75.0, 45.0, -70.0, 50.0],
      "byteSize": 37000,
    },
  ],
}
```

`categoryCounts` exists so the landing grid can say "Topo · 65,877 maps"
**before a single shard is fetched**. `bbox` is the union of the shard's item
bboxes — deliberately not the cell, so a sheet whose coverage spills into the
next cell is still found by nearest-shard ranking. `byteSize` lets the client
budget a prefetch instead of guessing.

**As published today:** 65,877 items in **255 shards**, index **61.6 KB**,
search digest **429.9 KB** (142.6 KB gzipped, lazy),
shard bodies 23 MB in total, largest shard 147 KB / 400 items. Measured
worst-case first paint from three places on Earth — Québec City 300 KB, Denver
434 KB, Alice Springs 51 KB (index + three nearest shards).

### `v2/shards/<id>.json` — fetched on demand

```jsonc
{ "id": "topo-n40w080", "items": [/* CatalogItem[] — the v1 item shape */] }
```

Item fields are unchanged from v1 (`id`, `sourceId`, `title`, `category`,
`region?`, `bbox?`, `format`, `packaging`, `sizeBytes?`, `url`, `sidecar?`,
`thumbnailUrl?`, `updatedAt?`, `lang?`).

### `v1/manifest.json` — frozen, for old clients

Builds shipped before the world catalog read one flat manifest and know nothing
about shards. That file is still published, carrying **only** the original
Canadian CanTopo set (`LEGACY_FRAGMENTS` in `build-manifest.ts`). Pouring 30 000
worldwide sheets into it would hand those clients a multi-megabyte download they
cannot page. New clients never read it — but `parseCatalogIndex` still _accepts_
it, which is what keeps a cache written by an older build usable after an
update.

## 2. The sharding scheme

**Shard key = category × geographic cell.** Both halves matter: the category
half is what the landing grid browses by, the geographic half is what "Around
you" needs.

The cell grid is a **quadtree over WGS84 rooted at 10° cells** (`src/core/catalog/shard.ts`):

| Level | Cell side | Id example    |
| ----- | --------- | ------------- |
| 0     | 10°       | `n40w080`     |
| 1     | 5°        | `n40w080-3`   |
| 2     | 2.5°      | `n40w080-31`  |
| 3     | 1.25°     | `n40w080-312` |

- The id names the **level-0 origin** (south/west corner, hemisphere-prefixed,
  zero-padded: `n40w080`, `s40e010`) plus the quadrant path taken from it —
  `0` SW, `1` SE, `2` NW, `3` NE. So `topo-n40w080-31` is fully decodable from
  its name alone, and is a legal filename and cache key everywhere.
- An item is assigned by its **bbox centre**, so it lives in exactly one shard.
- A cell holding more than `DEFAULT_MAX_SHARD_ITEMS` (400) **subdivides into
  four**, recursively, until it fits or the cell reaches `DEFAULT_MIN_CELL_DEG`
  (1.25°). A harbour with 900 charts on one pier must not spawn a thousand
  shards, so an over-full leaf at the floor is simply accepted.
- Items with no bbox go to one `<category>-nogeo` shard, ranked last everywhere.

Concretely: a 400-item shard of typical topo rows is ~150 KB of JSON. Opening
the Search tab costs the index (tens of KB) plus at most 6 shards under a
1.5 MB budget — not the whole world.

**Why not shard by country/region?** Country codes are a poor proxy for "near
me" (a user on the Detroit river needs both sides), they need a boundary
dataset to assign, and they are wildly unbalanced. A graticule quadtree needs
only the bbox we already have, balances itself by construction, and gives the
client a distance metric it can compute with no extra data.

**Antimeridian:** `distanceToBboxMeters` clamps longitude without wrapping, so
shards straddling ±180° rank slightly late. They still load; nothing breaks.
Fixing it means splitting those shards at the seam — worth doing only if we
ever ship Fiji-dense coverage.

## 3. How the client reads it

`src/data/catalogCache.ts` + `src/state/catalogStore.ts`:

1. `load()` fetches the index (24 h TTL) and caches it as `catalog.json`.
2. `ensureShardsNear(origin, category)` picks shards with the shared, pure
   `selectShards()` — nearest-first, capped at 6 shards / 1.5 MB, and
   **round-robin by category** when no category is selected so one dense
   category cannot crowd "Around you". Already-loaded and in-flight shards are
   skipped.
3. Each shard is cached as `catalog-shard-<id>.json` with a 7-day TTL. Items
   accumulate in the store for the session and are never evicted, so backing
   out of a category and returning is instant.
4. Every fetch falls back to its cached copy on failure. **Offline browsing
   works for anything already seen**; the index and shard caches are what make
   that true, and the `fromCache` flag drives the "Showing the saved catalog"
   note.

Shard URLs are resolved by the pure `resolveCatalogUrl(indexUrl, path)` —
hand-rolled because React Native's `URL` shim has no relative resolution — and
it refuses absolute paths, `..` and off-host URLs. The parser rejects the same
things when reading the index, so a tampered manifest cannot redirect a phone
off-host.

### Search across a sharded catalog

Sharding made the tab honest about bytes and dishonest about search: filtering
only the loaded items meant a user in Montréal typing "Grand Canyon" was told
**"No maps match your search."** about a catalog holding dozens of them. So the
generator publishes a search digest and the client consults it.

`v2/search.json` is an inverted index — folded token → the shards containing it:

```json
{
  "schemaVersion": 1,
  "shardIds": ["topo-n10w070", "topo-n20w090-30", "…"],
  "tokens": { "canyon": [17, 42], "quebec": [3], "…": [] }
}
```

- It is a **separate document**, not part of `index.json`. The index is fetched
  on every cold start and first paint depends on it; the digest is fetched
  lazily on the first keystroke and then cached for a week like a shard. Sizes:

  | Document      | Raw       | Gzipped  | Fetched                |
  | ------------- | --------- | -------- | ---------------------- |
  | `index.json`  | 61.6 KB   | 5.5 KB   | every cold start       |
  | `search.json` | 429.9 KB  | 142.6 KB | first search, then 7 d |
  | one shard     | 37–146 KB | 4–13 KB  | 6 per fetch round      |

  So the digest costs roughly what a dozen shards cost, once, only for someone
  who actually searches — against a 24 MB catalog and 20 MB map downloads.

- `shardIdsForQuery()` matches a query term as a **substring** of the digest's
  tokens and splits it on non-alphanumerics first, so it is never narrower than
  the item filter that runs on the fetched rows. False positives (a shard where
  two different items supplied the two terms) cost one wasted fetch; false
  negatives are impossible by construction.
- That is what lets the empty state stop lying. `catalogStore.searchScope`
  reports `complete` (every matching shard is in — "No maps match your search."
  is now a true statement), `partial` (more shards to pull), or `area-only` (no
  digest, e.g. offline). The last two show what was searched and offer an
  explicit **Search the whole catalog**.
- Build and query share one pure module (`src/core/catalog/searchDigest.ts`), so
  generator and client cannot drift on tokenization — the same rule as
  `planCatalogShards`.

## 4. Generating it

```
npx tsx scripts/catalog/fetch-<source>.ts   # → scripts/catalog/fragments/<source>.json
npx tsx scripts/catalog/build-manifest.ts   # → docs/catalog/v2/{index.json,search.json,shards/*.json}
npx tsx scripts/catalog/make-fixture.ts     # → .maestro/fixtures/catalog/ (e2e)
```

- Fragments are plain `{ sources, items }` JSON: one per source, either crawled
  by a `fetch-*.ts` or hand-curated.
- `build-manifest.ts` merges them, drops duplicate ids, refuses items whose
  `sourceId` was never declared, plans the shards with the **same**
  `planCatalogShards` the client's ranking assumes, and validates every shard
  and the index with the **app's own parsers** before writing. Generator and
  client cannot drift.
- The shard directory is rewritten from scratch each run, so a shard that no
  longer exists can never linger and serve items the index no longer lists.
- Sharding is deterministic: same items in, byte-identical output.

### The e2e fixture is sharded too

`.maestro/fixtures/catalog/` is an index + a search digest + two shards (topo
and nautical) + five ~1 KB zipped GeoPDFs, all around Québec City where CI
geo-fixes the emulator.
That is deliberate: the fixture is the only place the production path — fetch
index, rank shards, fetch the nearest, merge, consult the digest when the user
types, show "Around you" — runs on a device. It stays ~10 KB, so the e2e run is no slower than before.
`src/core/catalog/fixture.test.ts` guards every claim `.maestro/store.yaml`
makes about it.

The fixture's **nautical** shard is intentional even though the published
catalog has no nautical items yet (see `docs/CATALOG-SOURCES.md` §2 — no
hydrographic office publishes chart documents in a format we can render). Two
categories are what make the e2e run prove the parts that only matter at world
scale: round-robin shard selection, the per-category cap in "Around you", and a
category grid with more than one card. The fixture holds **five** items —
exactly `NEARBY_ROWS` — so "Around you" is full only when that cap adapts to the
categories present; with two items per category the section filled either way,
which is how it shipped capped at two rows in the single-category production
catalog while this flow stayed green. When a marine source becomes shippable
it lands in exactly this category, against plumbing already covered on device.

## 5. Sources

See `docs/CATALOG-SOURCES.md` for the per-source licence verdicts and evidence.
