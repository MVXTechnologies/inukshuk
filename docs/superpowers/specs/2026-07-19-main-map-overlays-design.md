# Main-map terrain overlays: slope angle + contours in 2D and 3D — design

**Date:** 2026-07-19 · **Target release:** 1.2.0 (vc47)
**Request:** slope-angle overlay (with angle selector) and contour lines (with
interval selector) on the main map, applying in both 2D and 3D.

## What already exists (evidence)

- The main map's **3D mode already renders slope bands, contours and hypso
  tint** (`terrain3d/terrainMaterial.ts` shader injection over
  `@core/geo/terrainAnalysis` math, toggled by `TerrainOverlayButtons` with a
  contour-interval cycler over `CONTOUR_INTERVALS = [0=auto, 10, 25, 50, 100]`).
  The 3D mode itself is **unreachable**: the `video-3d` FAB was pulled in
  8f200bb ("live-3D isn't where we want it yet") — before 3D terrain P2 (#137)
  shipped the polish it was waiting for.
- Overlay math is pure and unit-tested in `src/core/geo/terrainAnalysis.ts`
  (Horn slope, CalTopo `SLOPE_BANDS` at 27/30/32/35/45°, `autoContourInterval`).
- `fetchHeightmap(bounds, grid)` (`features/map/dem.ts`) returns an offline-
  cached (128 MB LRU) metre-space Terrarium DEM grid usable outside 3D.
- The 2D map already renders GeoJSON line layers (tracks) and raster images
  (`ImageSource` + file:// PNG, PDF-overlay pipeline). `upng-js` is already a
  dependency (decoder today; its encoder ships in the same package).
- Overlay settings persist in `settingsStore` (`terrainSlope`,
  `terrainContours`, `terrainContourIntervalM`) and are shared by the main-map
  3D and the trail viewer.

## Design

### Selectors (new + existing)

- **Slope angle selector** — new persisted `terrainSlopeMinDeg` setting.
  Values are the `SLOPE_BANDS` floors: **27 / 30 / 32 / 35 / 45°**, default 27
  (= all bands, current behavior). Bands below the floor render transparent.
  One setting drives 2D raster, 3D shader (new `uSlopeMinDeg` uniform), and the
  trail viewer (shared shader — its overlay menu gains the same rows so the
  hidden bands are explicable there).
- **Contour interval selector** — reuse `terrainContourIntervalM` and
  `CONTOUR_INTERVALS` (Auto/10/25/50/100 m) exactly as the trail viewer does.

### 3D (main map)

Restore the `video-3d` FAB in `MapControlsRail` with its original guards
(disabled while recording / selecting an offline region / downloading).
`Terrain3DLiveView` + `TerrainOverlayButtons` then light up as shipped; add an
angle cycler button beside the existing interval cycler, and the
`uSlopeMinDeg` uniform to `terrainMaterial` (transparent below the floor).

### 2D (new renderer, `useTerrainOverlays2D` hook)

On `onRegionDidChange` (existing `refreshBounds`/`boundsVersion` pattern),
debounced, when either toggle is on:

1. `fetchHeightmap(visibleBounds padded ~15%, grid 256)` — offline-cached DEM.
2. **Slope**: per-cell Horn slope → `SLOPE_BANDS` colors with alpha (~0.55),
   transparent below `terrainSlopeMinDeg` → RGBA → `UPNG.encode` → PNG file via
   `storage.writeOverlayPng` → `<ImageSource>` + raster layer (PDF pattern).
3. **Contours**: new pure core module `src/core/geo/contours.ts` — marching
   squares over the grid at the selected interval (auto = `autoContourInterval`
   of the visible relief span), every 5th line flagged `major` → one GeoJSON
   FeatureCollection → `GeoJSONSource` + two line layers (minor thin/major
   thicker, brown, opacity ~0.7).

Layer order: above PDF overlays (they're near-opaque; overlays are explicit
user toggles), below trail/track lines. Stale results are dropped via a
request-id guard; recompute is skipped while the camera is pitched/rotated
(same limitation as the offline selector's `refreshBounds`).

### UI

`LayersMenu` (2D layers FAB menu) gains a **Terrain** section: Slope switch +
"≥ N°" rows, Contours switch + interval rows — mirroring the trail viewer's
overlay menu labels ("Slope", "Contours") for E2E consistency.

### Out of scope

Elevation tint in 2D (3D keeps it), slope legend, contour labels (raster style
has no glyphs), offline pre-download of DEM for arbitrary regions (M5).

## Testing

- Core: co-located tests for `contours.ts` (synthetic plane/cone grids: level
  count, closed loops, lng/lat mapping, major flags) and the slope RGBA
  generator (band colors, floor transparency, cell math), plus a
  `terrainMaterial` uniform test for the angle floor.
- E2E: new `.maestro/map-overlays.yaml` — 2D: open Layers menu, enable Slope +
  Contours, change interval and angle, assert map alive; 3D (conditional on the
  FAB being enabled + overlay bar present, trail-view-style timeouts): enter
  3D, toggle overlays, back to 2D. Wired into `e2e-attempts.sh` order.
- Full suites green on fresh installs, Android emulator + iOS simulator,
  before the vc47 build/submit.
