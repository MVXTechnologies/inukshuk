# Weather UX v2 — M2 (models) + M3 (Windy-style wind) design package

Owner spec (2026-08-09): Windy is the reference. M3 = thin animated flow streaks over a smooth
speed gradient (no arrows), speed/length ∝ wind speed and gusts, direction follows the field.
M2 = chevron at the right end of the M1 time scrubber → model picker + Windy-style comparison
table (rows = time, columns = models, cells = active layer's value per model).

All endpoints/layer ids below were verified LIVE on 2026-08-09 (~05:00 UTC). Repo facts verified
against the working tree (`map-chrome-batch`) and installed `node_modules`.

---

## 0. Stack facts this design is built on (verified)

- MapLibre RN v11.3.6: `onRegionIsChanging` streams full `ViewState` (center/zoom/bearing/
  pitch/bounds + `userInteraction`) during gestures; `onRegionDidChange` on settle; ref
  `getViewState()` (`node_modules/@maplibre/maplibre-react-native/.../components/map/Map.d.ts`).
  No custom-GL-layer or canvas-source API in the RN wrapper.
- `expo-gl ~56.0.6` + `three@0.162` (WebGL 1, pinned — see memory) + `expo-three@8` already ship
  in the app for the 3D terrain feature (`src/features/map/Terrain3DLiveView.tsx`).
- `@shopify/react-native-skia` is NOT a dependency (checked `package.json`). Adding it = new
  native module = new store build; expo-gl code ships OTA on the existing 1.3.0 runtime.
- Weather today: one WMS raster drape via `weatherTileUrl()` in `src/core/geo/weatherLayers.ts`,
  style-memo rebuild per frame swap (`src/features/map/mapStyle.ts` `options.weather`),
  `useWeatherFrames` (bounded radar animation), `useForecast` + `getFeatureInfoUrl` (tap card).
- M1 scrubber: branch `feature/weather-ux-m1` has no commits yet → M2 designs to an interface
  contract (§4.4), not to code.

---

## 1. Wind field data (M3) — decision: GeoMet WCS speed+direction grids, no server

**Key verified fact: GeoMet has NO U/V component layers** (0 hits for UGRD/VGRD/_VV across all
8,401 WMS layers; `HRDPS.CONTINENTAL_UU` is a styled barb composite "Winds at 10m [m/s]").
Wind exists as scalar **speed** (WSPD/WindSpeed) and **direction** (WD/WindDir) layers — and
both are WCS _coverages_, which return raw float32 grids. So the app derives components:

```
u = −spd · sin(dir·π/180)      // dir = meteorological "from" direction, degrees
v = −spd · cos(dir·π/180)
```

**Verified fetch** (HTTP 200, 11,226-byte uncompressed float32 single-band GeoTIFF, 45×60 px):

```
https://geo.weather.gc.ca/geomet?service=WCS&version=2.0.1&request=GetCoverage
  &coverageid=HRDPS.CONTINENTAL_WSPD
  &subset=lat(46,48)&subset=long(-72,-70)
  &format=image/tiff&TIME=2026-08-09T12:00:00Z
```

Same for `HRDPS.CONTINENTAL_WD`; `&TIME=` verified to select timesteps. **One animation frame =
2 requests ≈ 22 KB** for a Québec-City-sized viewport. HRDPS native grid is 0.0225° (~2.5 km,
2540×1290 EPSG:4326-aligned, lat 27.3→70.6 / lon −152.8→−40.7), so a viewport subset IS the
"coarse grid" — no resampling service needed. Uncompressed single-band float32 TIFF strips are
trivial to parse in ~100 lines of pure TS (`src/core` module, unit-tested; no geotiff.js dep).

Alternatives rejected:

- **WMS GetMap raw format**: tested live — `format=image/geotiff` → `InvalidFormat` exception.
  GetMap only serves png/jpeg/webp. Dead end.
- **PNG-encoded U/V tiles (windgl-style)**: needs our own encoding server — most infrastructure.
- **OGC API (api.weather.gc.ca)**: 104 collections, none expose NWP grids (only station-bound
  post-processed point forecasts, `prognos-*-realtime`). Not a field source.

Per-model coverage ids (all verified in WCS caps; naming scheme differs between HRDPS and the
newer models):

| Field         | HRDPS 2.5 km                                                      | RDPS 10 km                | GDPS 15 km                |
| ------------- | ----------------------------------------------------------------- | ------------------------- | ------------------------- |
| Speed 10m     | `HRDPS.CONTINENTAL_WSPD`                                          | `RDPS_10km_WindSpeed_10m` | `GDPS_15km_WindSpeed_10m` |
| Direction 10m | `HRDPS.CONTINENTAL_WD`                                            | `RDPS_10km_WindDir_10m`   | `GDPS_15km_WindDir_10m`   |
| Gust 10m      | `HRDPS-WEonG_2.5km_WindGust` (post-processed; raw HRDPS has none) | `RDPS_10km_WindGust_10m`  | `GDPS_15km_WindGust_10m`  |

Budget: prefetch the scrubber's visible window lazily — current frame + 2 neighbours, then
opportunistic fill; 48 hourly HRDPS frames ≈ 1 MB total. Honour GeoMet's ~1 req/s policy with
the existing `WEATHER_USER_AGENT` and a small fetch queue. Cache per (model, bbox-quantized,
time) in memory + `expo-file-system` LRU (weather stays online-only, cache is a courtesy).
Gotcha to encode in tests: WCS DescribeCoverage `uom` metadata is wrong (says W·m⁻²·Sr⁻¹ for
wind speed — values are m/s); errors come back as XML even when JSON was requested.

## 2. Particle rendering (M3) — decision: expo-gl transparent overlay, ported webgl-wind GPU technique

### 2.1 Why option (b), concretely

- **Proven, tiny, licence-clean, WebGL 1**: mapbox/webgl-wind is the canonical Windy-style
  renderer — 196 lines of JS + 131 lines of GLSL ES 1.00 (`texture2D`/`gl_FragColor`, no
  WebGL 2 anywhere), ISC licence. It runs on expo-gl as-is; three isn't even required (port the
  raw shaders; expo-three stays for terrain). astrosat/windgl (ISC) shows the map-projection
  shader math to crib.
- **OTA-able**: expo-gl is already in the 1.3.0 binary (3D terrain). Skia (option a) is a new
  native module → store release, +4–6 MB, and its perf evidence at 1–3k animated streaks on
  mid-range Android is indirect only (Atlas API design intent, 60fps confetti discussions —
  no direct benchmark). Skia's SkSL is fragment-only: no vertex-texture-fetch, so GPU advection
  à la webgl-wind is impossible there; it would be CPU-worklet advection. Viable, but strictly
  more risk + a build for no gain.
- **MapLibre RN style hacks (option c) are out, verified**: v11.3.6 exposes no custom GL layer
  (zero `CustomLayer` occurrences at the tag) and no CanvasSource; maintainers say full GL-JS
  parity will never come (discussion #980). Animated line layers can't advect or fade trails.
- **Prior art check**: no published wind-particle layer exists for MapLibre/Mapbox RN — this is
  a first, so the port must stay small and boring (hence webgl-wind verbatim, not a rewrite).

### 2.2 Architecture

```
WCS WSPD+WD grids ──▶ core WindField (float u/v, pure TS, tested)
                          │ encode u/v → RGBA texture (RG=u, BA=v, min/max as uniforms)
                          ▼
GLView (absolute-fill over MapView, pointerEvents="none", isOpaque=false — expo-gl's
Android GLView is a TextureView with isOpaque=false by design; clearColor(0,0,0,0))
  frame loop @30fps cap:
   1. update pass  — fullscreen quad advects particle-state ping-pong textures
                     (positions RGBA-encoded; manual bilinear sample of wind texture;
                     dropRate + dropRateBump respawn keeps streaks distributed)
   2. trail pass   — previous screen texture redrawn at fadeOpacity ≈ 0.97 (thin comet
                     tails emerge; this IS the "streak", no polylines involved)
   3. draw pass    — GL_POINTS positioned from state texture, projected grid→screen by a
                     mercator matrix built from the latest ViewState (center/zoom/bearing)
```

- Particles live in the wind grid's normalized mercator space over a fetch bbox ~1.5× the
  viewport; only the projection matrix changes as the camera moves, so pan/zoom inside the
  bbox needs no refetch. Leaving the bbox or zooming ±1.5 levels re-anchors: one new 2-request
  frame (~22 KB) and a particle re-seed.
- **Camera sync**: drive the matrix from `onRegionIsChanging` payloads (they carry full
  center/zoom/bearing/pitch/bounds — no async round-trip). The JS-thread hop means a frame or
  two of swim during fast pans, so do what Windy's mobile behavior implies: on
  `userInteraction` movement, fade the overlay toward 0 over ~150 ms and clear the trail
  buffer; on `onRegionDidChange`, re-anchor if needed and fade back in. Particles pausing
  during gestures is explicitly acceptable per spec.
- **Speed/gust mapping** (owner spec: line speed and length ∝ wind speed and gusts):
  advection speed ∝ local |wind| (speedFactor), and trail length already emerges as
  speed × fadeOpacity — fast wind = longer, faster streaks for free. Gusts: also fetch the
  gust coverage (§1 table) and give a ~20% particle subset an advection multiplier of
  gust/speed at its location — gusty areas read as sparse, noticeably longer/faster streaks
  without changing the field direction. Streak color: near-white translucent over the gradient
  (Windy look), NOT the speed ramp (the underlay already encodes speed).
- **Pitched/3D map**: v1 renders only when pitch < ~20° (fade out above, like Windy's globe
  degradations); full pitch projection is a later nicety.

### 2.3 Battery / lifecycle

30fps cap via frame-skip in the RAF loop; unmount the GLView entirely when the wind layer is
off, when `offlineOnly` is on, on AppState background, and during the gesture fade above.
Advection is GPU-side; steady-state JS work is only the camera-event handler. The 3D terrain
feature is existing proof expo-gl sustains fullscreen rendering on both target devices.
Remember GLView breaks under remote JS debugging (known expo-gl limitation — dev-doc it).

### 2.4 Graceful static fallback

The failure mode at every level (WCS fetch fails, TIFF parse fails, GL context lost, low-power
mode) is: keep the §3 gradient drape, hide the GLView. That state is also the shipped "static
mode" — the drape alone is already today's wind UX, so degradation never looks broken.

### 2.5 Device perf gates (accept/reject before default-on)

| Gate                                               | Owner's Samsung (One UI 8, test dark mode) | iPhone           |
| -------------------------------------------------- | ------------------------------------------ | ---------------- |
| Sustained FPS, 10-min soak, drape+particles        | ≥ 28 fps @ 2,000 particles                 | ≥ 30 fps @ 3,000 |
| Gesture recovery (settle → streaks visible)        | ≤ 400 ms                                   | ≤ 400 ms         |
| JS thread frame time during animation              | < 4 ms avg (camera events only)            | < 4 ms           |
| Extra battery, 15 min screen-on soak vs drape-only | ≤ 3 pts                                    | ≤ 3 pts          |

Measured via GLView frame timestamps logged behind a dev flag; failing a gate drops particle
count by 25% steps to 1,000 before questioning the approach.

The 2,000 above is the GATE — what the device must sustain — not the count we draw. The overlay
seeds `DEFAULT_PARTICLES` (`windPerf.ts`), deliberately below the gate, because density is a
visual decision and the gate is an acceptance criterion. Retuning the look moves
`DEFAULT_PARTICLES`; this table only moves if the perf contract itself changes.

## 3. Color gradient underlay (M3) — decision: GeoMet WMS drape (existing mechanism)

Reuse the shipped raster-drape path (`mapStyle.ts options.weather`) with the wind **speed**
layer (`HRDPS.CONTINENTAL_WSPD` etc.) instead of the barb composite `_UU` currently in the
catalog. The WMS default style for WSPD is a continuous speed ramp; MapLibre's raster
bilinear magnification smooths the 2.5 km cells into a Windy-like gradient at trail zooms.
Client-rendering the gradient from the U/V grid would give pixel-identical-to-Windy colours but
duplicates what the drape already does for zero code — not worth it at M3 scope. The drape runs
at `raster-opacity` **0.50**, deliberately BELOW the 0.62 default every other weather layer
uses: wind is the only layer that also draws its own ink on top, so drape + streaks at the
normal strength read heavier than any other layer at the normal strength. M3 originally
specified ≈ 0.75 here; that buried the coastlines (owner, 2026-08-10), and 0.62 was measured on
device and still washed the street grid out at 24 km/h. At 0.50 the basemap stays legible under
the streaks and the streaks keep their contrast in both themes. If the default WMS style looks
too classed/stepped
on device, the WMS `styles=` parameter can select an alternative ramp before we ever consider
client rendering (owner question Q3).

## 4. M2 — models + comparison table

### 4.1 Models to expose (all verified live, layer-scoped GetCapabilities)

| Model | Res    | Horizon / step             | Runs/day       | Time dimension (verbatim form)                            |
| ----- | ------ | -------------------------- | -------------- | --------------------------------------------------------- |
| HRDPS | 2.5 km | 48 h, PT1H                 | 4 (PT6H refs)  | interval `2026-08-09T00:00:00Z/2026-08-11T00:00:00Z/PT1H` |
| RDPS  | 10 km  | 84 h, PT1H                 | 4              | interval `.../PT1H`                                       |
| GDPS  | 15 km  | 240 h; PT1H→h84, then PT3H | 2 (PT12H refs) | **comma-separated list**, not an interval                 |

The GDPS list-form dimension means `parseTimeDimension` (interval-only today) must grow a
list/mixed parser — that's a core change with tests, and the scrubber consumes the result as an
explicit `timesMs: number[]` (uneven steps are real, not a bug).

### 4.2 Comparison-table data — decision: WMS GetFeatureInfo, one request per cell

Verified template (Québec City 46.813, −71.208 → EPSG:3857 −7,926,838.30, 5,911,604.15):

```
https://geo.weather.gc.ca/geomet?service=WMS&version=1.3.0&request=GetFeatureInfo
  &crs=EPSG:3857&width=101&height=101&i=50&j=50&info_format=application/json
  &layers=HRDPS.CONTINENTAL_TT&query_layers=HRDPS.CONTINENTAL_TT
  &bbox=-7931838.30,5906604.15,-7921838.30,5916604.15&time=2026-08-09T15:00:00Z
```

Real response (~600 B; RDPS/GDPS identical shape — same valid time gave a genuine model spread
of **22.50 / 20.81 / 21.29 °C**):

```json
{
  "type": "FeatureCollection",
  "layer": "HRDPS.CONTINENTAL_TT",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [-71.2035, 46.8204] },
      "properties": {
        "value": 22.504023,
        "title_en": "HRDPS.CONTINENTAL - Air temperature at 2m above ground [°C]",
        "time": "2026-08-09T15:00:00Z",
        "dim_reference_time": "2026-08-09T00:00:00Z"
      }
    }
  ]
}
```

Verified constraints that shape the design:

- **Multi-layer queries rejected** (`InvalidLayersParameter`) → the table is N_times × N_models
  individual requests. A 6-row × 3-model table = 18 requests × ~600 B — fire in parallel bursts
  respecting ~1 req/s average (a queue with burst 6 / refill 1 Hz keeps first paint < 2 s).
- Out-of-range `time` → **XML** ServiceException even with JSON `info_format` → parser treats
  non-JSON as "no value", cell renders "—".
- `dim_reference_time` is echoed per cell → the table header can show each model's run age for
  free (e.g. "GDPS · run 12Z").
- The existing `getFeatureInfoUrl`/`parseFeatureInfo` core pair generalizes: add `time` +
  arbitrary WMS layer name parameters — small, already-tested surface.

Per-model table layers (verified ids): temp `HRDPS.CONTINENTAL_TT` / `RDPS_10km_AirTemp_2m` /
`GDPS_15km_AirTemp_2m`; wind speed + gust as in §1; precip `HRDPS.CONTINENTAL.DIAG_PR_PT1H` /
`RDPS_10km_Precip-Accum1h` / `GDPS_15km_Precip-Accum1h` (interval accumulations — comparable
across models, unlike total-accum `_PR`).

GFS comparator: Open-Meteo verified live (`models=gfs_seamless,gem_seamless`, one ~3.4 KB
response covering all hours × models, incl. gusts) — but its free tier is **non-commercial
only** (terms fetched live). Direct NOMADS GRIB is public-domain but not mobile-feasible
(multi-MB per variable/timestep + GRIB2 decoding + rate limits). → Launch ECCC-only via
GetFeatureInfo; GFS is an owner decision (Q2).

### 4.3 UX

- Scrubber right end: chevron (`chevron-up` in a 44 pt hit target) → bottom sheet, two zones:
  1. **Model picker** — segmented row `HRDPS · RDPS · GDPS` with res/horizon captions
     ("2.5 km · 48 h"). Selecting a model swaps the active drape layer id, the scrubber's
     `timesMs`, and (M3) the wind-field coverage ids. Persist as `weatherModel` in
     settingsStore (sanitizer like `sanitizeWeatherLayer`).
  2. **Comparison table** — rows = the scrubber's next timesteps at a per-model-comparable
     cadence (every 3 h out to +24 h ≈ 8 rows); columns = models (+ run-age subheader); cells =
     active layer's variable (temp °C / wind m·s⁻¹ + gust / precip mm). Point = map centre, or
     the tap-card point when one is active. Loading skeleton per cell; "—" on error; whole
     sheet degrades to "needs a connection" offline (weather is online-only by policy).
- Timeline adaptation: scrubber renders from `timesMs[]` — hourly ticks for HRDPS/RDPS, the
  GDPS 1 h→3 h cadence change marked by tick spacing; horizon label at the right edge under the
  chevron ("48 h" / "84 h" / "10 d"). Switching models clamps the selected time to the nearest
  available step (pure helper, tested).

### 4.4 M1 scrubber interface contract (to agree with the M1 team now)

```ts
interface TimeScrubberProps {
  timesMs: readonly number[]; // explicit steps — supports GDPS uneven cadence
  valueMs: number; // clamped to nearest entry
  onChange(ms: number): void;
  trailingAccessory?: ReactNode; // M2 mounts the chevron here
}
```

M2 owns model state + time-list generation (`@core/weather/modelTimeline.ts`); M1 owns
rendering/gesture. If M1 ships a narrower API, M2 wraps it — only `trailingAccessory` is a hard
ask.

## 5. Milestones — M2 first, then M3

M2 first: it's pure JS/UI + small HTTP (days, OTA-able, no perf risk), it forces the
model/timeline core (`modelTimeline`, list-form dimension parsing, model catalog) that M3's
per-model wind fields sit on, and it gives the owner visible progress while M3's renderer is
tuned on device. M3 depends on M2's model selection; the reverse order would build wind on a
hardcoded model and rework it.

### M2 (≈1 week, OTA on existing runtime)

- Core (all with co-located tests): `weatherModels.ts` catalog (ids/labels/WMS+WCS names/
  horizons); `parseTimeDimension` list+mixed form; `modelTimeline` (times[], clamp, table rows);
  `featureInfo` generalization (per-layer + time, XML-error tolerance); table-matrix assembler.
- Features: chevron accessory, model sheet + table (Paper Dialog/Sheet, user-invoked so Portal
  is allowed per [[paper-portal-touch-swallow]]), `weatherModel` setting + sanitizer, drape
  layer-id resolution per model, fetch queue (burst 6, 1 Hz refill).
- Test strategy: Jest on all core; component test for cell states (loading/value/"—");
  Maestro crash-gate: open sheet → switch model → open table → dismiss, airplane-mode variant
  asserts the offline state (network-independent, per e2e conventions).

### M3 (≈2 weeks, OTA on existing runtime — expo-gl/three already in the binary)

1. Core first (pure, tested): float32-TIFF strip parser; `WindField` (bilinear sample, u/v
   derivation, mercator advection step); frame cache keying.
2. GL overlay behind a dev setting: gradient drape (§3) + static field render; camera sync via
   `onRegionIsChanging`.
3. Particles + trails + gust mapping (§2), pause-during-gesture, battery gates (pause on
   background/screen-off via existing keep-awake patterns, stop when layer off).
4. Device tuning against perf gates (§2.5) on the owner's Samsung (dark mode!) + iPhone, then
   default-on.

- Test strategy: advection/decoding/reseeding math in Jest (golden grids as fixtures); Maestro
  crash-gates only (toggle wind on → pan/zoom → toggle off; GLView mount/unmount is the crash
  surface — no visual asserts, animation is non-deterministic and network-dependent).
- Static fallback ships in step 2 and remains the failure mode: gradient drape + no particles
  (fetch failure, GL context loss, or "reduce motion"/low-power detection).

## 6. Owner decision questions (each with a recommendation)

1. **Renderer: expo-gl port of webgl-wind (recommended) vs adding react-native-skia.**
   GL ships OTA on the current runtime, uses proven ISC-licensed ~330-line code, GPU advection.
   Skia = new native module (store build, +4–6 MB), CPU advection, only indirect perf evidence.
   Pick Skia only if we independently want it for other UI work soon.
2. **Models at launch: ECCC-only (recommended) or +GFS column?** A GFS comparison column needs
   Open-Meteo, whose free tier is non-commercial-only (verified in their terms) — with paid
   tiers on the roadmap that means their commercial plan (€/mo) or nothing. Direct NOAA GRIB is
   not mobile-feasible. Recommend: ship HRDPS/RDPS/GDPS now; revisit GFS with budget.
3. **Gust visualization mapping.** Recommended: ~20% of particles advect at gust-scaled speed
   (longer/faster streaks exactly where it's gusty; field direction unchanged). Alternative
   (cheaper, less Windy): gusts shown only as the extra number in the table/tap-card, particles
   ignore gusts. Confirm the 20%-subset mapping.
4. **Gradient palette.** Recommended: GeoMet's server-side WSPD style first (zero code, §3);
   if it looks stepped/wrong on device next to the streaks, fall back to client-rendering the
   gradient from the same WCS grid (adds a small colormap pass to the GL overlay, ~1 day).
   Judge on-device during M3 step 2.

## 7. Sources / verification log (2026-08-09)

- GeoMet WMS caps (39.6 MB, 8,401 layers), layer-scoped caps per model, GetFeatureInfo probes
  (QC city 46.813/−71.208), WCS caps + DescribeCoverage + live GetCoverage fetches — all
  fetched live; exact URLs inline above. Docs: eccc-msc.github.io/open-data/msc-geomet/
  (`wms_en`, `wcs_en`; the old `web-services_en` URL now 404s).
- Open-Meteo live probe with `models=gfs_seamless,gem_seamless` (+ `gem_hrdps_continental`)
  and terms page (non-commercial free tier, CC-BY 4.0).
- mapbox/webgl-wind + astrosat/windgl source read (line counts, ISC, GLSL ES 1.00);
  maplibre-react-native v11.3.6 tag (no CustomLayer; `onRegionIsChanging` ← native
  `addOnCameraMoveListener`, full ViewState payload) — also confirmed in the app's installed
  `node_modules` typings; expo-gl Android `GLView.kt` (`TextureView`, `isOpaque = false`).
- Windy mobile: Capacitor WebView of the web app; WebGL particles since v11 (2017), ~30fps
  design target, Canvas-2D fallback; no public statement on gesture-pause (community threads
  imply degradation during gestures).
