# Native 3D terrain inside the MapLibre map ("Option C")

Status: "Match Outmap" checkpoint (per-tile drape of the 2D style on a finer mesh, see below); branch `feat/native-3d-terrain`, HOLD for owner review.
Store build only — this is native code (a new local Expo module), never an OTA.

## Goal

Two-finger tilt on the main map (up to 80°) shows **real 3D relief** — the
ground rises into mountains — while the surface keeps showing exactly the map
the user sees (Stone & Paper light/dark, satellite, contours, trails, heatmap,
PDF overlays), at 60 fps, with no hitch when tiles load. The 2D path (pitch
below the threshold, or the setting off) must be byte-for-byte what ships
today.

## 2026-10-03 — "Match Outmap": per-tile drape (supersedes the shaded model below)

The owner judged the shaded relief model "not working at all well" (blobby,
monotone, contours dominant) and chose Outmap's approach: sharp terrain with
**our map painted on crisply** (forest, water, glaciers in the theme's
colours), a pin on every summit, smooth movement. Unlike the rejected
"frame drape" (the screen frame reused as a texture, blurry), each terrain
tile now samples its own texture rendered from the 2D style at a proper
resolution — the render-to-texture draping of Mapbox/MapLibre GL terrain.

Architecture decision (evidence 2026-10-03):

- (a) Upstream MapLibre Native terrain (`feature/terrain-3d`, draft #4190):
  real RTT draping on all backends, Metal verified on device, but measured
  at **~22 fps at 65° pitch on an iPhone 16 Pro Max** (its TERRAIN.md), the
  gestures-on-terrain and symbol PRs still open (#4558/#4559/#4711/#4712),
  the darwin runtime API PRs closed unmerged, the branch 50 commits behind
  main, and shipping it means a self-built MapLibre fork for iOS _and_
  Android (Bazel/NDK builds, many GB). Rejected for now; revisit when a
  release ships terrain.
- (c) MapLibre GL JS terrain in a WebView: mature, but a second map engine
  beside the native map (gestures, offline packs, PDF overlays, memory).
  Rejected.
- (b) **Chosen**: keep our engine (mesh, LOD, morphs, pins, 80° gestures,
  0.1–0.2 ms/frame) and drape textures rendered by **MapLibre's own
  offscreen renderer** (`MLNMapSnapshotter`; Android has `MapSnapshotter`):
  - `drapeStyle()` (`src/core/terrain3d/drapeStyle.ts`): the live style
    without symbol layers or the tilt pass, contours softened, the hillshade
    at every zoom with more contrast, its DEM read two zooms deeper.
  - A drape tile = a mesh tile. Map: rendered one zoom out at 2× (the 2D map
    at the scale a terrain tile shows, 512 px); satellite: at the tile's zoom
    at 1× (the imagery's own 512 px). One snapshot renders a 2×2 block (four
    drapes), up to three snapshotters in parallel, ~50–60 ms per snapshot.
  - Engine: drape mode, per-slot textures of any power-of-two size with a
    CPU mip chain, generations (a new style drops stale renders), parent
    windows while children render, 160 slots (~224 MB).
  - Metal: trilinear + 16× anisotropic sampling; analytic contours off
    under the drape; mesh lighting reduced to the large forms.
  - Mesh: 64 cells per tile edge on iOS over the same 32-cell LOD (sharper
    ridges, same tile count); Android still bakes 32 (its GLES height atlas
    is sized for it).
  - Pins: candidates filtered to the view footprint before ranking (the
    loaded tiles held ~10 000 summits, truncated to off-screen ones).

Open: Android port of the drape (MapSnapshotter + GLES per-slot textures),
texture memory budget per device class, pin density vs Outmap, contour
legibility at very steep slopes.

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

### The scene: real 3D layers, no draping (owner decision on #551)

The first implementation draped the captured 2D frame on the mesh ("frame
drape"). The owner rejected it on review: _"I don't want draping! I want the
3D, then the contour lines added as 3D geometry so it doesn't look painted,
then the labels as 3D pin labels."_ The layer now draws **its own scene**; it
captures nothing from MapLibre.

Past the pitch ramp the custom layer — kept on top of the style — draws, in
order, crossfading in with the ramp `t` (alpha = `t`, so the 2D map dissolves
into the 3D scene over 25°–45°, no hard cut):

1. **Sky** — a horizon→zenith gradient in theme colours, haze below the
   horizon.
2. **Terrain surface** — the quadtree mesh, shaded by us:
   - _Map style (light/dark)_: base colour = the map's `land` token, a rock
     tint (`landAlt`) above 2200–3400 m (max 35 %), water and glaciers from
     per-tile **masks** (vector `water` polygons, `landcover` glaciers,
     rasterised into the tile's 64² detail texture by the bake worker; sea
     level from the DEM), lit like the 2D hillshade — NW sun (`bearing +
335°`, 45° altitude), soft shadow toward the theme's `shadow` mix (0.62),
     highlight on lit faces (0.45), and a slope darkening term (0.18) for crisp
     ridgelines without a plastic look. `src/core/terrain3d/surface.ts`.
   - _Satellite_: Esri World Imagery tiles as per-tile textures (192 slots of
     256², same LOD as the mesh, parent windows while children load, 300 ms
     crossfades), plus a gentle form term.
   - Fog / atmospheric perspective toward the theme's fog colour.
3. **Contours as geometry** — evaluated per fragment from the surface's real
   height: distance to the nearest level divided by the screen-space height
   gradient (`fwidth`), so lines are a **constant screen width** (minor 1.1,
   index 2.0 logical px), anti-aliased, never blurred and never swimming —
   they sit on the 3D surface, not in a texture. Intervals follow the 2D
   ladder by zoom (`contourLevels`) and step coarser where the terrain is
   foreshortened (≥ 5 px between lines), with a crossfade between levels;
   every 5th (the index line) is thicker and darker. Colours are the map's
   contour tokens; on satellite they follow the "contours on satellite"
   setting. We evaluated marching-squares polylines with a depth bias as the
   alternative: the analytic form needs no extra geometry, has no z-fighting
   and adapts its density per pixel, so it won. `contours3d.ts`.
4. **Trails** — shown trails, the focused trail and the live recording as 3D
   polylines lifted onto the DEM (densified to ~15 m), extruded to a constant
   screen width with a halo, depth-tested against the terrain with a small
   bias. `lines.ts`.
5. **3D pin labels** — peaks (our peaks tiles, banded rank #549), places (by
   `min_zoom`), huts/shelters/passes/viewpoints and named lakes, read from the
   vector tiles MapLibre already loaded (native queries on camera idle and
   every ~1.2 s while moving; no per-frame JS). Each is a paper plate in
   Atkinson (rendered once into a 2048² sprite atlas), on a thin stem above a
   ground dot anchored at its real (lon, lat, terrain height). Every frame the
   engine projects them, declutters by priority with screen-space collision,
   fades them in/out (220 ms, no popping), scales/fades with distance, and
   hides those the terrain occludes (a ray march against the displayed
   heights). `labels.ts`.
6. **Location marker** — projected at the terrain height under the fix.

The 2D map is untouched below 25° (the layer returns immediately), and with
the setting off the module is never attached.

Per platform, the layer draws straight into MapLibre's render pass:

- **Android (GLES 3)**: one instanced draw per 128 tiles (heights in an
  RGBA32F atlas, detail textures in a 2D array, imagery in a lazily created
  array), lines and sprites after, all inside `render()`.
- **iOS (Metal)**: `MLNCustomStyleLayer` exposes MapLibre's
  `renderEncoder`/`renderPassDesc`; we build pipelines matching its
  attachments (colour, depth-stencil, sample count) and draw directly — no
  post-pass, no `MTKView` re-classing. Depth is "cleared" with a full-screen
  draw at z = 1 (MapLibre's 2D depth means nothing to the scene).

**PDF overlays** are not in the 3D scene yet (they show in 2D below the
ramp). Next phase: render each overlay's raster into per-tile textures where
it covers, sampled like the imagery slots.

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

- Light: the 2D hillshade's — azimuth 335° anchored to the viewport
  (`bearing + 335°`), altitude 45° — so lit and shadowed faces agree with the
  2D relief. The 2D "tilt relief" pass is switched off while 3D is active.
- Map light/dark: all surface colours come from the Stone & Paper tokens
  (`land`, `landAlt`, river `water`, ochre `contour`, `ink` for the index
  lines and shadows) via `terrainLook` (`look.ts`); fog = the land colour, so
  the horizon dissolves into the paper.
- Satellite: haze toward a blue-white, a daylight sky.

### Activation, gestures, camera

- Setting: the existing **"3D relief"** row (Off / Natural / Dramatic). With
  native terrain available it no longer needs Shading (3D works on satellite):
  Natural = 1.0× exaggeration, Dramatic = 1.6×. Off = no native layer at all
  and the 60° ceiling — the 2D path exactly as today.
- Ramp: `t = smoothstep(25°, 45°, pitch)`; below 25° nothing is
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
