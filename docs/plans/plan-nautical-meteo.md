# Nautical charts + weather (meteo) — design package

Feature-lead plan, 2026-08-08. Owner request: marine charts (reference: Navionics)

- weather-map integration. Owner in Québec City; St. Lawrence coverage is the bar.
  Backlog entry: `docs/BACKLOG.md` "Nautical + meteo".

**TL;DR**: Navionics/Garmin is form-gated, unpriced, and the same partnership
structure that just froze the owner out of Garmin Connect — don't build on it.
CHS navigation-grade charts can't legally ship (VAR intake closed). What CAN ship
free and legal for the St. Lawrence: **CHS NONNA-10 bathymetry (open licence) +
OSM/OpenSeaMap seamarks**, framed "not for navigation". Weather is a clean win:
**ECCC GeoMet** (radar + HRDPS overlays, free, commercial-OK) + **CHS IWLS**
tides/water levels (free, no auth, SPINE forecasts cover Montréal→Gaspé).
Total recurring cost of the recommended stack: **$0**.

---

## 1. Chart sources & licensing (the critical path)

### Navionics (owner's reference) — do not plan on it

Garmin runs a "Marine Charts and Maps" developer program with a Navionics Mobile
SDK (iOS/Android) and Web API (developer.garmin.com/marine-charts). Access is a
request-form gate → discretionary approval → negotiated developer token;
monetization is an in-app-purchase resale plan for Navionics cartography. **No
public pricing, no approval criteria, no timeline** — the same opaque partnership
structure as the Garmin Connect Developer Program that froze this owner out with
no timeline (Garmin package parked on PR #171). The SDK is native iOS/Android
(no React Native support), and it's a chart-view SDK that would replace, not
overlay, our MapLibre map. **Verdict: submit the request form as a free lottery
ticket at most; build the roadmap on open sources.**

### The honest Canada picture (St. Lawrence)

- **CHS navigation-grade charts cannot legally ship today.** Crown copyright;
  redistribution needs a CHS licence. The Value-Added Reseller licence
  ($300/term + 18% of net sales) is the vehicle — and **CHS is not accepting new
  VAR applicants until further notice**. One-off chart purchases (~$50/chart
  ENC/BSB) grant no app redistribution rights. o-charts.org (sells CHS vector
  charts, OpenCPN-only EULA) proves VAR deals exist, not that we can get one.
- **What CAN legally ship for the St. Lawrence, now, free:**
  1. **CHS NONNA bathymetry** (Non-Navigational Bathymetric Data, 10 m/100 m
     grids; open.canada.ca) — Open Government Licence – Canada + a
     "NON-NAVIGATIONAL USE ONLY" supplement. Commercial use and redistribution OK
     with attribution. **NONNA-10 densely covers the St. Lawrence** (incl. Québec
     City–Île aux Coudres). Served live as **WMTS/WMS/WCS** from
     `nonna-geoserver.data.chs-shc.ca` — WMTS drops straight into a MapLibre
     raster source, exactly like the Waymarked Trails overlay. WCS/GeoTIFF also
     allows pre-rendering our own depth-tint/contour tiles later.
  2. **OSM seamark data (ODbL)** — buoys, lights, harbours; reasonably mapped on
     the St. Lawrence. OpenSeaMap's public server
     (`tiles.openseamap.org/seamark/{z}/{x}/{y}.png`, transparent PNG) works as a
     v1 overlay, but it's volunteer-run with shaky health — plan to self-render
     seamark tiles from OSM data if usage grows. OpenSeaMap depth data is
     sparse/moribund: NONNA for depths, OpenSeaMap for seamarks only.
  3. Position it like the rest of the app: **"reference bathymetry + seamarks —
     not for navigation"** disclaimer (mirrors the slope disclaimer snackbar).
- **Commercial bridge to real CHS charts**: **GeoGarage** (geogarage.com) sells a
  raster chart-tile REST API including a **licensed CHS layer** (St. Lawrence
  covered) — subscription, quote-based, used by several boating apps. The only
  practical near-term path to navigation-look CHS charts; offline caching would
  need their agreement. C-MAP is B2B-negotiation only; MapTiler Ocean is
  bathymetry styling, not chart data.

### US / Great Lakes: NOAA (free, CC0)

Traditional raster charts are gone (RNC tile services shut 2021–22; paper program
ended Jan 2025). Everything is ENC-derived: the **NOAA Chart Display Service**
exposes **WMTS** (`gis.charttools.noaa.gov/.../NOAACharts/MapServer/WMTS`) usable
directly in MapLibre, plus **pre-built MBTiles** (`distribution.charts.noaa.gov/
ncds/`) for offline. Licensing is genuinely **public domain / CC0**:
redistribution, offline caching, commercial bundling all allowed; attribution
requested only. Zero Canadian coverage — but a zero-cost, zero-risk layer for US
waters + US Great Lakes and the template for offline chart packs.

## 2. Weather stack

### Recommendation: ECCC GeoMet + CHS IWLS (free, Canadian-official, $0)

| Need                     | Pick                                                                                                         | Notes                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Radar + animation        | **GeoMet WMS** `RADAR_1KM_RRAI` (rain) / `RADAR_1KM_RSNO` (snow)                                             | 1 km NA composite, 6-min updates, 3 h window; TIME dimension from GetCapabilities                            |
| Wind/precip/temp overlay | **GeoMet WMS** `HRDPS.CONTINENTAL_UU/_PR/_TT`                                                                | 2.5 km, hourly, 48 h — best available for Québec; GDPS for 10-day                                            |
| Point forecast (tap)     | **GeoMet-OGC-API** `api.weather.gc.ca` `citypage-weather` (+ WMS GetFeatureInfo for gridded values)          | Official ECCC forecasts, FR/EN, JSON, no key                                                                 |
| Tides / water levels     | **CHS IWLS** `api-iwls.dfo-mpo.gc.ca` — `wlo` obs, `wlp` predictions, `wlf` forecasts                        | No auth; `chs-region-code=QUE`; SPINE forecasts cover Montréal→Îles-de-la-Madeleine; 3 req/s, 30 req/min cap |
| Marine wind/waves        | HRDPS wind + `marineweather-realtime` OGC-API zone forecasts/warnings; GDWPS/RDWPS wave WMS for estuary/gulf | Global wave models don't resolve the river — official zone forecasts do                                      |

GeoMet licence: ECCC end-use licence v2.1 — worldwide, royalty-free, **commercial
use allowed**, attribution "Data Source: Environment and Climate Change Canada".
Usage policy: ~1 req/s sustained soft cap, meaningful User-Agent, client-side
caching — fine for us, but it shapes the animation design (few pre-fetched
frames, throttled).

### Alternatives considered (rejected or fallback)

- **RainViewer** — free XYZ radar tiles, Canada covered, trivially animated, adds
  **nowcast** (+30 min) frames GeoMet lacks. No SLA, small-project terms. Keep as
  optional secondary provider if WMS animation proves janky; not the default.
- **OpenWeatherMap** — free-tier tiles are coarse/3-hourly, model-blend quality
  below HRDPS for Québec. Fallback only.
- **Windy** — €990+/yr minimum for production; Leaflet-based map product fights
  the MapLibre stack. Not viable.
- **Open-Meteo** — free tier is **non-commercial only**; marine API explicitly
  unsuitable for coastal/river water. Skip.

### MapLibre WMS mechanics (verified pattern)

GeoMet WMS works as a raster source via the `{bbox-epsg-3857}` template:
`https://geo.weather.gc.ca/geomet?service=WMS&version=1.3.0&request=GetMap&layers=RADAR_1KM_RRAI&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256&format=image/png&transparent=true&time=<ISO8601>`
with `tileSize: 256`. Caveat: changing `TIME` means swapping the source (remove/
re-add — `setUrl` doesn't re-template WMS), which our style-memo rebuild in
`MapScreen.tsx` already does naturally on state change.

### Offline behavior

Weather is inherently online. Never in offline packs; hidden when `offlineOnly`
is on (exactly how `markedTrailsNetworks` is dropped in the `MapScreen.tsx` style
memo); Weather menu rows render disabled with a "needs connection" hint when
unreachable; forecast/tide cards show "as of HH:MM" from the last fetch; no stale
radar ever.

## 3. Architecture fit (grounded in current code)

The app already has every mechanism this needs; no native-layer changes.

### Existing mechanisms to reuse

| Mechanism                                                   | Where                                                                                    | Reused for                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Raster overlay tiles composed into the style                | `src/features/map/mapStyle.ts` (`markedTrailsNetworks` → `wmt-*` sources/layers)         | NONNA WMTS, seamarks, GeoMet radar/model layers                                                         |
| Overlay registry (id/label/URL + sanitize on hydration)     | `src/core/geo/trailNetworks.ts`                                                          | `marineLayers.ts`, `weatherLayers.ts`                                                                   |
| Overlay pick UI                                             | `MapOverlaysMenu.tsx` + `TrailNetworksDialog.tsx`                                        | "Marine" and "Weather" rows + dialogs                                                                   |
| Persisted layer choices                                     | `settingsStore` (`markedTrailsNetworks`, sanitized on hydration)                         | `marineLayers: MarineLayerId[]`, `weatherLayer: WeatherLayerId \| null`                                 |
| Transient view state                                        | `mapStore` (`showPdfOverlay`, `terrain3d`)                                               | `showWeather`, radar frame index                                                                        |
| Offline packs (loopback style server, per-layer zoom clamp) | `src/data/offline.ts`, `offlineStore.downloadMany`, `packZoomRange` in `@core/geo/tiles` | Offline chart regions (M4)                                                                              |
| Offline-only degradation                                    | `MapScreen.tsx` style memo                                                               | Weather/chart overlays hidden offline                                                                   |
| Imported georeferenced documents                            | `usePdfOverlay.ts` + `@core/geo/geopdf`                                                  | "Bring your own chart": a user's own purchased CHS BSB/PDF stays personal-use — no redistribution by us |
| First-enable disclaimer + snackbar                          | `useSlopeDisclaimer` / `useTimedSnackbar`                                                | "Not for navigation" notice                                                                             |
| Point-tap → card UI                                         | `WaypointViewerCard`, `TrailInspectPanel` idioms                                         | Forecast tap-card, tide station card                                                                    |

### New code layout

- `src/core/geo/weatherLayers.ts` (+tests) — layer catalog; WMS GetMap tile-URL
  builder; TIME formatting; GetCapabilities time-extent parsing (pure).
- `src/core/weather/forecast.ts` (+tests) — citypage/GetFeatureInfo responses →
  view model, using existing settings units.
- `src/core/weather/tides.ts` (+tests) — IWLS parsing, nearest-station selection
  (reuse `geomath.ts` haversine), next high/low extraction from `wlp` series.
- `src/core/geo/marineLayers.ts` (+tests) — chart/seamark/bathy catalog with
  per-source attribution + max zoom (same discipline as `NATIVE_MAX_ZOOM`; the
  offline downloader must obey it via `packZoomRange`).
- `src/features/map/weather/` — `useWeatherFrames.ts` (frame timestamps + tick),
  `WeatherMenuRows.tsx`, `ForecastCard.tsx`, `TideCard.tsx`.
- `src/features/map/marine/` — `MarineLayersDialog.tsx` (clone of
  TrailNetworksDialog).
- `mapStyle.ts` — extend `OsmStyleOptions` with `marineLayers` and
  `weather?: { urlTemplate: string; opacity: number }`; radar frame swap = new
  source URL flowing through the existing style-memo rebuild.
- `src/data` — nothing new for weather (online-only); M4 extends
  `data/offline.ts` pack creation for chart layers.

### Design rules

- Chart/weather layers are **overlays, not basemaps**: they live in the Overlays
  menu (gradient FAB), draping over OSM/satellite like Waymarked Trails — the
  mountain menu stays "which ground you stand on".
- Radar animation: 6–12 pre-listed frames, ~600 ms/frame, pausable, frame list
  refreshed on menu open — respects GeoMet's ~1 req/s policy with tile caching.
- Every layer ships its attribution string in the catalog (ECCC, CHS NONNA,
  OpenSeaMap CC-BY-SA, NOAA courtesy line) — the style builder already plumbs
  per-source `attribution`.

## 4. Milestone plan (thin shippable slices)

All slices are JS-only (no new native modules) → OTA-able on the current runtime;
`npm run check` gates; new `src/core` logic gets co-located `*.test.ts` under the
coverage gate.

### M1 — GeoMet radar + wind overlay, forecast tap-card

- Weather section in Overlays menu: Radar (RRAI/RSNO), Wind (HRDPS UU), Precip
  (PR). Latest-frame static first; animation toggle as a sub-row. Long-press →
  ECCC forecast card (nearest citypage + GetFeatureInfo values).
- Tests: `weatherLayers.test.ts` (WMS URL/bbox/TIME math, capabilities parsing on
  fixture XML — pure, no network), `forecast.test.ts` on fixture JSON. Maestro
  `weather.yaml` modeled on `map-overlays.yaml`: toggle rows, assert menu state +
  crash gate only — never weather pixels; in CI the layer URL resolves to an
  unreachable host and the map degrades to background tiles, which it already
  tolerates. No network dependency, no flakiness.

### M2 — Tides & water levels (St. Lawrence)

- IWLS station pins toggle (region QUE) + tide card: current level (`wlo`), next
  high/low from `wlp`, SPINE forecast (`wlf`) where offered. Client-side throttle
  honoring 3 req/s / 30 req/min.
- Tests: `tides.test.ts` on recorded IWLS fixtures (stations + series);
  station-selection math pure. Maestro: open/close the card, assert the
  offline-degraded state (deterministic without network).

### M3 — Marine reference layer (NONNA bathymetry + seamarks)

- Marine dialog: NONNA-10 depth layer (CHS WMTS), OpenSeaMap seamarks. First
  enable → "Reference only — not for navigation" disclaimer. Attribution + zoom
  clamps from `marineLayers.ts`.
- Tests: `marineLayers.test.ts` (URL/zoom/attribution); `marine.yaml` Maestro
  flow (menu toggles + crash gate). If GeoGarage or Navionics ever clears
  licensing, it lands here as another catalog entry — architecture unchanged.

### M4 — Offline chart regions

- Chart layers as extra `DownloadLayer`s in `offlineStore.downloadMany` — **only
  sources whose licence permits caching** (NONNA OGL: yes; NOAA CC0: yes, or
  ship their pre-built MBTiles; OpenSeaMap tile server: no bulk download — needs
  self-rendered tiles first; GeoGarage: contract-dependent). Zoom clamp via
  `packZoomRange`; size estimates via `estimateBytesForBasemaps` with a chart
  bytes/tile constant.
- Tests: extend `tiles.test.ts` estimates + `offline.test.ts` pack id/label
  cases; manual device verification per the release-gotchas playbook.

Sequence rationale: M1/M2 deliver the "extremely complete" feel immediately with
zero licensing risk; M3 ships the best legal St. Lawrence marine content; M4 is
gated on M3's source mix and is the only slice touching `src/data`.

## 5. Owner decisions (recommendations in bold)

1. **Navionics: pursue licensing vs ship free sources first?**
   **Ship free sources first.** Optionally submit the Navionics Mobile SDK
   request form now (free, non-binding) — but given the Garmin Connect freeze
   precedent, the unpriced IAP-resale model, and a native SDK that would replace
   our MapLibre map, nothing on the roadmap should wait on Garmin. Revisit only
   if they approve with acceptable terms.
2. **Is US/Great Lakes NOAA coverage acceptable at launch given CHS blocks
   St. Lawrence charts?** Reframed: we don't have to choose. **Launch the
   St. Lawrence with NONNA-10 bathymetry + seamarks (legal, free, dense local
   coverage), and add the NOAA chart layer as a cheap bonus** for US waters
   (CC0, WMTS + ready-made offline MBTiles). If the owner wants true CHS
   navigation charts, the real decision is whether to request a **GeoGarage
   quote** (subscription, online-first) — worth one email, not worth blocking.
3. **Weather provider?** **ECCC GeoMet + CHS IWLS** — official, free, commercial
   use allowed, best resolution for Québec (HRDPS 2.5 km), attribution-only.
   RainViewer held as an optional nowcast add-on; OWM fallback only; Windy and
   Open-Meteo rejected (cost / non-commercial terms).
4. **Radar animation scope?** **Static latest-frame in M1, plus a bounded
   animation toggle (6–12 frames over the past 1–2 h, pausable) in the same
   milestone if the WMS source-swap proves smooth on device; otherwise defer
   animation to M1.1.** Full nowcast/scrubbing UI is out of scope unless
   RainViewer is adopted.
5. **NONNA depth presentation** (minor): **start with CHS's own WMTS rendering**
   (zero work); later self-render depth tints/contours from WCS GeoTIFFs for a
   Navionics-like look and offline friendliness.
