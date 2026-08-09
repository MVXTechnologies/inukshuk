# Marine deep improvements (Wave D) — design package

Design lead plan, 2026-08-09. Owner field feedback on the shipped marine layer
(marine M2+M3, PR #194): resolution awful; coastlines invisible under the tint
(Wave B owns the global labels-above-drape fix — we coordinate, not duplicate);
wants tap-for-depth with the actual number; international waters; honesty about
"data which would allow navigation"; and a bottom prompt on low-res regions
offering a free auto-updating local marine chart pack (marine M4).

**TL;DR**: Live probing proves the blockiness is the CHS server, not our code —
it serves only a pre-colored ~13 m-ground mosaic, magnified nearest-neighbor
past z13 with a harsh rainbow ramp and seam lines; no WMS parameter fixes it
(verified by 4× supersampling: identical blocks, 4× larger). The headline fix is
**client-side rendering of the raw WCS depth grid** — same 13 m data, but our
own smooth ramp, bilinear interpolation, seam infill — reusing weather M3's
float32-TIFF parser (needs two small extensions, verified against real NONNA
output). Tap-for-depth must use WCS 1-px GetCoverage (verified: −26.47 m in
0.21 s at a real St. Lawrence point; GetFeatureInfo is a dead end — it returns
render colors). Worldwide coverage ships free and legal via a NONNA → NOAA →
EMODnet → GEBCO ladder (all endpoints + licences re-verified live; the shipped
plan's NOAA WMTS URL is dead — replacement found). Offline marine packs are
startlingly cheap: **~22 MB per 30×30 km at full served resolution** as a single
WCS GeoTIFF that doubles as offline tap-for-depth. Everything stays legally
"not for navigation" — that chip is a licence condition of NONNA, GEBCO, and
even redistributed NOAA ENCs.

**Coordination**: Wave A owns tap-anywhere — we add one line to its card (§2).
Wave B owns labels-above-drape — our client drape is designed to render _below_
labels so it inherits that fix (§1, option B); do not ship a GL overlay that
covers labels. All probe artifacts (tiles, TIFFs, capabilities XML) are saved in
`scratchpad/nonna-probe/` for the implementation team as test fixtures.

## 1. Resolution reality check (verified live, 2026-08-09)

Probe: GetMap tiles z10–z15 over the Québec City ship channel (46.80N, −71.20W),
256 px and 1024 px supersamples, single-layer isolations, WMS GetCapabilities,
WCS DescribeCoverage + subsets. Findings:

- **The server does not hold a 10 m grid.** DescribeCoverage: "NONNA 10" is a
  world 2²¹×2²¹ EPSG:3857 mosaic with **19.0986 mercator-metre cells ≈ 13.1 m
  ground at 46.8°N** (NONNA-100: 152.8 m cells). That is the ceiling for every
  access route. Measured WMS block sizes match it exactly (4 px blocks at z15).
- **Nearest-neighbor magnification, provably.** The same bbox at 1024×1024 has
  an _identical_ distinct-color count and exactly 4× larger blocks — the server
  adds zero information past z13 (19.1 m/px). Requesting bigger tiles, higher
  zooms, or supersampled WMS cannot help. Blockiness is (mostly) not our bug.
- **One style exists** (`raster`, pre-colored opaque rainbow). No contours, no
  hillshade, no alternative ramp server-side. Plus **1-px nodata seam lines on
  every 0.01° granule boundary** (visible white hairlines in the current drape).
- **NONNA-10 does cover the ship channel** densely (58.5% opaque, rich detail at
  z13); NONNA-100 contributes only a ~11% coarse fringe. Layer order is correct.

**Fix — client-rendered depth drape from WCS** (the headline recommendation):
same 13 m data, dramatically better presentation: bilinear interpolation
(smooth gradients instead of 4–16 px stair-steps), our own hypsometric ramp
(Windy-quality, theme-aware, legend-pill reuse), seam-line infill, optional
subtle hillshade. Cost verified live: a viewport subset is tens of KB
(45.6 KB/km² as served); latency 0.6 s.

_Parser reuse (assessed against real NONNA bytes)_: `windTiff.ts` already
handles big-endian ("MM" — NONNA emits it) and uncompressed float32 single-band.
Two real gaps: NONNA output is **tiled** (112×16 tiles, tags 322–325, not
strips) and georeferenced by **ModelTransformation tag 34264** (not
PixelScale+Tiepoint; rotation terms are 0, so it converts trivially). GeoServer
provably ignores `tiling=false`/`compression` params, but honors
`tilewidth/tileheight ≥ subset` → single contiguous tile as a stopgap.
Recommendation: promote the parser to a shared `@core` float32-GeoTIFF module
with tile + tag-34264 support (~60 lines, pure, fixtures recorded from the
probe); keep GeoMet behavior byte-identical.

_Drape mechanism — two options_:

- **A. GL overlay** (reuse `WindParticleOverlay`/`windGl` texture + clip-matrix
  machinery wholesale): fastest build, but the GLView sits _above_ the whole
  MapView — a 0.7-opacity tint would cover town names and re-break exactly what
  Wave B is fixing. Rejected as primary.
- **B. Recommended: georeferenced-image drape below labels** — render the grid
  to an RGBA image client-side (pure-JS PNG encode of a viewport-sized bitmap;
  uncompressed-deflate PNG writer is ~100 dependency-free lines in `@core`),
  write to cache, drape via a MapLibre image source **below Wave B's label
  layers** — the exact `usePdfOverlay` mechanic (file URI, never data-URI: known
  MapLibre crash). Re-render on camera settle like the PDF overlay. WMS drape
  remains as fallback (kill-switch in Settings → Map, wind-particles precedent).

## 2. Tap-for-depth (verified live)

- **WMS GetFeatureInfo is a dead end** — verified: it returns the styled mosaic
  RGBA values (`GridCoverage_Band1..3` = 124/149/254), i.e. colors, not depth.
- **WCS 1-px GetCoverage works**: subset ±10 m around 46.78502N −71.21338W →
  1.4 KB TIFF, single float32 **−26.47 m**, 0.21 s. This is the mechanism.
- Caveat verified: the 0.01° seam lines are nodata (float32-max nilValue), and
  round coordinates can land on them — query a **3×3-px subset and take the
  nearest valid cell**, never a bare pixel.

**UX** (coordinate with Wave A's tap-anywhere card): when any marine layer is
active, the tap card gains one line — anchor icon + "Depth 26.5 m" (settings
units; "below chart datum" in the expanded view; positive values shown as
"drying 3.8 m"). Same garnish semantics as `useForecast`'s `layerValue`: depth
fetch failure never fails the card; no marine layer → no line, zero cost.
Source ladder follows §3: NONNA WCS in Canada; EMODnet
`rest.emodnet-bathymetry.eu/depth_sample` in Europe (verified: JSON, −64.03 m
North Sea); NCEI `DEM_global_mosaic/identify` elsewhere (verified: −15.36 m off
Boston; ETOPO 15″ globally, ~3 m CUDEM in US waters). Offline: sample the local
pack grid — free and instant. New pure module `@core/geo/depthQuery.ts` (URL
builders, response parsers, seam fallback, ladder pick) + tests.

## 3. International waters — coverage-aware source stack

All endpoints and licences verified by live fetch 2026-08-09:

| Source                 | Coverage                                         | Resolution       | Licence (verified)                                                                                                                                    | Endpoint (verified live)                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHS NONNA 10/100       | Canada                                           | 10 m / 100 m     | OGL–Canada + "NON-NAVIGATIONAL USE ONLY" supplement (open.canada.ca dataset d3881c4c…)                                                                | WMS/WCS `nonna-geoserver.data.chs-shc.ca` (in app today)                                                                                                                                             |
| NOAA ENC Online        | US waters                                        | chart-scale ENC  | US Gov: "download, use, and redistribute… without restriction"; redistributed copies "NOT… official NOAA ENCs" (charts.noaa.gov/ENCs/Agreement.shtml) | ArcGIS export w/ bbox templating `gis.charttools.noaa.gov/...MCS/ENCOnline/...` — HTTP 200 png, 0.27 s. **Old NOAAChartDisplay WMTS is dead (HTTP 500)** — the shipped plan's URL must not be reused |
| NOAA NCDS MBTiles      | US waters                                        | ENC tile pyramid | same (official offline packages, updated weekly)                                                                                                      | `distribution.charts.noaa.gov/ncds/` — verified, regions 138–596 MB                                                                                                                                  |
| EMODnet DTM 2024       | European seas                                    | ~115 m (1/16′)   | CC-BY 4.0, "free of restrictions of use and free of costs"                                                                                            | XYZ `tiles.emodnet-bathymetry.eu/2020/baselayer/web_mercator/{z}/{x}/{y}.png` + WMS + WMTS — all HTTP 200                                                                                            |
| GEBCO_2026             | Global                                           | ~450 m (15″)     | Public domain; commercial exploitation explicitly allowed; attribution **mandatory**; "should NOT be used for navigation"                             | WMS `wms.gebco.net/mapserv`, layer `GEBCO_LATEST` — HTTP 200 png, 0.65 s. Capabilities disclaim service continuity → never scrape for offline; pre-render from the 4–4.8 GB grid instead             |
| OpenSeaMap seamarks    | Global                                           | vector-derived   | tiles CC-BY-SA, data ODbL; **no formal bulk/offline policy**, donation-run, no SLA                                                                    | `tiles.openseamap.org` — HTTP 200, 0.76 s today                                                                                                                                                      |
| NCEI DEM_global_mosaic | Global (ETOPO 15″) upgrading to ~3 m CUDEM in US | point depth      | US Gov, citation requested                                                                                                                            | `gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer/identify` → returned −15.36 m off Boston                                                                           |

**Design — `marineSources.ts` coverage ladder** (mirrors weather's HRDPS→RDPS→GDPS
model fallback in `windCoverage.ts`/`weatherModels.ts`): a pure catalog of
bathymetry sources with a coverage predicate (bbox polygon test, like
`windCoverage`'s domain checks). Priority: **NONNA (Canada) → NOAA ENC (US) →
EMODnet XYZ (Europe) → GEBCO (global)**. The style builder picks the best source
covering the viewport centre and composes it exactly like today's `marine-*`
raster pair in `mapStyle.ts`; crossing a coverage boundary swaps the source via
the existing style-memo rebuild (same mechanic as radar TIME swaps). Seamarks
stay OpenSeaMap worldwide (already global). Each catalog entry carries its
attribution line (all five feed the Settings → Maps & data credits) — GEBCO's
"GEBCO Bathymetric Compilation Group 2026" line is a licence _requirement_, not
courtesy. ETOPO/SRTM15+ were assessed and rejected as global bases: same
compilation lineage as GEBCO, no resolution advantage over water.

## 4. Navigation-grade honesty

The wall has not moved (all re-verified live 2026-08-09):

- **CHS navigation charts**: Crown copyright; the VAR licence intake is closed;
  one-off chart purchases carry no redistribution rights. Nothing shippable.
- **GeoGarage** (licensed CHS raster tiles via REST): product page live, still
  B2B quote-only. The one realistic paid bridge to real CHS charts for the
  St. Lawrence; offline caching would be contract-dependent. Worth one email if
  the owner wants chart-look; do not block the roadmap on it.
- **Navionics/Garmin Marine SDK**: still request-form-gated, no public pricing,
  native chart-view SDK that replaces MapLibre. Unchanged verdict: lottery
  ticket at most (and the Garmin Connect freeze precedent stands).
- **NOAA is the honesty exception**: genuinely free/redistributable — but even
  NOAA says redistributed ENCs are "NOT considered official" and don't meet
  carriage regulations. GEBCO and NONNA both _require_ non-navigational framing.

**Scope line to give the owner**: everything in this package — 10 m depth tints,
tap-for-depth numbers, seamarks, offline packs, worldwide coverage — ships free
and legal, but ALL of its sources legally require the "Not for navigation" chip
to stay. "Data which would allow navigation" (official ENC symbology, verified
soundings, carriage-grade updates) exists only behind GeoGarage-type contracts
(Canada) or as unofficial-but-real NOAA ENC rendering (US only). The chip is a
licence condition, not timidity.

## 5. Offline marine packs + low-res prompt

**The prompt** (the owner's "download free local marine map" ask): a bottom
banner, NOT a Portal/Dialog (launch-path Portals soft-lock One UI — see
MarineDisclaimerChip's own comment) and NOT stacked over Wave A's weather dock —
a plain themed Surface row in `MapScreen.tsx`'s bottom stack, same idiom as the
recording card, sitting just above the tab bar: "Marine detail available for
this area — download the free chart pack (~NN MB)" with Download / Not now.
Trigger: marine layer active AND viewport is inside a NONNA coverage cell AND no
pack covers the viewport. "Not now" snoozes per region (persisted set in
`settingsStore`, like dismissed disclaimers) — the banner must never nag.
Download hands off to the existing `offlineStore.downloadMany` progress UI.

**Low-res detection** is coverage-ladder-derived, not pixel-sniffing: the
`marineSources.ts` predicate already knows whether the viewport is on NONNA-10,
NONNA-100-only, EMODnet, or GEBCO. "Low-res region" = best available source for
the viewport is coarser than the pack we can offer (e.g. GEBCO drape where a
NONNA cell exists offline, or any coverage where a pack would beat the online
WMS render). Pure function + tests in core.

**Pack contents — two-layer design**:

1. _Depth grid_ (the headline): WCS GeoTIFF region at full served resolution
   (13 m ground), stored under `Paths.document/marine-packs/<region>/`,
   client-rendered by the §1 depth pipeline — one file replaces an entire tile
   pyramid and gives offline tap-for-depth for free (local grid lookup).
   **Size verified live: 45.6 KB/km² as served → ~22 MB per 30×30 km**; a
   Québec City–Île d'Orléans reach (~40×15 km) ≈ **14 MB**. The banner's "~NN
   MB" comes from a bytes/km² constant × region area (mirrors
   `estimateBytesForBasemaps`). Fetch in bbox chunks (GeoServer subset limits)
   with resume, through the existing download-progress UI.
2. _Seamarks_: NOT bulk-scraped from tiles.openseamap.org (no bulk policy,
   donation-run — see §3); ship without offline seamarks in M-pack v1, and
   self-render from OSM extracts later if demand shows.
   US waters bonus: NOAA's official NCDS MBTiles (138–596 MB/region, weekly) are
   purpose-built for this — a later catalog entry, not Wave D.

**Auto-update policy**: NONNA cells revise slowly; on app foreground + Wi-Fi +
(pack older than 30 days), HEAD/ETag the WCS source and refresh changed regions
silently, honoring the existing disk-budget guard (`diskSpace.ts` /
`isOutOfSpaceMessage`). Settings → Data settings row: "Marine packs: auto-update
on Wi-Fi" (default on) + per-pack delete, mirroring offline-region management.

## 6. Milestones (thin, all JS-only → OTA-able), tests, owner decisions

**D1 — Tap-for-depth + parser groundwork** (smallest visible win first)

- Promote `windTiff` to a shared float32-GeoTIFF core module (tile layout +
  tag 34264; GeoMet path byte-identical, guarded by existing tests + new NONNA
  fixtures from `scratchpad/nonna-probe/sub10.tif`/`pin.tif`).
- `@core/geo/depthQuery.ts` (WCS 1-px URL, 3×3 seam fallback, EMODnet/NCEI
  parsers, ladder pick) + "Depth" line in Wave A's tap card.
- Tests: pure fixtures for all three response shapes; Maestro adds one assert
  to the existing tap-card flow (menu/crash gate only, never live pixels).

**D2 — Client-rendered depth drape** (the resolution fix)

- Viewport WCS subset → bilinear resample → own ramp + seam infill → PNG file →
  image-source drape below labels (Wave B inherit), re-render on camera settle;
  WMS fallback + kill-switch. Legend pill reuses the weather gradient idiom.
- Tests: pure ramp/resample/PNG-encoder tests (encoder output round-tripped
  through the TIFF…PNG fixtures); on-device verification for perf (emulator GL
  lies — release build, both themes per the dark-mode rule).

**D3 — Worldwide ladder** — `marineSources.ts` coverage predicates + EMODnet
XYZ + GEBCO WMS drapes + NOAA ENC Online entry (the dead WMTS URL must not
ship), per-source attribution + the chip everywhere. Tests: predicate/URL
tests; Maestro unchanged (source swap is a style rebuild, already exercised).

**D4 — Offline marine packs + low-res prompt** (marine M4 realized)

- Pack fetch/store/auto-update per §5; banner component; offline depth
  sampling; Settings rows. Only slice touching `src/data`.
- Tests: size-estimate + pack-bookkeeping units; banner logic pure-tested
  (trigger = ladder state × pack inventory × snooze set); manual device pass
  per the release-gotchas playbook.

Sequencing: D1 unblocks D2 (parser) and needs no design approvals; D2 is the
owner-visible payoff; D3/D4 are independent after D1 and can land in either
order. Each slice passes `npm run check` and ships OTA on 1.5.0/1.4.0 runtimes.

**Owner decisions (recommendations in bold)**

1. Resolution: accept that 13 m ground is the hard ceiling of CHS's server and
   fix presentation client-side? **Yes — D2; verified no server route delivers
   more.** (True 10 m would mean bulk NONNA portal downloads + preprocessing on
   the NAS — possible later, big lift, same "not for navigation" limit.)
2. Worldwide scope now? **Yes — D3 is thin and the licences are clean; GEBCO's
   450 m global base is honest low-res far offshore, labeled as such.**
3. "Data which would allow navigation": pursue the paid route? **Send GeoGarage
   one quote email now (only realistic CHS bridge; quote-based), skip
   Navionics/Garmin (form-gated, no pricing, native SDK replaces MapLibre).
   Nothing in D1–D4 waits on either.**
4. Offline seamarks: bulk-cache OpenSeaMap tiles into packs? **No — no bulk
   policy, donation-run server; ship depth-only packs v1, revisit self-rendered
   OSM seamarks if usage shows demand.**
5. Pack auto-update default? **On (Wi-Fi-only, 30-day check, disk-budget
   guarded) — "auto-updates" was the owner's explicit ask; the per-pack sizes
   (~14–22 MB) make silent refresh safe.**
