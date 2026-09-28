# Vector base-map hosting (Cloudflare R2 + Worker)

The Stone & Paper base map (`src/core/map/stoneStyle.ts`, flag `VECTOR_BASEMAP_ENABLED`) reads
vector tiles in the **Protomaps v4 schema** from our own host. Why self-host, and why Protomaps:
`docs/design/vector-basemap.md`.

```
Protomaps daily planet ──(nas/refresh.sh: extract our regions)──▶ basemap.pmtiles
                                                                        │ upload
phones ──▶ inukshuk-tiles.…workers.dev (worker/, edge-cached) ──▶ R2 bucket inukshuk-tiles
```

| Path                             | What                                               |
| -------------------------------- | -------------------------------------------------- |
| `/basemap/{z}/{x}/{y}.mvt`       | vector tile (gzip), z0–15; 204 where there is none |
| `/basemap.json`                  | TileJSON                                           |
| `/fonts/{fontstack}/{range}.pbf` | MapLibre glyphs (Atkinson Hyperlegible Next)       |

Coverage (`nas/region.geojson`): Canada, the United States (with Alaska and Hawaii), Greenland
and Europe, about 70 GB. The rest of the world later is one more polygon (~120 GB total).

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
7. **Monthly refresh**: a NAS cron entry running `refresh.sh` (first of the month, at night).

## Check it

```sh
curl -sI https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/basemap/14/4950/5775.mvt   # 200, gzip
curl -s  https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/basemap.json | head -c 200
curl -sI "https://inukshuk-tiles.marcandre-vigneault-96.workers.dev/fonts/Atkinson%20Hyperlegible%20Next%20Regular/0-255.pbf"
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

Map data © OpenStreetMap contributors (ODbL), processed by Protomaps (the app credits
"© OpenStreetMap · Protomaps"). Atkinson Hyperlegible Next: SIL OFL 1.1.
