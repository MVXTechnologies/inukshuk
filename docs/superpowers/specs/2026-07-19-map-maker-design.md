# Map Maker ("Make a map") — 1.4.0 design

CalTopo-style custom map export: pick a region and layers on the live map,
and the app composes a **georeferenced PDF** that drops into the Library's
imported PDFs — activatable offline with live position tracking, exactly like
any GeoPDF imported from outside. The app already knows how to _read_
georeferenced PDFs; this teaches it to _write_ them.

## Decisions (user-approved 2026-07-19)

- **Content**: chosen basemap (map / satellite / relief) + contour lines
  (interval selector) + slope shading (current range window) + the user's
  saved **tracks and waypoints** that fall inside the region. No freehand
  drawing tools in 1.4.0 (candidate for 1.5).
- **Layout**: full-page map with a margin strip — title, scale bar, contour
  interval, north arrow, generation date. Classic printed-topo look.
- **Destination**: the file auto-imports into the Library (Ungrouped, page
  active) and can also be shared/printed from there like any PDF.

## User flow

1. "+" dial gains **Make a map** (`map-plus` icon), available while idle.
2. Region select — same drag-box idiom as the offline download (reused
   component, different confirm strip: _Next_ instead of _Download_).
3. Options sheet: map name (default from region geocode, like offline
   regions), basemap picker, contours toggle + interval, slope toggle,
   "Include my tracks & waypoints" toggle, page format (A4 / Letter;
   orientation auto-follows the region's aspect).
4. Progress (determinate: tiles → compose → write) with cancel. On success:
   snackbar "Map saved to Library" + _View_ action.

## Architecture

New pure logic lives in `src/core` with co-located tests; platform glue in
`src/features/map/mapmaker/`.

- `src/core/mapmaker/layout.ts` — page geometry. Given page size, margins and
  region bbox: the map rect (pt), the print scale (round to a clean 1:N),
  scale-bar tick lengths, and the raster zoom level needed for ~200 dpi
  (long-edge raster cap ~4096 px, memory ≤ ~64 MB RGBA).
- `src/core/mapmaker/pageSpace.ts` — WebMercator → page-point transform;
  projects contour GeoJSON, track polylines and waypoint positions into page
  coordinates for vector drawing.
- `src/core/geo/geopdf/write.ts` — Adobe GeoPDF dictionaries (/VP viewport +
  /Measure /GEO with GPTS/LPTS) for the map rect. **Round-trip tested against
  our own `parseGeoPdf`** — the parser is the acceptance test.
- Composition (feature layer, `pdf-lib` — pure-JS dep, OTA-able):
  basemap raster embedded as the base image; slope RGBA (existing
  `slopeOverlayRgba`) as a second translucent image; contours
  (existing `contourFeatures`), tracks and waypoint pins drawn as **vector**
  paths/circles/text on top — crisp at any print zoom; margin strip drawn
  with pdf-lib text + graphics.
- Tiles: reuse the offline downloader's tile fetch (cache-first, so a region
  you've downloaded composes fully offline); stitch decoded tiles (UPNG) into
  one raster in core (`stitchTiles.ts`, pure, tested).
- Import: write the PDF to a temp file → existing `storage.importPdf` +
  the normal GeoPDF import pipeline resolves georeferencing → `MapDocument`
  added with `activePages: [0]`. No special-case "generated map" type — a
  made map IS an imported PDF (delete/rename/folders all just work).

## Generation pipeline & perf

Same cooperative pattern as the 2D overlays: yield checkpoints between tile
batches, stitch, slope compute, contour extraction and PDF write; cancel
bails at the next checkpoint. Disk preflight via the existing `diskBudget`.
Tile count for generation is bounded by the raster cap (≤ ~400 tiles), far
below the offline-download cap — no policy concerns.

## Error handling

- Offline with uncached tiles → "You're offline and this area isn't
  downloaded" (compose proceeds if the cache can satisfy it).
- Region too large for the dpi floor → auto-step to the achievable scale and
  say so in the options sheet (never a dead-end error).
- Import/georeference failure of our own file is a bug: report through the
  error-reporting queue with the compose parameters, and keep the PDF in
  share-only mode so the user still gets their map.

## Testing

- Core units: layout math (scales, rasters, margins), mercator→page
  transforms, tile stitching, GPTS write→`parseGeoPdf` round-trip.
- E2E (both platforms): make a small Standard map over the fixture area,
  assert the progress completes, the Library shows the new PDF entry, and
  activating it renders an overlay (map-overlays-style crash checks).

## Out of scope for 1.4.0

Freehand drawing/labels, multi-page atlases, UTM grid overlay, custom
declination, re-editing a made map's recipe (the options are not persisted
per-map yet).
