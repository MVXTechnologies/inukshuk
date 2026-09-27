# Vector base map: decision note

Status: **proposal, flag OFF** (`VECTOR_BASEMAP_ENABLED` in `src/core/features/flags.ts`).
Researched 2026-09-27. Owner decisions are marked **DECIDE**.

## Why vector

The `map` basemap is raster OSM tiles today (`src/features/map/mapStyle.ts`). A raster can only be
tinted as a whole, so it can never look like the Stone & Paper boards
(`docs/design/ui-revamp/boards/Main.html` with `blobs/1d745d6f….svg`, and `After-Map-Dark.html`
with `blobs/f9caad86….svg`). A vector source can, because every feature class gets its own colour
from the tokens. The style is `src/core/map/stoneStyle.ts`, and `src/features/map/stoneScheme.ts`
maps `SchemeTokens` onto it.

## Tile sources

| Source                                   | Schema                                                           | Detail for rural Québec trails                                                                                                                    | Mobile / commercial terms                                                                            | **Bulk offline download**                                                                                                                              | Cost / limits                                                                                           | Glyphs / sprites                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **OpenFreeMap** (hosted)                 | OpenMapTiles 3.16, z0–14 [1]                                     | `path`/`track` classes. At z12 only route-rank 1 is kept; at z13, named, rank ≤ 2 or `sac_scale` paths; from z14, everything [2][3]. No contours. | Commercial use "Yes". Attribution required [4]                                                       | **Not permitted without asking.** The ToS forbids users who "attempt to collect data from the service in automated ways without permission" [5].       | Free; "no limits on the number of map views or requests" [4]                                            | Noto Sans Regular/Bold/Italic at `tiles.openfreemap.org/fonts/…`, plus a sprite [6] |
| **OpenFreeMap planet, self-hosted**      | Same as above                                                    | Same as above                                                                                                                                     | ODbL, with OSM + OpenMapTiles attribution                                                            | **Yes.** It is our own server.                                                                                                                         | Weekly planet MBTiles download [7]. Cost is storage and egress on our host.                             | We host them ourselves                                                              |
| **Protomaps** (self-hosted PMTiles)      | Protomaps v4. **Not OpenMapTiles**; it derives from Tilezen [8]. | `roads.kind_detail` includes path, track, bridleway and steps [8]. z0–15.                                                                         | ODbL produced work. The docs discourage hotlinking and say to copy the file to your own storage [9]. | **Yes, from our own host.** `pmtiles extract --bbox/--region` cuts a Québec file [10].                                                                 | Planet is about 120 GB [9]. Any static host that supports HTTP range requests works (NAS, R2, S3) [10]. | Noto Sans (OFL) and sprites (MIT) in `protomaps/basemaps-assets` [11]               |
| Protomaps API (hosted)                   | Protomaps v4                                                     | Same as above                                                                                                                                     | "Free for non-commercial use". Needs a key. Commercial use means becoming a GitHub Sponsor [12].     | Not stated                                                                                                                                             | Not stated                                                                                              | Same as above                                                                       |
| **MapTiler Cloud**                       | OpenMapTiles (+ its own)                                         | Also offers **Contours v2** (`contour` layer: `height`, `nth_line`; detailed lines from z14) [13]                                                 | The free plan is "limited to non-commercial use and research & development" [14]                     | **No.** "It is prohibited to batch or excessive bulk download of map tiles." Only a "temporary personal cache… for a single end-user" is allowed [14]. | Free plan: 100k requests or 5k sessions a month, then the service pauses [15]                           | Hosted                                                                              |
| Stadia Maps                              | OpenMapTiles                                                     | Same as OpenMapTiles                                                                                                                              | The free tier is non-commercial or evaluation only [16]                                              | **Limited:** "caching small amounts of data for offline use in a mobile application, not to exceed 100MB… per device" [16]                             | Paid for commercial use                                                                                 | Hosted                                                                              |
| VersaTiles                               | Shortbread (a third schema)                                      | Coarser than OpenMapTiles for paths                                                                                                               | Free public server [17]                                                                              | No bulk policy found. Self-host the downloadable tilesets instead [18].                                                                                | Free                                                                                                    | Hosted                                                                              |
| _(today)_ tile.openstreetmap.org, raster | —                                                                | —                                                                                                                                                 | —                                                                                                    | **Prohibited.** "Offline use is not permitted", and "'Download city/country for offline use'… [is] therefore prohibited" [19]                          | —                                                                                                       | —                                                                                   |

**The current raster offline packs break the OSM tile policy** [19]. The policy says violators are
"blocked without notice". This is separate from the vector base map, but any vector source we
choose should also replace the pack source.

MapLibre Native supports `pmtiles://` sources from iOS 6.10.0 and Android 11.8.0 [20][21]. We ship
iOS 6.26.0 and Android 13.2.0 (`@maplibre/maplibre-react-native` 11.3.8). The ambient cache for
PMTiles only arrives in iOS 6.27.0 / Android 13.3.0 [20][21]. **Unverified:** whether offline packs
can hold a PMTiles source. The safe path is XYZ URLs from our own server; see Recommendation.

## Glyphs (Atkinson Hyperlegible Next)

- **Licence:** SIL OFL 1.1. The TTFs are at `googlefonts/atkinson-hyperlegible-next` and on Google
  Fonts [22].
- **Generating glyphs:** `maplibre/font-maker` turns TTF/OTF into SDF PBF ranges, from the web app
  or the CLI [23]. Generate Regular, Bold and Italic.
- **Where to host:** static files, e.g. `…/fonts/Atkinson Hyperlegible Next Regular/0-255.pbf`, on
  the same host as the tiles.
- **Why the stacks stay single-font:** MapLibre Native requests a whole stack as one
  comma-joined `{fontstack}` URL (`fontStackToString`) [24]. OpenFreeMap returns 404 for a joined
  stack [6], and so would any static host. `stoneStyle` therefore never mixes Atkinson and Noto in
  one stack: `STONE_FONTS_ATKINSON` and `STONE_FONTS_NOTO` are swapped as a whole, together with the
  `glyphs` URL.
- **No local-font fallback:** leaving out `glyphs` to use local fonts works in GL JS only, not in
  Native [25]. Until Atkinson is hosted, the integration uses OpenFreeMap's Noto glyphs.

## Bilingual labels (FR/EN)

The OpenMapTiles label layers carry `name`, `name:latin`, `name_en` and `name:xx` [2]. In Québec,
`name` is almost always the French name, and `name:en` is rarely tagged. `buildStoneLayers` takes
`language: 'fr' | 'en' | 'local'`, which becomes a `coalesce` chain that falls back to `name`.

- `local` is the default.
- Wiring `language` to the app locale is a follow-up.
- Stacked "FR / EN" double labels are left out on purpose. They were the reason Esri's labels were
  rejected earlier (see the comment above `OFM_GLYPHS_URL` in `mapStyle.ts`).

## Contours

- **MapLibre Native can't draw contours from a DEM.** `maplibre-contour` is a plugin for MapLibre
  **GL JS** that works from `raster-dem` sources [26]. OpenMapTiles and Protomaps carry no
  contours either.

The options, cheapest first:

1. **Already in the app:** `src/core/geo/contours.ts` (JS marching squares over the Terrarium DEM
   we already fetch and cache), drawn by `useTerrainOverlays2D` and `mapLayers.tsx`. It works
   offline wherever the DEM is cached. It is limited to the viewport and recomputes as you pan.
   - Next step: restyle its line colours to `scheme.contour` so it matches the board.
2. **Pre-generated contour tiles:**
   - Source DEM: NRCan CDEM (about 23 m), or HRDEM (1–2 m, partial coverage). Both are under the
     Open Government Licence – Canada [27][28]. CanVec also ships contours [29].
   - Pipeline: `gdal_contour` → `tippecanoe` → `.pmtiles` [30]. Host it next to the base tiles.
   - `buildStoneLayers({ contours: { source, sourceLayer, field, intervalM, majorEvery } })`
     already draws minor and major lines from such a source.
3. **MapTiler Contours v2** [13]: bulk offline download is not allowed [14]. MapTiler's
   self-hostable contour dataset is sold separately [31].

## Recommendation

1. **Preview now on hosted OpenFreeMap**, online only. It uses the OpenMapTiles schema, free
   commercial use, no key, and it is already used for weather labels. That is what the flag does
   today.
2. **Ship on our own host.** Download the OpenFreeMap weekly planet MBTiles [7], cut Canada or
   Québec, and serve it as XYZ (and/or PMTiles) from a CDN bucket, with the NAS as the build box
   or origin. Keeping the OpenMapTiles schema means `stoneStyle` needs no change. Offline packs
   then fetch **our** tiles, which clears both the OSM policy breach and OpenFreeMap's "automated
   collection" clause.
   - A home NAS as the only public origin for every app user is an uptime and bandwidth risk,
     so put a CDN in front of it.
3. **Host Atkinson glyphs and contour PMTiles** (CDEM, OGL-Canada) on the same host. Then flip
   `fonts` to `STONE_FONTS_ATKINSON` and add the contour source.
4. **Protomaps** is the alternative if we'd rather have daily builds and z15. It costs a second
   layer set, because its schema differs.
5. **Not viable for offline packs:** MapTiler and Stadia (both bulk-restricted), and the hosted
   Protomaps API (non-commercial).

**DECIDE:**

- Self-host yes or no, and where: NAS, R2 or another CDN.
- Whether to write to OpenFreeMap for bulk permission, as an interim step.
- When to move the raster offline packs off `tile.openstreetmap.org`.

## Known gaps in the flagged build

- **Glyphs:** Noto fallback, not Atkinson.
- **Sprites:** none, so there are no icons. POIs and peaks are text-only, which is deliberate for
  now.
- **Contours:** none from tiles. The existing DEM contour overlay still works.
- **Hillshade:** blended over the vector body; its tuning was done for raster.
- **Colours:** token substitutions for board colours with no token yet:
  - road casing is `outlineVariant`, lighter than the board's `#B9AE98`;
  - light water labels are the info blue, 3.6:1 on paper;
  - stone-night road ribbons are `outlineVariant`, 1.8:1 on land.
- **Online only:** the vector base is dropped in offline-only mode (raster packs are used). The
  attribution chip still reads "© OpenStreetMap"; the OpenFreeMap credit sits in the source's
  attribution.
- **Not seen on a device yet.** The lead's simulator screenshots are the ship gate.

## Sources

1. https://tiles.openfreemap.org/planet (TileJSON: `version 3.16.0`, `maxzoom 14`)
2. https://openmaptiles.org/schema/
3. https://raw.githubusercontent.com/openmaptiles/openmaptiles/master/layers/transportation/transportation.sql
4. https://openfreemap.org/
5. https://openfreemap.org/tos/
6. https://github.com/hyperknot/openfreemap-styles (glyph URLs probed 2026-09-27: single stacks 200, joined stack 404)
7. https://github.com/hyperknot/openfreemap
8. https://docs.protomaps.com/basemaps/layers
9. https://docs.protomaps.com/basemaps/downloads
10. https://docs.protomaps.com/pmtiles/cli
11. https://github.com/protomaps/basemaps-assets
12. https://protomaps.com/api
13. https://docs.maptiler.com/schema/contours/
14. https://www.maptiler.com/terms/cloud/
15. https://www.maptiler.com/cloud/pricing/
16. https://stadiamaps.com/terms-of-service/
17. https://docs.versatiles.org/guides/use_tiles_versatiles_org
18. https://docs.versatiles.org/
19. https://operations.osmfoundation.org/policies/tiles/
20. https://github.com/maplibre/maplibre-native/blob/main/platform/ios/CHANGELOG.md
21. https://github.com/maplibre/maplibre-native/blob/main/platform/android/CHANGELOG.md
22. https://github.com/googlefonts/atkinson-hyperlegible-next
23. https://github.com/maplibre/font-maker
24. https://maplibre.org/maplibre-style-spec/glyphs/ ; maplibre-native `src/mln/util/font_stack.cpp`
25. https://maplibre.org/maplibre-style-spec/glyphs/ (local-font support table)
26. https://github.com/onthegomap/maplibre-contour
27. https://developers.google.com/earth-engine/datasets/catalog/NRCan_CDEM
28. https://portal.opentopography.org/datasetMetadata?otCollectionID=OT.062025.3979.1
29. https://open.canada.ca/data/en/dataset/64aad38d-f692-4ab6-bf2c-f938586c1249
30. https://docs.protomaps.com/pmtiles/create
31. https://data.maptiler.com/downloads/dataset/contours/
