# Inukshuk — web playground

A browser copy of the app's map surface, built to **explore and decide UI and
features faster**. Speed of iteration is the product: this is a design surface,
not a shipping app, and nothing here goes anywhere near a phone.

It is a self-contained npm project. It does **not** share `package.json`,
`tsconfig.json` or `eslint.config.js` with the app — the repo root excludes
`web/` from all three on purpose.

---

## Run it

```bash
cd web
npm install      # first time only. NEVER run npm install at the repo root.
npm run dev      # http://localhost:5173  — Vite, HMR on
```

Other scripts:

```bash
npm run check        # typecheck + lint + format:check (all three must pass)
npm run typecheck
npm run lint
npm run build        # tsc --noEmit && vite build
npm run preview      # serve the production build
```

The app's own `npm run check` at the repo root is unaffected by anything in
here, and stays that way.

### Reproducible captures

Every bit of opening state is in the URL, so a screenshot can be re-taken and a
comparison can be shared:

```
?theme=dark|light          which theme to open in
?layer=wind|temp|precip|radar-rain|radar-snow|off
?at=<lng>,<lat>,<zoom>     opening camera, e.g. at=-71.2075,46.8139,10.4
?basemap=liberty|bright|positron|dark|fiord
                           force one OpenFreeMap cartography for both themes
                           (for comparing cartography under identical chrome)
?panel=catalog|tracks      open a side drawer on load
```

Example — the same viewport, both themes, wind up:

```
http://localhost:5173/?theme=dark&layer=wind&at=-71.2075,46.8139,8.4
http://localhost:5173/?theme=light&layer=wind&at=-71.2075,46.8139,8.4
```

In dev the live map is on `window.__map`, so you can try a value in the console
(`__map.setPaintProperty('weather-drape-a','raster-opacity',0.45)`) before
committing it to code.

---

## What it reuses from `@core`

This is the whole architecture. `src/core/**` is deliberately pure TypeScript —
no `react-native`, no `expo` (AGENTS.md enforces it with a lint rule) — so it
runs in a browser **unchanged**. `@core/*` is aliased straight at `../src/core`
in both `vite.config.ts` and `tsconfig.json`; nothing is copied or vendored, so
a change in the app's logic shows up here on the next HMR tick.

| Area            | Reused, unmodified                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weather catalog | `@core/geo/weatherLayers` — the layer list, WMS names, swatches, legend scales, GetCapabilities URL building, `parseTimeDimension`, `parseReferenceTimeDefault`, `formatWmsTime`                                                |
| Timeline        | `@core/geo/weatherTimeline` — `defaultTimeline` (the zero-network clock guess), `timelineFromDimension`, `nearestFrameIndex`, `wmsTimeParam`, `throttleGate`, `daySegments`, `isHourMark`, `formatTimelineLabel`, `floorToStep` |
| Drape           | `@core/weather/weatherDrape` — `weatherDrapeAnchor` (padding, span/centre snapping, pixel budget), `drapeNeedsReanchor`, `weatherDrapeUrl`                                                                                      |
| Crossfade       | `@core/weather/weatherCrossfade` — the whole A/B slot state machine and its timing constants                                                                                                                                    |
| Wind look       | `@core/weather/windLook` — `WIND_DRAPE_OPACITY`                                                                                                                                                                                 |
| Colour ramps    | `@core/weather/colorRamp` — `interpolateRamp` drives the picker thumbnails and the legend                                                                                                                                       |
| Catalog         | `@core/catalog/schema`, `shard`, `nearby`, `searchDigest`, `filterCatalog` — parsing, shard selection, URL resolution, nearest-first ranking, the search digest                                                                 |
| GPX             | `@core/geo/gpx` — `parseGpx`                                                                                                                                                                                                    |
| Track math      | `@core/geo/track` — `computeTrackStats` (distance, D+/D−, moving time, bbox)                                                                                                                                                    |
| Models          | `@core/models` — `LatLng`, `LngLat`, `BoundingBox`, `TrackPoint`, `TrackStats`                                                                                                                                                  |

The browser half of the app is only fetch, timers, DOM and MapLibre plumbing.
Every decision with a number in it comes from `@core`.

### What had to be re-expressed for the browser

- **The map style.** `src/features/map/mapStyle.ts` cannot be imported: it types
  itself against `@maplibre/maplibre-react-native` (native-only) and reads
  `MapBasemap` out of a Zustand store. Its _numbers_ are what matter, so
  `src/map/mapStyle.ts` copies them verbatim with their provenance —
  `WEATHER_REFERENCE_INK` (the cased coast/road ink, both polarities),
  `WATER_LINE_W`, `ROAD_LINE_W`, the casing allowance, the zoom interpolation,
  the road-class filter, the label layers. `useWeather.ts` copies the
  non-wind drape opacity (`0.62`) from `MapScreen.tsx`, and `ui/theme.ts` copies
  the weather dim (`#101418` @ 0.45 dark, `#F4F1EC` @ 0.38 light).

  **If you change a number in one place, change it in the other**, or the
  playground stops being a baseline.

- **The basemap mute.** The app's basemap is raster, so weather mode applies
  `raster-saturation: -0.85` to the tile pixels plus the dim. A vector basemap
  has no global saturation knob, so the same decision is expressed as a choice
  of cartography: colourful while there is no drape (`liberty` / `fiord`),
  near-neutral while there is one (`positron` / `dark`). Those two were picked
  off the published style JSON — `positron` is rgb(242,243,240) land with
  rgb(194,200,202) water, `dark` is rgb(12,12,12)/rgb(27,27,29), i.e. genuinely
  desaturated, which is what the app's basemap has become by that point.

- **The reference overlay's source.** On native it needs its own OpenFreeMap
  vector source, because the basemap under it is raster. Here the basemap _is_
  an OpenFreeMap vector style, so the pass reuses the style's existing
  `openmaptiles` source and the same `water` / `transportation` / `place`
  source-layers. Identical data, one fewer network source.

- **Frame readiness.** The app polls MapLibre native for a fully-rendered frame
  before committing a crossfade. That signal does not exist in gl-js, and
  `isSourceLoaded` is actively misleading for an `ImageSource` (it stays true
  across `updateImage`, so it reports the _outgoing_ image as ready). The
  browser has a better one: decode the URL into an `Image` first, which doubles
  as the prefetch since MapLibre's own request then hits the HTTP cache.

---

## What it deliberately does NOT do

- **No backend, no accounts, no sync.** Everything is fetched client-direct from
  public, CORS-open, key-free endpoints: ECCC GeoMet (weather), OpenFreeMap
  (basemap + glyphs), and the static catalog JSON at
  `inukshuk.mvxtechnologies.com`. There is no server to run and no state shared
  with the phone — imports here never reach a device, and nothing on a device
  ever appears here.
- **No device GPS.** "Around this view" uses the **map centre** as the origin
  instead of a fix. That turns out to be the more useful tool for this job: you
  can point it anywhere on Earth and see what the catalog holds there.
- **No PDF / GeoPDF overlays.** `@core/geo/geopdf` is pure and would parse in a
  browser, but the rendering path is the app's `pdf.js`-in-a-WebView pipeline
  and is out of scope here.
- **No wind particle field.** The app's wind layer is the colour drape _plus_ an
  animated GL streak overlay (`windGl.ts`, an `expo-gl` shader). Only the drape
  is reproduced. `WIND_DRAPE_OPACITY` is faithful, but remember you are looking
  at the wind layer with its defining element missing — the drape is deliberately
  weak (0.30) precisely _because_ the streaks carry the reading on device.
- **No 3D terrain, no offline packs, no marine chart mode, no recording, no
  Library, no Strava.** Pan/zoom/tilt only.
- **No tests.** The logic that deserves tests lives in `src/core` and is already
  tested there, under the app's coverage gate. This project is chrome around it.

---

## Layout

```
web/
  vite.config.ts        @core -> ../src/core, and fs.allow for it
  src/
    App.tsx             wiring: theme, drawers, drag-and-drop, URL state
    map/
      MapCanvas.tsx     the MapLibre GL JS instance, style swaps, viewport
      mapStyle.ts       the app's style numbers, copied with provenance
      useMapOverlays.ts rebuilds the layer stack on every style load
    weather/
      useWeather.ts     timeline + anchor + drape URL + crossfade
      LayerRail.tsx     picker with interpolateRamp thumbnails
      Legend.tsx        Windy-style value scale
      TimeScrubber.tsx  day/hour ticks, playback
    catalog/            index -> shards -> nearby / search
    tracks/             GPX import, IndexedDB, stats
    lib/                IndexedDB wrapper, stepped clock, URL state
    ui/                 theme tokens, icons
  styles.css            all chrome; both themes defined for every token
```

### A note on the layer stack

Order is the design, and it is rebuilt on every `style.load`:

```
basemap  ->  weather dim  ->  weather drape (2 crossfade slots)
         ->  cased coast/road + place labels  ->  GPX tracks
```

The dim mutes the basemap, the drape owns the colour, and the reference overlay
is redrawn **above** the drape so a saturated colour field can never swallow the
geography. Listen to `style.load`, never `styledata` — the latter fires on every
change the app itself makes, which turns a rebuild-on-style-change into an
infinite teardown loop.

---

## Known gaps worth knowing about

- **The legend ramps are approximate.** `WEATHER_LAYERS[].swatch` in
  `@core/geo/weatherLayers` is documented as approximating GeoMet's default WMS
  styles, and for wind the gap is large: the catalog swatch runs near-white
  (`#E8F2F4`) to magenta (`#C9488F`), while GeoMet's actual `CONTINENTAL_WSPD`
  default style renders light winds as a saturated `rgb(0,10,216)` blue. The
  legend and the drape are telling you different things. Same caveat applies to
  the other layers to a lesser degree.
- **Duplicate place labels.** The reference overlay draws city/town labels above
  the drape, and the vector basemap already has its own underneath. MapLibre's
  symbol collision suppresses most of the overlap, but this does not arise on
  device (where the basemap is raster and its labels are baked into pixels).
- **Catalog coverage.** As published, no shard bbox covers Québec City itself —
  the northernmost nearby coverage ends at 46.75° N — so "Around this view" at
  the home viewport shows US Topo sheets in Maine ~88 km away. That is the data,
  not the UI.
