# Inukshuk

**Website: [inukshuk.mvxtechnologies.com](https://inukshuk.mvxtechnologies.com/)**

**Offline trail navigation with georeferenced PDF maps.** Load a georeferenced
PDF (topo map, trail map, orienteering map), see your live GPS position on it,
and fall back to OpenStreetMap wherever the PDF doesn't cover. Record routes as
GPX with a live dashboard — compass, time, distance, elevation gain (D+) and
loss (D-) — and a highlighted trail on the map.

An _inukshuk_ is an Inuit stone landmark that marks a route or a safe place —
the same job this app does on your phone.

Free and open source. No paid services, no API keys, no accounts required to use it.

---

## Features

- **Georeferenced PDF maps** — imports PDFs with embedded georeferencing
  (ISO 32000 `/Measure /GEO` viewports and OGC/TerraGo `LGIDict`) or sidecar
  world files / GDAL `.aux.xml`. The page is rendered to an image and overlaid
  on the map at its true geographic corners.
- **OpenStreetMap base layer** — free raster tiles via MapLibre fill in
  everything outside your PDF, so you're never off the map.
- **Live GPS** — your position and heading, with a follow-me camera.
- **Route recording** — start/pause/stop, with a live HUD showing time,
  distance, D+, D-, speed and max altitude, and the trail drawn as you go.
- **GPX library** — every recording is saved as standard GPX you can view on
  the map or share to any other app.
- **Compass** — true-north heading with a rotating needle.

## Tech stack (all free, gold-standard libraries)

| Concern        | Choice                                                 |
| -------------- | ------------------------------------------------------ |
| Framework      | Expo SDK 56 + React Native 0.85 + React 19, TypeScript |
| Navigation     | expo-router (file-based)                               |
| Maps           | MapLibre Native (`@maplibre/maplibre-react-native`)    |
| UI components  | React Native Paper (Material Design 3)                 |
| State          | Zustand                                                |
| Location       | expo-location · expo-sensors                           |
| PDF rendering  | pdf.js (bundled, offline) in a hidden WebView          |
| Georeferencing | custom parser + proj4 (pure TS, unit-tested)           |
| GPX            | custom parser/builder (fast-xml-parser)                |
| Storage        | expo-file-system (File/Directory API)                  |

## Architecture

Layered so the hard logic is pure and testable, and the platform code is thin.

```
src/
  core/          Pure, platform-free, unit-tested logic (no RN imports)
    models/        Domain types (LatLng, GeoReference, Track, …)
    geo/
      geomath.ts   Affine fit, page→geo extrapolation, bbox math
      geopdf/      Embedded GeoPDF + sidecar georeference parsing (proj4)
      gpx/         GPX 1.1 read/write
      track/       Distance, D+/D- (hysteresis), moving time, speeds
  data/          Platform persistence (expo-file-system)
  state/         Zustand stores (library, recorder, settings, map)
  features/      Screens + hooks (map, library, settings)
  ui/            Theme + shared presentational components
  lib/           Formatting helpers
app/             expo-router routes ((tabs): Map, Library, Settings)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, including
how georeferenced overlays are computed.

## Getting started

```bash
npm ci

# Type-check, lint, format-check, and test everything:
npm run check

# Run on a device/simulator (requires a development build — this app uses
# native modules, so Expo Go won't work):
npm run ios       # builds & runs the iOS dev client
npm run android   # builds & runs the Android dev client
```

> This app uses native modules (MapLibre, location). The first run does a native
> build via `expo run:*`. After that, `npm start` launches the dev server for
> the installed dev client.

## Scripts

| Script              | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `npm run check`     | typecheck + lint + format-check + tests w/ coverage |
| `npm run typecheck` | `tsc --noEmit`                                      |
| `npm run lint`      | ESLint (zero warnings allowed)                      |
| `npm test`          | Jest unit tests                                     |
| `npm run doctor`    | `expo-doctor` project health                        |

## Quality & automation

Everything is wired to run itself without an engineer watching:

- **CI** (`ci.yml`) — typecheck, lint, format, tests + coverage on every PR.
- **Native build tests** (`native-build.yml`) — real iOS (`xcodebuild`) and
  Android (`gradlew assembleDebug`) compiles on the latest runners.
- **E2E** (`e2e.yml`) — Maestro smoke flow on an Android emulator.
- **Nightly health check** (`nightly.yml`) — full gate + `expo-doctor` + audit;
  opens a tracking issue if anything regresses.
- **OTA updates** (`ota-update.yml`) — merges to `main` ship as EAS Updates so
  installed apps self-correct without a store release.
- **Releases** (`release.yml`) — version tags build on EAS and auto-submit to
  the App Store and Play Store.
- **Dependencies** — Dependabot + auto-merge for green minor/patch updates.

See [docs/CI.md](docs/CI.md) and, for publishing to the stores,
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Licensing & attribution

- Code: see [LICENSE](LICENSE).
- Maps & data: © OpenStreetMap contributors. The default OSM tile server has a
  [usage policy](https://operations.osmfoundation.org/policies/tiles/) — for
  wide distribution, point `Settings → Base map tiles` at your own cache or a
  free provider.
