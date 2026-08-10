# World catalog — sources and licence verdicts

Verified live on **2026-08-10**. The test every source must pass:

> We never rehost. The manifest points at the publisher's own download URL and
> the phone fetches from them directly. So: does the licence permit a
> third-party app to **link** those URLs, and the end user to **download and
> keep** the file offline? And is the URL reachable **without an API key,
> session cookie, CAPTCHA or click-through EULA**?

A source also has to ship a format we can actually render. Today that is
**GeoPDF or plain PDF** — we have no GeoTIFF, BSB/KAP or S-57 support. That
turns out to be the binding constraint on marine charts (§2).

## 1. Shipping now

| Source                                | Category | Items  | Format                 | Licence                | Evidence                       |
| ------------------------------------- | -------- | ------ | ---------------------- | ---------------------- | ------------------------------ |
| **USGS US Topo**                      | topo     | 65,240 | GeoPDF, 11–51 MB       | Public domain (US Gov) | see §1.1                       |
| **NRCan CanTopo 50k**                 | topo     | 128    | GeoPDF (zipped), ~5 MB | OGL-Canada-2.0         | pre-existing source, unchanged |
| **Geoscience Australia AUSTopo 250k** | topo     | 509    | GeoPDF, 3.4–51 MB      | CC BY 4.0              | see §1.2                       |

**65,877 items** total.

### 1.1 USGS US Topo — INCLUDE

- **Licence.** <https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map>:
  _"Map services and data downloaded from The National Map are free and in the
  public domain. There are no restrictions."_ Acknowledgement is **requested,
  not required**; we carry it as the source's `attribution`.
- **Enumeration.** Bulk metadata CSV, refreshed nightly:
  `https://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/Metadata/ustopo_current.zip`
  — HEAD verified `200`, `Content-Length: 10465206`, `Last-Modified` same day.
  `ustopo_current.csv` holds **65,240 rows** with `westbc/eastbc/northbc/southbc`,
  `product_filesize`, `publication_date` and `product_url`. One 10 MB download
  replaces 65,000 HEAD requests, and it is the reason this source was cheap.
- **Download URL.** The CSV's `product_url` is the stable _Current_ alias, e.g.
  `https://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/USTopo/Current/PDF/AL/AL_Abbeville_East.pdf`
  — no date in the path, so a reissued quad keeps its manifest URL.
- **Also key-free but not used:** the TNM Access API
  (`tnmaccess.nationalmap.gov/api/v1/products`, no key). Gotchas if you ever
  need it: `prodFormats=GeoPDF` returns 0 for US Topo (the value is
  `Geospatial PDF`), and `datasets=US Topo` times out — use `US Topo Current`.
- **Deliberately excluded:** the Historical Topographic Map Collection (186,061
  sheets, same CSV format). It would nearly quadruple the catalog and bury every
  current quad under eight historical editions of itself in "Around you". It is
  a _category_ decision, not a licence one — add it behind its own category if
  it is ever wanted.

### 1.2 Geoscience Australia AUSTopo 1:250 000 — INCLUDE

- **Licence.** <https://www.ga.gov.au/copyright>: _"All material on this website
  is licensed under the Creative Commons Attribution 4.0 International
  Licence"_. Carve-outs are the Coat of Arms, the GA logo and third-party
  content — none of which we redistribute. Each eCat record independently
  carries `legalconstraints: "Creative Commons Attribution 4.0 International
Licence"`.
- **Enumeration.** One anonymous POST, no key/cookie/EULA:
  `POST https://ecat.ga.gov.au/geonetwork/srv/api/search/records/_search` with
  `{"match_phrase":{"resourceTitleObject.default":"AUSTopo 1:250 000 digital map"}}`
  → `total.value: 509`. Each record carries the sheet title with its map-sheet
  code, the direct CloudFront URL, the size in the link description
  (`"Download the map (GeoPDF) [3.4 MB]"`) and a `geom` polygon —
  e.g. Cook SH52-11 → `[[129,-31],[130.5,-31],[130.5,-30],[129,-30]]`, a correct
  1.5°×1.0° tile.
- **Download URL.** `https://d28rz98at9flks.cloudfront.net/148128/148128_00_Feb26.pdf`
  — HEAD verified `200`, `application/pdf`. **Filenames are not derivable**
  (508 sheets end `_Feb26.pdf`, one ends `_Feb2026.pdf`), so the generator always
  reads URLs from the index and never synthesises them.
- **Two traps found and handled** (both cost real bugs):
  1. ~75 of the 509 records leave the link's `function` field empty and the
     wording varies (`Download Map (GeoPDF)` vs `Download the map (GeoPDF)`);
     filtering on `function === 'download'` silently loses them.
  2. **Two sheets (Manilla SH56-09, Monto SG56-01) are plain `(pdf)`, not
     GeoPDF.** They ship as `format: 'pdf'` so the importer's un-georeferenced
     path warns, rather than the catalog overstating what the file is.
- **The locator-inset trap — a real bug this found.** Parsing a sheet with our
  own `parseGeoPdf` returns **three** viewports, and the **first is a
  whole-of-Australia locator inset** (111°E–156°E) in a 142×142 pt box; the map
  is the second. The overlay pipeline used to take the first georeference for a
  page, which would have drawn all 509 sheets stretched across the continent.
  Fixed in `src/core/geo/geopdf/primary.ts` (largest viewport wins) and wired
  into the overlay, import and Library paths. US Topo ships the same
  three-viewport layout and only happens to list the map first — so this was
  latent for the US source too.

## 2. Marine charts — nothing shippable, and the reason is format

**This is the headline negative result.** Every openly-licensed chart source is
GeoTIFF or BSB/KAP; every chart product published as PDF is paywalled or
login-gated. The blocker is **our format support, not licensing**.

| Source                                                                                         | Verdict                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **NOAA (US)**                                                                                  | **EXCLUDE — product discontinued** | The raster sunset **completed December 2024**: paper charts, RNC/BSB, full-size chart PDFs, **BookletCharts**, RNC tile services — all cancelled (<https://nauticalcharts.noaa.gov/charts/farewell-to-traditional-nautical-charts.html>). Verified dead today: `charts.noaa.gov/BookletChart/12326_BookletChart.pdf`, `/PDFs/12326.pdf`, `/RNCs/12326.zip` — all **404**. Licence would have been ideal (CC0-1.0). **There is no NOAA PDF chart left to link to.** |
| NOAA ENC                                                                                       | EXCLUDE — format                   | S-57. Superb index though: `charts.noaa.gov/ENCs/ENCProdCat_19115.xml` (200, 51.8 MB, 7,224 datasets with coverage polygons). Revisit if we ever support S-57.                                                                                                                                                                                                                                                                                                     |
| NOAA Custom Chart                                                                              | EXCLUDE — interactive only         | Produces georeferenced PDFs, but it is an Esri Web AppBuilder app with no batch/GP endpoint. Pre-generating them ourselves would mean **rehosting**, which is exactly the model we avoid.                                                                                                                                                                                                                                                                          |
| **NZ LINZ charts**                                                                             | **EXCLUDE — format**               | Licence is _clean_: explicit CC BY 4.0 per chart, key-free index `charts.linz.govt.nz/api/charts/spatial?_format=json`, 184 charts with WGS84 polygons. But the product is TIFF — `https://static.charts.linz.govt.nz/chart/tiff/nz4314.tif` (200, `image/tiff`; the `/chart/pdf/` sibling does not exist) — **and the TIFFs carry an empty GeoKeyDirectory**, so they are not even georeferenced.                                                                 |
| **Norway Kartverket POD**                                                                      | **EXCLUDE — gated**                | The one per-sheet **PDF** chart series found in Europe, and it is the gated one. Geonorge metadata for _POD - Hovedkart (sjø)_: `DistributionFormats: [PDF]`, but `AccessConstraints: "Norge digitalt begrenset"`, `UseConstraints: "Lisens"`, use limitation _"Etter kjøp…"_ (after purchase). All nine POD products, including every marine one, are partner-role restricted.                                                                                    |
| Norway open sea charts                                                                         | EXCLUDE — format                   | `Sjøkart - raster Kystkart` is `noConditionsApply`, but GeoTIFF and only 12 charts.                                                                                                                                                                                                                                                                                                                                                                                |
| **Brazil DHN**                                                                                 | **EXCLUDE — non-commercial**       | Mechanically ideal (553 charts on clean direct URLs) but BSB/KAP + GeoTIFF, and explicitly _"não podem ser reproduzidas/compiladas/derivadas para fins comerciais"_. NC collides with the paid-sync roadmap even while the app is free.                                                                                                                                                                                                                            |
| Peru, Argentina, Chile, Colombia, Mexico SEMAR                                                 | EXCLUDE                            | Sold, non-commercial reservations, or CAPTCHA-gated.                                                                                                                                                                                                                                                                                                                                                                                                               |
| UKHO, Australia AHO, Denmark, Netherlands, Germany BSH, Sweden, Russia, Japan JHOD, Korea KHOA | **UNVERIFIED**                     | The research pass covering these never returned. UKHO and AHO are near-certain commercial excludes but we hold **no quoted evidence**, so they are recorded as open, not as negatives.                                                                                                                                                                                                                                                                             |

**What would unlock marine.** Adding **GeoTIFF import** (already scoped as M3 in
`docs/plans/plan-map-store.md` for Québec BDTQ) would immediately make NZ LINZ's
184 CC BY 4.0 charts and Norway's 12 open Kystkart charts shippable — except
that the LINZ TIFFs would still need georeferencing supplied from the index
polygon rather than the file. That is the single highest-value next step for
this initiative, and it is a format project, not a licensing one.

## 3. World topo — licence-clean but format-blocked

All of these pass the licence test and fail on format. None ship.

- **swisstopo** — key-free STAC (`data.geo.admin.ch/api/stac/v1/`), per-item
  bbox and checksums; terms permit commercial use. All 508 collections scanned:
  **zero map-series PDFs**, COG GeoTIFF only. (Correct collection ids are
  `ch.swisstopo.pixelkarte-farbe-pk25.noscale` and
  `ch.swisstopo.landeskarte-farbe-10`; `swiss-map-raster25` does not exist.)
- **Spain IGN MTN25/50** — CC BY 4.0, but the format moved to bare COG in 2025
  and the download endpoint is **POST-only** (`GET descargaDir` → 403). A
  plain-URL manifest cannot express it.
- **Austria BEV KM50-R** — CC BY 4.0, enumerable with bbox, but COG at
  330–840 MB per tile.
- **Norway N50 Raster** — CC BY 4.0, ~1,335 cells, GeoTIFF-in-ZIP, no bbox in
  the feed. (The vector N50 is CC BY 4.0 too: FGDB/GML/PostGIS/SOSI only.)
- **NZ Topo50** — CC BY 4.0, but the georeferenced variant is ~144.7 MB _per
  sheet_ (~65 GB corpus); the small variant has no geo tags. Size or
  georeferencing, never both.
- **France IGN** — EXCLUDE on licence too: free use is limited to _"usage
  professionnel ou associatif"_, consumer TOP25 is a paid subscription, and
  SCAN 25/100 is absent from the free catalogue. No PDF at any granularity.
- **OpenTopoMap / OSM** — EXCLUDE. No per-area document product; the Garmin
  builds are CC-BY-**NC**-SA 4.0, "NOT FOR RESALE", and `.img` not PDF. OSM's
  tile policy: _"Offline use is not permitted on tile.openstreetmap.org."_

## 4. Other US sources — verified, not yet shipped

- **USFS FSTopo** — 21,445 georeferenced PDFs, ~1–4 MB, public domain, access
  constraints "None". Verified: `data.fs.usda.gov/geodata/rastergateway/data3/30095/fstopo/Bear_Creek_302209507_FSTopo.pdf`
  → 200, 1,791,052 bytes; geo dict confirmed inside compressed object streams.
  Bbox is derivable from the filename's 9-digit SW-corner code. Cost is a
  498-page HTML scrape — a good next source, deferred only on time.
- **USFS MVUM** — georeferenced PDFs, high user value, but **no national
  index**; every regional page is a JS ArcGIS app. Needs a hand-curated list and
  an annual January refresh.
- **BLM** — ~low hundreds of genuinely georeferenced PDFs across 12 scrapeable
  state pages, public domain, but **no bbox metadata** anywhere, and files run to
  tens of MB. Items without a bbox land in a `nogeo` shard and never surface in
  "Around you", which limits the value.
- **NPS** — **EXCLUDE as a georeferenced source.** The licence is excellent
  (public domain, explicit reproduction/derivative/distribution grant), and
  `nps.gov/npgallery/GetAsset/{guid}` serves PDFs. But decompressing every
  stream of the 25.5 MB National Park System map found `GPTS`=0, `/Measure`=0,
  `GEOGCS`=0 — **not georeferenced** — the "Carto" geospatial-PDF portal is gone
  (302s to a landing page), the NPS Data API **requires a key**, and there is no
  bbox anywhere.
- **FEMA** — EXCLUDE. `msc.fema.gov` reset the TLS connection on every attempt,
  including with a browser UA — bot/TLS-fingerprint filtering a phone may not
  clear. FIRM panels are flood-insurance maps anyway.

## 5. Unverified leads for a future pass

Recorded as **open questions, not negatives** — a research pass reported on
several of these without a source and later retracted:

- **Mexico INEGI** — the highest-value lead. The endpoint is real
  (`POST .../app/api/productos/interna_v2/mapas/lista/resultados` → 200 JSON,
  GET → 405) but no request body produced data; recovering the real shape needs
  browser network inspection. Plausibly per-sheet 1:50k GeoPDF under the
  permissive _Términos de Libre Uso_.
- Estonia, Czechia, Poland GUGiK, Finland NLS, Sweden Lantmäteriet, Japan GSI,
  Portugal CIGeoE.
- Every European/Asian hydrographic office (see §2).
