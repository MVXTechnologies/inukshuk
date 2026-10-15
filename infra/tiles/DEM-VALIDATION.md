# DEM validation: heights and vertical datum of `/dem` (#725)

The LiDAR tiles served at `/dem/{z}/{x}/{y}.png` come from Mapterhorn (release 0.0.13). Mapterhorn
blends national terrain models into one Web Mercator surface. **It does not convert heights**: each
pixel keeps the vertical datum of the model it came from. These checks follow the project's geodesy
rule (every height is cross-checked against the agency's own tool, the check is reproducible, and a
CI gate keeps it).

## What the heights are

| Region             | Source served (Mapterhorn id)                 | Agency    | Vertical datum                  | Stated accuracy                                      |
| ------------------ | --------------------------------------------- | --------- | ------------------------------- | ---------------------------------------------------- |
| Québec             | HRDEM Mosaic DTM 2 m (`cahrdem2`)             | NRCan     | **CGVD2013**                    | lidar DTM (NRCan product page)                       |
| Alps — Switzerland | swissALTI3D 0.5 m (`swissalti3d`)             | swisstopo | **LN02** (MN95/LV95 planimetry) | ±0.3 m 1σ below 2000 m, ±1–3 m above (ProdInfo §1.4) |
| Alps — France      | MNT LiDAR HD 0.5 m (`frhd2154b`, `frhd2154d`) | IGN       | **NGF-IGN69**                   | LiDAR HD MNT                                         |

So an elevation read from these tiles is an **orthometric (normal) height in the country's own
official system**, not an ellipsoidal or EGM height. Across a national border the systems differ by
decimetres; the app should label readouts "above sea level" and, where it shows accuracy, use the
figures above.

Left out until validated (AWS Terrarium answers there; `pendingValidation` in
`nas/dem/regions.json`): Austria (BEV ALS-DGM and three Länder), Bavaria, Baden-Württemberg,
Slovenia (ARSO), South Tyrol, Aosta, the Zürich canton DTM (`chzh`, see below) and IGN RGE ALTI 1 m
(`frrgealti1metro`, see below). Each needs a site in `nas/dem/validation-sites.json` checked against
its agency's own service.

## Method

`nas/dem/validate.py` (2026-10-15), per site:

1. **Our tile.** The Mapterhorn z15 WebP over the site, cut by `transcode.py` (the code the NAS
   runs) into the z16 PNG that `/dem` serves. Before validating, the transcode itself is proven
   bit-exact: every PNG decodes to exactly the quadrant's RGB bytes (`test_dem.py`, plus a
   per-tile check in every pipeline run).
2. **The agency's own terrain-model service**, at the same places:
   - Québec: **NRCan HRDEM Mosaic WCS** (`datacube.services.geo.ca`, coverage `dtm`), requested on
     the tile's own EPSG:3857 grid. The GeoTIFF's tie point and pixel size are checked against
     the tile, then **all 65 536 pixels** are compared.
   - Switzerland: **swisstopo height service** (`api3.geo.admin.ch/rest/services/height`), with
     positions converted WGS84 → LV95 by **swisstopo REFRAME**. 16 points on a 4 × 4 grid around
     the site.
   - France: **IGN Géoplateforme altimetry** (`data.geopf.fr/altimetrie`), resource
     `ign_lidar_hd_mnt_mono_wld` (LiDAR HD MNT). 16 points. RGE ALTI (`ign_rge_alti_wld`) is
     recorded alongside.
3. **Survey benchmarks** near the site, with the agency's published height: NRCan CBN, HP3D and
   PVC marks (CGVD2013), and swisstopo HFP1/LFP1 (H02 = LN02). The DEM is interpolated
   bilinearly at the mark. A mark is _consistent_ when its height lies within the DEM's range over
   its own position uncertainty, ±0.5 m. Benchmarks are bolts in walls, on steps and on bridge
   abutments, and many Québec positions are map-scaled to about 11 m. They identify the
   **datum**, not the model's accuracy.

Differences are DEM − official, in metres.

## Results

### Against the agency's terrain-model service

| Site                | Tool             | n      | mean   | RMS   | p95 \|Δ\| | max \|Δ\| |
| ------------------- | ---------------- | ------ | ------ | ----- | --------- | --------- |
| Québec — Plaines    | HRDEM WCS (tile) | 65 536 | −0.036 | 0.128 | 0.262     | 1.98      |
| Mont-Sainte-Anne    | HRDEM WCS (tile) | 65 536 | −0.055 | 0.335 | 0.745     | 5.49      |
| Mont-Tremblant      | HRDEM WCS (tile) | 65 536 | +0.095 | 0.340 | 0.737     | 4.79      |
| Mont Mégantic       | HRDEM WCS (tile) | 65 536 | −0.236 | 0.345 | 0.640     | 1.61      |
| Saguenay            | HRDEM WCS (tile) | 65 536 | +0.006 | 0.050 | 0.083     | 1.49      |
| Charlevoix          | HRDEM WCS (tile) | 65 536 | −0.000 | 0.114 | 0.220     | 1.72      |
| Bern                | swisstopo height | 16     | +0.018 | 0.050 | —         | 0.10      |
| Interlaken          | swisstopo height | 16     | −0.030 | 0.141 | —         | 0.53      |
| Zermatt             | swisstopo height | 16     | −0.005 | 0.073 | —         | 0.13      |
| St. Moritz          | swisstopo height | 16     | −0.005 | 0.119 | —         | 0.33      |
| Gornergrat (3100 m) | swisstopo height | 16     | −0.007 | 0.544 | —         | 1.55      |
| Chamonix            | IGN LiDAR HD MNT | 16     | −0.006 | 0.046 | —         | 0.14      |
| Annecy              | IGN LiDAR HD MNT | 16     | −0.004 | 0.024 | —         | 0.05      |
| Briançon            | IGN LiDAR HD MNT | 16     | +0.018 | 0.046 | —         | 0.11      |

The two grids in Québec are resampled from the same 2 m mosaic by different software. The large
single-pixel maxima (up to 5.5 m) sit on cliffs and steep cuts, where half a pixel of offset is
metres of height; the 95th percentile stays under 0.75 m everywhere. Mont Mégantic has a −0.24 m
tile-wide mean (forested summit; the 32-px crop the CI gate holds is at +0.13 m). That is within the
lidar DTM's accuracy, and it is the one Québec site to recheck after the next Mapterhorn release.

**No datum offset anywhere.** The means are centimetres. An ellipsoidal height would be about 30 m
off in Québec and about 50 m in the Alps, and a swapped national system would be decimetres off.

### Against survey benchmarks (datum check)

| Site             | Marks | median Δ | mean Δ | consistent |
| ---------------- | ----- | -------- | ------ | ---------- |
| Québec — Plaines | 12    | −0.59    | −0.35  | 4 / 12     |
| Mont-Sainte-Anne | 9     | +0.09    | +2.98  | 3 / 9      |
| Saguenay         | 12    | −0.53    | +1.38  | 4 / 12     |
| Bern             | 12    | −0.45    | −0.76  | 9 / 12     |
| Interlaken       | 12    | −0.04    | +0.07  | 7 / 12     |
| Zermatt          | 10    | −0.12    | +0.04  | 10 / 10    |
| St. Moritz       | 12    | −0.32    | −0.27  | 11 / 12    |

The Swiss marks have surveyed positions (≤ 5 cm). They agree to decimetres, and the residual is
negative because the bolts sit on walls and steps above the ground the DTM models. The Québec PVC
marks are map-scaled (about 11 m) and often on structures, so their scatter is large. Their medians
are still within ±0.6 m, which rules out any datum error of metres. Mont Tremblant, Mont Mégantic
and Charlevoix got no benchmarks: the CSRS webapp timed out (`benchmarksError` in the report).

### Sources left out after checking

- **Zürich canton DTM (`chzh`, 0.25 m).** At Uetliberg it differs from swisstopo's swissALTI3D
  service by −0.245 m mean and 0.57 m RMS. That is beyond swissALTI3D's ±0.3 m. Mapterhorn would
  draw it over swissALTI3D, so the mask carves its footprint out.
- **IGN RGE ALTI 1 m (`frrgealti1metro`).** At Briançon IGN's own two products differ by 3.7 m
  (RGE ALTI vs LiDAR HD, mean over 16 points; partly photogrammetric in the mountains). Our tiles
  match LiDAR HD to 2 cm. Only LiDAR HD is served.

## The CI gate

`infra/tiles/worker/src/demValidation.test.ts` runs in `npm run check` and in the Worker CI job. It
reads `src/__fixtures__/dem/validation.json`: per site, a 32 × 32-px crop of the served tile
(Terrarium PNG) and the official values inside it. It decodes the crops with the Worker's own
Terrarium decoder and holds each site to these limits:

| Tool             | \|mean\| | RMS                         | max \|Δ\|        |
| ---------------- | -------- | --------------------------- | ---------------- |
| HRDEM WCS        | 0.15     | 0.35                        | 1.5 (resampling) |
| swisstopo height | 0.15     | 0.3 (< 2000 m), 1.0 (above) | 3σ               |
| IGN LiDAR HD     | 0.15     | 0.3                         | 3σ               |

The fixture must list exactly the sites in `nas/dem/validation-sites.json`, in both regions and
all three datums. To re-run after a Mapterhorn release or for a new region:

```sh
python3 infra/tiles/nas/dem/validate.py --report <scratch>/report.json \
  --fixtures infra/tiles/worker/src/__fixtures__/dem      # needs Pillow; ~1–2 min a site
npx prettier --write infra/tiles/worker/src/__fixtures__/dem/validation.json
```

Sites run again replace their entries, and the others are kept. A disagreement is a blocker: the
source goes back to `pendingValidation` until it is understood.
