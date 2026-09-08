# Inukshuk audit — 2026-09-08

Resumed the interrupted Codex audit against `870e299` (PR #270 merged), on
`codex/codebase-audit`. Claude remains the architectural lead. The original
checkout and its untracked `docs/plans/plan-data-and-preload.md` were preserved.

## Verified fixes in this branch

- **Stale PDF overlays after catalog updates.** `usePdfOverlay.ts` keyed its
  effect and both raster caches only by library id/page/width. Catalog updates
  preserve the library id while replacing the PDF. The effect now includes
  file and georeference identity; cache filenames include an import revision.
  Regression tests reproduced the old raster and old coordinates, then passed
  after the fix. Container-path changes on iOS do not invalidate the file revision.
- **PDF timeout queue ownership.** `PdfRasterizer.tsx` treated every timeout as
  the active request and retained expired queued entries. It now removes queued
  expirations, tracks active ownership, and remounts the WebView after an active
  timeout before resuming work. Tests reproduced stale requests being injected
  and the old engine being reused, then passed after the fix.
- **Unknown PDF sizes bypassed the base64 limit.** `fileSizeAt` returns zero
  when metadata cannot be read; `chooseRasterSource` treated zero as small.
  Without a usable local server this could attempt an unbounded whole-file
  base64 allocation. Unknown/invalid sizes now refuse inline loading; the
  streaming path remains available regardless of known size.
- **GPX coordinates outside geographic bounds.** The parser accepted finite
  latitudes over 90 degrees and longitudes over 180 degrees. Track, route, and
  waypoint imports now discard these points before mapping/statistics. Tests
  cover all three sources and retain valid pole/antimeridian boundary values.
- **Publishing bypassed quality checks.** OTA and store-release workflows ran
  independently of CI. Both now run the SDK dependency check and `npm run check`
  on their checkout before publishing/build submission.
- **Workflow gaps.** OTA paths now include the lockfile and bundler configs;
  native-build triggers include config plugins. Manual runtime input is passed
  through an environment variable and validated before shell use. Store secrets
  are written through environment variables rather than embedded into shell code.
- **Release documentation.** `eas.json` uses Play `production` with
  `releaseStatus: completed`, although the documentation described internal
  drafts. Documentation now describes the actual public-release behavior.

## Findings requiring follow-up

1. **P1: Service credentials in public app configuration.** `app.config.ts`
   exposes `errorReportToken` and `stravaClientSecret` through `extra` whenever
   those environment variables are set. Scope restrictions do not make a
   distributed credential private. No actual secret values were inspected.
   Use the existing error-report relay interface and move Strava exchange/refresh
   behind a server that owns the client secret. Coordinate deployment before
   removing client fields to avoid silently disabling existing integrations;
   rotate any credentials that have already shipped. Expo explicitly warns
   against sensitive data in [public app config](https://docs.expo.dev/workflow/configuration/),
   and Strava says the [client secret must not be shared](https://developers.strava.com/docs/authentication/).
   The OTA workflow now accepts repository variable `ERROR_REPORT_ENDPOINT` so
   a configured relay URL reaches subsequent updates.
2. **P1: Merge gates are documented but not enforced by repository settings.**
   At inspection, GitHub's main-branch protection endpoint returned “Branch not
   protected” and the repository rulesets API returned an empty array.
   Dependabot's `gh pr merge --auto` therefore must not be assumed to wait for
   the intended checks. Configure required quality/native checks and review the
   bypass policy; account settings were not changed in this branch.
3. **P1: Nightly reports a Hermes memory regression.** The failed September 8
   health run passed 21/22 Expo Doctor checks; the failure identifies Expo
   56.0.21 / Hermes 250829098.0.10. Its suggested remediation is an SDK 57/native
   runtime upgrade. This is separate from the screenshot's Java base64 allocation
   failure. Keep the blocking nightly signal and schedule a native migration with
   Claude rather than hiding it or independently upgrading this SDK 56 project.
4. **P2: Web playground persistence reports false success.**
   `web/src/library/useLibrary.ts` catches and ignores IndexedDB GPX writes in
   import and both trim paths, then updates summaries or returns success.
   Index writes also fail silently. A complete fix needs an explicit persistence
   failure contract across the hook and consuming UI, including index/GPX
   consistency; the native app does not use this IndexedDB implementation.
5. **P2: Timestamp-free GPX imports miss Navigation classification.**
   `parseGpx` normalizes absent time to zero, but `importGpx.ts` tests for
   `undefined`. Align classification with `buildImportedTrack`, which treats
   positive finite timestamps as recorded times, and test the actual import flow.

## GitHub context and Android report

- [PR #270](https://github.com/MVXTechnologies/inukshuk/pull/270) merged. Its
  success-path PDF resource cleanup and post-load error reporting supersede two
  findings from the interrupted review.
- Existing enhancements [#271](https://github.com/MVXTechnologies/inukshuk/issues/271)
  and [#272](https://github.com/MVXTechnologies/inukshuk/issues/272) cover raster
  resolution and rendering speed. Native rasterization/tiles remain separate work.
- Open PRs at inspection: #263 and #261 (site), #254 (filter design), #239 and
  #214 (dependencies), and parked #171 (third-party sync). No PR was merged,
  closed, or otherwise modified by this audit.
- The owner's 11:07 Android screenshot shows `FileSystemFile.base64` failing a
  140,060,264-byte allocation with a 268,435,456-byte heap limit. This establishes
  a whole-file base64 memory failure, not a georeferencing or GPU failure.
- Publishing logs confirm the #270 bundle reached production runtime 1.5.0 at
  11:03:10 EDT ([run](https://github.com/MVXTechnologies/inukshuk/actions/runs/34241993098))
  and runtime 1.4.0 at 11:06:14 EDT
  ([run](https://github.com/MVXTechnologies/inukshuk/actions/runs/34242311082)).
  Publication does not prove that the phone has downloaded and launched that
  bundle. The device's version and retry after two online cold launches are
  still needed to distinguish an older bundle from a remaining fallback fault.

## Validation and limits

The merged baseline passed `npm run check`: 198 suites / 2,378 tests. The final
fix set passed `npm run check`: 200 suites / 2,390 tests, including the unknown-size
guard. `npx expo install --check` reports dependencies are up to date.
All workflow YAML was parsed locally. A separate read-only reviewer found no
definite regression in the first fix set; its suggested late-message and
second-request completion coverage was subsequently added and passes. The first fix commit passed Android and iOS native builds in CI. Local simulator
validation of the following zoom implementation is described below. Physical-device
PDF rendering, store submission, and OTA deployment of this branch have not been run.

This is a risk-directed review using source inspection, recovered review
findings, regression tests, repository settings, and CI logs. It is not a claim
that every UI flow or every source line has been exhaustively verified.

## Extended review: findings awaiting fixes and verification

The following findings came from the second source-review pass. They are not
included in the first fix commit. Each needs a focused regression test and
verification before being described as fixed.

### Persistence and recovery

- **P1 — Recorder journal can be discarded after a failed checkpoint write.**
  `recorderCheckpoint.writeCheckpoint` catches write failures, while recovery
  and background merge callers clear the journal after awaiting it. A disk-full
  failure can leave the old checkpoint and remove the only newer points.
  Propagate persistence success and acknowledge only the successfully saved
  journal snapshot.
- **P1 — Delayed recovery can overwrite a newly started recording.**
  `recorderStore.recover` checks idle state before asynchronous reads, then
  restores the old session without rechecking ownership. Guard the result with
  a session generation before applying it or cleaning recovery files.
- **P1 — Marine refresh deletes the existing offline cell before replacement.**
  `marinePacks.writePack` removes the previous file before writing the new one.
  Stage and validate a replacement before swapping it into place.
- **P2 — Concurrent initial background appends can lose a batch.** Two callers
  can both enter journal initialization and overwrite the cached array. Serialize
  initialization, append, and acknowledgement; test overlapping batches.
- **P2 — Library deletion precedes index persistence.** Map/track removal and
  photo replacement can delete the asset, then fail to save the metadata change.
  Persist the new index before deleting unreferenced assets.
- **P2 — Malformed nested index records can prevent hydration.** Migration accepts
  records based on shallow shape checks. Null georeferences, non-array notes,
  and missing file paths can throw. The rejected hydration promise remains
  cached, preventing retry. Validate nested records and release failed hydration.

### Bounded computation and track correctness

- **P1 — PDF decompression limits are checked after a potentially huge allocation.**
  The inflater receives a whole compressed stream in one push. A local probe
  expanded 81,876 compressed bytes into an 83,886,080-byte callback before the
  64 MB output guard ran. Feed bounded input chunks and enforce an output budget
  during decoding; do not assume callback size is bounded.
- **P1 — PDF object-stream and predictor metadata can request excessive work.**
  `/N` directly bounds a loop; `/First` and predictor geometry need bounds tied
  to the actual stream and supported output size. A tiny synthetic PDF declaring
  one million objects caused one million iterations.
- **P1 — Heat interpolation takes the long path across the date line.** Two
  points at longitude 179.999 and -179.999 schedule roughly 3.2 million samples
  despite being about 222 metres apart. Normalize longitude deltas and impose
  defensible per-segment and total work limits.
- **P2 — Missing GPX times inflate duration.** Missing timestamps become zero,
  then mix with actual timestamps in track statistics. Keep geometry but exclude
  missing timestamps from elapsed-time calculations.
- **Needs caller verification — Map-builder scale cap.** The layout can cap its
  displayed scale at 1:1,000,000 while expanding the geographic bounds beyond
  that scale. Check reachable input limits and ensure the printed scale matches
  the rendered extent.

### Screens and caches

- **P1 — Leaving 3D can retain a render loop for an unmounted GL view.** The
  screen survives the 3D-to-2D switch; its GL generation can remain current.
  Tie generation invalidation and disposal to GL-view ownership, including late
  asynchronous scene builds.
- **P2 — Marine cache retains more entries than raster storage retains files.**
  Six cached charts share an output id whose storage retains two files. A cache
  hit can return a deleted URI. Verify existence and align cache/file ownership.
- **P2 — Marine chart cache omits unit preference.** Sounding labels are baked
  into the bitmap, while the cache key omits imperial/metric preference.
- **P2 — New marine packs can be ignored at an unchanged viewport.** An early
  bounds-based return precedes pack-version handling.
- **P2 — Elevation profiles remain cached after overwriting a trimmed trail.**
  The Library profile cache uses only the track id, which trimming preserves.
- **P2 — Incoming GPX deduplication can discard distinct recordings.** Matching
  name, point count, and near-equal distance does not establish identical points,
  times, or notes. Compare normalized content before deleting an incoming file.
- **P3 — Dashboard date boundaries freeze while mounted.** Its captured current
  date does not advance at midnight or month rollover.

### Catalog and web

- **P2 — Failed catalog shards are treated as complete search coverage.** Excluding
  failed shards from pending work makes partial results appear exhaustive.
- **P2 — Catalog refresh retains an obsolete search digest and failed-attempt flag.**
  Reset digest state and guard in-flight requests by manifest generation.
- **P2 — Web IndexedDB writes resolve before commit.** The request success handler
  resolves the promise; a subsequent transaction abort can therefore report a
  successful save. Await transaction completion and close the database on all
  terminal paths.
- **Further investigation — Web import/save failures are suppressed.** Some GPX
  and index writes catch and discard storage errors. Trace partial-save behavior
  and provide a consistent recoverable failure contract before changing it.

### Scope of this pass

Reviewers inspected core parsing/geometry/tracks/heat/migrations and selected
catalog/weather modules, all 27 production files in data/state/lib, and the
feature/screen sources by traced behavior. Focused core checks passed 6 suites /
120 tests; platform checks passed 28 suites / 259 tests. These are supporting
checks of current behavior, not proof that the findings have been fixed. Some
large source reads were truncated; detailed weather/rendering, catalog locator,
selector/formatting, web UI, and catalog-generation-script coverage remains.
The web typecheck and production build passed; the build reports a large main
chunk and an ineffective GPX dynamic split because the module is also imported
statically.

### Owner-provided map regression samples

The three original PDFs were downloaded locally with the owner's authorization
and were not added to Git. At the audit commit, Anticosti, EcoLL1, and the 216 MB
NORD UTM sheet all parse without warnings and produce geographic coordinates.
Anticosti has no page rotation and its MediaBox equals its CropBox. This does
not establish what metadata or bundle the owner's phone currently uses.

The current import flow stores georeferencing once; updating the app does not
reparse existing documents. The renderer also uses one 2,048-pixel-wide bitmap
for each full page regardless of zoom. The local iOS sample display confirms
close-zoom blur. A simulator navigation smoke flow passed against the existing
installed app, but that binary was not verified to load this branch. The Android native build subsequently passed. Freshly parsed samples do not
reproduce the reversal or unsupported-projection result; persisted metadata on
the owner’s phone still needs verification.

### Zoom-dependent PDF rendering

The follow-up keeps the cached overview and adds bounded visible-page crops
when the camera settles. Crops have a 2,048-pixel edge / 3-megapixel cap, with at
most two refined pages, one active request, four settled cache files, and up to
two temporary handoff files. Superseded camera positions replace waiting work.
The overview remains when refinement fails. These limits bound canvas and
output-cache memory; they do not bound pdf.js document/image decoding memory.

Crop placement matches MapLibre’s two Mercator-space triangles, including
rotated/sheared sheets and crops crossing the original diagonal. Native source
and layer identities change with each detail image so new coordinates cannot
briefly display the previous bitmap. Review identified and tests reproduced
two additional lifecycle gaps: startup time consumed the active render budget,
and document destruction completed after the next request could start. Active
requests now receive a fresh 45-second budget; completion and retries await
worker destruction, with WebView replacement after cleanup failure.

Local validation used the original PDFs and fresh parser output seeded into
simulator libraries. This tests parsing, rendering and map placement, but is
not an end-to-end document-picker import test. Android used a locally built
arm64 debug app loading this branch. iOS used the existing compatible 1.5.0
native binary with this branch’s production JS bundle embedded and OTA disabled
only in the local test copy. The owner’s original iPhone 17 installation was
preserved.

- Anticosti renders upright with more detailed labels/linework on Android and
  iOS. Android panning produced a new cropped image; refinement is also visible
  with offline-only mode enabled.
- EcoLL1 renders its georeferenced forestry map on iOS and its overview on
  Android (19.2 seconds). Android detail completion for this sheet still needs
  a clean follow-up run; the last test overlapped development reloads.
- NORD UTM renders both overview and detail on Android and iOS, including
  offline-only mode. The successful normal Android overview took 34.6 seconds
  (272 ms open / 33.1 seconds render). Two earlier attempts timed out; a direct
  diagnostic render took 14.1 seconds. The timeout-budget fix is verified by
  tests, but these timings do not establish the cause of every device timeout.
- The Android emulator has a 576 MB Java heap limit, unlike the owner’s 256 MB
  phone. Large-sheet speed and physical-device memory safety remain validation
  limits. NORD contains 140 image objects and the overview reads the 216 MB PDF
  through range requests; bounded output does not imply cheap source decoding.
- The provided crash report names SpringBoard and its XCTAutomationSupport
  accessibility-session initialization. Inukshuk remained alive in simulator
  logs. This occurred during a Maestro run; iOS automation was stopped and
  validation continued with direct launches/screenshots. A location permission
  alert obstructed part of the iOS captures. This is not evidence that every
  app crash has been ruled out.

Independent review rechecked placement, stale-source identity, coalescing,
timeout budgets and destruction ordering. No remaining actionable finding was
identified in that targeted review. The broader findings above remain open;
this feature is not completion of the full-app audit.

Final local `npm run check` passes: 202 suites / 2,407 tests, with typecheck,
zero-warning lint, formatting and coverage gates passing. Native CI for the
first fix commit passed; the updated PR will run CI again.
