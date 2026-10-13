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
  (location, sensors, WebView, expo-gl for the parked wind-particle overlay).
- `src/ui/**`, `src/lib/**` — theme, shared components, native-only glue
  (background location, Strava, error reporting). Value formatting is pure and
  lives in `@core/format`; `src/state/formatters.ts` binds it to the user's
  chosen units.
- `app/**` — expo-router routes only; each file just renders a feature screen.
  `+native-intent.tsx` intercepts "Open with" file intents (GPX, FIT / TCX /
  gzip / zip activity exports, and PDF maps, all sniffed by content —
  `core/import/openedFile`) before routing.

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
     points (`viewport.rect`), its geographic corners (`viewport.corners`),
     and the page's **rendered box** (`pageBox` — CropBox ∩ MediaBox, with its
     origin, in the same user space; `core/geo/geopdf/pageBox.ts`). That last
     one is what every renderer actually draws, and it is not always a
     zero-origin MediaBox (#287). A `MapDocument` stores `georeferences[]`
     plus `activePages[]` (which pages are currently shown as overlays). The hand-written PDF reader is hardened
     against hostile input (clamped xref counts, bounded FlateDecode output).

2. **Rasterize the page** (`features/map/PdfRasterizer`). A hidden offscreen
   WebView runs **bundled pdf.js 6** (ES modules, no eval; the page's CSP forbids it) to render the
   page to a PNG, and reports the page size in points. The page and the PDF
   are both served from the app's loopback server (`data/localServer.ts`,
   root = the document directory) so pdf.js range-fetches only the bytes the
   page needs — nothing crossing the bridge scales with file size, which is
   what let 50–200 MB GeoPDFs render at all (#269). PDF layers (optional
   content) are resolved per render: document defaults plus aerial imagery
   off (`core/geo/pdfLayers`), and the bundled worker is patched
   (`core/geo/pdfWorkerPatch`) to skip hidden images and forms instead of
   decoding them. That hidden decoding was ~80 % of a US Topo sheet's render
   (#477). "See-through white" (#489, `core/geo/pdfWhiteKey`) is one more
   pass in the same page: after pdf.js paints, near-white, near-neutral
   pixels are keyed to transparency (colour-to-alpha, so text edges get no
   halo) at a 5-stop strength (Off, 25–100 %) chosen globally on the Overlays
   menu slider or per map; the
   level is part of the raster's cache name. A detail tile a native renderer
   drew is keyed by the same page afterwards (`__pdfKeyImage`), so a keyed
   map keeps its native tiles. If the server cannot
   start, PDFs under 16 MB fall back to the old base64-over-the-bridge path;
   bigger ones fail with a message instead of hanging. Requests are queued,
   with a watchdog that falls back to pdf.js's main-thread fake worker if the
   real one wedges. Each page's outcome is published to `overlayStatusStore`
   and shown on its Library card ("Rendering page N…" / "Couldn't render page
   N: …"). Right after an import (picker, store, map maker) every active
   georeferenced page is also pre-rendered in the background at the lowest
   queue priority (`features/map/usePrerenderOnImport` over
   `core/library/prerenderQueue`, #272 step 2) into the same cache file, so
   the map tab usually finds the raster already on disk; the card says
   "Preparing page N…" meanwhile.

3. **Extrapolate full-page corners** (`core/geo/geopdf/pageBox` over
   `core/geo/geomath`). The georeferencing often describes only the inner map
   frame, but we render the _whole_ rendered page box. We fit a 2D affine
   transform from the viewport's four (page-point → geographic) corner
   correspondences and evaluate it at that box (`renderedPageCorners`). This
   yields the geographic corners of the rendered image even with
   rotation/skew, and — because the box carries its origin — for cropped or
   shifted pages too. Detail tiles subdivide the same image, and the native
   crop renderers (Android `PdfRenderer`, iOS JPEG/mosaic) are only offered a
   page whose rendered box is a zero-origin MediaBox (`nativePageGeometry`);
   everything else stays on pdf.js. Maps imported before the box was recorded
   keep the old zero-origin placement and are flagged by
   `needsPageBoxReprocessing` until re-imported.

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
- **A pause is a segment boundary** (`core/geo/track/segments.ts`). The
  recorder keeps its completed pauses; a resume opens a new segment, and
  nothing bridges a pause — not distance, moving time, D±, the map trace
  (one `MultiLineString` part per segment) nor the GPX (one `<trkseg>` per
  segment). Background-journaled fixes stamped inside a pause are dropped.
  The crash checkpoint stores the pauses and the in-flight pause's start
  (`pausedAt`), so a phone killed while paused and reopened an hour later
  resumes _that_ pause instead of counting the hour as active time; a
  checkpoint that died while recording stops the clock at its last evidence
  of life (checkpoint write or newest fix, including fixes the OS task kept
  journaling).
- **D+ / D-** uses hysteresis (default 3 m threshold) so GPS altitude noise on
  flat ground doesn't inflate elevation gain — the number hikers actually expect.
- Tracks persist as standard GPX 1.1 in the document directory; the library
  index (`library.json`) keeps lightweight summaries and loads points on demand.
- **Screen-off recording & permissions** (`lib/backgroundLocation.ts`). The
  OS task (`startLocationUpdatesAsync`) is started while the app is in front.
  Android runs it as a foreground service. "Allow all the time" is
  recommended, with a rationale, but it is not required. iOS sets
  `allowsBackgroundLocationUpdates` under `UIBackgroundModes: [location]`, so
  **"While Using the App" is enough and the app never asks for "Always"**.
  That choice avoids an alarming prompt and App Review friction for no gain.
- **Recording check** (`core/recording/recordingReadiness.ts`,
  `features/recording`). It shows precise location, screen-off recording
  (Android), battery restrictions (Android; these can't be read without a
  native module, so the row is advice) and notifications (Android 13+). Each
  row has a one-tap fix. iOS precise location is fixed only through Settings,
  because expo-location 56 has no temporary-full-accuracy API. The check opens
  before the first recording, on any start where a row reports a problem, and
  from Settings. It is an inline overlay, never a Portal.
- **Recording health** (`core/geo/track/recordingHealth.ts`). The recorder
  counts the fixes it drops for an approximate-location accuracy (≥ 500 m).
  The session tracks its screen-off spells. A silent span in which the user
  moved ≥ 150 m over ≥ 90 s is a gap. Mostly-background gaps (≥ 2 min in total)
  mean GPS stopped with the screen off. That, or approximate location, opens
  the Recording check with a one-line explanation, both mid-recording (after
  the screen comes back on) and after Stop.
- Waypoints dropped during recording become distance-anchored trail notes
  (optionally with photos) on the saved track. Waypoints dropped outside a
  recording (map "+" speed-dial) are standalone: they keep their coordinate
  and persist in the library index (`waypoints`).

## Activity-file import (Strava / Garmin exports)

`core/geo/activityFiles` imports FIT (own decoder in `core/geo/fit`), TCX
(`core/geo/tcx`) and GPX files — gzipped or not, loose or in zip archives,
including Garmin's zips-inside-zips — and every activity is stored as GPX
through the same pipeline as a GPX import. Archives are read through a
random-access ZIP reader (central directory first, one entry inflated at a
time, nested zips spilled to the cache), so a multi-GB export is never held
in memory; decompression caps (`limits.ts`) are enforced on the bytes actually
inflated. Activities with the same start (±60 s) and distance (±2 %) as a
library track are skipped as duplicates. `features/library/importActivities`
is the file-system shell (picker, "Open with", UI yielding).

## Connected-source import (Strava, Apple Health / Health Connect)

Every connected source implements one contract (`core/import/sources`):
list cheaply (start, distance, name, "has a route" — no GPS), then fetch
routes one by one. `core/import/plan` drops what is already in the Library
(same source + activity id, or same start ±60 s and distance ±2 %) and what
has no route before anything is fetched; imported trails carry their
`origin` in the library index (schema v10), which drives the source mark,
the "From Strava" chip, and "delete what came from Strava" on disconnect.
`features/import/runSourceImport` is the loop (batched Library writes, the
job persisted right after each batch); `importController` owns the one
running job (`state/importStore`, `imports.json`). Strava's read limits are
handled in `lib/stravaSource`: a spent 15-minute window is waited out in
place, a spent daily budget pauses the job until midnight UTC. A paused or
interrupted job resumes by re-listing — planning makes that idempotent.
Health imports run in the foreground only (paused on background). Strava
auto-import (`features/import/autoImport`, rules in `core/import/auto`)
quietly imports "since last import" on launch/foreground at most every
15 minutes, once a first import was made by hand.

## Offline maps

- 2D basemap tiles for a user-drawn region are downloaded into MapLibre
  offline packs (`data/offline.ts` → `OfflineManager.createPack`). MapLibre's
  downloader only accepts an **http(s) style URL**, so the style JSON is served
  from the app's shared loopback HTTP server (`data/localServer.ts`, one
  ref-counted instance — the native library allows a single server per app —
  also used by the PDF rasterizer) for the duration of the download. A
  stall watchdog rejects if progress stops (MapLibre can hang without erroring).
- "Locally downloaded only" flips MapLibre's `NetworkManager.setConnected` so
  only cached/pack tiles are served. (Known gap: the DEM fetches
  bypass this — see the 2026-07-02 code review, archived on the
  `archive/docs-2026-10` branch.) The live style also caps
  the raster source's `maxzoom` at the packs' top stored zoom (recorded in
  pack metadata; legacy packs assume z15) so zooming deeper overscales the
  deepest downloaded tiles instead of going blank, and draws an opaque
  theme-matched mask over everything outside the downloaded regions
  (`core/geo/downloadedMask.ts` — a world polygon with disjoint holes).
- Raster sources always cap `maxzoom` at each service's real-data zoom
  (OSM z19, Esri imagery z17, Esri topo z15 — see `NATIVE_MAX_ZOOM` in
  `features/map/mapStyle.ts`): Esri serves HTTP-200 "Map data not yet
  available" placeholder tiles past its data, so without the cap MapLibre
  renders grey placeholders instead of overscaling real tiles.

## Map extensions (Settings → Extensions)

Layers the user installs on purpose (Geodetic points, Tide stations, …) are
one registry, not hand-wired screens (architecture review P1-3):

- **Pure half**, `src/core/extensions/`: `keys.ts` (every key, in draw
  order), one `ExtensionDescriptor` per extension in `descriptors/` (label,
  dataset, default switches, style builder, offline-pack policy, credit
  line), `registry.ts`, `state.ts` (installed / shown / pack rules) and
  `prefs.ts` (the persisted `extensions` entry of settings.json and its
  migration from the pre-registry flat keys).
- **Platform half**, `src/features/extensions/`, one registry per surface
  so each loads only what it shows: `settingsModules.ts` (the Settings entry
  in the shared `ExtensionSettingsShell`, and the install / remove / offline
  hooks), `panelEntries.ts` (its row in Map overlays › Extensions) and
  `mapModules.ts` (style extras, symbol images, tap → card; MapScreen's
  `mapHost` iterates it). `actions.ts` is the one Get / Remove / Offline
  lifecycle; `companions.ts` the companion packs for regions downloaded
  before an install.
- Tile data: the descriptor names a `DatasetId`; `data/datasets.ts` maps it
  to its tile template (still the frozen constants of `data/basemapTiles.ts`,
  pinned by `tileUrls.contract.test.ts`) and its TileJSON.
- `buildOsmStyle`, offline pack styles, credits, Settings, the overlays panel
  and the map's tap / card host all iterate the registry.
- Persistence: `settings.extensions[key] = { installedAt, show, offline }`.
  Geodetic and tides also keep writing their old flat keys
  (`legacySettings`), so a build from before the registry reads the same
  state after an OTA rollback.

### Adding an extension

1. Add its key to `EXTENSION_KEYS` (`core/extensions/keys.ts`) at its draw
   position, and its archive to `DatasetId` + `data/datasets.ts`.
2. Write `core/extensions/descriptors/<key>.ts` (its style builder goes in
   `core/map/<key>Style.ts` with its tests) and register it in
   `core/extensions/registry.ts`. No `legacySettings`: its state lives in
   `extensions[key]`, migrated for free. Its **`summary`** (required) is the
   one line its collapsed Settings row and its overlays row show: sentence
   case, no full stop, at most `EXTENSION_SUMMARY_MAX` (32) characters, e.g.
   "Survey marks and benchmarks" (`registry.test.ts` checks it).
   `summary`, `label` and `teaser` come from `ExtensionIdentity`, which every
   extension descriptor type extends (`ExtensionDescriptor`,
   `DeviceExtensionDescriptor`), so an extension without a summary does not
   type-check.
3. Write its components under `features/extensions/<key>/` — a Settings body
   in `ExtensionSettingsShell`, a panel row and, if it has a map card, a map
   module — and add one line to each surface registry it uses. The shell
   draws the entry as one row (badge, name, summary, optional short
   `status` such as "Offline ✓", and Get or its switch) that expands inline
   to its details: description, legend, the extension's own rows
   (`children`) and Remove; one entry open at a time, nothing persisted
   (`features/extensions/expansion`). Its overlays row is one line too
   (`SwitchRow` with the summary as hint, no legend underneath). To link to
   its details from elsewhere, push `extensionSettingsHref(key)`
   (`/settings?open=extensions&ext=<key>`), which opens it expanded.
4. Pick its offline policy (`'installed'` for a few kB a region, `'opt-in'`
   with companion packs for more), then run `extensionStyles.pin.test.ts`:
   the existing extensions' hashes must not move.

An extension that adds a device or a tool rather than a map layer (the GNSS
receiver) is a **device extension**: its key goes in `DEVICE_EXTENSION_KEYS`,
its `DeviceExtensionDescriptor` (label, teaser, default switches — no dataset,
style or packs) in `DEVICE_EXTENSIONS`, its availability check in
`features/extensions/availability.ts` (`DEVICE_AVAILABLE`), and its Settings
module in `settingsModules.ts`. It gets the same Get / switch / Remove shell
(`switchDescription` says what its switch does) and the same persisted
`extensions[key]` entry; Settings lists it after the map extensions. Its
`show` is its on/off switch.

## Long-distance trails (Explore)

Explore's "Long-distance trails near you" (#467) comes from OpenStreetMap
route relations (hiking, cycling, ski and canoe routes on international,
national or regional networks, their superroutes, and long local routes),
built monthly on the NAS by `infra/tiles/nas/trails.sh` and served by the tile
Worker: a compact **index** (`/trails/v1/index.json`, every trail with a
~40-point thumbnail line, cached on the device for a week) and one **detail**
per trail (`/trails/v1/d/{version}/{id}.json`: geometry simplified at 10 m,
stages, operator/website), fetched when a trail page opens and kept. Until the
index is reachable the section simply isn't there (`@data/longTrails`,
`state/longTrailsStore`).

The logic is `src/core/trails`: parsing, the near-you ranking (popularity ×
proximity — formula in `rank.ts`, popularity in the build script), grouping by
country/continent, stage selection, the topo sheets a trail crosses
(`catalogAlong`), the climb from our DEM tiles (`climb`, computed on the trail
page — never estimated), and the **corridor download**, stage by stage (#472): the stage cut into
≤ 20 km chunks, each chunk's box grown by 3 km, one MapLibre pack per box
through the region downloader (`offlineStore.downloadSeries`). "Show on map"
puts the trail on the main map (`features/map/longTrail`: halo + orange line,
selected stage, a name pill and a stage sheet); the Library's trails and the
map's own overlays are unaffected. It replaced the old Waymarked Trails raster
overlay ("Marked trails"), whose persisted setting is dropped on hydration.

## Terrain

- Elevation comes from free Terrarium DEM tiles (`features/map/dem.ts`, tile
  math in `core/geo/terrain.ts` — tile ranges are budget-clamped so huge track
  bboxes can't OOM). It feeds the 2D slope/contour overlays
  (`useTerrainOverlays2D`), the map maker's relief, and the trail view's
  terrain-sampled elevation profile.
- Relief on the maps is MapLibre's own: the hillshade layer, plus the "3D
  relief" setting that deepens it when the map is tilted with two fingers
  (`hooks/useTiltRelief`). There is no three.js / GL terrain renderer any more;
  the focused trail view (`Trail3DGLScreen`, route `/trail3d/[id]` — name kept
  for deep links) is the 2D MapLibre map.
- **Native 3D terrain** (store builds with `modules/inukshuk-terrain`; design in
  `docs/plans/native-terrain.md`): with "3D relief" on, tilting the main map
  past ~25° crossfades into a true 3D scene, up to an 80° pitch. A MapLibre
  custom layer on top of the style draws its own world in MapLibre's render
  pass (Android GLES, iOS Metal): the terrain shaded in the theme's palette
  (or satellite imagery tiles), contour lines evaluated on the 3D surface,
  trails lifted onto it, 3D pin labels read from the loaded vector tiles, and
  the location marker. The math is `core/terrain3d` (TS reference, Jest) and
  its C++ twin `modules/inukshuk-terrain/cpp` (parity tests in
  `tests/run.sh`); JS only attaches/updates/detaches and sends trails and the
  fix on change (`hooks/useNativeTerrain`). Binaries without the module keep
  the 2D tilt relief. QA builds (`EXPO_PUBLIC_TERRAIN_QA=1`) add a
  deep-link/file harness (`hooks/useTerrainQa`) for screenshots and the
  gesture benchmark.

## Convert (coordinates, heights, epochs, chart datum)

Field operators rely on it, so **PROJ never chooses an operation**:

- `core/convert/graph.ts` plans a conversion as ONE pinned PROJ pipeline made
  only of steps (`steps.ts`) copied from pipelines validated against the
  defining agency's own tool, or returns a typed refusal (unvalidated pair,
  outside a region/zone/grid, missing grid, needs an epoch or a height…).
  Systems with no official-tool validation are not in the catalogue
  (`systems.ts`, `HIDDEN_SYSTEMS`).
- The reference suite (`core/convert/fixtures/reference.json`, from
  `scripts/convert-fixtures.py`) is the gate: Jest checks the planner emits
  exactly the validated pipelines and `lite.ts` reproduces the grid-free
  pairs; the same suite runs through the real engine on the build machine
  (`npm run proj:test-host GRID_DIR`) and on a simulator / emulator
  (`scripts/convert-native-suite.sh`, via the inert `convert-selftest` route).
- Engine: `modules/inukshuk-proj` — PROJ 9.8.1 + libtiff (+ SQLite on
  Android) static libs built from pinned sources (`scripts/prepare.sh`), a
  C++ facade shared by iOS and Android, proj.db + EGM96 + the NAD83(CSRS) v7
  velocity grid bundled. Store-release only; on an older runtime Convert
  falls back to `lite.ts` (proj4js, grid-free only).
- Grids come in packs (`infra/tiles/nas/projgrids.sh`: exact pixel-window
  crops per province/state/country, gated on the suite), served at
  `/proj-grids/*` and kept in `Documents/proj-grids/<pack>/`
  (`data/projGrids.ts`). Each conversion runs on the absolute path of the
  crop that covers the point (`core/convert/packs.ts`).
- UI: `features/convert` (route `app/convert.tsx`); entry points share
  `openConvert` + the `core/convert/prefill` builders (map chip, geodetic and
  tide cards, map-actions row, deep link).

## External GNSS receivers (#588)

- Stage 1 (pure core, `core/gnss`): NMEA / UBX / RTCM 3 framing over
  arbitrary byte chunks (`stream.ts`, fuzz-tested), fix assembly, the quality
  state machine and the phone-GPS standby policy (`quality.ts`), the NTRIP
  v1/v2 protocol (`ntrip.ts`, `sourcetable.ts`) and the output datum
  (`datum.ts`), which plans every datum change through `core/convert` and is
  gated by official-tool vectors (`fixtures/datum-vectors.json`, also run on
  the host PROJ). Module boundaries for the native transport and the UI:
  `src/core/gnss/README.md`.
- Stage 2 transport: `modules/inukshuk-gnss` — a Bluetooth byte pipe and nothing
  else (Android: Classic SPP to bonded receivers + BLE GATT; iOS: BLE with
  state restoration; a test-only simulated receiver). Design, permissions and
  store obligations: `modules/inukshuk-gnss/README.md`.
- JS: `lib/gnss/nativeGnss.ts` (typed, optional module: null on binaries
  before 2.5.0), `core/gnss/bleProfiles.ts` (the serial GATT profiles, sent on
  every connect), `data/gnss/receiverStream.ts` (native chunks → the
  `@core/gnss` demuxer). Parsing, fixes, NTRIP and datums are `core/gnss`.
- Stage 3 (UI and wiring, #623): a free **device extension** `gnss`
  (Settings → Extensions, `features/extensions/gnss`: pairing, NTRIP profile
  editor with the sourcetable browser, project datum, phone-GPS policy;
  routes `app/gnss/*`). `features/gnss/session.ts` is the one place the
  receiver is driven: the native module (`data/gnss/link.ts`; connects through
  `connectOptions()`, devices ordered by `rankDevices()`) → `receiverStream`
  into the pipeline's demuxer (a discontinuity flushes the assembler; a 1 s
  tick runs `nextStatus`) → `core/gnss/receiver.ts` (pipeline, `arbitrate` =
  `decideSource` + "no fallback", the RAM-only u-blox kit setup written after
  connecting a kit) → `state/gnssStore.ts`. The module's simulated receiver
  (`GNSS_FAKE_DEVICE=1`, E2E) is fed the core's Québec RTK session;
  `simulatedLink.ts` stands in where there is no module (Jest, web).
  While the receiver is the source: `useLocationTracking` returns its fix
  (≤ 1 Hz) and idles the phone watch (`Accuracy.Low`, or none), the puck is
  drawn on it (`UserPuck`, MapLibre's own listener unmounted) and followed by
  `ReceiverFollow`, the recorder takes its fixes (`trackPointFromFix`:
  `source: 'external'`, `gnss`, the receiver's 95 % accuracy) and refuses the
  phone's (`phoneFeedsRecorder`, also in the background task). A source change
  starts a segment (`core/geo/track/segments`); GPX carries `<src>`, `<fix>`,
  `<sat>`, `<hdop>`, `<ageofdgpsdata>` and `inukshuk:gnss`. The map dot is the
  fix moved to WGS 84 by `core/gnss/output.ts` (Convert's validated plans;
  refused → drawn as received, the sheet says why). NTRIP: `features/gnss/
ntripClient.ts` over `data/gnss/ntripSocket.ts` (the module's `openTcp` /
  `writeTcp` / `closeTcp`; RTCM to the receiver with `write`). Passwords and
  Strava tokens: `data/secureStore.ts` (Keychain / Keystore). A project datum
  whose grid isn't installed offers Convert's pack download (`GridDownload`).

## Team mode (#589)

- Pure protocol: `core/team` (docs/design/team-protocol.md); pure view logic
  for the screens: `core/teamui`.
- Transport: `modules/inukshuk-mesh` + `data/team/mesh*` (docs/design/team-mesh.md).
- App: `data/team/teamService.ts` (device identity, teams, join),
  `teamSession.ts` (one open team), `persistingStore.ts` (write-ahead op log),
  `state/teamStore.ts`, `features/team/*` (a device extension; `TeamHost` runs
  the mesh lifecycle). Decisions and the test plan: docs/design/team-ui.md.

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
- Delivery: flushed on launch / foreground / capture, deduped by a fingerprint
  marker in the issue title (repeats become a "Seen again" comment) and
  rate-limited client-side (5/day). Two channels, endpoint first:
  `extra.errorReportEndpoint` (POST to a relay that holds the token server-side)
  or `extra.errorReportToken` (a fine-grained Issues-only PAT baked into the
  binary — see docs/DEPLOYMENT.md § Error reporting). Transient failures
  (offline, 5xx, 429) back off exponentially, 30 s → 1 h; a report the API
  refuses outright (422) is dropped rather than left as a poison pill.
- **Fully silent.** The reporter never renders anything: no dialog, no banner,
  no "open a GitHub issue" prompt. With no channel configured (local dev, forks)
  reports just wait on disk. The only user-visible surfaces are the Settings →
  Privacy opt-out toggle (on by default) and, next to it, a developer-facing
  queue/"send now" diagnostics row.

## State & persistence

| Store                 | Persisted?            | Holds                                                                                                                                                      |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libraryStore`        | yes (`library.json`)  | maps (georeferences + active pages), track summaries + notes + activity categories, custom categories, bundles, folders, active map, active trail overlays |
| `settingsStore`       | yes (`settings.json`) | tile URL, keep-awake, point spacing, offline-only, view prefs, error-reporting opt-out                                                                     |
| `recorderStore`       | no (transient)        | live recording state + points + stats + pending waypoints                                                                                                  |
| `mapStore`            | no (transient)        | follow-user, overlay visibility toggles, basemap, focus bounds                                                                                             |
| `offlineStore`        | no (native packs)     | offline region list + download progress (packs live in MapLibre)                                                                                           |
| `importFeedbackStore` | no (transient)        | cross-screen import result snackbar message                                                                                                                |
| `longTrailsStore`     | no (files cached)     | long-distance trail index, opened trail details, the trail shown on the map and its selected stage                                                         |
| Store                 | Persisted?            | Holds                                                                                                                                                      |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------                    |
| `libraryStore`        | yes (`library.json`)  | maps (georeferences + active pages), track summaries + notes, bundles, folders, standalone waypoints, active map, active trail overlays                    |
| `settingsStore`       | yes (`settings.json`) | tile URL, keep-awake, point spacing, offline-only, view prefs, error-reporting opt-out                                                                     |
| `recorderStore`       | no (transient)        | live recording state + points + stats + pending waypoints                                                                                                  |
| `mapStore`            | no (transient)        | follow-user, overlay visibility toggles, basemap, focus bounds                                                                                             |
| `offlineStore`        | no (native packs)     | offline region list + download progress (packs live in MapLibre)                                                                                           |
| `importFeedbackStore` | no (transient)        | cross-screen import result snackbar message                                                                                                                |

Stores hydrate from disk on app start in `app/_layout.tsx`. `libraryStore`'s
hydration is single-flight and `persist()` refuses to write before hydration
(a cold-start "Open with" import must not clobber the index). JSON documents
are written atomically (staged `.tmp` + swap); a corrupt index is preserved as
`.corrupt` instead of being silently reset. Both persisted documents carry a
`schemaVersion` and every load routes through the migration ladder in
`src/core/library/migrations.ts` (legacy unversioned files are treated as v1
and normalized; migrators are total and never throw on junk).
