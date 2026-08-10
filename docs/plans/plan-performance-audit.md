# Performance audit — 2026-08-10

Owner report: _"There is an efficiency issue on both iPhone and Android — less
laggy, more flowy."_

Static analysis + Node micro-benchmarks against the real modules. **No device
measurement was taken** (the machine's disk was reserved for another agent's
build tree), so every device figure below is an extrapolation and is labelled as
such. Desktop numbers are real and reproducible.

- **MEASURED** = ran on this Mac (Node v25.2.1, Apple Silicon) against the
  actual repo / vendored code.
- **REASONED** = inferred from code structure or extrapolated from a MEASURED
  number. Phone estimates use a 4–8× Hermes/mid-range-Android multiplier.

---

## TL;DR — where the lag comes from

The app's pure logic is in good shape. Track stats are incremental, the compass
filter is excellent, geo math allocates nothing in hot loops, store hydration is
parallel, and — checked exhaustively — **there is not one unstable Zustand
selector in the codebase**. The classic suspects are all clean.

The lag is almost entirely one shape of bug, repeated:

> **A `React.memo` boundary that can never bail out, sitting in front of
> something expensive.**

`maplibre-react-native` memoizes `<Map>` and `<GeoJSONSource>` and then does
`JSON.stringify(...)` inside their render bodies. `memo` compares props
shallowly — and `children` is a prop. Every one of those components is written
with inline JSX children, so `children` is a fresh object on every render, the
memo never holds, and the app re-serializes **megabytes of geometry and the
whole map style on every single MapScreen render**. MapScreen renders 2–4× per
second while recording (up to 12.5×/s with compass rotation on).

Everything else — the Library's zero virtualization, the Store's per-row
geometry, the synchronous filesystem writes inside reducers — is real but
secondary.

### Ranked

| #   | Finding                                                                        | Impact       | Effort  | Status                                |
| --- | ------------------------------------------------------------------------------ | ------------ | ------- | ------------------------------------- |
| 1   | `<GeoJSONSource>` memo defeated → all trail geometry re-stringified per render | **critical** | low     | **fixed on branch**                   |
| 2   | Weather playback drives ~2.9 **full native style reloads/second**              | **critical** | med     | report only (owned elsewhere)         |
| 3   | `<Map>` memo defeated → `JSON.stringify(style)` (up to 59 KB) per render       | high         | trivial | report only (needs device smoke test) |
| 4   | 3D terrain rAF loop keeps running after you leave the Map tab                  | high         | med     | report only                           |
| 5   | Weather playback interval keeps ticking + refetching tiles off-screen          | high         | trivial | report only (owned elsewhere)         |
| 6   | Whole-library GPX read + XML parse at map mount, ungated                       | high         | med     | report only                           |
| 7   | GPS watch at `BestForNavigation`, 1 Hz, never stops                            | high         | med     | report only                           |
| 8   | Library renders every card with no virtualization                              | high         | high    | report only                           |
| 9   | Locator thumbnails: ~5.5k points projected + clipped per row, per recycle      | high         | low     | **fixed on branch**                   |
| 10  | `stop()` blocks the JS thread; N+1 synchronous `library.json` rewrites         | med-high     | med     | report only                           |
| 11  | Crash checkpoint re-stringifies the whole point array every 20 fixes           | med-high     | med     | report only                           |
| 12  | Freshly-saved GPX is written, then immediately re-read and re-parsed twice     | med          | low     | report only                           |
| 13  | MapScreen re-renders 2–12.5×/s and nothing under it is memoized                | med          | high    | partly mitigated                      |
| 14  | 1 s recording timer torn down and rebuilt on every GPS fix                     | med          | trivial | **fixed on branch**                   |
| 15  | Store search re-filters + re-sorts + rebuilds thumbnails per keystroke         | med          | low     | **fixed on branch**                   |
| 16  | Library derived values recomputed on every render                              | med          | low     | **fixed on branch**                   |
| 17  | `three` (1.3 MB), `pdf-lib`, `proj4` eagerly evaluated to show the 2D map      | med          | med     | report only                           |
| 18  | `PdfRasterizerProvider` builds a 1.5 MB HTML string + WebView at app root      | med          | med     | report only                           |
| 19  | No-op store writes notify every subscriber (+ a sync file write)               | low-med      | trivial | **fixed on branch**                   |
| 20  | Full-resolution camera JPEGs decoded into 44×44 thumbnails                     | low-med      | med     | report only                           |

---

## 1. `<GeoJSONSource>`'s memo is defeated — every trail is re-serialized per render

**CRITICAL · fixed on `perf/audit-quick-wins`**

### Evidence

`node_modules/@maplibre/maplibre-react-native/src/components/sources/geojson-source/GeoJSONSource.tsx:178`
wraps the component in `memo(...)`, and line **235** serializes in the render
body:

```jsx
data={typeof data === "string" ? data : JSON.stringify(data)}
```

`memo`'s default comparator is a shallow prop compare and **`children` is a
prop**. Every source in `src/features/map/MapScreen.tsx` was written with inline
`<Layer>` children — `:1575` (live recorded trail), `:1491` (`tracks-lines`, every
saved trail), `:1428` (`tracks-heat-points`), `:1514` (`focused-trail-line`),
`:1528`, `:1553`, plus `components/HeadingCone.tsx:77`.

**MEASURED (React proof, repo-local `react-test-renderer`):**

```
children = none              → after 10 parent re-renders, stringify ran  1 time
children = inline <Layer/>   → after 10 parent re-renders, stringify ran 11 times
```

So `useThrottledLineFeature` (`MapScreen.tsx:119-155`), which carefully keeps the
live trail's _identity_ stable, bought nothing — the expensive step downstream
ran anyway.

**MEASURED cost per MapScreen render (desktop V8):**

| scenario                                       | `JSON.stringify` per render |
| ---------------------------------------------- | --------------------------- |
| live 1 000 pts + 20 saved trails + heat points | **4.76 ms**                 |
| live 4 300 pts (3 h walk @ 5 m displacement)   | 4.36 ms                     |
| live 10 800 pts (3 h @ 1 Hz)                   | 4.98 ms                     |

Breakdown: `tracks-lines` 3.38 ms (**2.24 MB** of JSON), `heatPoints` 0.50 ms
(340 KB), live trail 0.72 ms, `focusLine` 0.27 ms.

**REASONED phone:** ~20–40 ms of pure serialization per render — 1.5–3 dropped
frames — _on top of_ MapScreen's own 2100-line render. Note `showHeatmap`
defaults to `true` (`settingsStore.ts:148`) and `showTrackOverlays` to `true`
(`mapStore.ts:62`), so this is the **default** configuration.

**MEASURED-derived cumulative:** at 2 renders/s over a 3 h recording, ~84 s of JS
thread spent re-serializing geometry that never changed.

### Symptom it explains

Map pan/zoom stutter while recording; degrades as the library grows; touch
latency; the "not flowy" complaint in its purest form.

### Fix (applied)

Hoisted the static `<Layer>` element trees to module scope in `MapScreen.tsx`
(`HEATMAP_LAYERS`, `TRACKS_LINES_LAYER.{shown,hidden}`, `FOCUSED_TRAIL_LAYER`,
`INSPECT_MARKER_LAYER`, `LIVE_TRAIL_LAYERS`, `CONTOUR_LAYERS` per basemap). They
close over nothing, so this is a pure identity change — the rendered tree is
byte-for-byte the same, but `children` is now reference-stable and each source
re-serializes only when its own `data` changes.

### Risk

Low. No behavioural change; layer mount order preserved. `npm run check` passes.

### Still to do

`HeadingCone.tsx` and the two single-point marker sources still pass inline
children, but their payloads are one feature each — negligible.

---

## 2. Weather playback triggers ~2.9 full native style reloads per second

**CRITICAL · report only — the weather crossfade path is owned by another agent**

### Evidence

`MapScreen.tsx:361-443` memoizes the whole MapLibre style. The dep array is
almost entirely static — **nothing changes per animation frame or per gesture**,
which is a credit to the existing design (gesture-rate camera state lives in
refs at `:576-600`, the scrubber commits on release, `useOverlayLabelTiles`
caches in-module). Two deps churn:

- **`weatherFade`** (`weather/useWeatherCrossfade.ts:21`) produces **two** style
  objects per weather frame: the _stage_ (incoming URL into the idle slot) and,
  240 ms later, the _commit_ (the `activeSlot` opacity flip). At
  `WEATHER_FRAME_INTERVAL_MS = 700` that is **2.86 whole-style rebuilds per
  second**.
- **`marineChart`** — once per meaningful camera settle. Correct, but it drags
  the entire style with it.

The rebuild itself is cheap. What it triggers is not:

- **Android** (`android/.../MLRNMapView.kt:762-784`):
  `removeAllSourcesFromMap()` → `map.setStyle(Style.Builder().fromJson(...))` →
  `addAllSourcesToMap()`. No equality guard on the setter.
- **iOS** (`ios/.../MLRNMapView.m:341-346`): `_removeAllSourcesFromMap` → new
  `styleURL`; and `MLRNUtils.m:146-190` **MD5-hashes the JSON and writes it to a
  temp file on disk** first.

A style reload destroys and recreates **every** source — basemap raster, weather
rasters, vector labels, the marine drape — dropping their tile caches, _and_ it
tears down and re-adds every React child source (the recording trail,
`tracks-lines`, heat points, contours, PDF `ImageSource`s). So with a long Québec
track on screen, that geometry is re-uploaded to native **2.86×/second during
weather playback**.

**MEASURED style sizes and costs (real `buildOsmStyle`, run in Node):**

| Config                                  | sources | layers | serialized  | build (med) | `JSON.stringify` (med) |
| --------------------------------------- | ------- | ------ | ----------- | ----------- | ---------------------- |
| plain map                               | 2       | 3      | 0.9 KB      | 0.0005 ms   | 0.0005 ms              |
| weather + labels (real playback config) | 4       | 8      | 2.8 KB      | 0.0010 ms   | 0.0041 ms              |
| marine chart (400 soundings) + labels   | 5       | 10     | **56.8 KB** | 0.0013 ms   | 0.065 ms               |
| everything on                           | 10      | 16     | **58.6 KB** | 0.0020 ms   | 0.130 ms               |

Static/dynamic split at 58.6 KB: **the `marine-soundings` GeoJSON source alone is
54.1 KB — 92 % of the style.** One playback frame's stage→commit delta: both
strings are 60 336 bytes and **only two `raster-opacity` numbers differ** — for a
full style reload.

> **The builder is not the problem.** `buildOsmStyle` costs 0.5–2 µs. The
> suspicion that rebuilding the style JSON causes the stutter is **not
> supported by measurement**. The cost is what the rebuild _triggers_ natively.

### Fix

1. **Move the weather A/B slots out of the style** into `<RasterSource tiles={[url]}>`
   - `<Layer paint={{'raster-opacity': …}} beforeId=…>` children. Eliminates
     100 % of playback-driven style reloads (2.86/s → 0); the opacity flip becomes a
     native set-property in place. The library already supports this and the repo
     already uses the idiom for PDF overlays (`MapScreen.tsx:1341`).
2. **Move the marine soundings + depth drape out of the style** the same way.
   Style JSON 58.6 KB → ~4.5 KB (−92 %), which makes every remaining reload ~13×
   cheaper and shrinks the iOS MD5 + temp-file write per frame.

### Risk

Medium. Layer ordering must be reproduced with `beforeId` (the drape sits above
`weather-dim`, below the wave-B label layers) and verified on device in both
themes; the `beforeId` target only exists when `overlayLabels` resolved, so a
null-overlay fallback ordering is needed. **Direct collision with the in-flight
weather/marine work — sequence after it, don't merge into it.**

---

## 3. `<Map>`'s memo is defeated too — the style is stringified on every render

**HIGH · trivial fix · report only (needs a device smoke test)**

`MapScreen.tsx:1237` passes the style **object**: `<Map mapStyle={style}>`. The
object identity is stable (the memo at `:361` holds), but `Map` is
`memo(forwardRef(...))` (`Map.tsx:552`) with JSX children, so the memo can't bail;
inside, `nativeProps` is `useMemo(..., [props])` (`Map.tsx:663-674`) where `props`
is a fresh object every render — so **`JSON.stringify(mapStyle)` runs on every
MapScreen render**, style change or not.

Identical bytes mean no native call, so this is wasted JS, not a reload.
**REASONED at 60 Hz renders with the 58.6 KB marine style: ~4 ms/s desktop → ~24
ms/s on a phone.**

**Fix:** `mapStyle` is typed `string | StyleSpecification` and `Map.tsx:670` skips
its own stringify when handed a string. Stringify once inside the existing
`useMemo` — one line, same dep array — moving the cost from per-render to per
style change.

**Risk:** low but non-zero. iOS routes a JSON string through
`[NSURL URLWithString:]` first (`MLRNUtils.m:129`) and only falls back to
`RCTJSONParse`. Needs a device smoke test on both platforms, which is why it is
**not** on the quick-wins branch. (`useOfflineDownload.ts:245` already ships a
stringified style through the library, which is reassuring.)

---

## 4. The 3D terrain render loop never stops when you leave the Map tab

**HIGH — battery, "phone gets hot"**

`MapScreen.tsx:1224-1232` gates `<Terrain3DLiveView>` on the `terrain3d` flag
only — not on `screenFocused`. `terrain3d/glLifecycle.ts:66-79`'s `runRenderLoop`
re-queues `requestAnimationFrame` unconditionally while `isCurrent()` holds, and
`isCurrent()` only flips on **unmount** — which happens only when the user toggles
3D off.

The code documents the intended contract at `MapScreen.tsx:566-568` ("unmounting
is what stops the GL loop") and `WindParticleLayer` honours it exactly
(`wind/WindParticleLayer.tsx:47-51` unmounts on `AppState !== 'active'`, and
`MapScreen.tsx:578` gates on `screenFocused`). Terrain3D got neither gate.

**REASONED:** a full three.js scene update + draw call at display refresh rate,
against a detached surface, indefinitely. The most expensive idle loop in the app.

**Fix:** cheapest is to make `runRenderLoop` skip `onFrame`/`render` while
unfocused/backgrounded (keeps camera state, still queues rAF, captures ~95 % of
the win). Fuller fix: `{terrain3d && screenFocused ? … }` plus the `AppState`
unmount, with orbit state lifted into a ref so returning to the tab doesn't reset
the view.

**Risk:** medium for the unmount version (remount re-runs `onContextCreate` and
re-fetches DEM/drape tiles — the tile cache absorbs it); low for the skip-frame
version.

---

## 5. Weather playback keeps ticking and re-fetching tiles after you leave the map

**HIGH · one-line fix · report only (owned elsewhere)**

`weather/useWeatherTimeline.ts:190-198` runs `setInterval(..., 700 ms)` gated only
on `playing`, which is `mapStore.weatherAnimating` — a plain global flag, **not**
ANDed with `screenFocused`, unlike every other heavy consumer on that screen
(`MapScreen.tsx:355`, `:560`, `:573-578`). Each tick advances the frame → new
`timeParam` → new tile URL → MapLibre refetches the **entire visible weather
raster tile set** from ECCC GeoMet. Leave playback on, walk to Library, and that
loop keeps running against a map nobody is looking at.

**Fix:** `useWeatherTimeline(..., weatherAnimating && screenFocused)` — the state
already exists six lines above the call site. **Risk: very low.**

---

## 6. The whole library's GPX is read and XML-parsed at map mount

**HIGH — time-to-interactive**

`showHeatmap` defaults to **`true`** (`settingsStore.ts:148`), so
`MapScreen.tsx:221-226` widens `allTrackIds` to **every trail in the library**.
`useTrackHeat.ts:98-128` then, per id, does `storage.readFileText` → `parseGpx`
(fast-xml-parser) → `traceCells`, with only a `setTimeout(0)` yield between
tracks, and one `setCache` (⇒ one MapScreen re-render) per track. No
`screenFocused` gate, no `mapLoaded` gate, no `InteractionManager` deferral.

**MEASURED (desktop):** `parseGpx` is the most expensive pure function in the
codebase — 9.9 ms @1 000 pts, 31.6 ms @5 000, **93.7 ms @10 800**. `traceCells`
over 20 × 3 000 pts = 60.6 ms.

**REASONED:** the 20-Québec-runs fixture profile ≈ 0.6 s desktop → **3–5 s of
interleaved JS on a phone**, right when the map is doing its first render, camera
seed and first GPS fixes. It grows linearly with library size, forever.

**Fix:** (a) gate on `screenFocused && mapLoaded`; (b) defer the first batch
behind `InteractionManager.runAfterInteractions`; (c) batch `setCache` instead of
one re-render per track; (d) persist the per-track heat trace keyed on
`cacheKey(t)` so a GPX is parsed once per track lifetime, not once per launch.
**Risk:** low for (a)–(c), medium for (d) (new persisted artifact + invalidation
on trim).

---

## 7. The GPS watch runs at `BestForNavigation`, 1 Hz, forever

**HIGH — battery**

`MapScreen.tsx:183` → `useLocation.ts:127-133`:
`watchPositionAsync({ accuracy: BestForNavigation, timeInterval: 1000, … })`,
with effect deps `[minDisplacement, recheck]` (`:193`) — the only teardown is
MapScreen unmount, and bottom-tab screens stay mounted (the file says so at
`MapScreen.tsx:335-337`). The `AppState` listener (`:79-90`) _adds_ work on
background and re-establishes the watch on every foreground; it never pauses it.
The app holds `ACCESS_BACKGROUND_LOCATION` and iOS `UIBackgroundModes:
['location']`, so the OS may keep servicing it while backgrounded.

**Fix:** thread a gate into `useLocationTracking` — drop to `Accuracy.Balanced` /
a longer interval when `!screenFocused`, and remove the subscription on
`AppState !== 'active'` unless `recorderStore.status === 'recording'`. The
`recheck` mechanism already exists to re-establish it.

**Risk:** medium. `useAutoPauseOnLocationLoss` must not read a deliberate teardown
as "location lost" (that was the #116 regression) — gate the auto-pause on the
same flag.

---

## 8. The Library renders every card with no virtualization

**HIGH · structural**

`LibraryScreen.tsx:881` is a plain `ScrollView` and every item is `.map()`ed into
it (`:820-822`, `:928`, `:955`, `:971`). Worse than a plain row list, because each
card mounts a `react-native-paper` `Menu` (`:379`, `:490`, `:688`) — each with its
own state, `Animated.Value` and measuring wrapper. 200 trails = 200 Menus + 200
Cards + 400 IconButtons mounted at once, all built before first paint. The store
imposes no cap on library size (`libraryStore.ts`).

Compounded by **zero `React.memo` in `src/features/library/`**: `expandedTrack`,
`expandedMap`, `collapsed`, `cardMenu`, `selectedTrackIds` and `dragHovered` each
re-render the whole screen, so **opening one card's ⋮ menu rebuilds all N cards**.

**Fix:** extract `React.memo`'d `TrackCard`/`MapCard`/`WaypointCard` (pass ids +
`useCallback` handlers; move the open-menu comparison inside the row), then move
to `SectionList` — the sections map 1:1 onto the existing folder groups. Do both
in one change; virtualizing without memoized rows buys much less.

**Risk:** medium-high. `useDragToFolder` attaches `scrollRef`/`onScroll`/`onLayout`
to this exact `ScrollView` (`:882-886`) and auto-scrolls it
(`useDragToFolder.ts:161-165`) — `FlatList` exposes `scrollToOffset`, not
`scrollTo`. Drop targets measured via `measureInWindow` still work with sticky
headers but need re-testing.

_Credit: `useDragToFolder` is careful — the ghost uses `Animated.ValueXY` and
`onScroll` writes a ref, so scrolling does not re-render._

---

## 9. Locator thumbnails: ~5.5k points projected and clipped per row, per recycle

**HIGH · fixed on branch**

`LocatorThumb.tsx:27-30` calls `buildLocatorScene(bbox, LOCATOR_BASEMAP, 100)`
(`core/catalog/locator.ts:257-300`): bounds-reject rings, then `projectRing`
(one tuple allocated per vertex) and `clipPolygonToSquare` (**four**
Sutherland–Hodgman passes, each allocating a fresh array).

**MEASURED against the real 128-item manifest:**

```
avg points projected + clipped per thumbnail : 5,472  (of 14,315 in the basemap)
max                                          : 6,494
all 128 items (desktop V8, warm)             : 33.4 ms  → 0.26 ms/item
worst single item                            : 7.3 ms
resulting SVG                                : ~4.9 paths, ~96 vertices, ~900 chars
```

The output is tiny — **the cost is 100 % JS-side geometry**. The Canada mainland
ring alone is 5 289 points and its bbox intersects essentially every Canadian
sheet, so bounds rejection never helps for this catalog. The existing `memo`
correctly prevents rebuilds on progress ticks, but **memo does not survive
unmount**, and a FlatList recycles cells constantly.

**Fix (applied):** module-level `Map<string, LocatorScene>` keyed on the bbox.
Deterministic pure function, ~130 entries of ~900 chars. Every re-visit is now
free. **Risk:** low (already covered by `locator.test.ts`).

**Still to do:** split the 5 289-point mainland ring into a spatial grid in
`scripts/catalog/build-locator-basemap.ts` so bounds rejection actually rejects
— that fixes the _first_ render too.

---

## 10. `stop()` blocks the JS thread, with one full `library.json` rewrite per waypoint

**MED-HIGH**

`recorderStore.ts:355-424`, all synchronous: `computeTrackStats` → `buildGpx`
(fast-xml-parser `XMLBuilder`) → `storage.writeTrackGpx` → `lib.addTrack`
(→ `persist` → sync `writeJson` of the whole index) → **a loop of
`lib.addTrackNote`, each of which calls `persist` again** (`libraryStore.ts:263`).
N waypoints = **N+1 full synchronous rewrites of `library.json`**.

`storage.writeJson` (`storage.ts:435-443`) is fully synchronous — `staged.create()`,
`staged.write(JSON.stringify(...))`, `file.delete()`, `staged.move(file)`.

**MEASURED (desktop):**

| points    | `computeTrackStats` | `buildGpx`  | GPX size    |
| --------- | ------------------- | ----------- | ----------- |
| 1 000     | 0.095 ms            | 3.76 ms     | 0.16 MB     |
| **5 000** | **0.176 ms**        | **13.5 ms** | **0.78 MB** |
| 10 800    | 0.373 ms            | 32.9 ms     | 1.69 MB     |

**REASONED phone, 5 000-point track:** ~60–110 ms of computation, plus a
synchronous 0.78 MB file write, plus 9 synchronous index rewrites with 8
waypoints. **Symptom:** visible freeze on tapping Stop.

**Fix:** (a) add `libraryStore.addTrackNotes(trackId, notes[])` that persists once
— removes N−1 whole-index writes, one line per call site; (b) emit GPX by string
concatenation instead of building an object tree for `XMLBuilder` (currently two
full allocations of the track before a single character is emitted,
`gpx/index.ts:289-309`); (c) yield between stages so the button's press state
renders. **Risk:** (a) low; (b) medium — GPX is durable user data, keep the tests
and add a round-trip case; (c) low, but preserve the `stop()`-rejects-with-state-
intact contract at `useRecordingSession.ts:118-125`.

---

## 11. The crash checkpoint re-stringifies the whole track every 20 fixes

**MED-HIGH — O(n²) over a recording**

`recorderStore.ts:246-247` → `recorderCheckpoint.ts:65-73`
(`CHECKPOINT_EVERY_N_POINTS = 20`) → `storage.writeJson`. `checkpointOf`
(`recorderStore.ts:168-179`) hands it `s.points` — the entire track — and the
write is synchronous, **inside the GPS callback**.

**MEASURED (stringify only; file I/O is on top):** 0.234 ms @1 000 pts, 0.739 ms
@5 000, **2.205 ms @10 800** (~1.5 MB payload). Cumulative over 10 800 fixes: 540
writes, **596 ms** of stringify. **REASONED phone:** the last writes plausibly
block the JS thread 50–150 ms each, near the end of a long hike.

**Fix:** append-only journal (line-delimited points via `FileMode.Append`, small
header kept in the atomic JSON) → O(1) per write. Interim: scale the interval with
`n`, e.g. every `max(20, n/50)` points. **Risk:** medium for the rewrite (this is
the crash-durability path, with real tests); low for the interim throttle, though
it widens the loss window.

---

## 12. The app re-reads and re-parses the GPX it just wrote

**MED**

`stop()` saves the track; `tracks` changes; `useTrackHeat.ts:98-129` then reads
the file back off disk and `parseGpx`es it — microseconds after `recorderStore`
had those exact points in memory. `useTrackOverlays.ts:33-51` independently does
the same read+parse of the same file, into a second cache.

**REASONED, 3 h recording:** 0.4–0.7 s of blocking JS immediately after the
stop-freeze of #10, and it happens twice.

**Fix:** seed both caches from the in-memory points on save (same `cacheKey`), and
share one parsed-GPX cache between the two hooks. **Risk:** low — the cache key
(`id|pointCount|distanceM`) already makes seeding safe and self-invalidating.

---

## 13. MapScreen re-renders 2–12.5×/s and nothing under it is memoized

**MED (amplifier for everything above) · partly mitigated**

MapScreen is 2100 lines with **108 hook calls** — 20 `useState`, 12 `useEffect`,
39 store subscriptions, 15 custom hooks. `React.memo` appears **once in the entire
codebase** (`LocatorThumb.tsx`), so every render walks the whole tree.

Render triggers while recording:

1. `elapsedS` timer — `useRecordingSession.ts:75-87`, 1/s guaranteed.
2. Per GPS fix — `useLocation.ts:140` allocates a fresh position object, plus the
   recorder-store write; batched into one render.
3. The throttled line rebuild — a _second_ render pass, up to 1/s.
4. Camera settle — follow mode moves the camera per fix; `onRegionDidChange`
   (`MapScreen.tsx:1265-1279`) fires `setRegionVersion` + `setSettledBounds` +
   `setMapCenter`.
5. `headingForCamera` — `useHeadingCamera` state lives in **MapScreen**
   (`:184`), gated at `MIN_EMIT_DELTA_DEG 0.5` **and** `MIN_EMIT_INTERVAL_MS 80`
   ⇒ **up to 12.5 renders/s of the whole screen while turning**, for users with
   "Rotate map with heading" on (default off).

**Fix:** #1 removes most of the per-render cost. Then: (a) move the camera bearing
into a ref and drive `cameraRef.current.setCamera({ bearing })` imperatively from
the `subscribeHeading` callback — exactly what `CompassBadge` and `HeadingCone`
already do for their own subtrees; (b) split the recording HUD (`StatsHud`,
`RecordControls`) into a memoized subtree that owns the 1 s timer.

**Risk:** (a) medium — the imperative camera call must not fight
`trackUserLocation`. (b) low.

_Credit: the compass path is genuinely well engineered — one ref-counted OS watch
shared app-wide, a 1-Euro filter that emits literally zero state updates from a
stationary phone, and a native-driver needle animation._

---

## 14–16, 19. Fixed on the branch (details in the commit)

- **14** — the 1 s recording interval listed `lastFixAt`/`lastAccuracyM` as effect
  deps (`useRecordingSession.ts:87`), so it was torn down and rebuilt on every
  accepted fix; when fixes arrive faster than 1 s the interval never fired and the
  "independent of GPS cadence" clock was in fact driven by GPS. Now reads them
  fresh from the store inside the tick, which also drops two per-fix
  subscriptions.
- **15** — Store search had no debounce (`StoreScreen.tsx:319`): each keystroke
  re-folded 128 items (`normalize('NFD')` + regex + `toLowerCase`, uncached),
  re-sorted them (with `lastKnownPosition === null` the alphabetical comparator
  calls `foldText` twice per comparison — **~1 700 `normalize()` calls per
  keystroke**), and rebuilt every visible thumbnail. Now filters off a
  `useDeferredValue` copy. _Still to do: precompute a folded haystack per item._
- **16** — `filterTracks`, `groupByFolder` and three `sortWaypointsNewestFirst`
  calls ran on every LibraryScreen render. Memoized.
- **19** — `mapStore.setMapCenter` (`mapStore.ts:77`) had no equality guard and is
  fed a fresh object literal on **every** camera settle, including rotate/pitch-only
  gestures and follow mode moving with each fix; `settingsStore.set`
  (`settingsStore.ts:266`) had no no-op guard and every call snapshots 28 fields
  and synchronously rewrites `settings.json`. Both now bail on an unchanged value.
  Also fixed: `installStatusFor` scanned the whole library per visible Store row
  (now indexed once), the Store FlatList had no tuning props and a fresh
  `contentContainerStyle` array per render, and `useTrackOverlays` returned an
  unmemoized array that defeated the 3D drape's memo downstream.

---

## 17. `three`, `pdf-lib`, `proj4` are evaluated just to show the 2D map

**MED — cold start**

`inlineRequires` is **off** (Expo's default, not overridden), so every static
import in the eval path is eagerly evaluated. Reaching the Map tab pulls in **204
project modules plus** `three` (`three.cjs` = **1 296 606 B**), `expo-three`,
`pdf-lib` (23 MB on disk), `proj4` (**316 165 B**), `fflate`, `jpeg-js`,
`upng-js`, `fast-xml-parser`.

Three of those are for features the user has not asked for at launch:

- `pdf-lib` + `proj4` + `fflate` come entirely from `MapScreen.tsx:49`
  `import { makeMap }` — the Make-a-Map composer.
- `jpeg-js` + `upng-js` from `MapScreen.tsx:48` `MakeMapSheet` → `useMakeMapPreview`
  → `dem.ts`.
- `three` arrives via **two** chains, one of them
  `MapControlsRail` → `terrain3d/overlayControls` → `terrainMaterial.ts:7` — i.e.
  **the control rail drags in the whole of three.js even in pure 2D mode**.

**Fix, in effort order:** (1) split the pure control-rail UI from anything that
touches `three`; (2) dynamic-`import()` `makeMap` inside `startMakeMap`;
(3) `React.lazy` the `MakeMapSheet`; (4) dynamic-import `Terrain3DLiveView` when
3D first flips on. **Risk:** low-medium — on native a dynamic import is a
deferred `require`, not a network fetch, but the call sites become async.

_Not a finding: `pdfjs-dist` is **not** in the JS bundle — it ships as two Metro
assets (377 KB + 1 134 KB) loaded into a WebView._

---

## 18. `PdfRasterizerProvider` builds a 1.5 MB HTML string at app root, every launch

**MED**

`app/_layout.tsx:59` mounts it unconditionally. On mount
(`PdfRasterizer.tsx:310-330`) it does 2× `Asset.downloadAsync`, reads **377 KB +
1 134 KB** back as JS strings, concatenates them into one ~1.5 MB template
literal, and mounts a hidden `WebView` that parses and executes it. A library with
zero PDF maps pays 100 % of it.

**Fix:** keep the context, but build the HTML / mount the WebView on the first
`rasterize()` call — the queue machinery at `:346-372` already handles requests
arriving before ready. Middle option: defer the mount behind
`InteractionManager.runAfterInteractions` so it warms up _after_ first
interaction. **Risk:** medium — the README documents deliberate warm-up, and this
path has device-only history (pdf.js worker hang, MapLibre data-URI crash).
Measure first-overlay latency before shipping.

---

## 20. Full-resolution camera JPEGs decoded into 44×44 thumbnails

**LOW-MED — memory, plausible OOM on low-RAM Android**

`LibraryScreen.tsx:773-775` renders `<Image source={{ uri: w.photoUri }} />` at
44×44 (`:1123`). Photos are captured at `quality: 0.6` with **no `maxWidth`**
(`WaypointEditorDialog.tsx:70-71`), so a 3000–4000 px JPEG is decoded to a full
bitmap to draw 44 px. Compounded by #8: with no virtualization, **all** waypoint
photos decode simultaneously.

**Fix:** generate a thumbnail at capture time (`expo-image-manipulator`, ~128 px)
and point the row at it; or swap to `expo-image`, which downsamples at decode.
**Risk:** medium — needs a fallback for photos that predate thumbnails.

---

## Explicitly checked and found clean (do not regress)

- **Zustand selectors** — all 185 non-test call sites enumerated. Every one
  returns a primitive, a derived primitive, or a stored reference. **Zero**
  object/array literals, `.filter()`, `.map()`, `Object.values()` or `?? []`
  selectors; zero whole-store subscriptions. `useShallow` is imported nowhere,
  correctly.
- **Track stats are incremental**, not O(n²) — `reduceStatsWith` +
  `stepElevationGainLoss` are O(1) per fix (MEASURED: below timer resolution at
  every size). The `[...points, point]` copy is 0.006 ms at 10 800 points — 34 ms
  across a whole 3 h recording. `liveSpeed` is a bounded backward window.
- **`toLineFeature`** — 0.078 ms at 10 800 points; its throttle totals 84 ms across
  a 3 h recording. Never the problem; the `JSON.stringify` downstream was.
- **`haversineMeters` / `computeTrackStats`** allocate nothing in hot loops.
- **Store hydration is parallel and non-blocking** (`app/_layout.tsx:38-49`), with
  a single-flight guard on the library.
- **Migrations** are cheap array maps over already-parsed objects. Not a finding.
- **expo-updates does not block launch** (`fallbackToCacheTimeout: 0`). No
  font/asset preloading gates first paint. Not findings.
- **The wind particle overlay is the reference implementation** — camera state in
  a ref, `screenFocused` gate, `AppState` unmount, a frame-interval ladder.
- **`writeJson` is atomic** with `.tmp` staging; `readJson` preserves corrupt files.
- **`MapScreen.tsx:339-344`'s `useFocusEffect` + `screenFocused` is exactly the
  right primitive** — it is simply applied to 3 of the 6 things that need it
  (missing on location, weather playback, and 3D).
- **The `<Layer>` prop pipeline is cheap.** I benchmarked the real vendored
  `mergeStyleProps` + `transformStyle` + `BridgeValue` walk over MapScreen's
  actual paint objects: **17.0 µs for a full pass over all 14 layers** (the big
  heatmap expression is 2.35 µs and allocates 60 `BridgeValue` objects). Even at
  10× Hermes penalty this is ~170 µs/render. Hoisting the paint objects is worth
  doing for the _element identity_ (finding #1), **not** for the transform cost.

### A missing gate, for the record

`MapScreen.tsx:1146-1161` runs the marine-pack staleness sweep on **every**
foreground (default on), not monthly — the monthly policy governs the download,
not the check. A local "last sweep at" timestamp guard (≥ 6 h) would fix it.

---

## Suggested order of work

1. **#5** — `&& screenFocused` on the weather timeline. One line, free.
2. **#4** — stop the 3D render loop off-focus. Largest idle-CPU win.
3. **#2** — weather slots + marine soundings out of the style JSON. Largest
   interaction win; sequence _after_ the in-flight weather/marine work.
4. **#3** — memoized style _string_ (with a device smoke test).
5. **#6** — gate + defer + batch `useTrackHeat`. Largest TTI win.
6. **#7** — pause/downgrade the GPS watch off-focus.
7. **#10(a)**, **#12** — batch waypoint-note persistence; seed the GPX caches.
8. **#8** — memoized rows + `SectionList` in the Library (one change).
9. **#11**, **#17**, **#18**, **#20** — dedicated efforts, each with its own risk.

Verify with `eas observe` cold-launch / TTI metrics rather than by feel — see
`docs/CI.md`.

---

## Performance rules for this codebase

_(Proposed for `AGENTS.md`.)_

**Selectors.** Zustand selectors must return a primitive or a stored reference —
never a fresh object or array (`(s) => ({a, b})`, `.filter()`, `?? []`). In
zustand v5 that re-renders on every write to that store. Split into two
primitive selectors, or reach for `useShallow`. _This codebase is currently 100 %
clean here; keep it that way._

**Store writes.** A setter fed a fresh object must compare the value before
storing it — a no-op `set()` still notifies every subscriber, and in
`settingsStore` it also synchronously rewrites `settings.json`. Never persist
inside a reducer on a hot path; `storage.writeJson` blocks the JS thread
(stage → write → delete → move).

**MapLibre children.** `<Map>`, `<GeoJSONSource>` and friends are `React.memo`'d
and `JSON.stringify` their data in the render body — and `children` is a prop, so
**inline JSX children defeat the memo completely**. Give every source
reference-stable children: hoist static `<Layer>` trees to module scope, or wrap
the subtree in `useMemo`. This is the single most expensive mistake available on
this screen.

**Map style.** Anything that changes more than a few times a minute does not
belong in the style JSON. A new style object is a **full native style reload** —
every source destroyed and recreated, tile caches dropped, and on iOS an MD5 plus
a temp-file write. Dynamic layers go in as `<RasterSource>` / `<GeoJSONSource>` /
`<ImageSource>` children with `beforeId` for ordering, so updates become
set-property-in-place.

**Memo boundaries around the map.** MapScreen re-renders several times a second
while recording. Any child that is not trivially cheap must be `React.memo`'d and
fed `useCallback` handlers — an inline arrow prop silently disables the memo.
Prefer pushing a high-rate subscription _into_ the small component that needs it
(as `CompassBadge` and `HeadingCone` do) over lifting it into MapScreen.

**Camera and gesture streams.** Anything arriving at gesture or sensor rate goes
into a **ref**, never React state; commit to state only on settle, and drive the
camera imperatively via `cameraRef` if a value must reach it per frame.

**Focus gates.** Tab screens stay mounted. Every timer, `requestAnimationFrame`
loop, network poll, sensor watch and GL surface must be gated on `screenFocused`
(`useFocusEffect`) and, for anything expensive, on `AppState === 'active'` too.
`WindParticleLayer` is the reference implementation; copy it.

**Heavy pixel and parse work.** PNG encoding, DEM analysis, GPX parsing and
`JSON.stringify` of large payloads never run on the render path. Debounce on
settle, yield between stages (`await new Promise(r => setTimeout(r, 0))` or
`InteractionManager.runAfterInteractions`), check a request id at each checkpoint
so an abandoned pass bails, and cache the result on a content key.

**Lists.** Anything unbounded is a `FlatList`/`SectionList`, never `.map()` inside
a `ScrollView` — especially with a Paper `Menu` per row. Identity-based
`keyExtractor`, `React.memo`'d row components, `useCallback`'d `renderItem`, and
stable `contentContainerStyle`. For rows that do real work, tune the defaults
down (`initialNumToRender={6}`, `maxToRenderPerBatch={5}`, `windowSize={7}`,
`removeClippedSubviews` on Android).

**Pure-function caches.** `useMemo` dies with the component, and lists recycle
cells constantly. A deterministic pure function of stable inputs (a locator
scene, a parsed GPX, a heat trace) belongs in a module-level cache keyed on its
inputs.

**Images.** Never hand a full-resolution camera JPEG to a thumbnail-sized
`<Image>`. Resize at capture time or use a decoder that downsamples.

**Startup.** Nothing heavy may be statically reachable from the entry graph
(`inlineRequires` is off, so a static import is an eager evaluation). Feature
modules that pull in `three`, `pdf-lib` or `proj4` are dynamic-`import()`ed at
first use.
