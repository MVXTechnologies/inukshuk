# Vector base-map hosting (Cloudflare R2 + Worker)

The Stone & Paper base map (`src/core/map/stoneStyle.ts`, flag `VECTOR_BASEMAP_ENABLED`) reads
vector tiles in the **Protomaps v4 schema** from our own host. Why self-host, and why Protomaps:
`docs/design/vector-basemap.md`.

```
Protomaps daily planet ──(nas/refresh.sh: extract our regions)──▶ basemap.pmtiles
                                                                        │ upload
phones ──▶ inukshuk-tiles.…workers.dev (worker/, edge-cached) ──▶ R2 bucket inukshuk-tiles
```

| Path                               | What                                               |
| ---------------------------------- | -------------------------------------------------- |
| `/basemap/{z}/{x}/{y}.mvt`         | vector tile (gzip), z0–15; 204 where there is none |
| `/basemap.json`                    | TileJSON                                           |
| `/peaks/{z}/{x}/{y}.mvt`           | named summits (gzip), z5–12, from `peaks.pmtiles`  |
| `/contours/{z}/{x}/{y}.mvt`        | contour lines, generated on demand from DEM tiles  |
| `/fonts/{fontstack}/{range}.pbf`   | MapLibre glyphs (Atkinson Hyperlegible Next)       |
| `/trails/v1/index.json`            | long-distance trail index (Explore, #467)          |
| `/trails/v1/d/{version}/{id}.json` | one trail's route and stages (range-read)          |

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

## Long-distance trails (Explore, #467)

Explore's "Long-distance trails near you" reads OpenStreetMap route relations built by
`nas/trails.sh` (+ `nas/trails_build.py`, stdlib Python like the peaks script):

1. **Overpass, tags only** — per `pieces.json` bbox, `out tags bb` for every relation that is
   `type=route` + `route=hiking|foot|bicycle|mtb|ski|canoe` + `network=iwn|nwn|rwn|icn|ncn|rcn`,
   every `type=superroute` of those activities, and every hiking/ski/canoe route whatever its
   network (the Sentier des Caps de Charlevoix is `lwn`). A prefilter on the relation's bbox
   diagonal keeps what can be long: ≥ 10 km (international / national / superroutes), ≥ 15 km
   (regional), ≥ 20 km or a `distance` ≥ 40 km (local and unnetworked; cycling needs a network).
2. **Overpass, geometry** — `relation(id:…);out geom;` in batches (≤ 150 relations, ≤ 8 000 km of
   bbox diagonals), then the same for their child relations (stages), up to three levels.
3. **Wikidata** — sitelink counts for relations with a `wikidata` tag (50 ids per request).
4. **Build** — ways chained into lines (member order, either direction, gaps ≤ 60 m joined;
   `alternative`/`excursion`/`approach`/`backward` members left out), measured, and kept when
   ≥ 20 km (international / national) or ≥ 40 km (everything else). A relation that is a member
   of another candidate is that trail's stage. Same-name twins with overlapping boxes (a summer
   hike and a winter ski route) merge into one trail with both activities. Countries and regions
   come from Natural Earth (21 samples along the line; admin-1 at the midpoint).

**Popularity** (0…1; OSM has no usage data):

```
raw = network (international 1.0 · national 0.75 · regional 0.5 · other 0.3)
    + 0.15 if it has a wikipedia/wikidata tag
    + 0.35 · min(1, log10(1 + sitelinks) / log10(41))        40 language editions = full marks
    + 0.15 · clamp(log10(km / 20) / 2, 0, 1)                 20 km → 0, 2 000 km → 1
    + 0.05 if it has stages
pop = raw / 1.70
```

The app ranks "near you" as `0.55 · pop + 0.45 · 1 / (1 + km_away / 100)` over the trails within
300 km (topped up with the nearest others to at least three; worldwide by popularity without a
position) — `src/core/trails/rank.ts`.

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

## Check it

```sh
curl -sI https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/basemap/14/4950/5775.mvt   # 200, gzip
curl -s  https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/basemap.json | head -c 200
curl -sI "https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/fonts/Atkinson%20Hyperlegible%20Next%20Regular/0-255.pbf"
curl -sI https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/peaks/7/66/45.mvt        # 200, gzip (the Alps)
curl -s  https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/peaks.json | head -c 300
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
