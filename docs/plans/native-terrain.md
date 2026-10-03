# Native 3D terrain inside the MapLibre map ("Option C")

Status: design + first implementation (branch `feat/native-3d-terrain`, HOLD for owner review).
Store build only — this is native code (a new local Expo module), never an OTA.

## Goal

Two-finger tilt on the main map (up to 80°) shows **real 3D relief** — the
ground rises into mountains — while the surface keeps showing exactly the map
the user sees (Stone & Paper light/dark, satellite, contours, trails, heatmap,
PDF overlays), at 60 fps, with no hitch when tiles load. The 2D path (pitch
below the threshold, or the setting off) must be byte-for-byte what ships
today.

## Phase 0 — what the platform gives us (verified 2026-10-02)

### Upstream MapLibre Native terrain ("Option A") — not ready

- Our pins: Android `org.maplibre.gl:android-sdk-opengl:13.6.1`, iOS
  `MapLibre.xcframework 6.31.0`, via `@maplibre/maplibre-react-native 11.4.0`.
- Neither release has terrain. The style parser knows `light` but not
  `terrain`/`sky`; there is no `MLNStyle.terrain`, no `Style.setTerrain`.
- Upstream work lives on the `feature/terrain-3d` branch: draft PR
  maplibre-native#4190 ("Terrain 3D", draft, last touched 2026-10-02) with its
  own TODO list still open — symbols/circles not lifted, line layers need a
  terrain shader variant, `coveringTiles()` not terrain-aware, "Performance
  will likely be bad in `Continuous` mode, and there may be memory leaks", no
  transparency. Satellite PRs #4558 (annotations/labels/collision on terrain),
  #4559 (symbol occlusion), #4556 (Metal API validation with terrain), #4701,
  #4711, #4712 (gestures anchored on terrain) are all OPEN. The darwin runtime
  API PRs (#4614/#4615) were closed unmerged.
- The RN wrapper exposes nothing terrain-related (no `terrain` prop, no
  max-pitch prop).

Decision: **A is not ready** (unreleased, draft, known perf/leak caveats, and
it would mean shipping a self-built MapLibre fork). We build C, structured so
it can be swapped for upstream terrain the day a release ships it.

### Custom-layer APIs in our exact versions

- **Core host interface** (`include/mln/style/layers/custom_layer_host.hpp`,
  identical at `android-v13.6.1` and `ios-v6.31.0`): `initialize(const
CustomLayerInitParameters&)`, `preRender(const gfx::Context&, const
CustomLayerRenderParameters&)`, `render(const CustomLayerRenderParameters&)`,
  `contextLost()`, `deinitialize()`. The render parameters carry `width,
height, latitude, longitude, zoom, bearing, pitch, fieldOfView`, the
  **`projectionMatrix`** (double[16], world pixel x/y at the current zoom, z in
  metres — the same matrix MapLibre draws fill-extrusions with) and
  `nearClippedProjectionMatrix`.
- **Android (GLES 3)**: `org.maplibre.android.style.layers.CustomLayer(id,
long host)` takes a raw pointer to a C++ `mln::style::CustomLayerHost`
  (ownership passes to the core). So the Android side needs a small C++
  library. The host is only ever called through its vtable, so our `.so`
  needs no MapLibre symbols — we compile against a vendored copy of the two
  ABI headers (`modules/inukshuk-terrain/cpp/mln_abi.hpp`). The layer renders
  inside MapLibre's single "main buffer" render pass, translucent stage, and
  MapLibre restores its own state afterwards (`DrawableCustomLayerHostTweaker`
  rebinds the default renderable and marks the context dirty).
- **iOS (Metal)**: `MLNCustomStyleLayer` is Metal-ready in 6.31: during
  `drawInMapView:withContext:` it exposes `renderEncoder` (the live
  `MTLRenderCommandEncoder` of MapLibre's main pass), `commandBuffer` and
  `renderPassDesc`, and the drawing context carries `projectionMatrix` and
  `nearClippedProjectionMatrix`. `preDrawInMapView:` runs before the pass.
- **Max pitch**: core accepts up to π (`PITCH_MAX = M_PI`). iOS:
  `MLNMapView.maximumPitch` goes straight to the core (`setBounds`), so 80°
  works, and the two-finger tilt gesture clamps to it. Android:
  `Transform.setMaxPitch` rejects > 60 and the shove gesture clamps to the
  compile-time `MapLibreConstants.MAXIMUM_TILT = 60`, so the module raises the
  core bound through `NativeMapView.nativeSetMaxPitch` (`@Keep`, reflection)
  and wraps MapLibre's shove listener so the gesture can continue past 60°.
  (No max-pitch native code existed before this branch — `tiltRelief.ts`
  documents 60° as the ceiling.)

### Matrices and depth per frame

- Both platforms hand us MapLibre's projection matrix every frame, so the
  terrain composes with the camera exactly; the eye position is recovered as
  `P⁻¹·(0,0,1,0)` (pure helper `eyeFromProjection`, tested).
- Depth: the GL default framebuffer has a depth+stencil buffer (MapLibre uses
  it for layer ordering); we clear depth inside our layer and write our own
  linear depth (`z = w / far`), so MapLibre's tiny far plane never clips a
  mountain. On Metal we render the terrain in our own pass with our own
  `Depth32Float` texture (see below).

## Phase 1 — design

### The drape: "frame drape" (screen-space render-to-texture)

The hard part is making the terrain show _the same map_. MapLibre GL JS does
it by rendering every layer into a texture per terrain tile. Native has that
machinery internally (`RenderTarget`s) but no public hook, so the candidates:

| Option                                                                                                                                                                                    | Shows the exact map?                                                               | Cost                                | Verdict                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- | -------------------------- |
| Per-tile offscreen render of the style (a `MapSnapshotter` per tile)                                                                                                                      | style only — RN runtime layers (trails, heatmap, PDFs, recording) missing or stale | seconds per tile, a second renderer | no                         |
| Terrain into the depth buffer, let MapLibre project onto it                                                                                                                               | MapLibre's 2D shaders never read depth for displacement                            | —                                   | impossible                 |
| Shading-only relief pass over the flat map                                                                                                                                                | no geometry: mountains don't rise                                                  | cheap                               | that's today's tilt relief |
| **Frame drape**: let MapLibre draw the flat map at the _same camera_, capture that frame, then draw the terrain mesh sampling the capture at each vertex's _flat_ (z = 0) screen position | **yes — every layer, by construction**, same colours, same AA, labels included     | one full-screen copy + the mesh     | **chosen**                 |

Why it is exact: a point of the ground at (x, y) is drawn by MapLibre at
`P·(x, y, 0)`. The terrain vertex for that ground point sits at
`P·(x, y, h)` and samples the captured frame at `P·(x, y, 0)`. At zero
exaggeration this is the identity (the 2D map, pixel for pixel), which is also
what makes the 2D↔3D transition seamless: the height is scaled by a pitch
ramp `t` and the frame morphs continuously out of the flat map. Occlusion
(mountains hiding valleys) comes from the mesh's own depth test.

Per platform:

- **Android (GL)**: our custom layer sits at the **top** of the style. In
  `render()` it `glCopyTexSubImage2D`s the current framebuffer (everything
  MapLibre drew below it) into a screen-sized texture, clears depth, draws the
  sky, then the terrain. A UI-thread watcher keeps the layer on top when RN
  re-inserts its component layers after a style reload.
- **iOS (Metal)**: a texture cannot be sampled while it is the attachment of
  the live encoder, and MapLibre owns that encoder. So the layer's
  `drawInMapView` only records the frame (matrices, command buffer); the
  terrain is drawn in a **post-pass on the same command buffer**, right after
  MapLibre ends its pass and before it presents: the MapLibre-created
  `MTKView` (a plain `MTKView`) is re-classed to a zero-ivar subclass whose
  `currentDrawable` getter — which MapLibre calls exactly once per frame, in
  `swap()`, right before `presentDrawable:`+`commit` — first encodes a blit
  (drawable → capture texture; the view is set `framebufferOnly = NO` while 3D
  is attached) and our terrain render pass. Public API only (subclassing
  `MTKView`, `object_setClass`), restored on detach. Because the capture is
  taken after _every_ layer, ordering does not matter on iOS.

Limits of the drape (documented, measured in QA):

1. **Resolution on camera-facing slopes**: the flat frame foreshortens far
   ground; a slope that faces the camera is stretched from fewer pixels. At
   pitch ≤ 70° it reads as slightly softer texture on steep faces.
2. **Off-frame ground**: terrain whose flat position is off-screen has no
   source pixel. Near the bottom edge this is avoided by the reference height
   (below); toward the top edge such fragments fade into the fog colour (reads
   as haze) instead of smearing.
3. **Overlay views** that are not GL (iOS user-location `UIView`, RN
   `MarkerView`s) stay at their flat position; GL symbols (labels, Android
   puck layers below ours) are draped and therefore positionally correct.
4. **Taps** resolve on the flat map (MapLibre's `queryRenderedFeatures`
   doesn't know about our terrain). With the reference height at the screen's
   bottom edge the error is zero there and grows with relief; documented.

### Reference height (camera altitude)

MapLibre's camera is defined relative to sea level; a 4 478 m Matterhorn
would pierce a z15 camera. Like GL JS ("centre altitude") the terrain is drawn
_relative_ to a reference height `h_ref`: `Δh = (h − h_ref) · exaggeration ·
t`. `h_ref = max(h(bottom-left), h(bottom-centre), h(bottom-right))` of the
ground under the bottom edge, smoothed over ~150 ms, so nothing near the
camera rises into view from below the frame (limit 2). Pure:
`referenceHeight`, tested.

### Terrain mesh and LOD

- **Tiles**: quadtree over Web-Mercator XYZ (512-px world tiles, MapLibre's
  convention), wrap −1/0/+1 for the antimeridian, terrain zoom ≤ 17 (DEM
  ≤ 15, deeper tiles sample the z15 DEM).
- **Shared grid**: 32×32 cells (33² vertices) + a 4-edge skirt (4·33
  vertices), one shared index buffer; per tile only a small height buffer
  `(hFrom, hTo, slopeX, slopeY)` (16 B/vertex, 19.5 KB/tile). Heights are
  baked on the CPU from the DEM (bilinear, neighbour-aware at edges so
  adjacent tiles share edge heights exactly); the quad diagonal is fixed so
  the coarse (morph) surface equals the parent tile's surface exactly.
- **Screen-space error**: `sse = (tileSizePx / 32) · ctc / distance`, with
  `ctc` the camera-to-centre distance in px and `distance` the eye → tile-AABB
  distance (heights included). Split while `sse > 6 px` (tuned in QA).
- **Culling**: frustum (planes from `P`, AABB with the tile's min/max height
  — conservative [−500, 9 000] m until known), horizon/fog (tiles beyond the
  fog end are dropped; they'd be fully fogged anyway).
- **Budget**: ≤ 240 tiles (~290 k vertices); over budget the SSE threshold is
  relaxed ×1.25 until it fits (deterministic).
- **Skirts** drop by `clamp(tileMetres · 0.03, 15, 1 500)` m.
- **Draw order**: front-to-back for early-z.

### No pop-ins: morph + parent fallback

- A tile renders as soon as _any_ ancestor DEM is loaded (heights upsampled
  from the ancestor); with none loaded it is flat (`h = h_ref`, which reads as
  the 2D map).
- Every height change is a **time morph**: the tile's buffer carries
  `hFrom` (what was on screen: the parent's surface for a fresh split, the old
  heights for a DEM upgrade) and `hTo`; `m` eases 1 → 0 over 280 ms
  (`morphFactor`, smoothstep). Merges switch at a sub-pixel SSE.
- DEM decode (PNG → Terrarium metres) and mesh baking run **off the render
  thread**; the render thread only uploads (≤ 6 tile buffers per frame) and
  draws.

### DEM pipeline

- Source: the same AWS Terrarium tiles the 2D hillshade uses
  (`s3.amazonaws.com/elevation-tiles-prod/terrarium`), z0–15, fetched natively
  (OkHttp / `URLSession`), cached on disk under the app cache
  (`terrain-dem/z/x/y.png`), decoded by our own small PNG decoder (zlib) in
  C++ — identical bytes → identical metres on both platforms, no colour
  management (CoreGraphics would gamma-convert).
- Decode rules (pure, tested): `h = R·256 + G + B/256 − 32768`; values outside
  [−12 000, 9 000] are no-data → 0; bathymetry is clamped to sea level (the
  map's water is drawn at the surface, not on the sea floor).
- LRU caches: decoded DEMs (48 MB budget, ~190 tiles), tile meshes on the GPU
  (by count), pinned while on screen. Low-memory warning → drop everything
  unpinned.
- **Prefetch** along the camera's look direction: the next-coarser ring of
  tiles ahead of the frustum (`prefetchTiles`), lower priority than visible.

### Lighting, colour, sky

- The draped frame **already carries the theme's own shading** (the Stone &
  Paper hillshade on Map; real sun shadows on Satellite), so the 3D lighting
  is a gentle _form_ term on top: `lambert` from the hillshade's light (azimuth
  335° anchored to the viewport, i.e. `bearing + 335°`, altitude 45°),
  strength 0.22 (map) / 0.18 (satellite), so lit/shadowed faces agree with the
  2D relief. The extra 2D "tilt relief" hillshade pass is switched off while
  3D is active (the geometry replaces it).
- **Map, light and dark**: fog colour = the map's own `land` token (paper /
  stone-night); sky = a 2-stop gradient derived from it (pure `skyLook`), so
  the horizon dissolves into the map's paper.
- **Satellite**: atmospheric perspective (exponential haze toward a
  blue-white), a daylight sky gradient (horizon haze → zenith blue), and the
  form term.
- Everything (height, fog, sky, form) is multiplied by the pitch ramp `t`, so
  at `t = 0` the output is the 2D frame.

### Activation, gestures, camera

- Setting: the existing **"3D relief"** row (Off / Natural / Dramatic). With
  native terrain available it no longer needs Shading (3D works on satellite):
  Natural = 1.0× exaggeration, Dramatic = 1.6×. Off = no native layer at all
  and the 60° ceiling — the 2D path exactly as today.
- Ramp: `t = smoothstep(25°, 45°, pitch)`; below 25° nothing is captured or
  drawn (the layer returns immediately), so flat use pays nothing.
- Max pitch 80° only while 3D is attached.
- Gestures stay 100 % native (MapLibre's recognisers); the layer reads the
  camera from the per-frame render parameters. **No JS work per frame.** JS
  only attaches/detaches and pushes the look (theme colours, strength) when it
  changes.

### Module layout

```
modules/inukshuk-terrain/
  cpp/           shared C++17 engine: tile math, LOD, culling, DEM/PNG decode,
                 mesh baking, LRU, look — the C++ twin of src/core/terrain3d
  cpp/gles/      Android renderer + CustomLayerHost (GLES 3)
  android/       Kotlin: Expo module, attach/detach, DEM fetcher, gesture
                 bridge, max pitch, frame stats; CMake build
  ios/           Swift Expo module + ObjC++ MLNCustomStyleLayer subclass and
                 Metal renderer
  tests/         C++ test runner (clang++, runs on macOS) checking the engine
                 against fixtures generated from the TS reference
src/core/terrain3d/   pure TS reference (Jest, hundreds of cases)
```

The TS reference is the spec; a Jest test writes/validates
`modules/inukshuk-terrain/tests/fixtures/*.json` and the C++ runner asserts
parity, so the two implementations cannot drift silently.

## Phase 3 — verification plan

- Unit: TS (Jest) + C++ parity runner.
- Visual: Android emulator (AVD `inukshuk`, SwiftShader) and the iPhone 17e
  simulator; places Zermatt, Chamonix, Mont-Sainte-Anne, Grand Canyon,
  Yosemite; pitch 0/45/70/80; Map light / Map dark / Satellite; with a PDF
  overlay and a trail; 2D tilt relief (before) vs 3D (after). Contact sheets.
- Fluidity: native gesture harness (Android: synthesized two-pointer
  `MotionEvent`s through MapLibre's real gesture detectors; iOS: a
  `CADisplayLink`-driven camera script, since iOS can't synthesize touches)
  recording frame intervals; median / p95 / worst, % > 16.7 ms and > 33 ms,
  2D vs 3D.
- Memory: RSS + our GPU allocations over a long scripted session, and after a
  simulated low-memory warning.
