# Map & trail store — design package

Owner request (docs/BACKLOG.md § Larger initiatives): a bottom "Search" tab, Avenza-style —
a centralized catalog of FREE maps/charts by category, searchable, downloading straight into
the Library with a chosen destination folder, rendered like any imported map. Primary
audience: Québec/Canada outdoors users.

## 0. What the codebase already gives us

The whole feature reduces to: **catalog entry → download file into `Paths.document/maps/<id>.pdf`
→ `mapDocumentFromStoredPdf(id, fileUri, name)` → `useLibraryStore.getState().addMap(doc)` →
`setItemFolder('map', doc.id, folderId)`**. Everything downstream (overlay rasterization via
`src/features/map/usePdfOverlay.ts` + `PdfRasterizer.tsx`, MapLibre `ImageSource` rendering in
`MapScreen.tsx`, delete/export) works unchanged. `makeMap.ts` (map-maker) already does exactly
this dance and is the template.

Key facts that shape the design:

- **Model** (`src/core/models/document.ts`): `MapDocument { id, name, fileUri, importedAt,
pageCount, georeferences, activePages, georeferenceWarning?, folderId? }`. No source/
  provenance, no size, no thumbnail. Adding fields ⇒ bump `LIBRARY_SCHEMA_VERSION` (currently 4)
  - migrator in `src/core/library/migrations.ts`. Persistence is file-based JSON
    (`library.json` in `Paths.document`), zustand store `src/state/libraryStore.ts`.
- **Parser** (`src/core/geo/geopdf/`): pure-TS GeoPDF parser (Adobe `/VP+/Measure/GEO` and
  TerraGo `/LGIDict`), never throws; un-georeferenced PDFs still import with a warning.
  `parseWorldFile` / `parseAuxXml` exist, tested, currently unwired — usable for sidecars.
- **Renderer needs**: one `file://` PNG + 4 WGS84 corners (`ImageSource`, MapScreen.tsx:832).
  No tiling, no MBTiles. **No GeoTIFF support anywhere**; the realistic GeoTIFF path is
  decode → `UPNG.encode` → `storage.writeOverlayPng` (precedent: `useTerrainOverlays2D.ts`).
- **Downloads**: `storage.downloadBytes/downloadToCacheUri` exist (single-flighted, offline-switch
  aware) but `File.downloadFileAsync` has **no progress callback**; `createDownloadResumable`
  unused. Tile-pack downloads (`offlineStore` + `src/data/offline.ts`) are MapLibre-native,
  not reusable here. Disk guard exists: `assessFreeSpaceForWrite` (`src/data/diskSpace.ts`).
- **No network-state detection** (deliberately no netinfo) — "cellular warning" must be
  size-based unless we add `expo-network` (SDK module, no third-party native dep).
- **No text search UI anywhere**; the pattern to mirror is `filterTracks` (pure predicate in
  `src/core/library/filterTracks.ts`) + dialog in features. **No list virtualization** —
  LibraryScreen is one ScrollView; the catalog list must introduce `FlatList` (RN built-in,
  fine for ~1–5k rows) rather than copy that pattern.
- **No remote-JSON fetch precedent**, but the GitHub Pages site is live at
  `inukshuk.mvxtechnologies.com` (repo `docs/` is the Pages root, `docs/CNAME`) — zero-infra
  manifest host. Fetch idiom to copy: `regionNaming.ts` (AbortController + timeout, never throws).
- Tabs: `app/(tabs)/_layout.tsx` (Map, Library, Dashboard, Settings; MaterialCommunityIcons;
  `minimal` UI style hides icons). New tab = thin `app/(tabs)/search.tsx` + one `Tabs.Screen`.
- App is English-only, react-native-paper MD3, strict TS, `src/core` purity gate.

## 1. Catalog sources (the heart)

All licence/URL claims below were verified by live fetch on 2026-08-08 (research agent).
Two structural facts up front: **the best Québec topo source is GeoTIFF-only** (affects Q4),
and **CanTopo GeoPDFs are served zipped** (download pipeline needs unzip — `fflate` is already
a dependency of the GeoPDF parser).

### Green — open licence, direct URLs, catalog unilaterally

| Source                                                                  | Products                                                                                                                              | Licence                                                 | Direct URLs                                                                                                                                                  | Size/cadence                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **NRCan CanTopo / CanMatrix / Toporama**                                | 1:50k GeoPDF (zipped) + GeoTIFF, NTS-sheet tiled, Canada-wide (CanTopo ~2,234 sheets, southern-QC `021/031` dirs confirmed populated) | OGL-Canada (link, rehost, derive all OK w/ attribution) | Predictable HTTPS dirs: `ftp.maps.canada.ca/pub/nrcan_rncan/raster/cantopo/50k_geopdf/{nts}/{letter}/cantopo_031l01_geopdf.zip`; KMZ/index files in `index/` | ~5 MB/zipped GeoPDF; legacy, updates "Not Planned" — ideal for a static manifest |
| **BDTQ 1:20 000 (MRNF)** — flagship QC topo                             | GeoTIFF (MTM + LCC), QC south of 52nd parallel                                                                                        | **CC-BY 4.0**                                           | **CSV sheet index**: `diffusion.mern.gouv.qc.ca/Diffusion/RGQ/Documentation/BDTQ/Index_BDTQ.csv` + flat GeoTIFF dirs — trivial to ingest                     | No longer updated                                                                |
| **USGS US Topo**                                                        | Geospatial PDF per 7.5' quad, ~3-yr refresh                                                                                           | Public domain                                           | TNM Access API → S3 `downloadURL` (verified live)                                                                                                            | ~40 MB/quad — model our schema on this API's response                            |
| **US NPS Carto portal**                                                 | 1,000+ maps incl. Geospatial PDFs "for mobile"                                                                                        | Public domain                                           | Per-map URLs; no machine index (scrape)                                                                                                                      | —                                                                                |
| **USFS FSTopo**                                                         | Geo-PDF + GeoTIFF 7.5' quads, annual                                                                                                  | Public domain                                           | Index moved behind an ArcGIS Experience app — moderate plumbing                                                                                              | —                                                                                |
| **Geology: GSC (GEOSCAN) + SIGÉOM QC**                                  | Georeferenced PDF/TIFF map sheets                                                                                                     | OGL-Canada / CC-BY 4.0                                  | GSC via open.canada.ca; SIGÉOM download is form-driven (per-URL work needed)                                                                                 | —                                                                                |
| **QC regional orthophotos** (Laurentides, Lanaudière, Montérégie, CMQ…) | GeoTIFF 2×2 km tiles                                                                                                                  | CC 4.0                                                  | Per-tile download maps on Données Québec                                                                                                                     | Large files; regional patchwork, not province-wide                               |

### Yellow — legal but constrained

- **Territoires fauniques structurés** (zecs, réserves fauniques, pourvoiries — the "hunting"
  category): **CC-BY-NC-ND 4.0**. Direct GPKG/SHP URLs on `diffusion.mffp.gouv.qc.ca`.
  ND forbids derivatives ⇒ we may link the unmodified files but cannot render them into map
  tiles; NC is fine while the app is free but collides with the paid-sync roadmap if the store
  ever gates behind it. Also: it's **vector**, not a ready map. No open hunting-zone _raster_
  exists (checked the MFFP diffusion tree).
- **Carte écoforestière** (forest): CC-BY 4.0 but vector (GPKG/FGDB) — usable only if we
  render it ourselves someday. Not a launch product.
- **OSM whitewater tags** (`whitewater:rapid_grade=0–6`): ODbL, legal, redistributable —
  but Québec coverage is sparse. The only open river-runs option today.
- **Parks Canada**: boundaries/data OGL; visitor maps not a clean open series (follow-up pass).
- **NOAA (US nautical)**: raster charts (RNC) sunset completed Jan 2025, tile services shut
  down. What remains free/PD: ENC vector charts (stable bulk URLs) and self-generated NOAA
  Custom Chart PDFs (no stable per-product URLs). A US-nautical category would mean
  pre-generating NCC PDFs ourselves — legal (PD data) but a real pipeline project.

### Red — no legal free source; do NOT invent one

- **SÉPAQ park maps**: publicly downloadable PDFs but copyrighted, no open licence, reuse
  requires partnership. Avenza has them via its Publisher Agreement (vendor keeps copyright,
  grants Avenza distribution). **QC parks at launch = no; start a SÉPAQ outreach track.**
- **Ontario Parks**: © Queen's Printer, republication forbidden.
- **CHS charts (Canada nautical)**: Crown copyright, licensing via paid VAR program (currently
  closed to new applicants), end users get no redistribution rights. Only open crumbs: NONNA
  bathymetry + tides. **Canadian nautical is out** — consistent with deferring to the separate
  "Nautical + meteo" initiative.
- **River runs with rapid classes**: American Whitewater's ToS forbids harvesting/reuse;
  Canot Kayak Québec's "Parcours pagayable" (~46 maps) is partnership-only, no open licence.
  **Honest verdict: this owner-requested category has no unilateral legal source.** Path:
  partnership with Canot Kayak Québec + OSM ODbL data as a slow-burn.
- **Avalanche Canada ATES**: KMZ downloads exist but ToS requires written consent; ~no QC
  coverage anyway.

### Category verdict for a QC/Canada launch

topo **YES (strong)** · geological **YES** · aerial **YES (patchy)** · forest/hunting
**PARTIAL (link-only vectors)** · parks **US yes / QC-ON no (agreements)** · touristic
**PARTIAL (OSM base only)** · nautical **NO Canada / partial US** · river runs **NO open
source** (partnership track).

## 2. Catalog architecture

### Where the catalog lives: static manifest on the Pages site (recommended)

**Recommendation: a build-time-generated static JSON manifest hosted on the existing GitHub
Pages site** (`https://inukshuk.mvxtechnologies.com/catalog/v1/manifest.json`), not live
source-API queries.

- Updatable without app releases (edit `docs/catalog/`, push to main — same trust model as OTA).
- One schema in the app regardless of upstream count; upstream API churn is absorbed by the
  generator script, not by shipped clients.
- Offline-friendly: manifest cached on device; browse works offline, only downloads need net.
- Live APIs (USGS TNM Access, CKAN on open.canada.ca/Données Québec) are used **by the generator
  in CI**, not by phones. Phones only hit: (a) our manifest, (b) the source's direct file URL
  for the actual bytes — we never rehost, which keeps us on the "attribute + link" side of the
  licences rather than the "redistribute" side.
- Versioned path (`/catalog/v1/`) so a breaking schema change doesn't strand old apps.

Escape hatch: if a category later needs live search (full USGS coverage ≈ 180k products — too
big for one manifest), add per-region manifest shards (`manifest-qc.json`, `manifest-us-ne.json`)
listed in a small root index — still static, lazily fetched.

### Schema (v1)

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-08T00:00:00Z",
  "sources": [
    {
      "id": "nrcan-cantopo",
      "name": "NRCan CanTopo",
      "licence": "OGL-Canada-2.0",
      "attribution": "Natural Resources Canada",
      "homepage": "https://...",
    },
  ],
  "items": [
    {
      "id": "cantopo-021L14", // stable: source + native sheet/product id
      "sourceId": "nrcan-cantopo",
      "title": "Québec (ville) — CanTopo 021L14",
      "category": "topo", // parks|forest|hunting|topo|touristic|nautical|geological|aerial|river
      "region": "CA-QC", // ISO 3166-2 for coarse filter chips
      "bbox": [-71.5, 46.75, -71.0, 47.0], // WGS84 [w,s,e,n] — drives near-me/extent search
      "format": "geopdf", // geopdf|pdf|geotiff
      "sizeBytes": 24500000, // real number from generator HEAD requests
      "url": "https://ftp.maps.canada.ca/...pdf",
      "sidecar": null, // optional world-file/aux-xml URL for plain-PDF sources
      "thumbnailUrl": "https://inukshuk.mvxtechnologies.com/catalog/v1/thumbs/cantopo-021L14.webp",
      "updatedAt": "2025-11-02",
      "lang": "fr", // fr|en|bilingual — matters for the QC audience
    },
  ],
}
```

`sidecar` lets us catalog sources publishing plain PDF + separate georeferencing — wire the
currently-dead `parseWorldFile`/`parseAuxXml` for it. Thumbnails are tiny WebPs we generate and
host ourselves for open-licensed products only.

### Generator pipeline (`scripts/catalog/`)

Node/TS scripts, run manually or on a scheduled GitHub Action:

- `fetch-<source>.ts` per source (TNM API / CKAN query / crawl of the NRCan HTTP index) emits a
  normalized fragment; HEAD every URL for `sizeBytes` + liveness.
- `build-manifest.ts` merges + validates with a zod schema shared with the app (schema types in
  `src/core/catalog/schema.ts` so app parser and generator can't drift; core stays pure —
  the generator imports from it, not vice versa).
- Weekly `catalog-links.yml` CI job re-HEADs every URL, opens an issue on dead links.
- `curated/*.jsonc` hand-maintained fragments for one-off gems (park maps, river runs) no API serves.

### Client-side search

Pure core module `src/core/catalog/` (unit-tested, under the coverage gate):

- `filterCatalog(items, { text?, category?, region?, bbox? })` — diacritic-folded text match
  ("riviere" finds "Rivière"), category/region chips, bbox-intersect for "near me"/"map area".
  1–5k items filter in <5 ms; no index needed at launch scale.
- `src/data/catalogCache.ts`: fetch with ETag, persist last-good manifest to
  `Paths.document/catalog.json`, ~24 h TTL, never-throw (offline ⇒ serve cached).

## 3. In-app UX

**Tab**: `app/(tabs)/search.tsx` → `src/features/store/StoreScreen.tsx`. Title **"Search"**,
icon `magnify`, between Library and Dashboard. Respects the three `uiStyle` variants for free.

**Screen** (react-native-paper, existing idioms):

1. Paper `Searchbar` + horizontal category `Chip` row + region chip.
2. Toggle row: "Near me" (existing location plumbing — race reads with a timeout, per the
   `getHeadingAsync` lesson) and "Map area" (reads the main map camera bbox).
3. Results in a `FlatList` of cards: thumbnail, title, source badge, size (`formatBytes`
   exists), region, updated date. Empty/offline states patterned on Library copy.
4. Detail sheet on tap: description, coverage (bbox rectangle or thumbnail), attribution +
   source link, licence line, Download button.

**Download flow**:

- Download → `DestinationFolderDialog` (new; radio list of folders + "New folder…" inline via
  existing `NameDialog`; defaults to last-used). Pre-flight `assessFreeSpaceForWrite(sizeBytes)`;
  if `sizeBytes > 30 MB`, an explicit size line in the dialog ("This map is 84 MB").
- Progress: new `src/data/catalogDownload.ts` on `expo-file-system/legacy`
  `createDownloadResumable` (progress + cancel; the SDK-56 File API has neither). Download to
  `Paths.cache`, move to `maps/<id>.pdf` on success — no partial files in the library dir.
  Determinate bar on the card, modeled on `offlineStore.progress`.
- Zip handling: CanTopo GeoPDFs ship zipped (~5 MB). Manifest carries `"packaging": "zip"`;
  after download, extract the inner PDF with `fflate` (already a dependency of the GeoPDF
  parser) — pure `src/core/catalog/unzip.ts`, unit-tested with a fixture zip.
- Landing: `mapDocumentFromStoredPdf(id, uri, title)` → `addMap` → `setItemFolder('map', id,
folderId)` → snackbar via `useImportFeedbackStore` ("Added to Library › Parcs"). The
  generator pre-verifies georeferencing, so the existing `georeferenceWarning` path is a
  safety net, not a normal outcome.
- **Dedup/update**: add `sourceItemId?` + `sourceUpdatedAt?` to `MapDocument` (schema v5 +
  migrator). Downloaded items show "In Library" (button → "Open"); when manifest `updatedAt`
  is newer, show "Update" → re-download replaces the file, keeps id/folder/activePages.
  Re-tapping Download never duplicates.

**GeoTIFF**: defer past M1, but — unlike the pre-research assumption — it is probably worth
building. §1 changed the calculus: **BDTQ 1:20k, the single best Québec topo product, exists
only as GeoTIFF** (as do the CC-4.0 orthophotos). M1 ships on GeoPDF sources (CanTopo, USGS);
GeoTIFF lands as its own milestone. Cost: decoder (`geotiff.js`, pure JS — RN spike needed),
LZW/deflate decode, reprojection of the tie-points to WGS84 corners, **windowed downsample to
≤2048 px during decode** (a large GeoTIFF must never be fully materialized in JS — this is the
real risk), `UPNG.encode` → `writeOverlayPng`, plus a `format: 'geotiff'` variant on
`MapDocument` so Library/list/delete handle non-PDF files. ~1–2 wk incl. memory hardening.
Decision Q4.

## 4. Milestones

**M1 — "CanTopo in your pocket" (shippable, ~1 wk)**
Manifest v1 on Pages, one source: **CanTopo 50k GeoPDF, Québec NTS sheets (021/031) first**
(OGL-Canada, predictable URLs, zip→fflate extract). Search tab: text + category chips,
FlatList, detail sheet, download-with-progress → folder picker → Library. `MapDocument`
schema v5 (source fields).

- Tests: `src/core/catalog/*.test.ts` (schema parse incl. malformed manifests, filter, dedup,
  unzip); manifest-cache tests with mocked fetch; Maestro `store.yaml` pointing the app at a
  **local test manifest** (manifest URL overridable via `Constants.expoConfig.extra`, same
  idiom as `errorReportEndpoint`) serving a ~50 KB fixture GeoPDF — CI never hits NRCan. E2E
  lessons apply (release APK, hide_error_dialogs).

**M2 — Depth + polish (~1 wk)**
Region chips, "near me" + "map area" bbox search, thumbnails, update-available flow, dead-link
tolerance (404 ⇒ friendly error + report through existing error reporting), generator CI +
link checker. New sources: **USGS US Topo** (TNM API in the generator; border/US-trip appeal)
and **NPS Geospatial PDFs** (public domain — gives a real "Parks" category even though it's
US-only at first), GSC geological GeoPDFs where per-URL work is done.

- Tests: bbox-intersect + diacritic-folding units; Maestro category-filter flow.

**M3 — GeoTIFF + Québec depth (gate: Q4)**
GeoTIFF pipeline (spike → windowed decode → overlay) unlocking **BDTQ 1:20k** (the flagship
QC topo, CSV-indexed) and regional orthophotos ("Aerial" category). Optional `expo-network`
cellular warning. Manifest shards if item count passes ~5k.

**Parallel non-code track (owner)**: partnership outreach — SÉPAQ (QC park maps) and Canot
Kayak Québec (river runs with rapid classes). These are the two highest-value categories with
no open licence; Avenza gets them via publisher agreements, and so must we. River-runs and
QC-parks categories ship only if/when an agreement lands (or, for rivers, as sparse OSM ODbL
data clearly labeled).

Non-goals: paid content, user submissions, rehosting files where licences forbid it, vector
charts, Canadian nautical (CHS — see the separate "Nautical + meteo" initiative).

## 5. Owner decision questions

1. **Tab name/icon**: "Search" + `magnify` (recommended — owner's word, Avenza precedent) vs
   "Store" + `storefront-outline` (implies commerce; everything is free — avoid).
2. **Manifest hosting**: Pages site `/catalog/v1/` (recommended: zero infra, PR-reviewed,
   versioned) vs NAS endpoint (couples app availability to home uptime — avoid for launch).
3. **Launch categories**: recommend **topo only at M1** (CanTopo QC — deep, legal, shippable
   in a week), parks (US NPS) + geological at M2. The categories the owner named that have
   **no legal free source** — QC parks (SÉPAQ), river runs with rapid classes, Canadian
   nautical, hunting-zone rasters — need either partnership outreach (SÉPAQ, Canot Kayak
   Québec) or must be dropped honestly. OK to start those two outreach conversations?
4. **GeoTIFF investment**: **yes, as M3** (recommended — revised upward: BDTQ 1:20k, the best
   QC topo product, and all QC orthophotos are GeoTIFF-only; without it the store's Québec
   story is CanTopo-only) vs never (store stays GeoPDF-only, skip BDTQ/aerial).
5. **Cellular warning**: size-threshold only (no new dep, recommended at M1) vs add
   `expo-network` for a real cellular check.
6. **French**: QC catalog content is largely FR; app chrome is EN-only. Ship mixed at M1
   (recommended) or trigger the broader i18n project?
