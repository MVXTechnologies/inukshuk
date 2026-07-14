# Architecture

## Layering

The guiding rule: **all the hard logic is pure and unit-tested; platform code is
a thin shell around it.**

- `src/core/**` — zero React Native / Expo imports (mechanically enforced by an
  eslint `no-restricted-imports` boundary). Pure functions and types. This is
  where georeferencing, GPX, track math, terrain/tile math, and the library
  domain logic (bundles, folders, notes) live, and where the test coverage gate
  is enforced (80% lines). Runs identically in Node (Jest) and on device.
- `src/data/**` — persistence via `expo-file-system`, plus the MapLibre offline
  pack manager (`offline.ts`). The only place that touches the filesystem.
- `src/state/**` — Zustand stores. They orchestrate `core` + `data`; they hold
  no business math themselves.
- `src/features/**` — screens and hooks. Composition and platform APIs
  (location, sensors, WebView, expo-gl).
- `src/ui/**`, `src/lib/**` — theme, shared components, formatting.
- `app/**` — expo-router routes only; each file just renders a feature screen.
  `+native-intent.tsx` intercepts "Open with" file intents (GPX import) before
  routing.

Path aliases (`@core`, `@data`, `@features`, `@state`, `@ui`, `@lib`, `@/`) are
declared once in `tsconfig.json` and mirrored in `jest.config.js`.

## The georeferenced-PDF pipeline

This is the most novel part. Getting a PDF onto the map at the right place takes
four stages:

1. **Parse georeferencing** (`core/geo/geopdf`, pure TS). On import we read the
   PDF bytes and extract whichever georeferencing is present:
   - Adobe ISO 32000 `/VP` → `/Measure /GEO` (GPTS in lat/lon, a GCS/EPSG/WKT),
   - OGC/TerraGo `/LGIDict` (registration control points + neatline), or
   - a sidecar world file / GDAL `.aux.xml`.
     The source CRS is reprojected to WGS84 with **proj4**. The result is one
     `GeoReference` per georeferenced page: the map-frame rectangle in PDF
     points (`viewport.rect`) and its geographic corners (`viewport.corners`).
     A `MapDocument` stores `georeferences[]` plus `activePages[]` (which pages
     are currently shown as overlays). The hand-written PDF reader is hardened
     against hostile input (clamped xref counts, bounded FlateDecode output).

2. **Rasterize the page** (`features/map/PdfRasterizer`). A hidden offscreen
   WebView runs **bundled pdf.js** (no network, `isEvalSupported: false`) to
   render the page to a PNG, and reports the page size in points. Requests are
   queued and chunked so multi-MB PDFs cross the bridge safely, with a watchdog
   that falls back to pdf.js's main-thread fake worker if the real one wedges.

3. **Extrapolate full-page corners** (`core/geo/geomath`). The georeferencing
   often describes only the inner map frame, but we render the _whole_ page. We
   fit a 2D affine transform from the viewport's four (page-point → geographic)
   corner correspondences and evaluate it at the full page rectangle. This
   yields the geographic corners of the rendered image even with rotation/skew.

4. **Overlay** (`MapScreen`). The PNG is written to a cache **file** (Android's
   MapLibre `ImageSource` cannot consume a `data:` URI — it crashes) and the
   `file://` URL goes into an `ImageSource` at those four corners; OSM raster
   tiles render underneath, so anywhere the PDF doesn't cover is still mapped.

## Recording & track math

- A single `expo-location` watch drives both the live marker and the recorder.
  The recorder store ignores incoming fixes unless its status is `recording`.
- Live HUD stats use a cheap incremental fold (`reduceStatsWith`); the
  authoritative stats saved to GPX are recomputed over the full point list
  (`computeTrackStats`). Elapsed time excludes paused wall time (`pausedMs`).
- **D+ / D-** uses hysteresis (default 3 m threshold) so GPS altitude noise on
  flat ground doesn't inflate elevation gain — the number hikers actually expect.
- Tracks persist as standard GPX 1.1 in the document directory; the library
  index (`library.json`) keeps lightweight summaries and loads points on demand.
- Waypoints dropped during recording become distance-anchored trail notes
  (optionally with photos) on the saved track.

## Offline maps

- 2D basemap tiles for a user-drawn region are downloaded into MapLibre
  offline packs (`data/offline.ts` → `OfflineManager.createPack`). MapLibre's
  downloader only accepts an **http(s) style URL**, so the style JSON is served
  from a transient loopback HTTP server for the duration of the download. A
  stall watchdog rejects if progress stops (MapLibre can hang without erroring).
- "Locally downloaded only" flips MapLibre's `NetworkManager.setConnected` so
  only cached/pack tiles are served. (Known gap: the 3D DEM/texture fetches
  bypass this — see docs/CODE-REVIEW-2026-07-02.md.)

## 3D terrain

- Elevation comes from free Terrarium DEM tiles; drape textures from Esri tile
  services (`features/map/dem.ts`, tile math in `core/geo/terrain.ts` — tile
  ranges are budget-clamped so huge track bboxes can't OOM). The mesh is built
  in `features/map/terrainScene.ts` (three r162 — expo-gl is WebGL 1; never
  bump three past r162).
- Two GL screens share that plumbing: `Trail3DGLScreen` (per-trail view,
  reachable from the Library) and `Terrain3DLiveView` (live main-map 3D,
  currently gated off behind the `terrain3d` flag). Render loops carry a GL
  "generation" and dispose their scene when the GLView remounts.

## Error reporting ("no silent fails")

- Capture: a chained `ErrorUtils` global handler (fatal + non-fatal), Hermes'
  unhandled-promise-rejection tracker, a top-level error boundary around the
  router root, and explicit `reportError(err, context)` calls from catch blocks
  that would otherwise swallow user-facing failures.
- Queue: reports persist to `error-reports.json` (same atomic write path as the
  other documents) so errors captured offline on a hike survive restarts. Pure
  logic — fingerprinting, dedupe/merge, rate limiting, issue formatting — lives
  in `src/core/errors/`; the platform glue in `src/lib/errorReporting` +
  `src/data/errorQueue.ts`.
- Delivery: flushed on launch / foreground / capture to GitHub issues on this
  repo, deduped by a fingerprint marker in the issue title (repeats become a
  "Seen again" comment) and rate-limited client-side. The API token comes from
  `extra.errorReportToken` (`ERROR_REPORT_TOKEN` EAS secret, a fine-grained
  Issues-only PAT); without one, the user is asked to open a pre-filled
  `issues/new` URL. Users can opt out in Settings → Privacy.

## State & persistence

| Store                 | Persisted?            | Holds                                                                                                             |
| --------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `libraryStore`        | yes (`library.json`)  | maps (georeferences + active pages), track summaries + notes, bundles, folders, active map, active trail overlays |
| `settingsStore`       | yes (`settings.json`) | tile URL, keep-awake, point spacing, offline-only, view prefs, error-reporting opt-out                            |
| `recorderStore`       | no (transient)        | live recording state + points + stats + pending waypoints                                                         |
| `mapStore`            | no (transient)        | follow-user, overlay visibility toggles, basemap, terrain3d flag, focus bounds                                    |
| `offlineStore`        | no (native packs)     | offline region list + download progress (packs live in MapLibre)                                                  |
| `importFeedbackStore` | no (transient)        | cross-screen import result snackbar message                                                                       |

Stores hydrate from disk on app start in `app/_layout.tsx`. `libraryStore`'s
hydration is single-flight and `persist()` refuses to write before hydration
(a cold-start "Open with" import must not clobber the index). JSON documents
are written atomically (staged `.tmp` + swap); a corrupt index is preserved as
`.corrupt` instead of being silently reset. Both persisted documents carry a
`schemaVersion` and every load routes through the migration ladder in
`src/core/library/migrations.ts` (legacy unversioned files are treated as v1
and normalized; migrators are total and never throw on junk).
