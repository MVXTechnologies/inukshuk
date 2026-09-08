# iOS hillshade zoom-out stutter — #230

**Status:** fix landed, unmeasured. The lag is **not proven fixed** — nothing in
this branch ran on an iPhone. What is proven is the mechanism, the tile
arithmetic, and that the style still builds and renders.

---

## What was wrong

`buildOsmStyle` blends a shaded-relief hillshade under `map` and `relief`
(`SHADE_BASEMAPS`) and deliberately not under `satellite`. On a fresh install
that hillshade is the **only** render-path difference between the basemap the
owner reports as laggy and the one he reports as smooth. As shipped in 1.5.0 it
was declared like this:

|                          | as shipped  | now                          |
| ------------------------ | ----------- | ---------------------------- |
| `dem` source `tileSize`  | 256         | **512**                      |
| `dem` source `maxzoom`   | 15          | 15 (unchanged)               |
| `dem` source `encoding`  | terrarium   | terrarium (unchanged)        |
| `hillshade-2d` `minzoom` | _none_      | **11**                       |
| `hillshade-2d` `maxzoom` | _none_      | _none_                       |
| `hillshade-exaggeration` | `0.45` flat | ramp `z11 → 0`, `z12 → 0.45` |

The layer sits directly above the `osm` raster and below every drape anchor —
that position did not change.

## Why zoom-out is the worst case

Not for the reason the issue guessed. Zooming out does **not** put more DEM
tiles on screen: measured with `viewportTileCount` in `@core/geo/tiles` against
a 440 × 956 pt phone viewport, a viewport needs **15 DEM tiles at z8, 15 at z10
and 15 at z12** — flat — and only 4 at z17 where the `maxzoom` clamp overscales.

Two other things are true, and they are the actual cost:

1. **Levels, not tiles.** Every integer camera zoom crossed maps to a different
   pyramid level, and each level is a whole fresh set of Terrarium PNGs to
   fetch, decode, and hillshade-prepare. A pinch-out from z15 to z8 crosses
   seven of them.
2. **The 256-px declaration fetched one level too deep.** MapLibre's zoom is
   defined against a 512-px canonical tile, so a source declaring 256 is asked
   for `camera z + 1` — camera z12 fetched DEM **z13** — four times the tiles a
   512 declaration needs for exactly the same ground.

One z15 → z8 pinch-out, per `zoomOutTileLoad` (pinned in
`src/core/geo/tiles.test.ts`, "live-viewport DEM tile load (#230)"):

| configuration                       | DEM tiles |
| ----------------------------------- | --------- |
| as shipped (256 px, no gate)        | **105**   |
| + zoom gate at z11                  | 60        |
| + 512-px declaration                | **30**    |
| below z11 (gate unloads the source) | **0**     |

## The three fix layers

Each is a separate commit, so the owner can keep or drop them independently
once he has a number.

### 1. Zoom gate — `mapStyle.ts`, commit `map: zoom-gate the 2D hillshade…`

`hillshade-2d` gets `minzoom: 11` and an exaggeration ramp `0 → 0.45` over the
first zoom level above it (so the shading fades in instead of popping).
MapLibre only keeps a source loaded while some layer using it is within its
zoom range, so below z11 there is now **no shading and no DEM traffic at all**.
z11 is roughly "a whole mountain range on screen", where hillshading carries
almost no information. **Keep this regardless of what the device says** — it is
a free win on both platforms.

### 2. DEM trim — same commit

`tileSize: 512` on the 2D DEM source. The Terrarium PNGs really are 256 px; the
declaration is what sets the tile grid, so this trades half the DEM sample rate
— invisible in a soft shading pass blended _under_ the basemap at exaggeration
0.45 — for a quarter of the tiles and a quarter of the per-tile prepare work.

Deliberately **not** applied to:

- the **3D terrain** DEM (`terrain3d` branch, same `dem` source id but a
  separate declaration): there the DEM is the geometry, and halving its sample
  rate would visibly flatten the surface. Still 256 px / maxzoom 15.
- the **2D contour / hypso / slope** overlays: they fetch Terrarium through
  `src/features/map/dem.ts`, an entirely separate code path that never touches
  this style source.

`maxzoom` was left at 15. Lowering it would only help at high camera zoom,
which is not the reported case, and would cost visible detail where the
hillshade is actually being read.

### 3. Platform default + switch — commit `settings: "Shaded relief" switch…`

`DEFAULT_SHOW_HILLSHADE = Platform.OS !== 'ios'` in `src/state/settingsStore.ts`
is the **one** place the per-platform decision is made. iOS opens with the
hillshade off; Android keeps it on. A "Shaded relief" row in Settings → Map
(mirroring the "Scale bar" switch from #224) flips it, and the value persists.

**This layer is the temporary one.** It is a mitigation for an unmeasured
symptom, not a diagnosis. Once the A/B below produces a number, flip the
constant back to a plain `true` and keep the switch.

With the switch off the style emits no `hillshade-2d` layer and no `dem` source
at all — off means zero DEM fetches, not a hidden layer.

---

## The 60-second device A/B

On the iPhone that reported the bug, on a build carrying this branch:

1. Map screen → basemap **map**. Zoom in to street level (≈ z15).
2. Settings → Map → **Shaded relief** → **on**.
3. Back to the map. Pinch **out** in one continuous gesture to regional scale
   (≈ z8). Watch for skipped frames and for how long tiles take to appear.
4. Settings → Map → **Shaded relief** → **off**. Repeat step 3 from the same
   place.
5. Repeat both passes on basemap **relief**, then once on **satellite** as the
   known-smooth control.

Reading the result:

- **Off is smooth, on still stutters** → the hillshade is confirmed as the
  cause and the zoom gate + DEM trim were not enough. Keep the iOS-off default
  and escalate to a Metal trace (below).
- **On is now as smooth as satellite** → the zoom gate and the 512-px DEM did
  the job. Flip `DEFAULT_SHOW_HILLSHADE` to `true`, keep the switch, close the
  issue.
- **Both on and off still stutter** → it is not the hillshade at all. That is
  hypothesis 3 in the issue (OSM/Esri Topo PNG decode vs Esri Imagery JPEG),
  and this whole branch is a perf improvement that happened to miss the bug.

A second, sharper check while you are there: watch specifically whether the
stutter **stops below z11**. It should, on any build with this branch, whatever
the switch says — that is the zoom gate doing its job, and it isolates the DEM
from the basemap raster without touching a setting.

### If a number is wanted

An FPS overlay already exists on the parked probe branch `ios-perf-probe`
(`5ba1905`, "perf probe (scratch — do not merge)"). Cherry-pick it onto this
branch for the A/B, then drop it — it is scratch and must not merge.

For the real attribution: Xcode → Debug → **Capture GPU Frame** or **Metal
System Trace** while pinching out on `map`, to see whether the time is in
hillshade _prepare_ (CPU-side Terrarium decode) or the shading _draw_ (GPU).
The issue's acceptance bar is "no >32 ms frames during a full zoom-out".

---

## What this branch does and does not prove

**Proven**

- The mechanism, in code: `SHADE_BASEMAPS`, the DEM declaration, and the layer
  position (`src/features/map/mapStyle.ts`).
- The tile arithmetic, as tests: `src/core/geo/tiles.test.ts`, "live-viewport
  DEM tile load (#230)".
- The style still builds and renders correctly: built for the iOS Simulator
  (Release) and screenshotted on an iPhone 17 Pro Max — shading present zoomed
  in, absent zoomed out, Settings row present.

**Not proven**

- That the lag is gone. **No physical iPhone was available**, and the iOS
  Simulator renders through software GL, so it cannot measure the stutter. The
  simulator check above is a correctness check; **it measures no frame rate at
  all.**
- Which of the three layers matters. That is exactly what the A/B is for.

**No regression risk on Android** — the zoom gate and DEM trim apply there too
(they are strictly less work), and `DEFAULT_SHOW_HILLSHADE` leaves Android on.
