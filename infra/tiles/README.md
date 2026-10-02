# Vector base-map hosting (Cloudflare R2 + Worker)

The Stone & Paper base map (`src/core/map/stoneStyle.ts`, flag `VECTOR_BASEMAP_ENABLED`) reads
vector tiles in the **Protomaps v4 schema** from our own host. Why self-host, and why Protomaps:
`docs/design/vector-basemap.md`.

```
Protomaps daily planet ──(nas/refresh.sh: extract our regions)──▶ basemap.pmtiles
                                                                        │ upload
phones ──▶ inukshuk-tiles.…workers.dev (worker/, edge-cached) ──▶ R2 bucket inukshuk-tiles
```

| Path                               | What                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| `/basemap/{z}/{x}/{y}.mvt`         | vector tile (gzip), z0–15; 204 where there is none   |
| `/basemap.json`                    | TileJSON                                             |
| `/peaks/{z}/{x}/{y}.mvt`           | named summits (gzip), z5–12, from `peaks.pmtiles`    |
| `/parks/{z}/{x}/{y}.mvt`           | national parks (gzip), z4–12 — **not published yet** |
| `/contours/{z}/{x}/{y}.mvt`        | contour lines, generated on demand from DEM tiles    |
| `/fonts/{fontstack}/{range}.pbf`   | MapLibre glyphs (Atkinson Hyperlegible Next)         |
| `/trails/v1/index.json`            | long-distance trail index (Explore, #467)            |
| `/trails/v1/d/{version}/{id}.json` | one trail's route and stages (range-read)            |

Coverage (`nas/pieces.json`): **the whole world** (land between 60° S and 84° N) as 20 regional
archives plus `basemap.index.json` — Canada/US/Greenland and Europe first (2026-09-28 morning),
the rest the same afternoon (~140 GB in R2). One extract of a large area needs more RAM than the
NAS has (its directory alone was OOM-killed), so the Worker routes each tile to the piece whose
bbox touches it; pieces never overlap.

## Live state (2026-09-27)

- Worker `inukshuk-tiles` deployed on the free **workers.dev** host (account
  `6da1749801bb30ce789cc1243b5b658f`), bound to R2 bucket `inukshuk-tiles`.
- `basemap.pmtiles` = a **Québec City region extract** (−73.0…−69.5, 46.0…48.6; 180 MB),
  uploaded from a Mac with `wrangler r2 object put` (limit ~300 MB). The full Canada + US +
  Europe archive needs `nas/refresh.sh` (S3 keys, multipart upload).
- Atkinson glyphs uploaded (10 ranges × Regular/Bold/Italic).
- Custom domain `tiles.mvxtechnologies.com` waits for the zone to move from Namecheap DNS to
  Cloudflare; the app's default host is `TILE_HOST` in `src/data/basemapTiles.ts`.

## One-time setup (owner)

1. **Cloudflare account** with **R2** enabled (asks for a card even on the free tier).
2. Create the bucket: R2 → Create bucket → `inukshuk-tiles` (location: automatic).
3. **R2 API token** (R2 → Manage API tokens → Create): _Object Read & Write_ on
   `inukshuk-tiles`. Note the **Access Key ID**, **Secret Access Key** and your **Account ID**.
4. **DNS**: add `mvxtechnologies.com` to Cloudflare (or delegate a subdomain), so the Worker can
   take `tiles.mvxtechnologies.com`.
5. **Deploy the Worker** (from `infra/tiles/worker/`):
   ```sh
   npm install
   npx wrangler login
   # uncomment the `routes` line in wrangler.toml once the zone is on Cloudflare
   npx wrangler deploy
   ```
6. **First upload** from the NAS (Docker, ~80 GB free):
   ```sh
   export R2_ACCOUNT_ID=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
   infra/tiles/nas/refresh.sh          # tiles, ~1–3 h (download + upload)
   infra/tiles/fonts/build-glyphs.sh   # glyphs, once
   ```
7. **Monthly refresh**: user crontabs are disabled on the UGREEN NAS, so a small container runs
   `nas/scheduler.sh` (1st of the month, 03:00): `docker compose -f nas/compose.yaml up -d`.
   Uploads go through the Worker (`nas/upload.py`, token in `~/inukshuk-tiles/.upload-token`),
   so no R2 S3 keys are needed.

## Peaks (named summits)

Protomaps only puts peaks in its `pois` layer from **z13** (Mont Sainte-Anne, 808 m, first appears
in z13 tiles), so the big summits were nameless at the zooms where you plan a trip. `nas/peaks.sh`
builds our own worldwide `peaks.pmtiles` from OpenStreetMap and the app's `stone-peak` layer reads
it (source `basemap-peaks`, `src/features/map/mapStyle.ts`), labelled "Name / 1 234 m".

1. **Overpass**: `node["natural"~"^(peak|volcano)$"]["name"](s,w,n,e); out qt;` once per
   `pieces.json` bbox (24 queries), `[out:json][timeout:900][maxsize:1 GiB]`.
2. **`nas/peaks_geojson.py`** (stdlib): GeoJSONSeq with `name` (+ `name:en`/`name:fr` when they
   differ), `ele` (integer metres parsed from "1234", "1,234 m", "4000ft", "~1200" …; garbage
   dropped), `kind`, deduplicated by OSM id, and a per-feature `tippecanoe.minzoom`:

   | elevation  | ≥ 4000 m | ≥ 3000 | ≥ 2000 | ≥ 1500 | ≥ 1000 | ≥ 500 | > 0 | unknown |
   | ---------- | -------- | ------ | ------ | ------ | ------ | ----- | --- | ------- |
   | first zoom | 5        | 6      | 7      | 8      | 9      | 10    | 11  | 12      |

   An OSM `prominence` ≥ 500 m moves a peak one zoom earlier, ≥ 1500 m two (never before z5).
   Tests: `python3 -m unittest infra/tiles/nas/test_peaks_geojson.py`.

3. **tippecanoe** 2.79.0 (felt), built once on the NAS from its checksum-pinned release tarball
   (felt publishes no image): `-Z5 -z12 -r1 --no-feature-limit --no-tile-size-limit`, so every
   summit is in every tile from its own minzoom and nothing is thinned or shed from a crowded tile
   (the Alps at z7, the densest tile, is ~75 KB gzipped). z12 is the last rung of the ladder, so
   deeper tiles would only be copies; MapLibre overzooms z12.
4. **Upload** as `peaks.pmtiles` with `upload.py` — only if the count is ≥ `PEAKS_MIN_FEATURES`
   (400,000; OSM has ~700k named summits) and not more than 30 % below the last run's
   (`work/peaks/count`).

Run by hand (after the basemap refresh, or on its own):

```sh
~/inukshuk-tiles/infra/nas/peaks.sh                 # ~1–2 h, nearly all of it Overpass
PEAKS_RESUME=1 ~/inukshuk-tiles/infra/nas/peaks.sh  # keep the pieces an interrupted run fetched
OVERPASS_URL=https://overpass.private.coffee/api/interpreter ~/inukshuk-tiles/infra/nas/peaks.sh
```

Disk: < 1 GB in `work/peaks/` at peak (raw Overpass JSON ~150 MB, GeoJSONSeq ~130 MB, the archive
~80–150 MB — a Swiss sample of 14.7k summits made 1.9 MB); the first run also builds tippecanoe
(~5 min, ~0.5 GB of image and build cache). The monthly
`scheduler.sh` runs it after `refresh.sh`; either can fail without stopping the other, and the
previous month's archive stays live.

**Overpass etiquette**: one query at a time, a descriptive User-Agent
(`inukshuk-tiles/1.0 (+https://inukshuk.mvxtechnologies.com)`), 30 s between queries, exponential
backoff on 429/504, and a bbox Overpass can't answer (timeout / out of memory) is split in four,
up to four times. Once a month is well within the public instance's fair use.

**Attribution**: summits are OSM data (ODbL), covered by the base map's existing
"© OpenStreetMap contributors" credit; the archive carries the same attribution.

## Parks (national parks and protected areas)

**Status: written, not run.** `parks.pmtiles` is not on R2 yet, so the app draws the parks
Protomaps has. After the first run, set `PARKS_TILES_PUBLISHED = true` in
`src/data/basemapTiles.ts` (an OTA) and the map switches to these tiles.

**Why.** Protomaps files protected land under four `landuse`/`pois` kinds and gets the important
ones wrong. Measured on our served tiles (2026-10-02, 26 well-known parks on five continents):

| Protomaps kind   | parks                                                                          | boundary                             | name from  |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------ | ---------- |
| `national_park`  | 9 — Banff, Mont-Tremblant, Vanoise, Sarek, Torres del Paine …                  | z4                                   | z5–7       |
| `nature_reserve` | 8 — Yellowstone, Yosemite, Grand Canyon, Kruger, Serengeti, Kakadu …           | z4                                   | z7         |
| `park`           | 6 — Jacques-Cartier, Grands-Jardins, Algonquin, Swiss NP, Triglav, Daisetsuzan | z4, but the same kind as a city park | **z11–12** |
| no polygon       | 2 — Lake District, Adirondack                                                  | **none**                             | z7         |

The polygons carry no name and no size, only the kind; names are `pois` points with a `min_zoom`,
in the tiles from the zoom before it. So a third of the sample cannot be drawn as a national park
from Protomaps alone: Jacques-Cartier (670 km²) is indistinguishable from a neighbourhood park and
nameless until z12. OSM itself is clear about it: Jacques-Cartier and Grands-Jardins are
`boundary=national_park` — with no `protect_class`, which seems to be what Protomaps' rule wants.

**What `nas/parks.sh` builds** (+ `nas/parks_geojson.py`, stdlib Python; tests:
`python3 -m unittest infra/tiles/nas/test_parks_geojson.py`):

1. **Overpass**, two queries per `pieces.json` bbox:
   - _national_ — `boundary=national_park`, or `boundary=protected_area` + `protect_class=2`,
     named, `out geom` (~4 600 + the IUCN II areas worldwide);
   - _reserve_ — every other named `boundary=protected_area` of a nature class (`protect_class`
     1a–7 or none; heritage, military and Natura 2000 overlays are left out) and
     `leisure=nature_reserve`, `out tags bb` — no geometry (~110 000 worldwide; their
     boundaries stay Protomaps' polygons).
2. **Convert** to two GeoJSONSeq files:
   - `parks` layer — a MultiPolygon per national park (member ways stitched into rings, holes
     kept), with `name`, `class: national`, `rank`;
   - `park_labels` layer — a point per protected area with `name` (+ `name:en`/`name:fr`), `class`
     (`national` | `reserve`) and `rank`. A national park's point is inside its largest part, as
     far from the edge as a coarse grid search finds (a centroid can land outside a crescent);
     a reserve's is the centre of its bounds.

   `rank` is the zoom the area earns; a reserve comes two zooms after a park of its size (its
   area is estimated as 60 % of its bounding box):

   | area (km²) | ≥ 20 000 | ≥ 5 000 | ≥ 1 500 | ≥ 400 | ≥ 100 | ≥ 25 | ≥ 6 | smaller |
   | ---------- | -------- | ------- | ------- | ----- | ----- | ---- | --- | ------- |
   | rank       | 4        | 5       | 6       | 7     | 8     | 9    | 10  | 11      |

   A label is in the tiles from its rank, a polygon two zooms earlier (never before z4), so a
   park's outline arrives before its name.

3. **tippecanoe** (the image `peaks.sh` builds): `-Z4 -z12 -r1 --no-feature-limit
--no-tile-size-limit --no-tiny-polygon-reduction`, layers `parks` and `park_labels`.
4. **Upload** as `parks.pmtiles` — only with ≥ `PARKS_MIN_FEATURES` (3 500) national parks and not
   more than 30 % below the last run. The Worker needs no change: it serves any `{archive}.pmtiles`
   as `/{archive}/{z}/{x}/{y}.mvt` and `/_upload` already takes `*.pmtiles`.

```sh
~/inukshuk-tiles/infra/nas/parks.sh                 # several hours (estimate), nearly all Overpass
PARKS_RESUME=1 ~/inukshuk-tiles/infra/nas/parks.sh  # keep the pieces an interrupted run fetched
```

**Dry run** (2026-10-02, on a Mac, steps 1–3 without Docker or upload, three small boxes: Québec,
the Engadin, Yellowstone): 19 national polygons — every relation closed into rings — and 176
labels; 3.1 MB of raw Overpass JSON gave a 0.4 MB archive, and the app drew it from a loopback
`pmtiles serve` on the emulator. The full 24-piece run and its duration are untested.
**Monthly**: not in `scheduler.sh` yet; add it after peaks the way the trails block below shows.
Same Overpass etiquette and attribution as the peaks.

**In the app** (`buildStoneLayers`, `src/core/map/stoneStyle.ts`): `stone-park-band` +
`stone-park-line` (the boundary: a solid green edge over a translucent band along its inside),
`stone-park-outline` (quiet dashes) and `stone-park-label` (green italic), all behind the
"Parks & protected areas" switch of the overlays menu. With these tiles the strong boundary is
ours and every name comes from `park_labels`; without them it is Protomaps' three protected kinds,
its `park` polygons are dashed, and names appear when Protomaps' `min_zoom` says.

## Long-distance trails (Explore, #467)

Explore's "Long-distance trails near you" reads OpenStreetMap route relations built by
`nas/trails.sh` (+ `nas/trails_build.py`, stdlib Python like the peaks script):

1. **Overpass, tags only** — per `pieces.json` bbox, `out tags bb` for every relation that is
   `type=route` + `route=hiking|foot|bicycle|mtb|ski|canoe` + `network=iwn|nwn|rwn|icn|ncn|rcn`,
   every `type=superroute` of those activities, and every hiking/ski/canoe route whatever its
   network (the Sentier des Caps de Charlevoix is `lwn`), plus their parent relations up to three
   levels (`rel(br)` — a superroute has no ways of its own, so a bbox never matches it). A
   prefilter on the relation's bbox diagonal keeps what can be long: ≥ 10 km (international /
   national; superroutes always), ≥ 15 km (regional), ≥ 20 km or a `distance` ≥ 40 km (local and
   unnetworked; cycling needs a network). A bare `ref` is not a name.
2. **Overpass, geometry** — `relation(id:…);out geom;` in batches (≤ 150 relations, ≤ 8 000 km of
   bbox diagonals), then the same for their child relations (stages), up to three levels.
3. **Wikidata** — sitelink counts for relations with a `wikidata` tag (50 ids per request).
4. **Build** — ways chained into lines (member order first, then any ways sharing an end node
   whatever their order, either direction; the pieces left ordered and turned end-to-end —
   member order unless a geographic chaining jumps clearly less — and gaps ≤ 60 m joined; real
   gaps stay separate parts, never a drawn connector;
   `alternative`/`excursion`/`approach`/`backward` members left out), measured, and kept when
   ≥ 30 km (international / national) or ≥ 40 km (everything else). A relation that is a member
   of another route is that route's **stage**, and not a trail of its own — unless it stands
   alone: its own Wikidata item with ≥ 5 sitelinks (the Appalachian Trail, a stage of the Eastern
   Continental Trail), or its own `website` (the Sentier des Caps, a stage of the Sentier
   National); a section named like its trail ("Sentier National, Charlevoix") never does. A
   wrapper around one route (plus variants) is one trail. Stages keep member order (side trails
   listed after the main sections stay there), except that a stage listed out of place moves
   into the gap where it hands over to both neighbours (ends ≤ 1 km), and a stage mapped in the
   other direction is turned round, its `from`/`to` swapped (the AT's Virginia; the Balcon du
   Léman stages the GR 5 walks backwards). A way shared by two child routes is drawn once.
   A stage named only like its trail (the
   AT's state sections) takes its region's name. Same-name twins with overlapping boxes (a summer
   hike and a winter ski route) merge into one trail with both activities. Countries and regions
   come from Natural Earth (21 samples along the line; admin-1 at the midpoint). Thumbnails bridge
   OSM gaps under 8 % of the trail's extent; details keep them.

**Pilot (2026-09-29)** — Québec + Maritimes + New England (−80…−59, 40.5…50.5) and the Mont-Blanc
area (6.4…8.2, 45.4…46.4), on overpass-api.de: 2 tag queries + 27 geometry batches, 220 MB of raw Overpass JSON, 3 085 relations with geometry → **355 trails**
(69 with stages; 183 regional, 106 local, 55 national, 11 international; 145 cycling, 141 hiking,
73 paddling), index **135 KB (69 KB gzipped)**, details 4.4 MB (median 3 KB, largest 400 KB —
the Eastern Continental Trail). Parents outside the boxes come along (the whole Appalachian Trail,
the Via Alpina), so a worldwide run is not the sum of its pieces; expect roughly 20–40k trails,
an index of ~8–15 MB (~4–8 MB gzipped, ~380 bytes a trail) and a few hundred Overpass queries.

**Popularity** (0…1; OSM has no usage data):

```
raw = network (international 1.0 · national 0.75 · regional 0.5 · other 0.3)
    + 0.15 if it has a wikipedia/wikidata tag
    + 0.35 · min(1, log10(1 + sitelinks) / log10(41))        40 language editions = full marks
    + 0.15 · clamp(log10(km / 20) / 2, 0, 1)                 20 km → 0, 2 000 km → 1
    + 0.05 if it has stages
pop = raw / 1.70
```

The app ranks "near you" as `(0.55 · pop + 0.45 · 1 / (1 + km_away / 100)) · activity` over the
trails within 300 km (topped up with the nearest others to at least three; worldwide by
`pop · activity` without a position) — `src/core/trails/rank.ts`.

**Hiking first** (owner call, #472): `activity` is the best weight among the trail's activities —
hiking 1.0, skiing 0.85, paddling 0.8, cycling 0.75. It multiplies the near-you score and
"Most popular"; "Nearest first" sorts by `km_away / activity` (a cycle route 20 km away sorts like
a hike 27 km away). Cycling, paddling and ski routes still appear, after comparable hikes.

**Offline download, stage by stage** (#472): each stage's corridor (≈3 km each side, cut into
≤ 20 km boxes, one MapLibre pack per box) downloads on its own from its row on the trail page or
from the map's stage sheet. A trail without stages is one download only when it is ≤ 60 km;
longer ones say to download an area from the map.

**Outputs** (`work/trails/out/`), served by the Worker:

| R2 object                       | Route                              | What                                       |
| ------------------------------- | ---------------------------------- | ------------------------------------------ |
| `trails-v1.index.json`          | `/trails/v1/index.json`            | every trail, compact keys, 40-pt thumbnail |
| `trails-{version}.details.bin`  | `/trails/v1/d/{version}/{id}.json` | per-trail detail documents, concatenated   |
| `trails-{version}.offsets.json` | (read by the Worker)               | `{id: [offset, length]}` into the `.bin`   |

A detail is the trail's geometry simplified at 10 m (raised on the very longest so none passes
60 000 points) as encoded polylines, its stages (name, from/to, length, geometry) and its
`operator` / `website` / `wikipedia` / `description`. One `.bin` instead of tens of thousands of
small objects keeps the upload to three files; the version is in the detail URL, so details cache
for a month at the edge and the index — uploaded **last** — switches everything atomically.
Old `trails-{version}.*` objects can be deleted by hand once a newer index is live.

Run by hand:

```sh
~/inukshuk-tiles/infra/nas/trails.sh                  # Overpass + Wikidata + build + upload
TRAILS_RESUME=1 ~/inukshuk-tiles/infra/nas/trails.sh  # keep what an interrupted run fetched
python3 -m unittest infra/tiles/nas/test_trails_build.py
```

Uploading the new key types needs the Worker from this change deployed first (`/_upload` accepts
`*.details.bin` and `*.offsets.json`). It refuses to upload below `TRAILS_MIN_TRAILS` (8 000) or
more than 30 % under the last run's count (`work/trails/count`).

**Monthly**: not in `scheduler.sh` yet. To schedule it after peaks, add to the loop (then
`docker compose -f nas/compose.yaml up -d --force-recreate` — a running `sh` must not have its
script edited under it):

```sh
    echo "$(date) trails starting"
    "$HOME/inukshuk-tiles/infra/nas/trails.sh" && echo "$(date) trails done" || echo "$(date) trails FAILED"
```

**Attribution**: OSM data (ODbL) — the trail page says "Route from OpenStreetMap (© contributors,
ODbL)"; the index carries the attribution string too.

## Contour lines (#509)

`/contours/{z}/{x}/{y}.mvt` is generated on demand (`worker/src/contours.ts`, pure parts in
`contourMath.ts`, tested by the app's jest) from the Terrarium DEM tiles on AWS Open Data:

1. **Edge cache** (per Cloudflare location, 30 days), then **R2**: every generated tile is
   written to `contours/{CONTOUR_VERSION}/{z}/{x}/{y}.mvt` (gzipped) after the response, so a
   tile costs its CPU once ever. `X-Contour-Source: r2 | generated` says which. Bump
   `CONTOUR_VERSION` when the geometry changes; old prefixes can be deleted at leisure.
2. **Generation** aims at the free plan's 10 ms of CPU, which Alpine tiles used to blow (error
   1102): DEM PNGs inflated by the native `DecompressionStream`; decoded DEM tiles kept per
   isolate (LRU); steep regions get a coarser interval, set by the steepest tile of each
   4 × 4-tile region (`MAX_CROSSINGS_PER_CELL`, `DENSITY_REGION_ZOOMS` in `contourMath.ts` —
   the interval can only change on that grid, which shows as a density step where it does);
   lines simplified (Douglas–Peucker, ½ px, ¼ px on the deepest tiles); closed rings under 1.5
   DEM pixels, and anything at or below sea level, dropped.
   Coarsening thins the dark band the old dense lines drew on steep walls, so every feature
   carries `k` (how many lines of the zoom's own interval a line stands for; 1 = kept) and `s`
   (steepness class 0–3 of that stretch, from the DEM gradient along it; lines are cut where it
   changes). The app's style (`contourStroke` in `src/core/map/stoneStyle.ts`) draws `k > 1`
   stretches heavier and a little toward ink by `s`; `k = 1` tiles draw exactly as before.
3. The app loads z8–13 (`CONTOUR_SOURCE_*` in `src/features/map/mapStyle.ts`) and overzooms
   past 13; the Worker still answers z14 for older app versions.

Measured 2026-10-01 at z10–13 (Node on an M-series Mac, same V8; Workers' CPUs are slower):
an Alpine tile (Zermatt, Chamonix, Bernese Oberland, Brienz) went from 15–25 ms cold / 5–11 ms
warm to ≈ 9–11 ms cold / 3–5 ms warm, and from 26–55 k to 3.8–7.3 k vertices (36–76 KB →
11–19 KB gzipped, with the steepness tags). Québec City and Mont-Sainte-Anne keep their intervals and look the same (fewer
vertices only).

**Pre-generating dense mountain regions** (optional, NAS): run the same `contourTile` under
Node over a bbox (Alps, Rockies…) for z8–13, write the gzipped tiles into a PMTiles archive
(`pmtiles` CLI `convert` from an MBTiles, or write the R2 objects directly with the upload
endpoint), and have the Worker check it before generating. The R2 write-through makes this
unnecessary unless the free plan's CPU limit still bites.

## Check it

```sh
curl -sI https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/basemap/14/4950/5775.mvt   # 200, gzip
curl -s  https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/basemap.json | head -c 200
curl -sI "https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/fonts/Atkinson%20Hyperlegible%20Next%20Regular/0-255.pbf"
curl -sI https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/peaks/7/66/45.mvt        # 200, gzip (the Alps)
curl -s  https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/peaks.json | head -c 300
curl -sI "https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/contours/13/4270/2915.mvt?v=2"  # 200, gzip; X-Contour-Source
```

Then in the app: `VECTOR_BASEMAP_ENABLED = true` (`src/core/features/flags.ts`) and, once the
glyphs are up, `VECTOR_GLYPHS_URL` (see `src/data/basemapTiles.ts`).

## Local development

No Cloudflare needed: cut a small extract and serve it with the Worker itself.

```sh
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles quebec-dev.pmtiles \
  --bbox=-71.65,46.65,-70.75,47.40
cd infra/tiles/worker && npm install
npx wrangler r2 object put inukshuk-tiles/quebec-dev.pmtiles --file=../../../quebec-dev.pmtiles --local
npx wrangler dev --port 8787
# build the app with VECTOR_TILES_URL='http://127.0.0.1:8787/quebec-dev/{z}/{x}/{y}.mvt'
```

## Cost (Cloudflare list prices, Sept 2026 — check before relying on them)

- Storage: $0.015/GB-month after 10 GB free → ~$1/month for 70 GB.
- Worker: free up to 100k requests/day; the $5/month plan includes 10M requests/month, then
  $0.30 per million. Edge-cached tiles still count as Worker requests.
- R2 reads (cache misses only): 10M/month free, then $0.36 per million. No egress fees.
- Roughly **$6–8/month at 1,000 monthly users, ~$25 at 10,000, ~$50 at 25,000.**

## Licences

Map data (base map and summits) © OpenStreetMap contributors (ODbL), processed by Protomaps (the app credits
"© OpenStreetMap · Protomaps"). Atkinson Hyperlegible Next: SIL OFL 1.1.
