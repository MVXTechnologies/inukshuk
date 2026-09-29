# Changelog

All notable changes to Inukshuk are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Field updates (JS/asset-only) ship over-the-air via EAS Update to installed apps
with the same native runtime (a fingerprint of the native project, since 1.6.0;
the app version before that); native changes require a new store build. See
`docs/DEPLOYMENT.md`.

## [Unreleased]

## [2.0.1] - 2026-09-29

Bring your activities in.

### Added

- **Import from Strava.** Connect Strava in Settings › Connections, then
  import your activities, or only the new ones, with their routes. New
  activities can come in by themselves when you open the app. Imports pause
  and resume on their own when Strava asks us to slow down. Garmin, COROS,
  Polar and Suunto users can link their watch to Strava and import from there.
- **Import from Apple Health and Health Connect.** Workouts that were saved
  with a route (Apple Watch, Strava recordings, Polar on Android) import as
  trails. Read-only: Inukshuk never writes to Health.
- **Import activity files:** FIT, TCX and GPX, and the full account exports
  from Strava and Garmin (zip). Activities you already have are skipped.
  FIT and TCX files also open straight into Inukshuk from other apps.
- **Imported trails show where they came from**, with a "From Strava" filter.
- **Map maker:** make a printable map by framing it over the live map, with
  a scale, page shape and print style, and pick which of your trails and
  waypoints go on the sheet.
- **Waypoint icons:** choose the pin's icon (camp, water, viewpoint, …).
- **The map now covers the whole world**, poles included.

### Changed

- Library, Explore and Logbook share one header: the Settings gear stays
  in the same place on every page. Explore has the gear too.
- Page titles sit over the contour texture on every tab.
- Android 8.0 or later is now required (Health Connect needs it).
- MapLibre 11.4.

### Fixed

- The tab labels no longer touch the bottom edge on Android.
- Editing a note puts the cursor at the end of the text.
- Opening a map from the Library moves the map to it.

## [2.0.0] - 2026-09-28

A new map, and the rest of the "Stone & Paper" redesign.

### Added

- **A new map, drawn for the outdoors.** The street map is now a vector map
  in the app's own colours: paper land, sage woods, blue water, and trails
  as clear dashed lines above the roads, with city sidewalks kept quiet.
  Labels use Atkinson Hyperlegible Next. It works in light and dark, and
  covers Canada, the United States and Europe. It is served from our own
  servers, refreshed every month from OpenStreetMap.
- **Contour lines load with the map.** They are part of the map now, so
  they are already there around you when you pan, in denser lines as you
  zoom in, and they are saved in offline downloads.
- **Display modes.** Sunlight (maximum contrast) and Night red, switched on
  by you or automatically at sunset / while recording.
- **Route thumbnails** in the Library and Logbook, with the activity badge.

### Changed

- **Offline downloads of the map save the new map** (smaller than before).
  Areas downloaded before 2.0 show "Old map style · download again" in
  Settings.
- **Library, Maps and Logbook** are restyled: rows with thumbnails, filter
  chips, an Organize mode, and a clearer map store.
- **The Maps tab is now Explore**, with a magnifying-glass icon ("Map" and
  "Maps" side by side read as the same word).
- **Android: the system navigation bar is hidden**, so the app's tabs sit at
  the bottom of the screen. Swipe up from the bottom edge to bring Back and
  Home back for a moment.
- **The big Record button is gone.** Start a recording from "+" → Record
  track.
- Trails and the heat glow are much easier to tap.
- The map credit is a small ⓘ on the map; the full credits are in
  Settings › System info.

### Fixed

- The offline-download and map-maker area selectors could stay on
  "Calculating…" forever.
- Opening a map from the Library now moves the map to it.
- Night mode showed a blue position dot; it is red now.
- The recording panel no longer shows "−0 m" or "+0 m".
- Logbook totals' units were unreadable on the dark card.
- The scale bar and credit no longer cover the download and map-maker
  buttons.

## [1.7.0] - 2026-09-27

The first half of the UI revamp ("Stone & Paper", spec in
`docs/design/ui-revamp/`). Display modes, the library and the Maps/Logbook
restyle follow in later releases.

### Changed

- **A new look, and no more lavender.** Colours come from one set of tokens
  sampled from the logo: stone, paper and sage. Material's inherited purple
  tint is gone from every surface, outline and menu. Contrast is now checked
  in the tests against the colours as they are actually drawn, so pale text
  can't return unnoticed.
- **Atkinson Hyperlegible Next**, a typeface designed for legibility, is now
  used everywhere, with numbers that keep their width as they change.
- **One app style.** Edge and Minimal are retired. If you used Minimal, its
  folded map buttons stay on as the new **Compact map chrome** switch in
  Settings.
- **New tabs: Map · Library · Maps · Logbook.** Maps is the map store (it was
  called Search) and Logbook is the old Dashboard. Settings is no longer a
  tab: open it from the gear in the Library and Logbook headers, or from the
  map's "+" menu.
- **The map controls are redesigned.** Every button is at least 48 dp, big
  enough to use with gloves.
  - The compass is a small round badge top-left; tap it to turn the map back
    to north. It no longer shows your heading; the cone around your position
    does.
  - The target button, first on the right, follows your position; tap it
    again to stop following.
  - Base map and overlays share one button group.
  - A **Search places** bar opens coordinate entry.
  - A big **Record** button sits at the bottom of the map.
  - Your position is a blue dot in a white ring.
- **A new recording panel.**
  - Three sizes: a small pill, the default strip, and an expanded view with
    six more fields and your elevation so far. Chevrons or swipes switch
    between them, and switching never touches the recording.
  - Tap a large field to change what it shows. The fields available include
    time left until sunset.
  - **Stop needs a 0.8-second hold**, so a pocket tap can't end a hike.
  - The GPS state is spelled out, for example "Weak GPS · ±35 m", with an
    amber ring on the map.
  - **Glove lock** blocks the map and every button until you hold to unlock.
  - While recording, the Map tab hides the tab bar. From any other tab, a
    pill takes you back to the map.

### Notes

- 1.7.0 is a store build only. The new typeface is built into the app, so
  1.6.x installs don't receive it as an over-the-air update.

## [1.6.0] - 2026-09-26

### Fixed

- **PDF maps keep drawing after the app comes back from the background.**
  On iOS the app's built-in map file server could stop answering while the
  app was suspended, and every page it served then failed: pages were
  turned off, large maps stopped rendering, and one phone sent 677 identical
  error reports in two and a half minutes. The app now checks the server
  after a resume, after a minute idle and after any refused request,
  restarts it on the same port when it is down, and retries the page
  instead of failing it. A page that keeps failing for a reason that is not
  its own now waits (2 s, doubling up to a minute) instead of retrying on
  every pan, and reports once. A PDF that reads back empty now says so,
  with the size on disk, instead of a generic error.
- **A finished recording can no longer vanish from the library.** If the
  library index could not be read at launch, Stop wrote the trail's GPX,
  silently skipped the index, and then deleted the crash journal — leaving
  nothing to recover the hike from. Stop now retries loading the library
  first; if it still cannot, the recording stays open with its journal
  intact and says so, and the journal is only cleared once the trail is in
  the index. The library also retries loading when the app returns to the
  foreground, and a write it has to refuse is reported instead of dropped
  silently.
- **A setting changed during startup can no longer reset every other
  setting.** A change made before the settings file had been read wrote the
  defaults over it — the error-reporting opt-out included. Early changes are
  now held and applied on top of the saved settings once they load.
- **Strava stays connected after an over-the-air update.** Updates were
  published without the Strava keys, so any install that took one reported
  "Strava is not configured". Updates now carry them (from the GitHub
  copies described in `docs/DEPLOYMENT.md`), and the publish job refuses to
  run without them.

### Security

- **Error reports no longer carry file paths, map or trail names, or
  coordinates.** Reports are public issues; before they leave the device,
  paths and URIs, container ids, quoted text and coordinate pairs are
  scrubbed, including from reports queued by an earlier version. The
  re-parse report names a map by id instead of by its title. This is what
  the privacy policy already promised.

### Changed

- **A new icon and launch screen.** The Inukshuk stone figure, drawn from
  the approved artwork: a new app icon, an Android adaptive icon with a
  one-colour version for themed icons, and a light and a dark launch
  screen. Waiting in the map store or the 3D view now shows the stones
  falling into place instead of a spinner.
- **Expo SDK 56 patch releases** (seven packages), brought in with
  `npx expo install --fix`.
- **Over-the-air updates target a fingerprint of the native project, not
  the app version.** An update now reaches only binaries built from the
  same native code, so a native dependency bump can no longer be shipped
  to older binaries that lack it (as `@maplibre/maplibre-react-native`
  11.3.7/11.3.8 were). The manual "publish for an older app version"
  option is gone: it has no meaning under a fingerprint.
- **Native dependency updates are never merged automatically.** Dependabot
  groups them into one PR (`@maplibre/*` and `@dr.pogodin/*` now included),
  and they wait for a person and a store build.
- **Android builds go to the Play internal testing track.** Promotion to
  the beta or production is a deliberate step in the Play Console, as
  TestFlight → App Review already is on iOS.
- **One command bumps a release.** `npm run release:bump -- --version 1.6.0`
  (or `major`, `minor`, `patch`) moves the version in every file and both
  store build numbers, refuses to go backwards, and prints the tag to create.

## [1.5.3] - 2026-09-10

### Fixed

- **Maps whose page is one very large JPEG render on iPhone instead of
  failing with "Load failed".** A 181-megapixel page exceeded the native
  renderer's decode budget, so it fell back to PDF.js, which had to decode
  the whole frame in JavaScript — 2.9 GB, which the OS kills, and WebKit
  reports the kill to the page as a bare fetch error. Oversize crops now
  decode at a reduced JPEG scale: the same sheet renders in 0.7 s at a
  201 MB peak. The failing request is also named in the report now, instead
  of "Load failed" with no URL, status or byte count.
- **Georeferencing stored by an older parser is corrected on launch.**
  Parsing happened once, at import, and was persisted, so every parser fix
  reached new imports only — a sheet imported before the corner-order fix
  kept drawing upside down forever. Each parse now carries a parser
  revision, and stored maps below it are parsed again from their own PDF at
  startup, cheaply, thanks to the random-access reader. Page choices are
  kept; a parse that comes back empty is never applied.
- **The position marker stays above every map overlay.** MapLibre appends a
  layer added after first paint to the top of the style, so PDF overviews,
  detail tiles, the slope raster and trail lines were landing on top of the
  blue dot. Every overlay now inserts below a fixed anchor.
- **Importing a very large map no longer runs out of memory.** Parsing read
  the whole file to find a few hundred bytes of georeferencing; a 216 MB
  sheet died on a 192 MB heap. The reader now works by random access —
  68 KB read for that sheet — and falls back to the old whole-file parse for
  a small file if the platform handle misbehaves.
- **A pause no longer bridges the distance travelled while paused**, and
  time the app spent closed while paused is no longer counted as active.
  Each resume starts a new segment, written as its own `<trkseg>`.

### Added

- **Pages pre-render right after import**, in the background and yielding to
  anything on screen, so the map opens with its rasters ready instead of
  paying 15–20 s at the worst moment.
- **The "PDF maps" master switch is back**, persisted, and overlays follow
  the folder selection again.

### Changed

- The nightly health check applies dated Expo Doctor acknowledgements
  instead of failing every night on one finding that only the SDK 57 upgrade
  can close, and its tracking issue names the step that actually failed.

### Added

- **Scrubbing a trail's elevation profile now moves a marker along the 2D
  trace.** The trail view's 2D map previously only moved the 3D terrain pin;
  the 2D line showed nothing. The chart-x → distance → on-trail position
  mapping is pure core logic (`core/geo/track/scrub.ts`), shared with the
  main-map trail inspector, and the readout above the profile keeps showing
  distance / elevation / speed at the scrubbed point. Tapping a note row also
  jumps the marker to that note.
- **Trail notes are numbered on the 2D map.** Note pins on the trail view's 2D
  map now carry the note's number (1..N in trail order —
  `core/library/notes.ts#numberNotesOnTrack`, the same ordering the notes list
  and the profile pins use), so a pin on the map is trivially matched to its
  row in the list. Same fixed badge colours in light and dark mode.

### Fixed

- **iOS: single-large-JPEG GeoPDFs (EcoLL1) render instead of always failing
  with "Load failed" and being turned off (#331).** The 52 MB EcoLL1 sheet is
  one 181-megapixel JPEG. Its overview exceeded the native crop path's 16 Mi
  source-pixel decode budget, so iOS refused it into pdf.js, which must fetch
  all 52 MB and decode the full frame in JavaScript — 2.9 GB in the WebView
  process on the simulator, a memory kill on a phone, surfacing as WebKit's
  bare `Load failed` (#279, #280). The iOS renderer now decodes such crops at
  the JPEG DCT reduction (1/2, 1/4, 1/8) that fits the budget, so the whole
  page renders natively in under a second at ~200 MB. Needs a new native
  binary. Rasterizer errors also name the failing served request (`GET
/maps/….pdf bytes=…`, status, bytes read) instead of only "Load failed".
- **Map gestures in the trail view no longer fight the page scroll.** The trail
  view is one ScrollView, which intercepted vertical drags before they reached
  the native MapLibre view, so panning the 2D map stuttered or scrolled the
  page instead ("works on the main map, not in GPX focus mode"). While a finger
  is down on the map/terrain box the scroll is disabled, giving the map the
  whole gesture; the page still scrolls from anywhere below the map.
- **The offline-download layer previews show the map again.** The little
  per-basemap thumbnails in "Download offline area" fetched their sample tile
  with a bare image request — no `User-Agent` — which OSM's tile usage policy
  rejects by serving an "Access blocked" placeholder tile. The preview tile is
  now fetched with the app's identifying User-Agent through the shared tile
  cache, so it also survives going offline once seen and respects the
  "locally downloaded only" switch.
- **The map attribution "ⓘ" no longer overlaps the MapLibre logo.** Both
  ornaments defaulted to the same bottom-left corner; the attribution button now
  sits above the logo, keeping both visible (OSM/Esri attribution is a license
  requirement).

- **"Download your data" no longer claims success when the share sheet is
  cancelled.** `expo-sharing` resolves identically whether the user completed the
  share or dismissed the sheet (Android reports no outcome), so the export now
  says what it can actually vouch for — "Archive ready — N files, X MB", shown as
  the sheet opens — and stays silent afterwards instead of announcing a save that
  may never have happened. The staged zip is still deleted on cancel.
- **The compass is steady at rest.** The previous smoother scaled its
  responsiveness with how far each new sample sat from the estimate — but on
  Android `expo-location` derives the heading from the raw accelerometer +
  magnetometer and only emits a reading once it has moved ≥2°, so at rest the
  app receives nothing _but_ noise excursions. The filter therefore sped up for
  noise, and the needle wandered ~5° on a table. Heading is now filtered by a
  1-Euro filter (`src/core/signal/oneEuro.ts`) that adapts on the signal's
  _speed_, plus a still/turning hold: while the compass is not turning the
  reported heading does not move at all (0° of jitter, by construction), and a
  real turn is tracked within a few degrees. The needle, the direction cone and
  the map bearing in heading-up mode are all fed from that one filtered value —
  heading-up no longer uses MapLibre's native compass camera mode, which read
  the raw sensor and shook the map.
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

### Changed

- **One export, in Settings.** The Library's "Export backup" button is gone; the
  Settings → "Download your data" export supersedes it (same `library.json`,
  trails and note photos, plus the map PDFs the old in-memory backup had to omit).

### Added

- **Trim and Merge from a trail's ⋮ menu.** "Trim" jumps to the Map tab with
  that trail open in the inspect panel, straight into the scissors' trim mode;
  "Merge" enters the Library's multi-select mode (the one long-pressing a trail
  opens) with that trail pre-selected — tap the others and confirm. The menu is
  also decluttered: "Move to folder" and "Add to bundle" only appear once a
  folder or bundle actually exists, instead of showing greyed-out
  "No folders/bundles yet" placeholders.

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
