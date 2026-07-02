# Full-team code review — 2026-07-02

Multi-agent review of the whole app (branch `feat-3d-live-and-map-overhaul`):
9 specialized reviewers (architecture, core geo, core library, map features,
app shell, state/data, security/perf, tests, missing features) + adversarial
verification of every medium-or-higher bug claim. 83 findings survived
verification; 3 were refuted and discarded.

**Status legend:** ✅ fixed in this branch · 🔧 fixed in the CI pipeline PR
(#75) · ⏳ open (listed for planning).

## 1. Overall assessment

The codebase is in genuinely good shape for a single-dev app: `src/core` is
verifiably pure and well-tested (dense assertions, real edge cases), routes are
thin, stores contain no business math, platform pitfalls (Android Marker
onPress, MapLibre data-URI, pdf.js worker hangs, Samsung snackbar timers) are
known and handled. The debt concentrates in three places: **persistence has no
defense-in-depth** (fixed below), **the two 3D screens duplicate ~500 lines of
three.js plumbing**, and **everything outside `src/core` is untested**.

## 2. Bugs fixed (commit `46c987b` + PR #75)

### Critical — data loss

- ✅ **Cold-start "Open with" GPX import could wipe the library.**
  `redirectSystemPath` called `addTrack()` while `hydrate()` was still reading
  `library.json`; persist() then wrote an index built from the empty initial
  state. Found independently by two reviewers. Fix: single-flight `hydrate()`,
  the intent path awaits it, and `persist()` refuses to write pre-hydration.
- ✅ **Non-atomic `library.json` writes.** A kill mid-write truncated the index
  and the next mutation cemented a fresh-install reset. Now staged to `.tmp` +
  swap; corrupt files preserved as `.corrupt`; staging file recovered on read.

### High

- ✅ **Un-cancelled 60 fps render loops + no scene disposal in both 3D views.**
  Every GLView remount (2D↔3D toggle, basemap switch, recenter) stacked another
  permanent rAF loop and retained a multi-MB scene. Loops now carry a GL
  generation and self-terminate + dispose when superseded.
- ✅ **PDF parser freezes on crafted/corrupt files** (classic-xref count
  unclamped; xref-stream `/W [0 0 0]` infinite loop) and **decompression-bomb
  OOM** (no FlateDecode output cap). All three hardened + regression tests.

### Medium

- ✅ Recording timer jumped forward by the whole pause duration on resume
  (pausedMs now accumulated in recorderStore).
- ✅ Waypoint tap hit-test assumed a north-up, unpitched camera — taps missed
  or opened the wrong waypoint after rotate/pitch (now uses `mapRef.project`).
- ✅ Persisted "Locally downloaded only" never applied at launch (child effect
  ran before settings hydration).
- ✅ Overlay-error snackbar could never dismiss (hardcoded `visible`, no-op
  `onDismiss` — the exact paper bug `useTimedSnackbar` exists for).
- ✅ Deleted trails kept rendering via stale `activeTrackIds` + overlay cache.
- ✅ Failed GPX/PDF imports orphaned the copied file in permanent storage.
- ✅ Offline region download never settled when MapLibre stalled without an
  error — download UI disabled until force-kill (90 s no-progress watchdog).
- ✅ `parseGpx` silently dropped every `<rte>` after the first.
- ✅ 3D terrain fetch unbounded for huge track bboxes (2000 km tour → ~400 tile
  downloads + OOM-sized buffers) — tile range now clamped (`clampTileRange`).

### CI/CD (PR #75, branch `fix/ci-pipelines`)

- 🔧 **E2E (Maestro) never green since 2026-06-16**: the job installed a
  _debug_ APK — no embedded JS bundle + expo-dev-client + no Metro in CI means
  the emulator showed the dev-launcher screen, so no UI assert could ever pass.
  Now builds `assembleRelease` (x86_64-only), uploads Maestro failure
  screenshots, caches gradle, caps the job at 60 min.
- 🔧 **Nightly health check failing on `npm audit`** (issue #10): fixed the
  fixable (audit fix + overrides: 23 vulns → 15, 9 high → 1) and moved the gate
  to `audit-ci` with a documented allowlist (only pdf.js GHSA-wgrm-67xf-hhpq
  remains — mitigated in-app via `isEvalSupported: false`, properly fixed by
  the pdfjs-dist 6 upgrade in PR #72 once device-validated).
- 🔧 **Dependabot proposed never-mergeable PRs** (#68/#69): the
  `expo install --check` gate rejects SDK-managed bumps by design; those
  packages are now ignored in dependabot.yml (they move via `expo install`
  during SDK upgrades).
- 🔧 Deprecated actions bumped everywhere (checkout v7, setup-node v6,
  setup-java v5, setup-android v4, upload-artifact v7) — supersedes PRs
  #3/#4/#6/#66/#67.

## 3. Structural / architectural findings

- ⏳ **MapScreen.tsx is a god-file** (~830 lines, one component, ~8 concerns:
  recording lifecycle, waypoint dialog, trail inspection, offline downloads,
  layers menu, projection math, keep-awake, 3D gate). Every 1 s timer tick
  re-renders the whole tree, MapLibre children included. Extract:
  `useRecordingSession`, `WaypointEditorDialog`, `OfflineDownloadFlow`,
  `LayersMenu`.
- ⏳ **~500 lines duplicated between the two 3D screens**
  (`Terrain3DLiveView` vs `Trail3DGLScreen`): identical `disposeGroup`, orbit
  PanResponder state machine, GL init/render loop, polyline draping. Extract a
  shared `useTerrainScene` hook + gesture module before the next 3D milestone.
- ⏳ **Offline-only policy is not centralized**: it is enforced only at the
  MapLibre layer; `dem.ts` raw-fetches Terrarium/ArcGIS, so the 3D trail view
  ignores "Locally downloaded only" entirely. Route all fetches through one
  gate (e.g. in `src/data`).
- ⏳ **Trail-overlay activation is transient while PDF-page activation
  persists** (mapStore vs libraryStore) — bundle activation doesn't survive a
  restart for trails. Move "what is activated" wholly into libraryStore.
- ⏳ **No schema version in `library.json`/`settings.json`**; the single
  shape-sniffing migration (`migrateDoc`) won't scale to the next change. Add
  `schemaVersion` + a migration ladder.
- ⏳ **Core purity is unenforced by tooling** — add an eslint
  `no-restricted-imports` boundary for `src/core` (AGENTS.md's #1 rule).
- ⏳ **Dead/duplicate code**: `src/core/share/incomingFile.ts` (contradicts the
  shipped content-sniffing intent flow), two different `Basemap` types plus an
  inline third copy, cross-feature imports of `ElevationProfile`/
  `exportTrailPdf` from the map feature (move to `features/common` or `@ui`).
- ⏳ **Likely-unused native deps**: expo-sensors, expo-sqlite, expo-system-ui,
  react-native-reanimated/worklets have zero imports — each ships native code
  in every build. Verify (config plugins, transitive peers) and prune.
- ⏳ **docs/ARCHITECTURE.md has drifted** (4 stores documented vs 6 real;
  data-URI pipeline description outdated; offline/3D subsystems missing).

## 4. Missing / incomplete features (full inventory)

### Reliability of the core promise (highest priority)

1. ⏳ **No background recording** — foreground-only `watchPositionAsync`, no
   foreground service / background-location permission: pocket the phone and
   the track stops accruing. The app's own analysis ranks this #1.
2. ⏳ **In-progress recording is unpersisted** — process death mid-hike loses
   hours of track + waypoints. Needs periodic checkpointing (e.g. append to a
   SQLite/JSONL journal — note expo-sqlite is already a dependency, unused) and
   a relaunch-recovery path.
3. ⏳ **No GPS accuracy gating/smoothing** — every raw fix is appended;
   `accuracy` is captured but never read. Inflates distance/D± (the headline
   stats).

### The 3D story (branch context)

4. ⏳ **Live 3D main-map view is shipped as unreachable dead code** — the
   `terrain3d` flag can never be turned on (deliberate pull-back before merge),
   yet the Play Store listing/screenshots still advertise it. Either re-enable
   behind a "beta" toggle or align the store listing until M5 lands.
5. ⏳ **M5a: PDF overlays are not draped on 3D terrain** — entering 3D drops
   the app's core value prop (the georeferenced PDF).
6. ⏳ **M5b: 3D requires network** — DEM/drape tiles stream from S3/ArcGIS with
   only an OS-purgeable incidental cache; offline packs cover 2D only. The
   store promises "works with no signal".
7. ⏳ Offline 2D packs exclude the new hillshade look (deliberate size
   tradeoff; revisit with a size-estimated opt-in when M5b lands).

### Navigation (largest coherent product gap)

8. ⏳ **Zero active-navigation capability**: no route following, off-route
   alert, destination pin, distance/bearing/ETA. The compass feeds nothing
   navigational. This is the recorder→navigator step the feature analysis
   calls the biggest opportunity.

### UX / product polish

9. ⏳ **Destructive deletes are single-tap, no confirm/undo**, and they
   permanently delete files (maps, trails+note photos, bundles, folders,
   offline regions).
10. ⏳ **Dead settings UI**: "Rotate map with heading" toggle (nothing reads
    it) and the "Base map tiles" URL row (no way to edit it). Wire or remove.
11. ⏳ **No units setting** — metric only, everywhere.
12. ⏳ **No first-run onboarding** — offline first launch is a blank map;
    nothing explains PDF import or offline packs.
13. ⏳ **'+' speed-dial has exactly one action** ("Record track") — a stub of
    the planned map-actions menu; currently one extra tap for nothing.
14. ⏳ **No bulk export/backup** — per-trail GPX/PDF share only; a lost phone
    loses the library. (The "GPX annotation → PDF export" roadmap item IS
    shipped.)
15. ⏳ **Accessibility pass outstanding** — several icon-only FABs
    (locate, fit-to-page, bundle actions) lack `accessibilityLabel`s; one
    dark-mode contrast issue (ElevationProfile note-pin numbers).
16. ⏳ OpenTopoMap "Topo" basemap remains deferred (documented; tracked so it
    isn't forgotten).

## 5. Test-suite gaps (ranked by risk)

- ⏳ recorderStore record/persist path and the entire `src/data` layer
  (storage.ts, offline.ts) have zero tests — these guard user data.
- ⏳ The DEM fetch/decode/stitch pipeline (`features/map/dem.ts`) is untested.
- ⏳ No component/screen tests at all; `@testing-library/react-native` is
  installed but never imported. 5,200+ lines of `.tsx` are exercised only by a
  3-tab nightly Maestro smoke.
- ⏳ Coverage gate blind spots: `!src/core/**/index.ts` exempts the GPX codec
  (283 lines) and track-stats module (289 lines) from measurement; thresholds
  are directory-aggregate, letting under-covered files (terrain.ts 63.6%
  branches) hide behind well-covered peers.
- ⏳ `jest.setup.ts` globally silences `console.warn`.

## 6. Security & performance notes

Security posture is good: HTTPS-only hardcoded endpoints, minimal permissions
(foreground location only), no secrets in tree or history, pdf.js sandboxed in
an offscreen WebView with `isEvalSupported: false`, XML parsing with fflate
entity limits, loopback-only style server, nanoid filenames (no traversal
surface). The parser-hardening fixes above close the remaining hostile-input
gaps found.

Perf items worth scheduling (not fixed here): every compass event re-renders
the whole MapScreen tree; `usePdfOverlays` re-reads and re-rasterizes every
active page on any change; live recording re-serializes the full track
LineString per GPS fix; the DEM tile cache has no eviction.
