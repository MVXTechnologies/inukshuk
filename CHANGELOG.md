# Changelog

All notable changes to Inukshuk are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Field updates (JS/asset-only) ship over-the-air via EAS Update to installed apps
on the same app version; native changes require a new store build. See
`docs/DEPLOYMENT.md`.

## [Unreleased]

### Fixed

- **Offline downloads no longer grab a much larger area than the drawn box.**
  Entering region-select flattened the camera _and_ read the map's visible bounds
  in the same tick, so the box was converted against the still-pitched/rotated
  camera — whose visible bounds run to the horizon and are far larger than the
  viewport rectangle — and the bounds were never recomputed once the flatten
  landed. The screen-rect → bounds conversion now lives in `src/core/geo/screenBounds.ts`
  (interpolating in web-mercator Y, not in latitude), only ever runs against
  bounds captured from a flat, north-up camera, and is re-derived from fresh
  bounds at the moment Download is tapped.
- **The relief basemap can be downloaded again.** Relief tiles (Esri
  `World_Topo_Map`) are only served to z15, but the pack was created with the
  quality zoom (z16 "High", z17 "Max") — above the raster source's `maxzoom` —
  so the relief layer failed while map (z19) and satellite (z17) succeeded. Each
  layer is now clamped to its source's native max zoom (`packZoomRange`), the
  clamp is reflected in the size estimate and shown in the sheet ("Relief tops
  out at z15"), and the pack metadata records the zoom it really stored. Failed
  downloads now name the layer and the reason (network, tile limit, invalid zoom
  range, stall) instead of "X failed to download".

- **Multi-page georeferenced PDFs no longer crash the app.** A projected `/GCS`
  (e.g. UTM) in an Adobe GEO viewport caused the geographic `GPTS` to be wrongly
  reprojected, collapsing every page to a degenerate point near the equator; the
  resulting zero-area image quad crashed MapLibre natively, and because the import
  was the active map it re-crashed on every launch. GPTS are now treated as
  geographic per ISO 32000-2, and overlays validate their corners (finite,
  in-range, non-degenerate) before reaching the native layer.
- **PDF overlays now actually render on Android.** Two further on-device blockers:
  the pdf.js offscreen rasterizer hung on the WebView's Blob worker (now uses
  `workerSrc` with a watchdog that falls back to the main-thread worker), and the
  rasterized page was handed to MapLibre as a `data:` URI, which crashed its
  native `ImageSource` (now written to a cache file and referenced by `file://`).

### Added

- **Per-page overlay selection.** A multi-page PDF now lists each georeferenced
  page in the Library with a checkbox; any combination of pages (across one or
  more PDFs) can be shown on the map at once. Overlapping overlays are allowed.

## [1.0.0] — 2026-06-16

First public release: an offline trail-navigation app built around your own
georeferenced PDF maps. Initial distribution to the Google Play **internal
testing** track (Android).

### Maps

- **Import georeferenced PDF maps** and overlay them, correctly aligned, on a
  live map. Georeferencing is read from, in order:
  - Adobe ISO-32000 geospatial dictionaries (`/VP`, `/Measure`, `/GEO`);
  - OGC **LGIDict** control points and neatlines;
  - sidecar **world files** (`.pgw` / `.pdfw`);
  - GDAL **`.aux.xml`** sidecars.
- **Coordinate-system reprojection** to WGS84 via proj4, so maps in regional
  projections line up with GPS.
- **Full-page overlay extrapolation** — when only the map frame carries
  georeferencing, the full page is affine-extrapolated so the whole sheet
  overlays.
- PDFs **without** any georeferencing still import as plain documents (flagged
  in the library), so nothing is lost.
- **OpenStreetMap base layer** (MapLibre raster tiles) underneath, with a
  configurable tile URL.
- Toggle the PDF overlay on/off from the map.

### Location & navigation

- **Live GPS position** on the map, foreground-only (no background tracking).
- **Follow-me camera** that keeps you centered.
- **Compass heading badge** from device sensors.

### Trail recording

- **Record trails** with a live heads-up display: elapsed time, distance,
  elevation gain/loss (D+/D-), speed, and max altitude.
- **Pause / resume / stop**, with the screen kept awake while recording
  (optional).
- **GPS-noise suppression** — elevation gain/loss uses a hysteresis filter so a
  flat walk doesn't accumulate phantom climb.
- Recordings are saved as standard **GPX 1.1**.

### Library

- Manage imported **maps**: set the active map, see georeferencing status,
  delete.
- Browse **recorded trails** with distance and elevation summary, **view a
  trail on the map**, **share its GPX**, or delete it.
- **Elevation profile** per trail — expand a trail to see an
  elevation-vs-distance graph, and touch-and-drag to read the elevation and
  distance at any point. _(Delivered to 1.0.0 devices via the first
  over-the-air update.)_

### Settings

- Keep the screen awake while recording.
- GPS point spacing (2 m / 5 m / 10 m) to trade detail for battery.
- Custom base-map tile URL (defaults to OpenStreetMap).
- Reset to defaults; about/version info.

### Privacy

- **Foreground-only location**, used solely to show your position and record
  trails. No background location, no accounts, no analytics, no data leaves the
  device except when you explicitly share a GPX file. Privacy policy bundled
  with the app.

### Under the hood

- Expo SDK 56 / React Native 0.85 / React 19 / TypeScript (strict).
- Pure, unit-tested core logic (georeferencing, GPX I/O, track math) behind a
  coverage gate; platform code kept thin.
- **Over-the-air updates** wired via EAS Update for JS/asset-only fixes.
- CI runs typecheck, lint (zero warnings), format check, and tests; release
  builds and store submission are automated through EAS.

[1.0.0]: https://github.com/marcandrevigneault/inukshuk/releases/tag/v1.0.0
