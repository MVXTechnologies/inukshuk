# Inukshuk — web playground

A browser copy of the app's **map**, **Library** and **trail focus** surfaces,
built to **explore and decide UI and features faster**. Speed of iteration is
the product: this is a design surface, not a shipping app, and nothing here goes
anywhere near a phone.

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

?view=map|library|trail    which primary surface is up
?trail=<id>                the focused trail (implies view=trail)
?sort=recent|oldest|distance|ascent|duration|pace|name
?w=phone|wide              Library column width: 390 px or 720 px
?trimAt=rail|title|bottom  where the trim scissors sit (backlog item 6)
?units=metric|imperial     unit system handed to the app's own @lib/format
```

Unlike the map parameters, the Library/trail ones are also written BACK into the
address bar as you click, so the URL always describes what is on screen and any
screenshot can be handed over as a link.

Example — the same viewport, both themes, wind up:

```
http://localhost:5173/?theme=dark&layer=wind&at=-71.2075,46.8139,8.4
http://localhost:5173/?theme=light&layer=wind&at=-71.2075,46.8139,8.4
```

Example — the Library in both widths, and one trail with each candidate trim
placement:

```
http://localhost:5173/?view=library&layer=off&w=phone
http://localhost:5173/?view=library&layer=off&w=wide
http://localhost:5173/?trail=r-msa&layer=off&trimAt=rail
http://localhost:5173/?trail=r-msa&layer=off&trimAt=title
http://localhost:5173/?trail=r-msa&layer=off&trimAt=bottom
```

In dev the live map is on `window.__map`, so you can try a value in the console
(`__map.setPaintProperty('weather-drape-a','raster-opacity',0.45)`) before
committing it to code.

---

## The Library and trail focus

These are the two screens with the most open layout questions, which is why they
are here. Both are floating columns over the live map, in the same panel
language as everything else — the map stays the ground, and the trail you open
is drawn on it while you read its numbers.

### Two widths, on purpose

The Library header has a **Phone / Wide** switch (`?w=`). `phone` is 390 px — a
real device width, so a trail card wraps exactly where it wraps on the phone.
`wide` is 720 px: what the same list could be if it were allowed the room. The
card and stat-tile grids reflow between them from the same markup and the same
formatters, so the comparison is honest. Deciding between them is one of the
questions this screen exists to answer.

### Library — what it reproduces

| From the app                                                                                                                                 | Here                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Folder groups, one per folder, empty ones included; `TripA (3)` but bare `TripA` at zero                                                     | same, via `groupByFolder` + `folderItemCount`                                                                |
| Waypoints get a flat section ONLY when no folders exist; otherwise they sit inside each group after its trails, newest first                 | same, via `sortWaypointsNewestFirst`                                                                         |
| Trail card: name, `formatTimestamp`, then distance / duration / pace / ↑D+ / ↓D−, with duration+pace dropped entirely when `durationS === 0` | same fields, same order, same formatters — laid out as a grid (see below)                                    |
| Waypoint row: pin, label, one-line `notePreview` (80 chars, omitted when blank), timestamp                                                   | same                                                                                                         |
| Category chip colour + glyph, and the 4 px left border in the category colour                                                                | same; the MaterialCommunityIcons glyph NAMES from `@core` are redrawn as inline SVG in `ui/CategoryIcon.tsx` |
| `TrackFilterDialog`: category multi-select + Uncategorized, four date presets, four ranges                                                   | same criteria, same unit scaling, evaluated by `filterTracks`                                                |
| Filtering shrinks folder counts and never touches waypoints                                                                                  | same                                                                                                         |
| `⋮` menu: view on map, set category, trim, move to folder, delete                                                                            | same                                                                                                         |
| Drag an item's grip onto a folder header to move it                                                                                          | same, as HTML5 drag-and-drop                                                                                 |
| Folder visibility (`Everything` + one row per folder + `Ungrouped`)                                                                          | same rules, via `nextFolderVisibility` — but moved ONTO this screen (see below)                              |

### Trail focus — what it reproduces

The stat block, the elevation profile and the trim UI. The profile is a
near-literal port of `src/features/common/components/ElevationProfile.tsx`: the
app draws it with `react-native-svg`, which is the same element tree as DOM SVG.
Every constant is the app's — 140 px plot over a 30 px tick band, a 38 px
elevation gutter, 64 distance-even samples, Catmull-Rom smoothing, the four-stop
grade ramp over ±25 %, the pace/heart-rate curves and their dotted averages, and
`scrubProfileAtRatio` turning a pointer x into a sample and an on-trail point
(which moves the dot on the map).

### The trim button, three ways

`docs/BACKLOG.md` queues: _move the trim (scissors) button out of trail focus —
it edits the GPX (different from map viewing); move it next to the GPX title
(right side) or to the bottom of the trail view._

Rather than pick one, all three are live behind `?trimAt=`, with a switch at the
bottom of the trail screen:

- `rail` — today's app: a floating FAB on the right edge, over the map.
- `title` — candidate A: an icon button beside the trail name.
- `bottom` — candidate B: a full-width action under the profile.

The three can be captured back to back on the same trail in the same session.

---

## Where this deliberately DIFFERS from the app

Every one of these is a proposal to accept or reject, not an accident.

1. **The stats line is a grid, not a string.** The app renders
   `12.34 km · 1:04:09 · 5:12/km · ↑842 m · ↓810 m` as one run-on line. Same
   five values, same order, same formatters here — but each gets a labelled
   column, so the same value sits at the same x in every card and the list can
   be read DOWN a column instead of across each row.
2. **There is a sort.** The app has none: `libraryStore` prepends on add, so the
   list is insertion order and "which of these was longest?" has no answer short
   of scrolling. Seven orders are offered (`web/src/library/sortTracks.ts`). If
   this survives review it belongs in `@core/library/sortTracks.ts` with tests,
   adopted by the app unchanged; it is not in `@core` today only because `@core`
   requires a co-located test file and its own coverage gate.
3. **The filter is an inline section, not a modal.** The Library is already a
   floating panel over the map, and stacking a modal on a floating panel is the
   furniture the aesthetic gate exists to prevent. Expanding in place also keeps
   the result list visible while the criteria change, which is the feedback loop
   — so there is no Apply button either: the list IS the confirmation.
4. **Folder visibility lives on the Library screen.** In the app it is a dialog
   on the Map tab (overlays menu → Topology → "Content: …"). The folders are
   here; the decision "show me only Hiver" is about the folders. The RULES are
   untouched: `nextFolderVisibility` still restarts the selection when coming
   out of `type` mode, which is the fix for the "blank map after picking a
   folder" bug.
5. **Trimming keeps the profile on screen.** The app swaps the profile out for
   the trim slider. Here the profile stays and the cut ends are greyed in place,
   so the shape of what is being thrown away is visible while the handles move.
6. **Demo waypoints have real labels.** The app auto-labels every pin
   `Waypoint N` and puts the meaning in the note, which makes a list of twelve
   of them unreadable. Worth seeing as a decision to make.
7. **The trim slider is two native `<input type="range">`.** Keyboard stepping,
   Home/End and screen-reader announcements come free; the app's PanResponder
   version has none of them.

---

## The demo library

There is no backend and the owner's real trails live only on his phone, so the
Library seeds itself on first load: **23 real Québec City routes** —
les Plaines, la Promenade Samuel-De Champlain, le Corridor du Littoral, le parc
linéaire de la Rivière Saint-Charles, les Sentiers du Moulin, le Mont Wright,
la Vallée Bras-du-Nord, Les Loups, la Chute-Montmorency, l'Île d'Orléans, le
Mont-Sainte-Anne, le Camp Mercier — spread across four folders, nine
categories, both seasons, 4 km to 21 km.

They are **not** toy recordings, because a two-point track tells you nothing
about how a card or a profile actually looks. Each route is a dozen-odd
hand-placed anchor coordinates with hand-read elevations
(`src/demo/routes.ts`), inflated by `src/demo/synth.ts` into a full 1 Hz
recording: a Catmull-Rom spline through the anchors, rolling micro-terrain, a
grade-aware pace with pauses, autocorrelated GPS jitter and a lagged heart-rate
series. That is ~90 000 points and ~25 MB of GPX text across the library.

The output is GPX **text**, deliberately, and it goes in through
`@core/geo/gpx#parseGpx` — the exact path a dropped file takes. The demo library
and a real import are the same code path, so anything that would break a GPX
import breaks the seed too, loudly, on first load.

Seeding takes ~10–15 s in dev with a progress line, then persists in IndexedDB
and never runs again. The `⋮`-free way to redo it is to clear site data.

### Where it is stored

Mirroring the app's `library.json` + `tracks/<id>.gpx`, in two IndexedDB stores:

- `library` — one index blob: folders, trail summaries, waypoints, custom
  categories, visibility mode. Shaped like
  `@core/library/migrations#LibraryIndex` minus the parts that need a device.
- `gpx` — the GPX text per trail id.

A `WebTrack` **extends** `TrackSummary` rather than replacing it, which is what
lets `filterTracks`, `groupByFolder` and `visibleTrackIds` take these objects
verbatim; `fileUri` keeps its meaning and just names an IndexedDB key
(`idb://gpx/<id>`) instead of a `file://` path. It adds one field the app does
not need — `preview`, a 600-vertex decimated line — because the app draws trails
from the GPX it has already loaded, and here the full point lists live only in
IndexedDB. The overview map draws from `preview`; the real points are parsed on
demand when one trail is opened.

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
| GPX import      | `@core/geo/track` — `buildImportedTrack` (name/start/end from the points), `snapWaypointsToNotes` (`<wpt>` → distance-anchored trail notes)                                                                                     |
| Elevation       | `@core/geo/track` — `buildElevationProfile` (64 distance-even samples), `scrubProfileAtRatio`, `interpolateTrackAtDistance`                                                                                                     |
| Trim            | `@core/geo/gpx/edit` — `sliceTrack`, `retargetNotesAfterTrim`; `@core/geo/gpx` — `buildGpx`                                                                                                                                     |
| Folders         | `@core/library/folders` — `groupByFolder`, `folderItemCount`                                                                                                                                                                    |
| Visibility      | `@core/library/visibility` — `nextFolderVisibility` (the one-tap rule, incl. the never-yield-an-empty-selection fix), `visibleTrackIds`, `visibleWaypoints`, `UNGROUPED_FOLDER_ID`                                              |
| Filter          | `@core/library/filterTracks` — `filterTracks`, `countActiveFilters`, `paceSecPerKm`, `UNCATEGORIZED`                                                                                                                            |
| Categories      | `@core/library/categories` — `BUILT_IN_CATEGORIES`, `allCategories`, `findCategory` (ids, names, colours, glyph names)                                                                                                          |
| Waypoints       | `@core/library/waypoints` — `sortWaypointsNewestFirst`, `notePreview` (the 80-char rule)                                                                                                                                        |
| Trail notes     | `@core/library/notes` — `orderNotes`                                                                                                                                                                                            |
| Library schema  | `@core/library/migrations` — `LIBRARY_SCHEMA_VERSION`, `MapVisibilityMode`; `@core/library/toggleId`                                                                                                                            |
| Models          | `@core/models` — `LatLng`, `LngLat`, `BoundingBox`, `TrackPoint`, `TrackStats`, `TrackSummary`, `TrackNote`, `Folder`, `Waypoint`                                                                                               |

The browser half of the app is only fetch, timers, DOM and MapLibre plumbing.
Every decision with a number in it comes from `@core`.

### What had to be re-expressed for the browser

- **The number formatting is NOT behind `@core`.** `formatDistance`,
  `formatElevation`, `formatDuration`, `formatPace`, `formatSpeed` and
  `formatTimestamp` live in `src/lib/format.ts` — ~100 lines, zero imports,
  completely pure — but OUTSIDE `src/core`. Every number on a trail card and in
  the trail-focus stat block comes from them, and re-typing them here would mean
  cards that round differently from the app, which is exactly what makes a
  playground useless. So `@lib` is aliased at `../src/lib` in `vite.config.ts`
  and `tsconfig.json`, and **exactly one file** is imported through it.

  **This is the one place the pure-core boundary leaked, and it should be fixed
  in the app**: `src/lib/format.ts` belongs at `src/core/format/`, tests and
  all. Its `displayUnits` module-global deserves a look at the same time — it
  means `formatDistance` is not referentially transparent. The playground sets
  it once, from `?units=`, before the first render.

- **Two `@core/library` helpers are typed on `TrackSummary` instead of generic
  over it.** `filterTracks` and `groupByFolder` both take and return
  `TrackSummary`, so a caller holding a widened item type (here `WebTrack`, on
  device a summary joined with anything) loses the extra fields on the way
  through and has to resolve every item back through an id map. Adding
  `<T extends TrackSummary>` to both — the way `sortTracks` in this project is
  written — would delete that map and change nothing else.

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
  Strava.** The map itself is pan/zoom/tilt only.
- **No 3D trail viewer.** The app's trail focus IS a 3D screen
  (`Trail3DGLScreen.tsx`, an `expo-gl` terrain render with the profile docked
  under it). Here the map box is the shared 2D MapLibre map. The stat block,
  the profile and the trim are reproduced; the terrain render is not.
- **No maps in the Library.** The app's Library also lists `MapDocument`s
  (imported GeoPDFs) with their per-page overlay checkboxes, and its trail
  filter hides that whole section while active. There is no GeoPDF pipeline
  here, so `groupByFolder` is called with an empty maps array and folder counts
  are trails + waypoints only.
- **No selection / merge mode.** Long-press-to-select and the appbar merge
  action are not reproduced, though `@core/geo/gpx/edit#mergeTracks` is right
  there and would work unchanged.
- **No photos, no waypoint editor, no note editing, no PDF export, no Strava
  upload.** Waypoint notes and trail notes are read-only here.
- **Waypoints cannot be created.** They come from the map's "+" speed-dial on
  device; the demo seeds thirteen of them.
- **Custom categories cannot be created.** `validateCategoryName` and
  `CATEGORY_COLOR_PALETTE` are in `@core` and unused here; the demo seeds one
  (`Gravelle`) so the custom-category rendering path is exercised.
- **No tests.** The logic that deserves tests lives in `src/core` and is already
  tested there, under the app's coverage gate. This project is chrome around it.
  The one exception is `src/library/sortTracks.ts`, which is new pure logic and
  should move to `@core` with tests if it survives review.

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
    tracks/             the weather map's own GPX drop list (separate from the Library)
    library/
      useLibrary.ts     the index, its mutations, seeding, GPX load, trim apply
      importGpx.ts      GPX text -> WebTrack (the app's importGpx, browser side)
      types.ts          WebLibraryIndex / WebTrack
      LibraryPanel.tsx  folder groups, sections, drag targets, dialogs
      TrackCard.tsx     the trail card
      WaypointCard.tsx  the waypoint row
      FilterSheet.tsx   TrackFilterDialog's criteria, inline
      sortTracks.ts     NEW pure logic (the app has no sort) — see above
    trail/
      TrailFocus.tsx    stat block, notes, trim, the trim-placement switch
      ElevationProfile.tsx  the app's SVG chart, ported
      TrimSlider.tsx    the dual-thumb range
    demo/
      routes.ts         23 hand-anchored Quebec City routes + folders + waypoints
      synth.ts          anchors -> a full 1 Hz recording -> GPX text
    lib/                IndexedDB wrapper, stepped clock, URL state
    ui/                 theme tokens, icons, category glyphs, menu, dialog
  styles.css            all chrome; both themes defined for every token
```

### A note on the layer stack

Order is the design, and it is rebuilt on every `style.load`:

```
basemap  ->  weather dim  ->  weather drape (2 crossfade slots)
         ->  cased coast/road + place labels  ->  GPX tracks
         ->  Library trails + waypoints + the profile's scrub dot
```

The dim mutes the basemap, the drape owns the colour, and the reference overlay
is redrawn **above** the drape so a saturated colour field can never swallow the
geography. Listen to `style.load`, never `styledata` — the latter fires on every
change the app itself makes, which turns a rebuild-on-style-change into an
infinite teardown loop.

---

## Known gaps worth knowing about

- **Seeding the demo library takes ~10–15 s on first load** (dev build,
  unminified) and blocks nothing but shows a progress line. It runs once and
  persists; clear site data to redo it. In a production build it is ~2 s.
- **The demo tracks are synthetic and say so.** The geometry follows real
  corridors and the elevations are hand-read, but the second-by-second pace,
  the GPS jitter and the heart rate come out of a model, not a watch. They are
  right for judging a card, a list and a profile; they are not a dataset.
- **The trail on the map is the 600-vertex preview, not the real trace.** At
  overview zooms it is sub-pixel-accurate; zoom far enough into a switchback and
  you will see the decimation. The profile and every number always use the full
  point list.
- **OpenFreeMap tiles are occasionally slow to appear** after a style swap or a
  large camera jump. It is their CDN, not the layer stack — wait a few seconds
  before concluding a basemap is broken.

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
