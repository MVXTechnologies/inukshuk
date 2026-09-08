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
second-request completion coverage was subsequently added and passes. Native builds,
real-device PDF rendering, store submission,
and OTA deployment of this branch have not been run.

This is a risk-directed review using source inspection, recovered review
findings, regression tests, repository settings, and CI logs. It is not a claim
that every UI flow or every source line has been exhaustively verified.
