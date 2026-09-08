# PDF detail rendering implementation plan

**Goal:** Preserve readable PDF detail while zooming, and verify geographic placement with the owner's original maps.

**Architecture:** Retain the existing cached overview. After camera settlement, plan a padded, snapped visible-page crop in pure geometry code and render it through the existing serialized PDF engine. Bound each crop to 2,048 pixels per edge and 3 megapixels, retain at most four cached detail images, and refine at most two visible pages. Keep the overview when detail fails. Superseded viewport work must not enqueue an unbounded backlog or replace newer detail.

**Tech stack:** Expo SDK 56, React Native, MapLibre, existing pdf.js WebView; no new native dependency.

**Approved direction:** Owner requested zoom-dependent rendering and projection checks after the overview limitation was demonstrated. This implements that direction within the existing rendering subsystem.

## Constraints

- Keep core geometry free of platform imports, with colocated tests.
- Preserve current unrotated PDF coordinate convention and overview cache.
- Never inline a large PDF to render a crop; use the existing source-size guard.
- Do not change persisted georeferencing unless a reproduced defect warrants it.
- Test original PDFs locally; do not commit them.

## Tasks

- [x] Add `src/core/geo/pdfDetail.ts` and tests for cropped-page geometry: north-up and rotated/sheared georeferences, outside-page views, zoom thresholds, bounded dimensions and invalid bounds. Unit-space crops use visual top-left origin, with coordinates `[TL, TR, BR, BL]`.
- [x] Extend `RasterizeArgs` with optional normalized crop. Preserve full-page dimensions in results, render into the bounded crop canvas using a translation transform, and forward crop through both served/inline and retry paths. Add executable WebView-canvas tests and queue forwarding tests.
- [x] Add `usePdfDetails` with settled bounds input, one active refinement loop, latest-view coalescing, bounded file cache, revision-aware keys, and graceful overview fallback. Add asynchronous regression tests.
- [x] Integrate detail sources immediately above their corresponding overview in `MapScreen`. Keep details opaque over the overview to avoid double blending. Verify north-up and rotated views.
- [ ] Install the local Android debug build and test Anticosti, EcoLL1 and NORD UTM. Inspect labels at close zoom, placement against overview/base map, pan/zoom updates, and logs for failures. Run iOS where a branch-matched binary is available; distinguish installed baseline from changed code.
- [ ] Run focused tests, `npm run check`, independent code review, and update the PR with implementation and measured validation limits.

## Validation record

Implementation, focused tests and independent review are complete. `npm run check` passes 202 suites / 2,407 tests. The audit report records native rendering results and remaining limits: Android Eco detail, physical-device memory, repeated large-sheet timing, and document-picker reimport. The two validation checklist items remain open for those follow-ups.
