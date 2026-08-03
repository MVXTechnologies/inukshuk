# Trail heatmap on the main map — design (approved 2026-08-02)

Overlapping recorded trails of the same category render as a heatmap on the
main map: where two or more routes run together, the shared stretch glows in
an intensified version of the category colour; solo stretches stay normal
lines. Tapping a hot point opens a vertical carousel of the activities that
pass through it; focusing a card highlights that exact route. ("As soon as 2
trails touch each other, it should be part of the heat map.")

User decisions (asked one at a time):

- **Heat unit: shared segments only.** A trail's overlapping stretches glow;
  its solo stretches render as a normal line. Not whole-trail, not
  everything-is-heat.
- **Main-map traces adopt category colours.** Today every trace is flat
  orange (`mapColors.trackOverlay`); this feature recolours all main-map
  trails with the category palette (same as Library/Dashboard) so "same
  colour = same nature" reads. Heat = saturated/boosted category colour.
- **Carousel: right-edge card stack.** Compact cards docked near the tap on
  the right edge, swiped vertically; the map stays visible; the focused
  card's route lights up while other trails dim.
- **Performed activities only.** Navigation-category trails never contribute
  heat (consistent with the dashboard's exclusion); they still render as
  normal category-coloured lines. Custom categories build their own heat in
  their own colour. Categories never mix heat.

Approach: **corridor grid binning** (chosen over MapLibre's native `heatmap`
layer, which can't express shared-segments-only or answer "which trails pass
here", and over exact segment-to-segment matching, which is O(n²·points)
overkill for a 25 m visual).

## 1. Core math — `src/core/heat/` (pure, unit-tested)

- **Grid** (`grid.ts`): fixed geographic cells, nominal `HEAT_CELL_M = 25`
  real metres — Web Mercator integer cells with a cosine correction at the
  track's latitude so cells stay ~25 m on the ground. `cellKey(lng, lat)` →
  packed integer key; `cellOf`/`cellCenter` helpers. Zoom-independent.
- **Cell tracing** (`trace.ts`): `traceCells(points, cellSizeM)` → the
  ordered per-point cell plus the deduped cell set a track touches.
  Interpolates along segments longer than one cell (sparse GPS must not skip
  cells) and dilates by one ring (8-neighbourhood) so two traces of the same
  physical path wobbling 10–20 m apart still meet. The dilated set is for
  matching; the undilated per-point trace is for run-splitting.
- **Heat index** (`index.ts`): `buildHeatIndex(tracks: {id, categoryId,
cells}[])` → `Map<cellKey, Map<categoryId, Set<trackId>>>`. A cell is hot
  for a category when ≥ 2 distinct same-category trails touch it. Intensity
  of a cell = that count. Navigation-category tracks are excluded by the
  caller (`isPerformedActivity` from `@core/dashboard/aggregate` is the
  existing predicate).
- **Run splitting** (`runs.ts`): `splitHeatRuns(points, isHotAt)` cuts one
  track's polyline into alternating cold/hot runs, each with
  `{startIdx, endIdx, count}` where count = max same-category trail count
  over the run's cells (bucketed 2 / 3 / 5+). Adjacent runs share their
  boundary point so the drawn line has no gaps.
- **Tap lookup** (`index.ts`): `trailsAtCell(index, key)` and
  `trailsNear(index, key)` (the cell plus its ring, so a fat-finger tap next
  to the line still hits) → per-category `Set<trackId>`.

Tests (co-located, under the core coverage gate): parallel traces 20 m apart
merge; 60 m apart don't; categories never mix; interpolation over a 200 m
segment leaves no cell gaps; run boundaries land on the exact points;
`trailsNear` finds the ring; count bucketing at 2/3/5+.

## 2. Data pipeline — `useTrackHeat` hook (`src/features/map/`)

Consumes the same tracks/visibility inputs as `useTrackOverlays`:

- Per-track cell traces cached content-keyed (`${id}|${pointCount}|${distanceM}`,
  the existing overlay-cache key) — hiding/showing or adding one trail only
  computes that trail.
- Heat index + run features rebuilt **only when the visible track set (or a
  track's content) changes** — never on camera moves; the grid is
  geographic. Compute runs async with `await setTimeout(0)` yields between
  tracks (the `useTerrainOverlays2D` stale-checkpoint pattern) plus a
  request-id bail so a superseded rebuild abandons early.
- Output: one combined `FeatureCollection` of run features with properties
  `{trackId, categoryId, count, hot}` and a colour property resolved at
  build time (category colour + its hot variant — custom categories
  included, resolved via `categoryColor`), plus `heatAt(lngLat)` for taps.
- Progressive: plain category-coloured traces render immediately from the
  per-track features; hot styling lands when the index finishes.

## 3. Rendering — MapScreen

Replace the N per-trail `GeoJSONSource`s with **one combined source** and
three line layers (fewer native sources than today):

1. **Glow** (`line` layer, filter `hot`): wide, `line-blur`, category colour
   at low opacity — the GPU-cheap glow under hot runs.
2. **Trace** (`line` layer, all runs): data-driven colour from the feature's
   resolved colour property; cold runs thin (current widths), hot runs
   thicker and fully saturated, width/opacity stepping at count buckets
   2 / 3 / 5+ (capped — beyond 5 is just "very hot").
3. **Active highlight** (`line` layer, filter on the focused/inspected
   trackId): full-brightness route on top; while the carousel is open every
   other trail dims (opacity expression on layer 2).

The live-recording line, waypoints, PDF overlays and terrain overlays are
untouched. Dark and light themes both verified — hot colours must read on
the dark map wash.

## 4. Tap → carousel — `HeatPointCarousel`

- Trail taps move off per-source `onPress` into the map-level `onMapPress`
  hit-test (the waypoint-pin pattern — per-source press is unreliable on
  Android anyway). Priority at a tap: waypoint pin → heat cell → single
  trail.
- Hot cell (≥ 2 same-category trails in the tapped cell or its ring): open
  the carousel — an absolutely-positioned `Surface` stack on the right edge
  (**never** paper Portal over the map — known touch-swallow trap), compact
  cards: category icon, name, date, distance · time, newest first. Vertical
  swipe with snap, claim-at-touch-down PanResponder (the `ElevationProfile`
  recipe) so the map doesn't steal the gesture.
- A small ring marker shows the tapped spot. The focused card's route lights
  via the highlight layer filter (no recompute on swipe). Tap the focused
  card → `router.push('/trail3d/[id]')` (dashboard-calendar convention). Tap
  elsewhere on the map or the close affordance → dismiss.
- Exactly one trail at the tap: existing inspection panel, unchanged.

## 5. Scope and interplay

Heat is computed among **currently visible performed trails** only — it
respects `mapVisibilityMode` ('type'/'folders'), the master
`showTrackOverlays` switch, and folder checks. No new settings (a heat
on/off toggle is a trivial later add if the map feels busy). 3D views are
out of scope — heat is a main-map-2D feature.

## 6. Failure modes and performance

A track whose GPX fails to read contributes nothing (existing behaviour).
Compute is linear in total points; steady-state cost after a new recording
is that one track's trace plus an index rebuild. One combined
FeatureCollection serialization per visibility change replaces N per-trail
source updates. If a rebuild is superseded (visibility changed again), the
request-id checkpoint abandons it.

## 7. Testing

- Core: co-located unit tests as listed in §1 (coverage gate applies).
- E2E: new `.maestro/heatmap.yaml` — record two short runs over the same
  simulated GPS path (the CI geo-fix loop replays identical coordinates, so
  overlap is deterministic), tap the trace, assert the carousel shows two
  cards; swipe and assert focus moves; negative: a single-trail tap opens
  the inspection panel, not the carousel. Wired into
  `.github/scripts/e2e-attempts.sh` and both local suite scripts.
- Visual counter-validation on the emulator in light **and** dark themes.

## 8. Rollout

JS-only: full local gate (unit + 12-flow Maestro on Android and iOS) → PR →
merge → OTA to runtime 1.5.0 (and 1.4.0 via `app_version_override` while
that runtime still has installs).
