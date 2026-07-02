# Inukshuk — feature analysis & roadmap (2026-06-28)

A thorough analysis of what the app does today, what's missing, and the work
started in the `feat-3d-live-and-map-overhaul` branch. Compiled from three
parallel audits (missing-features, 2D styling, 3D rendering).

---

## 1. What shipped in this branch

Four user-requested improvements (all on `feat-3d-live-and-map-overhaul`):

1. **"+" speed-dial for recording.** The bottom Record button is now a Material
   `FAB.Group` at bottom-right: a "+" that expands to labeled actions (today
   "Record track"; room for route-planning / destination-pin / import later).
   Active pause/stop/waypoint controls take over while recording.
2. **2D map → AllTrails/outdoor look.** A shaded-relief hillshade (free Terrarium
   DEM) blended under the live map; per-basemap raster tuning that desaturates the
   neon OSM palette into natural tones; warm orange-red route line with a dark
   casing. Hillshade is excluded from offline packs so it doesn't bloat downloads.
3. **Live 3D navigation.** One-finger drag pans across the terrain (two-finger =
   pinch/rotate/tilt); the view streams fresh terrain around wherever the camera
   looks, so you can travel the map like the 2D view instead of orbiting a fixed
   point.
4. **Better 3D render.** Drape texture fixed from point-sampled/linear/aniso-1 to
   LinearFilter + sRGB + max-anisotropy (sharp, correctly-bright); bilinear DEM
   downsample (was nearest); warmer low-azimuth key light for stronger relief.

**Verification status:** typecheck + lint + tests all green; new unit tests cover
the 2D style assembly and the 3D project/unproject round-trip. The **3D and map
rendering is device-only (expo-gl/MapLibre native)** and could not be visually
verified in this session — it needs an on-device pass on a real phone (ideally the
Samsung target, in both light and dark mode).

**Constraint honoured:** `three` stays pinned to r162 (expo-gl is WebGL 1), so
every 3D change is WebGL1-safe.

---

## 2. Deferred 3D render upgrades (higher risk — gate behind device testing)

From the 3D audit, not yet implemented because they carry FPS/memory risk that
needs measuring on the target device:

- **Drape one zoom deeper (z15)** for ~2× sharper imagery — but ~37 MB RGBA per
  drape; pair with a smaller box (BOX_M 4000→~2800) to offset the transient peak
  during re-anchor swaps.
- **FXAA anti-aliasing** (EffectComposer + FXAAShader) — expo-gl has no MSAA on
  Android, so near silhouettes are jagged. One fullscreen pass, GL1-safe; measure
  FPS first.
- **ACES tone mapping** — richer contrast, but shifts brightness; A/B in both
  themes before committing.
- **Mesh resolution 256→320–384** — only worth it now the downsample is bilinear;
  512² risks FPS.
- **Terrain skirt + camera clamps** — the fill-the-view currently relies on fog
  only; edges may show when orbiting out (flagged in the 3D roadmap memory).

## 3. Deferred 2D styling option

- **OpenTopoMap "Topo" basemap** — baked contours + hillshade + soft palette, the
  closest single-source match to AllTrails. Keyless but OSM-fair-use, so it must be
  **online-only and excluded from offline downloads**. A new basemap option
  touching `tiles.ts`/`mapStore`/`RegionSelectOverlay`; left out of this pass to
  keep the offline-download path untouched.

---

## 4. Missing features (prioritized) — the real product gaps

The app is excellent at _recording and overlaying_ but has near-zero _active
navigation_. It shows where you are, not where to go. There are no open GitHub
feature issues; this is the backlog.

**The largest coherent gap: turn the recorder/viewer into a navigator.** Items
3,4,6,7 below are mostly pure-TS math that fits the tested `src/core` layer —
unusually low-risk for high value.

| #   | Feature                                                                        | Effort | Why                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Background recording (foreground service)**                                  | L      | Foreground-only today; a real hike with the phone pocketed drops the track. Biggest reliability gap. Needs expo-task-manager + Play background-location review. |
| 2   | **Persist in-progress recording + crash recovery**                             | M      | recorderStore is unpersisted — an app kill mid-hike loses the whole track. Cheap insurance; ship with/before #1.                                                |
| 3   | **Follow an imported/loaded route** (route-as-target, progress %, dist-to-end) | M      | The core "someone gave me a GPX, guide me" workflow. Uses existing track math.                                                                                  |
| 4   | **Off-route alert**                                                            | M      | Point-to-polyline distance + threshold + haptic. High safety value, small math.                                                                                 |
| 5   | **Units (metric/imperial) setting**                                            | M      | Everything is hard-coded metric (`src/lib/format.ts`); blocks US/UK users.                                                                                      |
| 6   | **Distance/bearing/ETA to next waypoint or destination**                       | S–M    | Turns the existing compass + waypoints into real wayfinding.                                                                                                    |
| 7   | **Drop-a-pin / go-to-coordinate destination**                                  | S      | Lightweight standalone marker; foundation for #6. Fits the new "+" speed-dial.                                                                                  |
| 8   | **GPS smoothing + accuracy gating + auto-pause**                               | M      | Points are appended raw; noisy fixes inflate distance/D+. Improves every stat the app advertises.                                                               |
| 9   | **First-run onboarding**                                                       | S–M    | The georeferenced-PDF value prop is non-obvious; a 3-card intro + sample map lifts activation.                                                                  |
| 10  | **Aggregate/lifetime stats + per-km splits**                                   | S–M    | High perceived value, pure additive math on stored data.                                                                                                        |
| 11  | **Accessibility pass** (labels/roles on icon controls)                         | M      | Little a11y today; broadens reach.                                                                                                                              |
| 12  | **Finish 3D: offline DEM caching + M5 PDF drape**                              | L      | Polishes a flagship differentiator; lower priority than core navigation.                                                                                        |

**Deliberately deferred (separate network/paid tier):** cloud backup/sync,
accounts, weather, share-live-location, multi-day trips.

## 5. Known rough edges (from code + memory notes)

- 3D fill-the-view relies on fog only — edges may show when orbiting out (skirt +
  clamps needed; device check).
- OSM public tile policy forbids heavy traffic; 3D drape already uses Esri. A
  scaling risk if the app grows; the new 2D shaded relief uses the keyless
  Terrarium DEM (safe).
- MapLibre caps pitch ~60° (no maxPitch API); 3D "strength" only via exaggeration.
- Possible orphaned route: memory references a `/trail/[id]` notes editor, but no
  `app/trail/[id].tsx` exists — verify it's still reachable.
- In-progress recording is unpersisted (see missing-feature #2).

## 6. Open dependency/CI items (from the prior session)

- **#9 pdfjs-dist 3→6** is now a _security_ fix (it clears the one real high-sev
  vuln the nightly audit flags: arbitrary JS on opening a malicious PDF). Needs an
  on-device multi-page GeoPDF rasterizer test before merge.
- **#5 eslint 10 / jest 30** majors — need a local `npm run check` pass.
- **#65 E2E Maestro fix** — the driver-startup-timeout fix is confirmed working
  (Maestro now launches the flow), but the ubuntu runner has no KVM acceleration,
  so the emulator is slow/intermittently unstable. E2E green also needs the
  `smoke.yaml` update (done in this branch) and likely a faster/self-hosted runner
  or making E2E advisory.
