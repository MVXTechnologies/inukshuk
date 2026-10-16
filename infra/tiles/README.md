# Vector base-map hosting (Cloudflare R2 + Worker)

The Stone & Paper base map (`src/core/map/stoneStyle.ts`, flag `VECTOR_BASEMAP_ENABLED`) reads
vector tiles in the **Protomaps v4 schema** from our own host. Why self-host, and why Protomaps:
`docs/design/vector-basemap.md`.

```
Protomaps daily planet ──(nas/refresh.sh: extract our regions)──▶ basemap.pmtiles
                                                                        │ upload
phones ──▶ tiles.mvxtechnologies.com (worker/, edge-cached) ──▶ R2 bucket inukshuk-tiles
```

| Path                               | What                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| `/basemap/{z}/{x}/{y}.mvt`         | vector tile (gzip), z0–15; 204 where there is none               |
| `/basemap.json`                    | TileJSON                                                         |
| `/peaks/{z}/{x}/{y}.mvt`           | named summits (gzip), z5–12, from `peaks.pmtiles`                |
| `/parks/{z}/{x}/{y}.mvt`           | national parks (gzip), z4–12 — **not published yet**             |
| `/geodetic/{z}/{x}/{y}.mvt`        | survey marks (gzip), z5–13, from `geodetic.pmtiles`              |
| `/geodetic.json`                   | its TileJSON; `description` = build date + counts                |
| `/dem/{z}/{x}/{y}.png`             | Terrarium elevation, z0–16: LiDAR inside coverage, AWS elsewhere |
| `/contours/{z}/{x}/{y}.mvt`        | contour lines, generated on demand from DEM tiles                |
| `/fonts/{fontstack}/{range}.pbf`   | MapLibre glyphs (Atkinson Hyperlegible Next)                     |
| `/trails/v1/index.json`            | long-distance trail index (Explore, #467)                        |
| `/trails/v1/d/{version}/{id}.json` | one trail's route and stages (range-read)                        |

Coverage (`nas/pieces.json`): **the whole world** (land between 60° S and 84° N) as 20 regional
archives plus `basemap.index.json` — Canada/US/Greenland and Europe first (2026-09-28 morning),
the rest the same afternoon (~140 GB in R2). One extract of a large area needs more RAM than the
NAS has (its directory alone was OOM-killed), so the Worker routes each tile to the piece whose
bbox touches it; pieces never overlap.

## Live state (2026-10-16): two accounts during the move (#731)

| Host                                                        | Account                                      | Bucket `inukshuk-tiles`           | Who uses it                                  |
| ----------------------------------------------------------- | -------------------------------------------- | --------------------------------- | -------------------------------------------- |
| `https://tiles.mvxtechnologies.com` (Custom Domain)         | company (MVX), `b9307a7d…3680`, Workers Paid | new; filled from the NAS (below)  | the app from the release that ships #731     |
| `https://inukshuk-tiles.marcandre-vigneault-96.workers.dev` | personal (old), `6da17498…658f`              | ~140 GB, frozen (no more uploads) | older installs, until it is retired (~3 mo.) |

- `worker/wrangler.toml` pins the company `account_id` and the Custom Domain route; a deploy from
  a machine logged into another account fails instead of landing there. Wrangler created the
  `tiles` DNS record and certificate itself. There is no workers.dev address on this account.
- `TILE_KEY_HOST` (`src/data/basemapTiles.ts`) stays the OLD host forever: it is the offline-pack
  cache key. `TILE_HOST` is the new one; MapLibre's requests are rewritten to it after the offline
  lookup (`docs/design/tile-urls.md`), so no downloaded region needs a re-download.
- NAS uploads (`upload.py`, `republish.sh`, `dem.sh`) default to the new host; `TILE_HOST=…`
  overrides. The old bucket no longer gets the monthly refresh: old installs keep the Oct-2026
  data until that Worker is retired.

### Moving to the company account (#731) — owner runbook

Done by an agent (2026-10-16): bucket `inukshuk-tiles` created on the company account, the Worker
from `main` deployed to `tiles.mvxtechnologies.com` (version `9a80b584`), Atkinson glyphs copied
(30 ranges, byte-identical to the old host), lifecycle rule `donor-verify/` → expire after 1 day
added. Without data the Worker answers the base map with
`502 tile error` (no `basemap.index.json` yet) and serves `/dem` from AWS, `/search` and
`/contours` normally.

1. **Secrets on the new Worker** (Mac, in `infra/tiles/worker`; the values never appear on
   screen or in chat):
   ```sh
   # The NAS upload token, piped straight from its file (reuses the existing token):
   ssh nas 'cat ~/inukshuk-tiles/.upload-token' | npx wrangler secret put UPLOAD_TOKEN
   npx wrangler secret put STRAVA_CLIENT_SECRET       # Strava → Settings → My API Application
   npx wrangler secret put ERROR_REPORT_GITHUB_TOKEN  # fine-grained PAT, Issues R/W on this repo
   npx wrangler secret put RESEND_API_KEY             # resend.com → API Keys
   npx wrangler secret put DONOR_VERIFY_SALT          # any long random string (pending codes live 15 min)
   ```
   `wrangler secret put` prompts with hidden input (or reads a pipe). Check:
   `npx wrangler secret list` names all five. Until each is set its route answers 404
   (`/_upload`, `/strava/*`, `/error-report`, `/donor-verify/*`).
2. **Refill the bucket from the NAS** — nothing is rebuilt; everything the NAS has on disk goes
   up through the Worker's `/_upload` endpoint (no R2 S3 keys needed):
   ```sh
   tar -C infra/tiles -cf - nas | ssh nas 'tar -C ~/inukshuk-tiles/infra -xf -'   # scp is broken there
   ssh nas 'nohup ~/inukshuk-tiles/infra/nas/republish.sh small   > ~/inukshuk-tiles/work/republish-small.log 2>&1 &'
   # check the small group landed (minutes), then the base map (hours):
   ssh nas 'nohup ~/inukshuk-tiles/infra/nas/republish.sh basemap > ~/inukshuk-tiles/work/republish-basemap.log 2>&1 &'
   ```
   `small` = Convert grid packs (~0.4 GB), trails (~51 MB), tides, geodetic (~0.9 GB), peaks,
   parks, and climbing data if built (~70 MB); `basemap` = the 24 pieces (**139 GB**) then
   `basemap.index.json`. At the ~30 MB/s measured on 2026-09-28 that is **~1.5 h** for the base
   map (up to ~4 h if the uplink is slower). Interrupted? Run the same command again: finished
   objects are skipped (`work/.republish/`), a half-sent one resumes part by part. Progress:
   `ssh nas tail -f ~/inukshuk-tiles/work/.republish/tiles.mvxtechnologies.com/current.log`.
3. **DEM** (#725) goes straight to the new bucket: the "Precise elevation" runbook below, unchanged
   (`dem.sh` now defaults to the new host).
4. **Check** the new host (the curls under _Check it_, which use it) and compare a few tiles byte
   for byte with the old host.
5. **Resend**: the records imported into the Cloudflare zone include none of Resend's
   (`resend._domainkey`, `send.` MX/TXT). Resend → Domains → `mvxtechnologies.com` must say
   _Verified_; if not, add the records it lists in Cloudflare → DNS, or the code emails fail.
6. **Ship the app change** (`TILE_HOST`) only after 2–4 pass, then point `ERROR_REPORT_ENDPOINT`
   (EAS env + repo variable, `docs/DEPLOYMENT.md`) at `https://tiles.mvxtechnologies.com/error-report`.
7. **Retire the old Worker** after ~3 months (old installs then lose the base map unless updated).

Not on the NAS, so step 2 does not bring them: generated contours (regenerated on demand, cached
in the new bucket), the donor records (`donors/pending/*`, `donor-verify/*`) and anything else
written by the old Worker. If those matter, copy the old bucket instead (or as well):

**Alternative: Cloudflare Super Slurper** (dashboard on the company account → R2 → Data Migration
→ Migrate files). Source: _S3-compatible_, endpoint
`https://6da1749801bb30ce789cc1243b5b658f.r2.cloudflarestorage.com`, bucket `inukshuk-tiles`,
with an R2 token **from the old account** (old dashboard → R2 → Manage R2 API Tokens → Create →
_Object Read only_, bucket `inukshuk-tiles`). Destination: bucket `inukshuk-tiles` with a
company-account token (R2 → Manage R2 API Tokens → Create → _Object Read & Write_, bucket
`inukshuk-tiles`). Keys are pasted only into that dashboard form. It copies every object (~140 GB,
including donors and contours) on Cloudflare's side, with no NAS uplink involved; expect hours, not
days. Run it before `republish.sh` (or instead of its `basemap` group) so the NAS does not upload
what the copy brings anyway, then delete both tokens.

## One-time setup (owner)

1. **Cloudflare account** with **R2** enabled (asks for a card even on the free tier).
2. Create the bucket: R2 → Create bucket → `inukshuk-tiles` (location: automatic).
3. **R2 API token** (R2 → Manage API tokens → Create): _Object Read & Write_ on
   `inukshuk-tiles`. Note the **Access Key ID**, **Secret Access Key** and your **Account ID**.
4. **DNS**: add `mvxtechnologies.com` to Cloudflare (or delegate a subdomain), so the Worker can
   take `tiles.mvxtechnologies.com`.
5. **Deploy the Worker** (from `infra/tiles/worker/`):
   ```sh
   npm ci   # exactly the committed package-lock.json, never a fresh resolve
   npx wrangler login
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

   **Density** (2026-10, not yet in the published archive — it needs a `peaks.sh` run): the
   ladder alone floods the great ranges. The six z9 tiles around Zermatt hold 4 100 summits for the
   two or three dozen names a phone can show, and the map still shapes and collides every one. So a
   summit's `rank` is also held back until it is one of the 6 best (ladder rank, then height) of
   its **cell** — a square a quarter of a tile wide (128 px), two zooms earlier, so that at the
   widest lead ("more" summits) no cell hands the map more than 6. "Normal" then gets 6 per
   256 px and "fewer" 6 per tile, which makes the density setting mean something in the Alps,
   where collisions used to make all three look alike. Sparse regions keep the ladder's ranks.
   Simulated on the live tiles: around Zermatt at z9 the style is handed 130 summits instead of
   3 757; around Québec City 61 instead of 108. `rank` keeps its meaning, so the app needs no
   change — but the labels a dense range shows at a given zoom do change: review them on a device
   before publishing.
   Tests: `python3 -m unittest infra/tiles/nas/test_peaks_geojson.py`.

3. **tippecanoe** 2.79.0 (felt), built once on the NAS from its checksum-pinned release tarball
   (felt publishes no image): `-Z5 -z12 -r1 --no-feature-limit --no-tile-size-limit`, so every
   summit is in every tile from its own minzoom and tippecanoe thins or sheds nothing itself — the
   thinning is ours, in the ranks above (the Alps at z7, the densest tile, was ~75 KB gzipped
   before it). z12 is the last rung of the ladder, so
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

## Geodetic points (Settings → Extensions)

**Status: live since 2026-10-05** (`geodetic.pmtiles` on R2; first build Québec + NGS, more
sources each week). The app's extension draws it; the card shows each agency's published values.

`nas/geodetic.sh` + `nas/geodetic/` (Python in the pinned image `geodetic/Dockerfile`; tests:
`python3 -m unittest discover -s infra/tiles/nas/geodetic -p 'test_*.py'`):

1. **fetch** — one job per source (= per agency server), at most `GEODETIC_JOBS` (6) at a time,
   each polite to its own server, resumable, logged to `work/geodetic/logs/fetch-SRC.log`.
   Monthly cadence (Québec weekly); a failed fetch keeps the previous raw copy.
2. **normalize** — per-source build records; gate = catalogue minimum and −30 % vs last good
   run, else last run's records stay. Agency coordinates and heights are kept as published text.
3. **assemble** — per z5 tile: ID-first dedupe (destroyed / not-found marks dropped and never
   revived by a twin), the thinning ladder (one mark per 18 px cell z5–13, all from z14), tile
   features: `geodetic` (official) and `geodetic_osm` (ODbL, own credit).
4. **tile** z5–13 (`-r1`, no limits) → verify → gate → `upload.py`.

```sh
~/inukshuk-tiles/infra/nas/geodetic.sh              # fetch then build
~/inukshuk-tiles/infra/nas/geodetic.sh fetch        # fetchers only (background-safe)
~/inukshuk-tiles/infra/nas/geodetic.sh build        # publish what is on disk
~/inukshuk-tiles/infra/nas/geodetic/harvest_qc.sh status   # Québec datasheet harvest
```

`scheduler.sh` starts `fetch` and `build` side by side every Monday (never on the 1st), so each
week's build ships newly harvested Québec datasheets and newly fetched sources. The Québec
harvester (`harvest_qc.sh`, container `inukshuk-geodetic-harvest`) fetches one MRNF datasheet
every 2.5 s, keeps only the extracted text, and re-checks daily for new or changed marks.

The app's tile URL carries `?v=N` (`@data/basemapTiles`): bump it only when the tile SCHEMA
changes — tiles are edge- and device-cached for a day.

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
`contourMath.ts` and `contourGrid.ts`, tested by the app's jest) from the Terrarium DEM tiles on
AWS Open Data:

1. **Edge cache** (per Cloudflare location, 30 days), then **R2**: every generated tile is
   written to `contours/{CONTOUR_VERSION}/{z}/{x}/{y}.mvt` (gzipped) after the response, so a
   tile costs its CPU once ever. `X-Contour-Source: r2 | generated | partial` says which. Bump
   `CONTOUR_VERSION` when the geometry changes; old prefixes can be deleted at leisure.
2. **Generation** aims at the free plan's 10 ms of CPU (next section): DEM PNGs inflated by the
   native `DecompressionStream`; decoded DEM tiles kept per isolate; the grid and the isolines
   traced in typed arrays (`contourGrid.ts` — maplibre-contour's algorithm and, byte for byte,
   its output, without its closure per pixel and its quadratic line joins); steep regions get a
   coarser interval, set by the steepest tile of each 4 × 4-tile region
   (`MAX_CROSSINGS_PER_CELL`, `DENSITY_REGION_ZOOMS` in `contourMath.ts` — the interval can only
   change on that grid, which shows as a density step where it does); lines simplified
   (Douglas–Peucker, ½ px, ¼ px on the deepest tiles); closed rings under 1.5 DEM pixels, and
   anything at or below sea level, dropped.
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

### The free plan's CPU limit (error 1102)

The Worker runs on the **free plan: 10 ms of CPU per request**. A request that goes over is
killed and Cloudflare answers **HTTP 503, body `error code: 1102`** — nothing the Worker can
catch, cache or log. On the map that tile is a **hole in the contour lines**: MapLibre Native
does not retry it (since maplibre-native #2051 its tile loader frees the request, and the
retry timer with it, on the first answer), so the hole stays until the user pans away and back.

Seen on the owner's phone on 2.1.0 (2026-10-02) in northern Québec: probes of uncached z12–13
tiles around 51° N, 67° W at concurrency 10–12 failed 30/60, 13/30 and 7/36; a retry of the
same tile succeeded 30–50 % of the time; the Himalaya, Andes and Pyrenees probes did not fail.
The rate is not stable: re-run the same day for this change, the same probe passed 84/84
(z13, concurrency 8–12, all `generated`). Read any measured rate as that moment's.

**Where the time went** (uncached z13 tile, Node on an M-series Mac, JIT warm; a fresh isolate
is 2–3× slower until V8 has optimised the loops):

| ms per tile                              | before     | after                              |
| ---------------------------------------- | ---------- | ---------------------------------- |
| decode 5 DEM PNGs (inflate + unfilter)   | 4.5–8.5    | 2 a request: 1.5–2.8 (all 5: 4–7)  |
| height grid (neighbours, corner average) | 0.45–1.4   | 0.13                               |
| isolines                                 | 0.8–3.9    | 0.4–1.7                            |
| clean-up, MVT, gzip                      | 0.2–4.1    | 0.2–2.5                            |
| **uncached tile, first request**         | **5–12.5** | **2–5.5** (partial; full: 4.5–7.5) |
| tile whose DEM is already in the isolate | 1.4–4.9    | 0.7–2.8                            |

- **Decoding DEM tiles is 65–80 % of an uncached tile**, and a tile needs five: its own, three
  neighbours for a two-pixel border, its region's for the interval. Northern Québec is not
  harder to contour (4.6–11 k raw vertices a tile, against 10–20 k in the Alps): its **DEM PNGs
  are heavy** — 115–125 KB each against 17 KB around Québec City and 64 KB under Everest (the
  Alps and the Pyrenees are as heavy: 133–136 KB) — and decoding one takes 1.5–2× as long.
- **Decode budget** (`CONTOUR_DECODE_BUDGET` in `wrangler.toml`, default 2): a request decodes
  at most that many DEM tiles itself — its own first, then the region's, then the neighbours —
  and takes the others from the isolate's cache, or from the request that is decoding them.
  When some are still missing it answers a **partial tile**: the same lines, drawn without the
  missing neighbours' border (up to half a DEM pixel off along those edges —
  [`contour-cpu-before-after.jpg`](contour-cpu-before-after.jpg)). A partial tile is `X-Contour-Source: partial`,
  cached 15 s, **never written to R2**; a later request for it finds the DEM decoded and makes
  the full tile. A cold 3 × 4-tile
  viewport: 9 full + 3 partial on the first round, all full on the second, 16 DEM decodes in
  all and never more than 2 in a request.
- The full tiles are **byte-identical** to before (640 tiles compared, z8–14, ten regions and
  the world's edges), so `CONTOUR_VERSION` stays `v3`: nothing is regenerated, no R2 cost.
- The app (`src/core/map/contourRecovery.ts`, from the version after 2.1.0) looks for the holes
  itself when the camera settles and gets MapLibre to load them again: at most 3 fetches a
  tile (2 s and 6 s apart) and 2 reloads.

**The fix that needs no code: Workers Paid** ($5/month: 30 s of CPU per request, 10 M requests
a month). Then set `CONTOUR_DECODE_BUDGET = "9"` and deploy: every tile is full on its first
request and partial tiles are never made.

Why not a marker ("this tile was tried and did not finish → make a lighter one next time")? A
marker has to be written (R2 or the cache: I/O on every uncached tile) before the work, and
only helps the second request; the budget is the same idea decided up front, from what the
isolate already holds, at no cost. What it cannot bound is the generation itself on a fresh
isolate (cold JIT), which is what the Paid plan is for.

Not done, in order of what they would buy: WebAssembly for the PNG unfilter (no JIT warm-up:
the biggest cut on a fresh isolate, at the price of a binary in the repo); `node:zlib`'s
synchronous inflate under `nodejs_compat` (≈ 0.3 ms a DEM tile in Node, untested in workerd);
keeping decoded DEM tiles in the Cache API across isolates; the DEM one zoom lower (2.25
decodes a tile instead of 5, but half the detail — CDEM has real 20 m data at z12).

**Deploy** (owner; from a checkout with `infra/tiles/worker/node_modules`):

```sh
cd infra/tiles/worker
npm ci                 # the committed lockfile; `npm install` would re-resolve ^ranges
npx tsc --noEmit
npx wrangler deploy
```

**Verify** — uncached tiles, so move the square each run (`offset`), and stay gentle (the
free plan's 100 000 requests a day are shared with users):

```sh
node infra/tiles/probe-contours.mjs 51.05 -67.1 13 36 12 120   # 36 tiles, concurrency 12
node infra/tiles/probe-contours.mjs 51.05 -67.1 13 36 12 120   # the same square again
```

Expect, on the free plan with the budget at 2: first run mostly `200 generated` with some
`200 partial` (about a quarter) and **few or no** `503 error code: 1102`; the second run, 15 s
or more later, `200 r2`/`cached` for what was full and `200 generated` for what was partial,
no `partial` left. If 1102s are still common, lower `CONTOUR_DECODE_BUDGET` to `"1"` (more
partial tiles, one more round) — or buy the Paid plan. On the Paid plan with the budget at 9:
all `200 generated`, then all `200 r2`/`cached`, never `partial`, never 1102.

**Pre-generating dense mountain regions** (optional, NAS): run the same `contourTile` under
Node over a bbox (Alps, Rockies…) for z8–13, write the gzipped tiles into a PMTiles archive
(`pmtiles` CLI `convert` from an MBTiles, or write the R2 objects directly with the upload
endpoint), and have the Worker check it before generating. The R2 write-through makes this
unnecessary unless the free plan's CPU limit still bites.

## Precise elevation (DEM, #725)

`/dem/{z}/{x}/{y}.png` (`worker/src/dem.ts`) serves 256-px Terrarium PNG, z0–16, one URL for
the whole world:

- **Inside LiDAR coverage** — Québec (NRCan HRDEM 2 m) and the Alps (swissALTI3D, IGN LiDAR HD):
  tiles from our own archives `dem-quebec.pmtiles` / `dem-alps.pmtiles`, listed in
  `dem.index.json`. They are [Mapterhorn](https://mapterhorn.com)'s 512-px lossless WebP tiles
  cut into their four 256-px quadrants and re-encoded as PNG, **bit for bit** (every PNG is
  decoded again and compared before it is stored; `verify` re-checks a sample after
  `pmtiles convert`).
- **Everywhere else** — AWS Terrarium (the app's former source), passed through byte for byte;
  z16 (AWS stops at z15) is the z15 parent's quadrant, bilinearly upsampled. `X-Dem-Source`
  says which: `lidar:<piece>`, `aws` or `aws-upsampled`.
- **Contours** (`/contours`) read the same tiles through the same code (no HTTP round trip), so
  they match the hillshade; `CONTOUR_VERSION` is `v4` since the switch. **Bump it again whenever
  a region is added**, or the stored contours there keep the AWS heights.
- PNG is already deflated: no `Content-Encoding`, so the cache-HIT path re-sends the stored bytes
  (no double-gzip). Cache: `CACHE_CONTROL` (1 day).

**Only LiDAR-grade terrain is served** (`nas/dem/coverage.py`). Mapterhorn fills every gap with
Copernicus GLO-30, a _surface_ model (tree tops, roofs) that reads 10–25 m high in forests. The
NAS keeps a tile only where every pixel comes from an allow-listed terrain model in
`nas/dem/regions.json`, using Mapterhorn's own source footprints (`coverage-index.pmtiles`,
`coverage.pmtiles`), 200 m inside them (Mapterhorn blends 150 m across source seams); a finer
source that is not allow-listed is carved out, because Mapterhorn would draw it on top. Sources
still waiting for their cross-check (Austria, Bavaria, Baden-Württemberg, Slovenia, South Tyrol,
Aosta, Zürich canton, RGE ALTI) are listed under `pendingValidation` and left to AWS. Heights stay
in each country's official system (CGVD2013, LN02, NGF-IGN69); the cross-checks are in
[DEM-VALIDATION.md](DEM-VALIDATION.md) and gate CI (`worker/src/demValidation.test.ts`).

### The pipeline (`nas/dem.sh`)

Per region, each step resumable (rerun the same command after any failure): mask → `pmtiles
extract` of `planet.pmtiles` z0–12 and the `6-x-y.pmtiles` z13–15 over the mask's macrotiles only →
transcode into MBTiles (multiprocessing, 4 PNG per WebP) → `pmtiles convert` → verify (tile count,
PNG type, uncompressed, sampled bytes, decoded-pixel sha256, mask) → upload (`upload.py`,
multipart, resumable). `dem.index.json` goes up **last**, then one probe tile per piece is fetched
back through the live Worker and compared byte for byte. It runs its own unit tests first
(`nas/dem/test_dem.py`, in the `inukshuk-dem-py:1` image from `nas/dem/Dockerfile`: Python 3.12 +
Pillow 12.3.0, nothing else). It refuses to upload more than `DEM_MAX_TOTAL_GB` (320) and stops if
Mapterhorn publishes a new release mid-run. A run with nothing new (same Mapterhorn version as
the last publish) exits at once, so it is safe monthly.

Expected (Mapterhorn 0.0.13, upper bounds from the whole-bbox `pmtiles extract --dry-run`
of the plan, PNG ≈ 1.4–1.6× WebP; the mask only removes from them): Québec ≤ ~190 GB, Alps
≤ ~80 GB (less while Austria/Germany/Italy/Slovenia are pending). `dem.sh` logs each piece's real
size and refuses more than `DEM_MAX_TOTAL_GB`. One night on the NAS. Dry run on a Mac (two 2 × 1 km boxes, ~60 MB):

```sh
DEM_DRY_RUN=1 DEM_LOCAL=1 WORK=/tmp/dem-dry infra/tiles/nas/dem.sh   # needs pmtiles + python3 with Pillow
```

### Owner runbook (first run)

Nothing here needs a new account or DNS change. Steps 1–3 are yours (sign-ins and billing); a
developer or agent can do 4–8 with you.

1. **Workers Paid** ($5/month): Cloudflare dashboard → Workers & Pages → Plans → _Workers Paid_.
   The DEM adds Worker requests on top of the base map and contours; the free plan's 100k
   requests/day will not hold. Then set `CONTOUR_DECODE_BUDGET = "9"` in `worker/wrangler.toml`.
2. **R2**: nothing to create (bucket `inukshuk-tiles` exists, billing active). The approved budget
   is ~270 GB on top of the ~140 GB base map (~$4/month).
3. **Wrangler login** on the Mac, only if `npx wrangler whoami` (in `infra/tiles/worker`) says
   you are logged out: `npx wrangler login`, approve in the browser.
4. **Deploy the Worker — from a checkout that contains every live route.** Deploying a branch
   drops any route only another unmerged branch has. Merge this work into `main` first (or
   combine the branches), check `main` has every route that is live today (basemap, peaks, parks,
   geodetic, tides, crags, contours, fonts, trails, climbing, proj-grids, search, route,
   error-report…), then from `infra/tiles/worker`: `npm ci && npx tsc --noEmit && npx wrangler
deploy`. Until `dem.index.json` exists `/dem` simply serves AWS everywhere, so the deploy is safe
   before the data.
5. **Keep the NAS reachable overnight** (WireGuard + SSH) and copy the scripts:
   `tar -C infra/tiles -cf - nas | ssh nas 'tar -C ~/inukshuk-tiles/infra -xf -'` (scp is broken
   there). About 600 GB free in `~/inukshuk-tiles/work` (WebP extracts + MBTiles + PMTiles; the next
   version's run deletes the previous one's working files).
6. **Run it** on the NAS (detached, it takes the night):
   `ssh nas 'nohup ~/inukshuk-tiles/infra/nas/dem.sh > ~/inukshuk-tiles/work/dem.log 2>&1 &'`.
   If it stops, run the same command again: it resumes. Read the log in the morning: every
   region `ready`, `published Mapterhorn 0.0.13`, and `probe … OK` per piece.
7. **Check**: `curl -sI "$HOST/dem/16/19860/23030.png?v=7"` → `200`, `X-Dem-Source:
lidar:dem-quebec`, no `Content-Encoding`; `…/dem/16/19500/22700.png` → `aws-upsampled`.
8. **Then** merge the app PR (URL switch). Never before step 6 succeeds: the phone caches what it
   fetched under the new key.

**Monthly**: add `dem.sh` to `scheduler.sh` after the base map (it exits at once when Mapterhorn
has not released). **Adding a region or validating a pending source**: add a site to
`nas/dem/validation-sites.json`, run `nas/dem/validate.py --report … --fixtures
worker/src/__fixtures__/dem`, record the numbers in DEM-VALIDATION.md, move the source into
`sources`, regenerate the credits (`dem.py credits --write src/core/map/demCredits.ts`, then
prettier), bump `CONTOUR_VERSION`, ship the app credits with it.

## Check it

```sh
curl -sI https://tiles.mvxtechnologies.com/basemap/14/4950/5775.mvt   # 200, gzip
curl -s  https://tiles.mvxtechnologies.com/basemap.json | head -c 200
curl -sI "https://tiles.mvxtechnologies.com/fonts/Atkinson%20Hyperlegible%20Next%20Regular/0-255.pbf"
curl -sI https://tiles.mvxtechnologies.com/peaks/7/66/45.mvt        # 200, gzip (the Alps)
curl -s  https://tiles.mvxtechnologies.com/peaks.json | head -c 300
curl -sI "https://tiles.mvxtechnologies.com/contours/13/4270/2915.mvt?v=2"  # 200, gzip; X-Contour-Source
```

Then in the app: `VECTOR_BASEMAP_ENABLED = true` (`src/core/features/flags.ts`) and, once the
glyphs are up, `VECTOR_GLYPHS_URL` (see `src/data/basemapTiles.ts`).

## Local development

No Cloudflare needed: cut a small extract and serve it with the Worker itself.

```sh
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles quebec-dev.pmtiles \
  --bbox=-71.65,46.65,-70.75,47.40
cd infra/tiles/worker && npm ci
npx wrangler r2 object put inukshuk-tiles/quebec-dev.pmtiles --file=../../../quebec-dev.pmtiles --local
npx wrangler dev --port 8787 --var ARCHIVES:quebec-dev
# build the app with VECTOR_TILES_URL='http://127.0.0.1:8787/quebec-dev/{z}/{x}/{y}.mvt'
```

Only the archives named in `ARCHIVES` (default: `basemap`, `peaks`, `parks`,
`geodetic`, `tides`, `crags`) are served; any other `/{archive}/…` is a 404
without touching R2, hence the `--var` above for a local test archive.

## Cost (Cloudflare list prices, Sept 2026 — check before relying on them)

- Storage: $0.015/GB-month after 10 GB free → ~$1/month for 70 GB.
- Worker: free up to 100k requests/day; the $5/month plan includes 10M requests/month, then
  $0.30 per million. Edge-cached tiles still count as Worker requests.
- R2 reads (cache misses only): 10M/month free, then $0.36 per million. No egress fees.
- Roughly **$6–8/month at 1,000 monthly users, ~$25 at 10,000, ~$50 at 25,000.**

## Abuse and cost limits

The Worker is public and unauthenticated by design (a phone app can hold no
secret), so these keep one abusive client from running up the bill or
starving everyone else (`worker/src/guards.ts`, security audit 2026-10):

| Route                               | Guard                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every static GET                    | edge-cache key = path + the app's `?v=N` only, so a random query string can't force an R2 read; unknown archives and malformed font stacks are refused before R2 |
| `/contours/…` (generation, R2 miss) | `CONTOUR_LIMITER`: 300 new tiles per client per minute, then `429` + `Retry-After: 30` (MapLibre and offline packs retry)                                        |
| `/search`, `/route` (cache misses)  | `SEARCH_LIMITER` 60/min, `ROUTE_LIMITER` 30/min per client; route upstreams paced at 1/s per isolate                                                             |
| `/strava/token`, `/strava/refresh`  | `STRAVA_LIMITER` 10/min plus 30/hour per isolate; only URL-safe tokens ≤ 256 chars go upstream                                                                   |
| `/donors`, `/donor-verify/*`        | `DONOR_LIMITER` 3/min plus per-isolate hourly caps; at most `VERIFY_DAILY_SEND_CAP` (90) code emails per UTC day in total                                        |
| every POST                          | the body is read with a hard byte cap (1–8 KB), whatever `Content-Length` says                                                                                   |
| `/_upload/…`                        | bearer `UPLOAD_TOKEN` (404 when unset), constant-time compare                                                                                                    |

Rate-limit bindings count per client IP per Cloudflare location and are free on
every plan. They do not stop a distributed flood: that is what the dashboard
settings in the security report are for (custom domain + WAF rate-limit rule,
usage notifications). Edge-cached tiles still count as Worker requests, so on
the free plan a flood past 100k requests/day makes the Worker fail for
everyone until 00:00 UTC; on the paid plan it costs $0.30 per extra million.

## Licences

Map data (base map and summits) © OpenStreetMap contributors (ODbL), processed by Protomaps (the app credits
"© OpenStreetMap · Protomaps"). Atkinson Hyperlegible Next: SIL OFL 1.1.
