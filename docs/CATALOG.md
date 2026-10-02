# The world catalog (`/catalog/v2/`)

How the Maps tab's catalog (the store; "Search" before 1.7.0) is generated, sharded, published and read.
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
  "categoryCounts": { "topo": 67983 },
  // Explorer facets (optional; §6). Global totals for the landing tiles:
  "kindCounts": { "topo": 79468 },
  "activityCounts": { "hiking": 27849, "paddling": 27881, "fishing": 21859, "climbing": 2163 },
  "terrainCounts": { "mountains": 27849, "water": 21859, "coast": 6515, "glacier": 2163 },
  // Side documents, fetched lazily (same path rules as shards):
  "search": { "path": "search.json", "byteSize": 741381, "tokenCount": 34764 },
  "facets": { "path": "facets.json", "byteSize": 47842 },
  "collections": { "path": "collections.json", "byteSize": 30603 },
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

`categoryCounts` exists so the landing grid can say "Topo · 67,983 maps"
**before a single shard is fetched**. `bbox` is the union of the shard's item
bboxes — deliberately not the cell, so a sheet whose coverage spills into the
next cell is still found by nearest-shard ranking. `byteSize` lets the client
budget a prefetch instead of guessing.

**As published today (2026-09-29):** 79,468 items in **352 shards** (281 topo,
71 forest), index **87.5 KB** (8.7 KB gzipped), search digest **724 KB**
(204 KB gzipped, lazy), facets digest 46.7 KB (6.5 KB gzipped, lazy), shard
bodies 31.2 MB in total, largest shard 166 KB / 400 items. (First-paint
measurements from 2026-09-02, before FSTopo: Québec City 367 KB, Denver
501 KB, Iqaluit 275 KB, Alice Springs 118 KB.)

### `v2/shards/<id>.json` — fetched on demand

```jsonc
{ "id": "topo-n40w080", "items": [/* CatalogItem[] — the v1 item shape */] }
```

Item fields are the v1 ones (`id`, `sourceId`, `title`, `category`,
`region?`, `bbox?`, `format`, `packaging`, `sizeBytes?`, `url`, `sidecar?`,
`thumbnailUrl?`, `updatedAt?`, `lang?`) plus the optional explorer fields
`kind?`, `activities?`, `terrain?` and `scale?` (§6). `category` stays
populated for apps that predate the explorer.

### `v1/manifest.json` — frozen, for old clients

Builds shipped before the world catalog read one flat manifest and know nothing
about shards. That file is still published, carrying **only** the Canadian
CanTopo set (`LEGACY_FRAGMENTS` in `build-manifest.ts`) — 2,234 sheets, ~1.0 MB
since the crawl went nationwide. Pouring the other 65 000 worldwide sheets into
it would hand those clients a 24 MB download they cannot page. New clients never read it — but `parseCatalogIndex` still _accepts_
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
the Maps tab costs the index (tens of KB) plus at most 6 shards under a
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

  | Document      | Raw       | Gzipped | Fetched                |
  | ------------- | --------- | ------- | ---------------------- |
  | `index.json`  | 87.5 KB   | 8.7 KB  | every cold start       |
  | `search.json` | 724 KB    | 204 KB  | first search, then 7 d |
  | one shard     | 37–166 KB | 4–15 KB | 6 per fetch round      |

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
npx tsx scripts/catalog/build-manifest.ts   # → docs/catalog/v2/{index,search,facets,collections}.json + shards/
npx tsx scripts/catalog/make-fixture.ts     # → .maestro/fixtures/catalog/ (e2e)
```

- Fragments are plain `{ sources, items }` JSON: one per source, either crawled
  by a `fetch-*.ts` or hand-curated.
- `fetch-quebec-rivers.ts` builds its fragment from a reviewed list,
  `scripts/catalog/sources/quebec-rivers.json`, and emits only the maps whose
  publisher has granted permission. Until one does, it writes no fragment
  (CATALOG-SOURCES §1.5).
- `build-manifest.ts` merges them, drops duplicate ids, refuses items whose
  `sourceId` was never declared, plans the shards with the **same**
  `planCatalogShards` the client's ranking assumes, and validates every shard
  and the index with the **app's own parsers** before writing. Generator and
  client cannot drift.
- The shard directory is rewritten from scratch each run, so a shard that no
  longer exists can never linger and serve items the index no longer lists.
- Sharding is deterministic: same items in, byte-identical output.
- `fetch-cantopo.ts` **discovers** NRCan's published NTS quadrangles from the
  directory index instead of carrying a list (a stale hardcoded list is what
  once held this source to 128 Maritimes/Ontario sheets), and takes each
  sheet's extent from NRCan's `nts_snrc.kmz` sheet index rather than the
  `ntsSheetBbox` grid formula, which returns null at 60°N and above — where
  four fifths of CanTopo's sheets are. Its ~2 200 HEADs are cached under
  `scripts/catalog/.cache/` (gitignored, 30-day TTL) so a re-run resumes.

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

## 6. The explorer taxonomy (#447)

The map explorer browses by **kind**, **activity** and **terrain**, and shows
link-out **collections** (Parcs Québec). The vocabulary is
`src/core/catalog/taxonomy.ts`; everything is derived at build time and the app
only reads it.

### Wire changes — additive, still `schemaVersion: 2`

- Items gain optional `kind`, `activities[]`, `terrain[]`, `scale` (denominator).
  The parser keeps known values only (deduplicated, in vocabulary order) and
  **never drops an item** over them. `category` stays populated for old apps.
- The index gains optional `kindCounts`, `activityCounts`, `terrainCounts`, and
  pointers `facets` and `collections` (same relative-path rules as shards).
- Why no version bump: the pre-explorer parser builds each item field by field
  and ignores unknown index keys. Checked directly: the parser as of `f5c4051`
  reads the regenerated index and all 352 shards (79,468 items) with **zero
  warnings**.
- Per-shard facet counts live in **`facets.json`** (`src/core/catalog/facets.ts`),
  not in the index: `{ schemaVersion: 1, shards: { "<shardId>": { kinds, activities, terrain } } }`.
  Shards are keyed by category × place, so without it "glacier maps near me"
  would mean fetching every nearby shard to find most hold none.
  `shardIdsWithFacet()` gives the shards worth fetching. It is 46.7 KB
  (6.5 KB gzipped), the same order as three shards. Kept out of the index,
  which every cold start pays for.

### Kind

`classifyKind()`: a title hint first (`historical`/`historique`/`legacy` →
`historical`), then the source (`SOURCE_KINDS`: US Topo, FSTopo, CanTopo and
AUSTopo are all `topo`), then the legacy category (`parks` → `park`, `hunting`
→ `hunting-fishing`, `touristic`/`river` → `trail`, …). Today every item is
`topo`.

### Activities — evidence, not vibes

Stored `activities` come only from evidence about the **product**:

1. **Keywords** (EN + FR, accent-folded, whole words) in tags, and in titles
   **only for descriptive kinds** (park, trail, hunting-fishing). A topo,
   nautical, aerial, geological or historical sheet is titled with a toponym.
   "Moose Lake", "Trail Creek", "Camp Verde" and "Fishing Bridge" say nothing
   about what the map is for.
   - `vtt` means **off-road**: in Québec it is the ATV (véhicule tout-terrain);
     a mountain bike is a "vélo de montagne".
   - `lac`/`lake`/`river` alone are not evidence. `river run`, `descente`,
     `portage` and the legacy `river` category are.
   - `sentier`/`trail` means hiking only when nothing more specific matched.
   - `hiver`/`winter` means ski + snowshoe only when neither is named.
2. **Kind default:** a hunting-fishing map that names neither activity gets
   both.

So **topo sheets carry no stored activities.** They reach the activity tiles
through **terrain affinity**, a browse rule rather than a fact about the sheet:
`itemActivities(item)` returns the item's own activities if it has any,
otherwise `TERRAIN_ACTIVITY_AFFINITY`:

| Terrain   | Activities         |
| --------- | ------------------ |
| mountains | hiking             |
| glacier   | climbing           |
| water     | paddling, fishing  |
| coast     | paddling           |
| forest    | — (would be "all") |

The index's `activityCounts` and `facets.json` count `itemActivities`, so a
tile's number always equals what tapping it lists. The UI can label
terrain-derived results honestly ("topographic maps of mountain terrain").

### Terrain — method and thresholds

Computed for every item with a bbox by `scripts/catalog/terrain.ts`. The pure
geometry is `src/core/catalog/terrain.ts`.

- **mountains** — Terrarium DEM (`elevation-tiles-prod/terrarium`, AWS Open
  Data; the contour Worker uses the same tiles), read at **z9**.
  - Each tile is reduced to 32 × 32 blocks of 8 px (about 1.1–2.2 km),
    holding min/max land elevation. Bathymetry and voids are clamped to 0 m.
  - Per item: `localRelief` is the largest max − min inside any 3 × 3-block
    window (about 5–7 km) of the footprint. It does not scale with sheet size,
    so a 1:250k sheet is not "mountains" just for being big.
  - **Mountains if `localRelief ≥ 450 m`, or `max ≥ 2000 m` and
    `localRelief ≥ 250 m`.** The second rule catches high country but not
    high plains.
  - Tuned on known sheets:

| Sheet                             | max / local relief (m) | Terrain                      |
| --------------------------------- | ---------------------- | ---------------------------- |
| Mount Washington NH (US Topo)     | 1904 / 1255            | mountains                    |
| Mount Rainier West WA             | 4367 / 2721            | mountains, glacier           |
| Mount Rainier East WA             | 4074 / 2376            | mountains, water, glacier    |
| Denali A-1 NW AK                  | 3495 / 1697            | mountains, glacier           |
| Mount Marcy NY                    | 1581 / 980             | mountains                    |
| Mount Mitchell NC                 | 2007 / 1060            | mountains                    |
| Aspen CO                          | 3549 / 1090            | mountains                    |
| South Lake Tahoe CA               | 3029 / 1119            | mountains, water             |
| Grand Canyon AZ                   | 2180 / 1438            | mountains, water             |
| Moab UT (canyon country)          | 1878 / 585             | mountains, water             |
| Wendover UT (salt desert)         | 1562 / 274             | —                            |
| Bonneville Racetrack UT           | 1610 / 361             | —                            |
| Key West FL                       | 89 / 89                | coast                        |
| Cape Canaveral FL                 | 16 / 16                | coast                        |
| Dodge City KS                     | 811 / 46               | water                        |
| Chicago Loop IL                   | 276 / 101              | water                        |
| Juneau A-1 NE AK                  | 1393 / 1324            | mountains, coast             |
| North Pangnirtung Fiord (CanTopo) | 1585 / 1339            | mountains, glacier, coast    |
| Iqaluit (CanTopo)                 | 378 / 283              | water, coast                 |
| Fredericton (CanTopo)             | 226 / 208              | water                        |
| Canberra SI55-16 (AUSTopo 250k)   | 1892 / 1022            | mountains, water             |
| Cook SH52-11 (AUSTopo, Nullarbor) | 194 / 29               | —                            |
| Uluru SG52-08 (AUSTopo 250k)      | 1079 / 472             | mountains (Petermann Ranges) |

Québec City has **no sheet** in the catalog (the CanTopo gap, see
CATALOG-SOURCES §1.3), so it cannot be spot-checked yet.
Result: 35% of items are mountains (US Topo 29%, CanTopo 29%, AUSTopo 36%).

- **glacier** — the footprint touches Natural Earth 1:10m `glaciated_areas`.
- **water** — the footprint touches a lake polygon or a river line. Layers:
  Natural Earth 1:10m `lakes`, `lakes_north_america`, `lakes_australia`,
  `rivers_lake_centerlines`, `rivers_north_america`, `rivers_australia`.
- **coast** — the footprint touches Natural Earth 1:10m `coastline`.
- **forest** — **not computed.** No small, open, global forest-cover layer
  answers "is this sheet forested" honestly at bbox scale, so we do not
  invent one.

Overlap uses a 0.5° grid-bucketed segment index (Liang–Barsky clip), plus a
centre-in-polygon test for sheets lying wholly inside a lake or ice sheet.
Natural Earth is generalized, so small lakes, streams and cirque glaciers are
missed. The facets are "notably", not "any".

**Runtime and cache.** First run: about 3 min. That is ~10,400 DEM tiles
(~1 GB transferred, never stored) plus ~38 MB of Natural Earth GeoJSON.
Re-runs: **a few seconds** for all 79k items. Cache in
`scripts/catalog/.cache/` (gitignored): `dem/` 41 MB of block summaries,
`naturalearth/` 38 MB. Pass `--no-terrain` to skip the pass.

### Scale

- US Topo: 1:24 000, Alaska 1:25 000. Territories get none, since Puerto Rico
  is 1:20 000.
- FSTopo: from the index, 1:24 000 or 1:25 000.
- CanTopo: 1:50 000.
- AUSTopo: 1:250 000.

### Collections — `v2/collections.json`

A bare `LinkOutCollection[]`, parsed by `src/core/catalog/collections.ts`.
Source data is hand-curated in `scripts/catalog/collections/*.json`, where each
place carries its provenance in an `evidence` field; the generator strips it.

- **Parcs Québec** (Sépaq): 24 parks and 13 wildlife reserves.
  - The 24 parks are 23 parcs nationaux plus the Parc marin du
    Saguenay–Saint-Laurent, typed "Marine park".
  - URLs are `https://www.sepaq.com/pq/{code}/` (parks) and `/rf/{code}/`
    (reserves).
  - Every code comes from a public source:
    - 27 from an OSM `website` tag confirmed by Wikidata P856;
    - 5 from Wikidata only: bou, ope, pta, mas, mor;
    - 5 from OSM only: msb, por, tem, aig, ssl.
  - **sepaq.com was never fetched.** It answers scripts with 403 and a CAPTCHA.
  - Coordinates are the OSM boundary centre (`out center`).
- **Zecs du Québec** (Réseau Zec): all 63 zecs, typed "ZEC", each linking to
  the zec's own site (`https://<name>.reseauzec.com/`, Martin-Valin on its own
  domain). Coordinates are the centre of the territory bbox from Réseau Zec's
  public `Public_zec` boundary layer. No zec states a licence, so no map file
  is linked and nothing enters the download catalog: see
  `docs/research/zec-maps.md` (per-zec map URLs, five GeoPDFs ready to add
  once Réseau Zec agrees).
- Activities per place type: national park → hiking, camping; marine park →
  paddling; wildlife reserve and ZEC → hunting, fishing (`PLACE_TYPE_ACTIVITIES`).
  A place may carry its own `activities` instead, when there is evidence for
  them (recorded in its `evidence.activities`): Zec Martin-Valin publishes a
  canoe-camping map, so it is tagged paddling, hunting, fishing, camping. No
  activity is added to a place on the strength of its type alone beyond the
  table above.
- **Places are points on the Explore map** (`src/core/catalog/explorePoints.ts`),
  beside the catalog sheets. A checked Activity keeps the places tagged with
  it; a checked Type keeps the places whose type maps to it
  (`PLACE_TYPE_KINDS`: parks → `park`, reserves and zecs → `hunting-fishing`);
  Terrain and Source describe sheets only, so they leave places out. A sheet's
  card downloads; a place's card opens the publisher's page. An activity with
  no point at all gets an empty state rather than a blank map.
- The explorer landing's "Popular near you" folds the nearest places (within
  250 km, at most half the row) in with the catalog maps
  (`popularNearYouCards`).
- Excluded, because Sépaq does not run them:
  - the Nunavik parks (Nunavik Parks);
  - Nibiischii and the Cree-run reserves;
  - reserves run by other operators;
  - federal parks.

  Sépaq tourist sites (Chute-Montmorency) are excluded too.
