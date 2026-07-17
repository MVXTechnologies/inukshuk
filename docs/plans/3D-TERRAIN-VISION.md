# 3D Terrain Vision — research & phased plan (2026-07-17)

Status: P1 (shader overlays + baked relief) shipped in #134; P2 (interaction
polish, §4 items 1–6) implemented on `feat/3d-terrain-p2`; P3 not started.
Produced from a web survey of Strava/FATMAP, CalTopo, Gaia, PeakVisor and a
feasibility audit of this repo's three r162 / WebGL1 / expo-gl stack.

# Best-in-class 3D terrain for Inukshuk — research report & implementation plan

## 1. What the reference apps do

**Strava / FATMAP.** Strava's proprietary Map Rendering Engine is FATMAP's tech: photorealistic 3D terrain with satellite drape, plus four analytical layers rendered _on_ the 3D surface — **Avalanche Gradient** (only slopes 25°–45°+ colored, i.e. where avalanches release), **Gradient** (full 0–90° ramp), **Aspect** (compass-direction coloring), and a winter style ([Strava press release](https://press.strava.com/articles/strava-introduces-proprietary-map-rendering-engine), [acquisition](https://techcrunch.com/2023/01/24/strava-acquires-fatmap-a-3d-map-platform-for-the-great-outdoors/), [FATMAP avalanche tool](https://fatmap.zendesk.com/hc/en-us/articles/115001419425-Avalanche-Tool-Terrain-Layer-)). What makes FATMAP _look_ good is not fancy shading at runtime — it's (a) high-res imagery, (b) multidirectional hillshade/ambient occlusion baked into the basemap so valleys read dark and ridges pop, (c) analytical overlays alpha-blended over the drape at partial opacity so terrain texture shows through, and (d) buttery inertial camera with tilt limits.

**CalTopo / Gaia GPS slope shading** (the de-facto standard the owner is asking for): fixed color bands keyed to avalanche-relevant angles — roughly **27–29° yellow, 30–31° light orange, 32–34° orange, 35–45° red, 46°+ purple/blue/black** — drawn at ~50–70% opacity over the base map ([CalTopo slope analysis](https://blog.caltopo.com/2012/02/09/avalanche-slope-analysis/), [SectionHiker comparison of Gaia vs CalTopo shading](https://sectionhiker.com/slope-angle-shading-in-gaiagps-and-caltopo/), [CalTopo high-res DEM post](https://blog.caltopo.com/2019/12/20/high-resolution-elevation-data/)). Gaia's worldwide layer is built from USGS 3DEP (10 m US) and NASA DEM (~30 m elsewhere) ([Gaia slope-angle layer](https://www.gaiagps.com/maps/source/slope-avy/), [Gaia blog](https://blog.gaiagps.com/identify-avalanche-terrain-with-new-high-res-worldwide-slope-angle-data/)) — i.e. **the same ~30 m class of data as AWS terrarium tiles**, so credible band-level slope display is achievable with your existing DEM (with the standard "not for micro-terrain assessment" caveat both apps print).

**PeakVisor** differentiates on atmosphere: sky gradient, haze/fog with distance, sun-consistent lighting, peak labels ([PeakVisor 3D maps](https://peakvisor.com/en/3d-maps.html)). **Gaia 3D** is just MapLibre-style tilted terrain with any 2D layer draped — proof that "any overlay draped on relief" is the winning architecture ([Gaia 3D maps help](https://help.gaiagps.com/hc/en-us/articles/15625779394583-Using-3D-Maps-on-gaiagps-com)). **maplibre-gl-js** ships sky/fog/horizon-blend controls and five hillshade methods (incl. `multidirectional`, `igor`) worth imitating ([sky-fog-terrain example](https://maplibre.org/maplibre-gl-js/docs/examples/sky-fog-terrain/)). **maplibre-contour** (onthegomap) demonstrates the modern consensus for contours: generate them **client-side from the raster DEM you already cache**, never host contour tiles ([maplibre-contour](https://github.com/onthegomap/maplibre-contour)) — in your 3D pipeline the analogue is even simpler: draw isolines in the fragment shader.

## 2. Feasibility facts verified in your stack

- **`fwidth()` works.** three r162 in WebGL1 injects `#extension GL_OES_standard_derivatives : enable` whenever the material is `physical` (i.e. **MeshStandardMaterial always has it**) or `material.extensions.derivatives = true` — verified in your `node_modules/three/build/three.module.js` lines 17294/19445/20884. expo-gl ships the Khronos conformance test for the extension ([expo/gl-conformance](https://github.com/expo/gl-conformance/blob/master/conformance-suites/1.0.3/conformance/extensions/oes-standard-derivatives.html)); derivatives are core in OpenGL ES 3, which is every device your app runs on. Still add a `gl.getExtension('OES_standard_derivatives')` runtime guard with a no-contour fallback.
- **Everything below is JS-only → OTA-able**, and derives from DEM tiles you already download and cache (`storage.downloadBytes` in `dem.ts`) → **zero new network, fully offline**.
- **Vertical exaggeration trap:** `terrainScene.ts` applies `vExag = 2.6`. Slope computed from mesh normals would be wrong by `atan(2.6·tan θ)`. Compute slope on CPU **in metre space from the heightmap** instead — which also makes it pure, testable core code.

## 3. Recommended architecture

Keep the current single-mesh pipeline. Add one pure-core "terrain analysis" module + one shader-injection module, and thread a `TerrainOverlay` option through `buildTerrain`.

**New pure core — `src/core/geo/terrainAnalysis.ts`** (co-located tests, no RN/expo imports):

- `slopeDegrees(data, grid, cellXm, cellZm): Float32Array` — Horn 3×3 gradient on the metre-space grid (what CalTopo/GDAL use).
- `aspectDegrees(...)` — `atan2` of the gradient (free bonus layer, Strava has it).
- `multidirHillshade(data, grid, cellXm, cellZm): Float32Array` — 4-azimuth soft hillshade + cavity term (0..1).
- `slopeRampRgba(): Uint8Array` — 256×1 CalTopo-style ramp (transparent < 27°, yellow→red→purple bands), so band edges are data, not shader branches.

**Shader injection — `src/features/map/terrain3d/terrainMaterial.ts`** using `material.onBeforeCompile` on the existing `MeshStandardMaterial` (keeps lights/fog/texture handling; derivatives already enabled):

New geometry attributes/uniforms: per-vertex `aElevM` (metres, from the heightmap — do _not_ reconstruct from exaggerated y) and `aSlopeDeg`; uniforms `uSlopeOpacity`, `uHypsoOpacity`, `uContourInterval`, `uContourMajorEvery`, `uMinH/uMaxH`, ramp `DataTexture`s.

Fragment snippet injected after `#include <map_fragment>`:

```glsl
// --- slope bands (toggleable) ---
vec4 slopeC = texture2D(uSlopeRamp, vec2(clamp(vSlopeDeg / 90.0, 0.0, 1.0), 0.5));
diffuseColor.rgb = mix(diffuseColor.rgb, slopeC.rgb, slopeC.a * uSlopeOpacity);

// --- hypsometric bands ("isobar-like" tint) ---
float band = floor(vElevM / uHypsoInterval);
vec3 hypso = texture2D(uHypsoRamp, vec2((band * uHypsoInterval - uMinH) / (uMaxH - uMinH), 0.5)).rgb;
diffuseColor.rgb = mix(diffuseColor.rgb, hypso, uHypsoOpacity);

// --- anti-aliased contour lines (fwidth) ---
float wpx = fwidth(vElevM);                         // metres of elevation per screen pixel
float dMinor = abs(fract(vElevM / uContourInterval - 0.5) - 0.5) * uContourInterval;
float minor = 1.0 - smoothstep(0.5 * wpx, 1.5 * wpx, dMinor);
float majorI = uContourInterval * uContourMajorEvery;
float dMajor = abs(fract(vElevM / majorI - 0.5) - 0.5) * majorI;
float major = 1.0 - smoothstep(0.8 * wpx, 2.2 * wpx, dMajor);
// auto-density: fade minors out when they'd alias (this is the key to it looking premium)
minor *= 1.0 - smoothstep(0.25, 0.5, wpx / uContourInterval);
diffuseColor.rgb = mix(diffuseColor.rgb, uContourColor, max(major * 0.55, minor * 0.3));
```

This is the standard fwidth-isoline technique ([three.js forum: drawing isolines with shaders](https://discourse.threejs.org/t/drawing-isolines-using-shaders/54382), [contour lines on terrain](https://discourse.threejs.org/t/how-to-add-contour-lines-to-terrain/58484)). Per-vertex `aElevM` interpolates linearly across triangles; at your ~15 m grid spacing (4 km box / 256 grid) contours look smooth at normal viewing distances. If close-up angularity bothers later, upgrade to a NEAREST-filtered terrarium-encoded elevation texture with 4-tap manual bilinear decode in the fragment shader (do not LINEAR-filter terrarium RGB — channel interpolation corrupts elevations).

**Lighting/atmosphere upgrades** (cheap, big wins):

1. Multiply `multidirHillshade` into the drape texture RGBA on CPU before upload (FATMAP's baked-relief look; free at render time; also fixes the flat washed look of the street-map drape).
2. Sky dome: inverted sphere with a 3-stop vertical-gradient `ShaderMaterial` (zenith blue → horizon haze) replacing the flat clear color; keep `THREE.Fog` tuned to blend into the horizon stop — and **add fog to `Trail3DGLScreen` too** (it currently has none, so the slab edge is visible).
3. Nudge `MeshStandardMaterial` with slight `envMapIntensity`-free rim: add `float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0)` × subtle sky color in the same injection — makes ridgelines glow against the sky.
4. Skirt geometry: extrude the mesh border down (a one-loop addition in `buildTerrain`) so re-anchoring/edges never show the slab underside.

**Data note:** AWS terrarium is SRTM ~30 m globally, 10 m NED in the US, 25 m EU-DEM in Europe ([tilezen data sources](https://github.com/tilezen/joerd/blob/master/docs/data-sources.md)) — same class as Gaia's worldwide slope layer, so band display is credible; show a one-time "slope shading is indicative, not for avalanche decision-making" disclaimer like CalTopo/Gaia do.

## 4. Interaction: current vs missing

Already there (`orbitGestures.ts`, both screens): pinch zoom (radius 0.8–9), twist-to-rotate + drag-to-tilt (live), one-finger orbit (trail) / pan (live), tilt clamps (phi 0.12–1.25/1.45), follow mode + re-anchor streaming, scrub marker.

Missing, in impact order:

1. **Inertia** — everything stops dead on release. Track velocity in the responder, decay it in `onFrame` (exp damping ~0.9/frame, stop under epsilon). Pure helper (`applyMomentum(orbit, vel, dt)`) → unit-testable.
2. **Zoom toward the finger** — pinch currently dollies about the look-at point. Fix: ray-march the analytic `heightAt` sampler from the pinch-centroid ray to find the ground hit `H`, then `center = H + (center − H) · s` while scaling radius by `s`. `heightAt` already exists on `TerrainBuild`; the ray-march is pure math → testable.
3. **Tap-to-query** — same ray-march; `unproject` the hit → lat/lng, elevation (heightmap), slope (new slope grid); show a small chip "1 742 m · 31°" + a temporary crosshair pin. This is the feature that makes slope shading feel interactive.
4. **Smooth fly-to** — recenter currently snaps theta/phi. Ease orbit params with a critically-damped spring over ~600 ms.
5. **Camera-terrain collision** — clamp `camera.y ≥ heightAt(camera.x, camera.z) + margin` in `positionCameraFromOrbit` callers; at phi 1.45 and small radius you can currently clip through peaks.
6. **Double-tap to zoom** (toward tap point, reusing #2's math).

## 5. Phased plan

**P1 — shader overlays + baked relief (the requested features).** ~3–5 dev days. JS-only → OTA-safe.

- `terrainAnalysis.ts` (slope/aspect/hillshade/ramps) + tests: inclined-plane grids give exact expected slope/aspect; hillshade bounds/monotonicity; ramp band-edge values at 27/30/32/35/45°.
- `terrainMaterial.ts` injection + `aElevM`/`aSlopeDeg` attributes in `buildTerrain`; overlay state in `mapStore`/`settingsStore`; toggles in the basemap bar (Trail screen) and speed-dial (live map): Slope / Contours / Hypso, contour interval Auto (span-based: 10/25/50/100 m).
- Bake hillshade into drape; sky dome + fog on the trail screen.
- Risk: **medium** — shader compile failures are device-only (CI stays green; see your pdf-overlay and three-pin incident history). Mitigate: `gl.getExtension` guard, try/catch around first render with fallback to the un-injected material, and mandatory on-device pass (Samsung, dark mode) via a dev build — not the production-OTA sed trick.
- Test strategy: all band math mirrored in TS and unit-tested (the GLSL is a transcription); Maestro E2E can only assert toggles exist; visuals need the device.

**P2 — interaction polish.** ~3–4 days. OTA-safe. Items 1–6 above; inertia/ray-march/fly-to springs as pure helpers in `terrain3d/` or `src/core` with tests (momentum decay, ray-hit on synthetic terrain, spring convergence). Risk: low (no new GL surface); feel-tuning needs hands on device.

**P3 — bigger world + sharper near field.** 1–2 weeks. OTA-safe but the riskiest.

- Concentric-ring LOD: keep the 256-grid inner box, add a coarse outer ring (z−2 DEM, 64-grid) to push the horizon from ~4 km to ~15 km; stitch with skirts (skirts, not T-junction stitching — cracks hidden, far simpler). Raise drape sharpness near-field by one zoom (clamp 6→8 tiles inner only; watch memory: 2048² RGBA = 16 MB).
- Optional: peak labels via RN overlay views projected through `project()` with depth test against `heightAt` (GL text is painful in expo).
- Risk: medium-high (memory on low-end devices, re-anchor complexity interacting with two meshes).

M5 (PDF drape onto 3D) composes cleanly with all of this: a PDF is just another drape texture; the overlay injection sits on top regardless.

## 6. Explicit WebGL1 / r162 ceiling (not feasible or not worth it)

- **Real-time sun shadow maps**: technically possible but grazing-angle acne on terrain + fill cost + expo-gl render-target quirks make it a bad trade; baked multidirectional hillshade gives 90% of the look for ~0 runtime cost.
- **Post-processing (SSAO, bloom, tone-map passes)**: float/half-float render targets and MSAA-resolve control are not guaranteed on WebGL1/expo-gl; EffectComposer is historically flaky there. Bake AO instead.
- **GPU-driven LOD / geometry clipmaps via transform feedback or instancing tricks**: WebGL2-only. CPU-built ring LOD (P3) is the ceiling.
- **Photorealistic PBR + atmosphere scattering** (FATMAP-quality imagery lighting): imagery resolution and GLES2-class shading budget cap this; the baked-relief + fog + sky-gradient combo is the attainable look.
- **In-scene text** (contour labels, peak names in GL): no canvas for glyph atlases in expo-gl; 3D apps generally skip contour labels — do the same; peak names only via RN overlay (P3 stretch).
- **Upgrading three for TSL/modern isoline helpers**: forbidden — r163+ drops WebGL1 and breaks on device while CI stays green (your pinned-three memory).

Key files for the implementer: `src/features/map/terrainScene.ts` (attributes, skirt, bake hook), `src/features/map/terrain3d/sceneSetup.ts` (sky/lights), `src/features/map/terrain3d/orbitGestures.ts` (inertia/zoom-to-point), `src/features/map/Terrain3DLiveView.tsx` + `Trail3DGLScreen.tsx` (toggles, tap-to-query), new `src/core/geo/terrainAnalysis.ts` (+tests), new `src/features/map/terrain3d/terrainMaterial.ts`.

Sources: [Strava MRE press release](https://press.strava.com/articles/strava-introduces-proprietary-map-rendering-engine) · [TechCrunch on FATMAP acquisition](https://techcrunch.com/2023/01/24/strava-acquires-fatmap-a-3d-map-platform-for-the-great-outdoors/) · [FATMAP avalanche/terrain layers](https://fatmap.zendesk.com/hc/en-us/articles/115001419425-Avalanche-Tool-Terrain-Layer-) · [CalTopo avalanche slope analysis](https://blog.caltopo.com/2012/02/09/avalanche-slope-analysis/) · [CalTopo high-res elevation](https://blog.caltopo.com/2019/12/20/high-resolution-elevation-data/) · [SectionHiker: Gaia vs CalTopo slope shading](https://sectionhiker.com/slope-angle-shading-in-gaiagps-and-caltopo/) · [Gaia slope-angle source](https://www.gaiagps.com/maps/source/slope-avy/) · [Gaia worldwide slope-angle blog](https://blog.gaiagps.com/identify-avalanche-terrain-with-new-high-res-worldwide-slope-angle-data/) · [Gaia 3D maps](https://help.gaiagps.com/hc/en-us/articles/15625779394583-Using-3D-Maps-on-gaiagps-com) · [PeakVisor 3D maps](https://peakvisor.com/en/3d-maps.html) · [maplibre-contour](https://github.com/onthegomap/maplibre-contour) · [MapLibre sky-fog-terrain](https://maplibre.org/maplibre-gl-js/docs/examples/sky-fog-terrain/) · [three.js forum isolines](https://discourse.threejs.org/t/drawing-isolines-using-shaders/54382) · [three.js forum terrain contours](https://discourse.threejs.org/t/how-to-add-contour-lines-to-terrain/58484) · [MDN OES_standard_derivatives](https://developer.mozilla.org/en-US/docs/Web/API/OES_standard_derivatives) · [expo/gl-conformance derivatives test](https://github.com/expo/gl-conformance/blob/master/conformance-suites/1.0.3/conformance/extensions/oes-standard-derivatives.html) · [tilezen DEM data sources](https://github.com/tilezen/joerd/blob/master/docs/data-sources.md)
