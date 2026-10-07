# PDF time-to-sharp bench

This is the device harness from #575. It measures how long a georeferenced PDF takes to turn sharp on the map, and how good the rasters are. The app side is `src/features/map/hooks/usePdfBench.ts`, which a bench build compiles in. These scripts are the host side.

Nothing here runs in CI. Every script takes an `OUT_DIR` / `RUN_DIR`. **Point it outside the repo**: run output is large and is not gitignored.

## Get a bench build

Only JS changes can be measured this way; native changes need a real store build.

| Script                                    | What it does                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `swap-android-bundle.sh BASE.apk OUT.apk` | Builds this tree's Hermes bundle with the bench compiled in, swaps it into an existing release APK and debug-signs it. |
| `swap-ios-bundle.sh BASE.app OUT.app`     | Does the same for a copy of a simulator `.app`, ad-hoc signed.                                                         |
| `patch-tree.py HARNESS_TREE TARGET_TREE`  | Injects the probe into an older source tree (v1.6.0 onwards), for bisecting.                                           |

## Run a plan

| Script                                                          | What it does                                                                                                                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-android.sh SERIAL PLAN.json CORPUS_DIR OUT_DIR`            | Clears app data, cold-starts the app, sends the plan link, then waits for `/done`.                                                                                         |
| `run-ios.sh UDID APP PLAN.json CORPUS_DIR OUT_DIR`              | Reinstalls the app on a simulator and hands it the plan link through `<Documents>/qa/command.txt`.                                                                         |
| `open-android.sh SERIAL PLAN.json CORPUS OUT SLUG LON LAT REPS` | Times a cold launch that opens the map, `REPS` times.                                                                                                                      |
| `host.py`                                                       | The server the app talks to: it serves the corpus (with HTTP Range) and the plan, and collects logs, results, tiles and screenshots. The `run-*` scripts start it for you. |

Zoom levels in a plan are relative to fitting the whole page. Jump views are
centred inside the map frame (the georeferenced area), not in the blank
collar around it (`src/features/map/hooks/pdfBenchPlan.ts`, #637). A view can
still be blank paper: a sheet may leave areas blank (US Topo leaves the far
side of a border empty), and the frame can reach slightly into the collar.
`report.py` lists such views so they are not mistaken for failed renders.

## Read the results

| Script                                                         | What it does                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `report.py RUN_DIR [...]` / `report.py --compare BEFORE AFTER` | Prints time-to-sharp p50/p95/max per map and zoom level.                                                                      |
| `quality.py`                                                   | Compares each uploaded raster with an independent MuPDF render (SSIM, sharpness, pixels per point). Needs PyMuPDF.            |
| `shots_compare.py RUN_BEFORE RUN_AFTER OUT_DIR`                | Does a screen-level before/after SSIM and sharpness check, and writes side-by-side crops.                                     |
| `project_hold.py RUN_DIR`                                      | A projection, not a measurement: what Android time-to-sharp would be if the native renderer kept the page open between crops. |
